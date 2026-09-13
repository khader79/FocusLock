import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'

export interface ExecResult {
  stdout: string
  stderr: string
}

export type ExecRunner = (command: string, args: string[]) => Promise<ExecResult>

export interface SystemDnsOptions {
  platform?: NodeJS.Platform
  runner?: ExecRunner
  backupFilePath: string
}

export type DnsMode = 'static' | 'dhcp' | 'none'

export interface SystemDnsState {
  servers: string[]
  mode: DnsMode
}

interface DnsBackup {
  platform: string
  target: string
  servers: string[]
  mode: DnsMode
}

type LinuxBackend = 'resolvectl' | 'nmcli'

const LOCAL_DNS = '127.0.0.1'
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

const realRunner: ExecRunner = (command, args) => {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function isIpv4(value: string): boolean {
  return IPV4_RE.test(value)
}

function linesOf(stdout: string): string[] {
  return stdout.split(/\r?\n/)
}

/**
 * Configures the OS resolver to use the focuslock local DNS server and backs
 * up the original servers so they can be restored on uninstall. Platform
 * specific: netsh (Windows), networksetup (macOS), resolvectl/nmcli (Linux).
 * The exec runner and platform are injectable for tests.
 */
export class SystemDnsController {
  private readonly platform: NodeJS.Platform
  private readonly runner: ExecRunner
  private readonly backupFilePath: string
  private linuxBackend: LinuxBackend = 'resolvectl'

  constructor(options: SystemDnsOptions) {
    this.platform = options.platform ?? process.platform
    this.runner = options.runner ?? realRunner
    this.backupFilePath = options.backupFilePath
  }

  async configure(): Promise<void> {
    if (await this.isConfigured()) {
      return
    }
    const target = await this.detectTarget()
    const current = await this.currentServers()
    await this.writeBackup({ platform: this.platform, target, ...current })
    await this.setServers(target, [LOCAL_DNS])
  }

  async restore(): Promise<void> {
    const backup = await this.readBackup()
    if (backup === null || backup.platform !== this.platform) {
      return
    }

    if (backup.mode === 'dhcp' || backup.servers.length === 0) {
      await this.clearServers(backup.target)
    } else {
      await this.setServers(backup.target, backup.servers)
    }
    await rm(this.backupFilePath, { force: true })
  }

  async isConfigured(): Promise<boolean> {
    if ((await this.readBackup()) !== null) {
      return true
    }
    try {
      const current = await this.currentServers()
      return current.servers.includes(LOCAL_DNS)
    } catch {
      return false
    }
  }

  async detectTarget(): Promise<string> {
    switch (this.platform) {
      case 'win32':
        return this.detectWindowsInterface()
      case 'darwin':
        return this.detectMacService()
      case 'linux':
        return this.detectLinuxDevice()
      default:
        throw new Error(`[system-dns] unsupported platform: ${this.platform}`)
    }
  }

  async currentServers(): Promise<SystemDnsState> {
    const target = await this.detectTarget()
    switch (this.platform) {
      case 'win32':
        return this.currentWindowsServers(target)
      case 'darwin':
        return this.currentMacServers(target)
      case 'linux':
        return this.currentLinuxServers(target)
      default:
        throw new Error(`[system-dns] unsupported platform: ${this.platform}`)
    }
  }

  private async detectWindowsInterface(): Promise<string> {
    const { stdout } = await this.run('netsh', ['interface', 'show', 'interface'])
    for (const raw of linesOf(stdout)) {
      const fields = raw.trim().split(/\s+/)
      if (fields.length >= 3 && fields[1] === 'Connected') {
        return fields.slice(3).join(' ')
      }
    }
    throw new Error('[system-dns] no connected network interface found (netsh)')
  }

  private async currentWindowsServers(target: string): Promise<SystemDnsState> {
    const { stdout } = await this.run('netsh', ['interface', 'ipv4', 'show', 'dns', `name=${target}`])
    const servers: string[] = []
    let mode: DnsMode = 'none'

    for (const line of linesOf(stdout)) {
      if (!/DNS servers configured/i.test(line)) {
        continue
      }
      mode = /dhcp/i.test(line) ? 'dhcp' : 'static'
      const after = line.split(':')[1] ?? ''
      for (const token of after.split(/[, ]+/)) {
        if (isIpv4(token)) {
          servers.push(token)
        }
      }
    }

    return { servers, mode: servers.length > 0 ? mode : 'none' }
  }

  private async detectMacService(): Promise<string> {
    const { stdout } = await this.run('networksetup', ['-listallnetworkservices'])
    for (const raw of linesOf(stdout)) {
      const line = raw.trim()
      if (
        line === '' ||
        line.startsWith('An asterisk') ||
        line.startsWith('*')
      ) {
        continue
      }
      return line
    }
    throw new Error('[system-dns] no network service found (networksetup)')
  }

  private async currentMacServers(target: string): Promise<SystemDnsState> {
    const { stdout } = await this.run('networksetup', ['-getdnsservers', target])
    if (/There aren't any DNS Servers/i.test(stdout)) {
      return { servers: [], mode: 'none' }
    }

    const servers: string[] = []
    for (const raw of linesOf(stdout)) {
      const value = raw.trim()
      if (isIpv4(value)) {
        servers.push(value)
      }
    }
    return { servers, mode: servers.length > 0 ? 'static' : 'none' }
  }

  private async detectLinuxDevice(): Promise<string> {
    if (this.linuxBackend === 'resolvectl') {
      const result = await this.tryRun('resolvectl', ['status'])
      if (result !== null) {
        const target = this.parseResolvectlTarget(result.stdout)
        if (target !== null) {
          return target
        }
      }
      this.linuxBackend = 'nmcli'
    }

    const { stdout } = await this.run('nmcli', ['-t', '-f', 'DEVICE,STATE', 'device', 'status'])
    for (const raw of linesOf(stdout)) {
      const line = raw.trim()
      if (line.endsWith(':connected')) {
        const device = line.slice(0, -':connected'.length)
        if (device !== '') {
          return device
        }
      }
    }
    throw new Error('[system-dns] no connected network device found (nmcli)')
  }

  private parseResolvectlTarget(stdout: string): string | null {
    for (const line of linesOf(stdout)) {
      const match = /Link\s+\d+\s*[:(]\s*\(?\s*([^\s)#]+)/.exec(line)
      const name = match?.[1]
      if (name !== undefined && name !== '' && name !== 'none') {
        return name
      }
    }
    return null
  }

  private async currentLinuxServers(target: string): Promise<SystemDnsState> {
    const servers: string[] = []

    if (this.linuxBackend === 'resolvectl') {
      const result = await this.tryRun('resolvectl', ['dns', target])
      if (result !== null) {
        for (const raw of linesOf(result.stdout)) {
          for (const token of raw.split(/\s+/)) {
            if (isIpv4(token)) {
              servers.push(token)
            }
          }
        }
        return { servers, mode: servers.length > 0 ? 'static' : 'none' }
      }
      this.linuxBackend = 'nmcli'
    }

    const { stdout } = await this.run('nmcli', ['-t', '-f', 'IP4.DNS', 'device', 'show', target])
    for (const raw of linesOf(stdout)) {
      const colon = raw.indexOf(':')
      if (colon === -1) {
        continue
      }
      const value = raw.slice(colon + 1).trim()
      if (isIpv4(value)) {
        servers.push(value)
      }
    }
    return { servers, mode: servers.length > 0 ? 'static' : 'none' }
  }

  private async setServers(target: string, servers: string[]): Promise<void> {
    if (servers.length === 0) {
      await this.clearServers(target)
      return
    }

    switch (this.platform) {
      case 'win32': {
        const primary = servers[0]!
        await this.run('netsh', ['interface', 'ip', 'set', 'dns', `name=${target}`, 'static', primary])
        for (const server of servers.slice(1)) {
          await this.run('netsh', ['interface', 'ip', 'add', 'dns', `name=${target}`, server])
        }
        break
      }
      case 'darwin':
        await this.run('networksetup', ['-setdnsservers', target, ...servers])
        break
      case 'linux':
        await this.setLinuxServers(target, servers)
        break
      default:
        throw new Error(`[system-dns] unsupported platform: ${this.platform}`)
    }
  }

  private async setLinuxServers(target: string, servers: string[]): Promise<void> {
    if (this.linuxBackend === 'resolvectl') {
      await this.run('resolvectl', ['dns', target, ...servers])
      await this.tryRun('resolvectl', ['flush-caches'])
      return
    }

    await this.run('nmcli', ['con', 'mod', target, 'ipv4.dns', servers.join(' ')])
    await this.run('nmcli', ['con', 'up', target])
  }

  private async clearServers(target: string): Promise<void> {
    switch (this.platform) {
      case 'win32':
        await this.run('netsh', ['interface', 'ip', 'set', 'dns', `name=${target}`, 'dhcp'])
        break
      case 'darwin':
        await this.run('networksetup', ['-setdnsservers', target, 'Empty'])
        break
      case 'linux':
        await this.clearLinuxServers(target)
        break
      default:
        throw new Error(`[system-dns] unsupported platform: ${this.platform}`)
    }
  }

  private async clearLinuxServers(target: string): Promise<void> {
    if (this.linuxBackend === 'resolvectl') {
      await this.run('resolvectl', ['revert', target])
      return
    }
    await this.run('nmcli', ['con', 'mod', target, 'ipv4.method', 'auto', 'ipv4.dns', ''])
    await this.run('nmcli', ['con', 'up', target])
  }

  private async run(command: string, args: string[]): Promise<ExecResult> {
    try {
      return await this.runner(command, args)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`[system-dns] "${command}" failed: ${detail}`)
    }
  }

  private async tryRun(command: string, args: string[]): Promise<ExecResult | null> {
    try {
      return await this.runner(command, args)
    } catch {
      return null
    }
  }

  private async readBackup(): Promise<DnsBackup | null> {
    try {
      const raw = await readFile(this.backupFilePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) {
        return null
      }
      return parsed as DnsBackup
    } catch {
      return null
    }
  }

  private async writeBackup(backup: DnsBackup): Promise<void> {
    await writeFile(this.backupFilePath, JSON.stringify(backup, null, 2) + EOL, 'utf8')
  }
}