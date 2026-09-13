import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SystemDnsController, type ExecRunner } from './system-dns'

type Call = { command: string; args: string[] }

function scriptedRunner(outputs: Record<string, string>): { runner: ExecRunner; calls: Call[] } {
  const calls: Call[] = []
  const runner: ExecRunner = async (command, args) => {
    calls.push({ command, args })
    const key = [command, ...args].join(' ')
    const stdout = outputs[key]
    if (stdout === undefined) {
      throw new Error(`unexpected command: ${key}`)
    }
    return { stdout, stderr: '' }
  }
  return { runner, calls }
}

const dirs: string[] = []

async function tempBackupPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-dns-'))
  dirs.push(dir)
  return join(dir, 'dns-backup.json')
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function hasCall(calls: Call[], command: string, args: string[]): boolean {
  return calls.some((call) => call.command === command && JSON.stringify(call.args) === JSON.stringify(args))
}

const WINDOWS_INTERFACES = [
  'Admin State    State          Type             Interface Name',
  '-------------------------------------------------------------------------------',
  'Enabled        Connected      Dedicated        Ethernet',
  'Enabled        Disconnected   Dedicated        VirtualBox Host-Only Network',
].join('\n')

describe('SystemDnsController (windows)', () => {
  it('configures the connected interface to use the local DNS and backs up', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'netsh interface show interface': WINDOWS_INTERFACES,
      'netsh interface ipv4 show dns name=Ethernet':
        '   DNS servers configured through DHCP:  192.168.1.254',
      'netsh interface ip set dns name=Ethernet static 127.0.0.1': '',
    })
    const controller = new SystemDnsController({ platform: 'win32', runner, backupFilePath: backupPath })

    await controller.configure()

    expect(hasCall(calls, 'netsh', ['interface', 'ip', 'set', 'dns', 'name=Ethernet', 'static', '127.0.0.1'])).toBe(
      true,
    )
    const backup = JSON.parse(await readFile(backupPath, 'utf8')) as {
      platform: string
      target: string
      mode: string
      servers: string[]
    }
    expect(backup.platform).toBe('win32')
    expect(backup.target).toBe('Ethernet')
    expect(backup.mode).toBe('dhcp')
    expect(backup.servers).toEqual(['192.168.1.254'])
  })

  it('restores a DHCP interface via netsh and deletes the backup', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'netsh interface show interface': WINDOWS_INTERFACES,
      'netsh interface ipv4 show dns name=Ethernet':
        '   DNS servers configured through DHCP:  192.168.1.254',
      'netsh interface ip set dns name=Ethernet static 127.0.0.1': '',
      'netsh interface ip set dns name=Ethernet dhcp': '',
    })
    const controller = new SystemDnsController({ platform: 'win32', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'netsh', ['interface', 'ip', 'set', 'dns', 'name=Ethernet', 'dhcp'])).toBe(true)
    await expect(readFile(backupPath, 'utf8')).rejects.toThrow()
  })

  it('restores static servers in order', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'netsh interface show interface': WINDOWS_INTERFACES,
      'netsh interface ipv4 show dns name=Ethernet': '   DNS servers configured through static:  8.8.8.8, 1.1.1.1',
      'netsh interface ip set dns name=Ethernet static 127.0.0.1': '',
      'netsh interface ip set dns name=Ethernet static 8.8.8.8': '',
      'netsh interface ip add dns name=Ethernet 1.1.1.1': '',
    })
    const controller = new SystemDnsController({ platform: 'win32', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'netsh', ['interface', 'ip', 'set', 'dns', 'name=Ethernet', 'static', '8.8.8.8'])).toBe(true)
    expect(hasCall(calls, 'netsh', ['interface', 'ip', 'add', 'dns', 'name=Ethernet', '1.1.1.1'])).toBe(true)
  })
})

describe('SystemDnsController (macOS)', () => {
  it('configures the first enabled network service', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'networksetup -listallnetworkservices':
        'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\nEthernet',
      'networksetup -getdnsservers Wi-Fi': '8.8.8.8\n1.1.1.1',
      'networksetup -setdnsservers Wi-Fi 127.0.0.1': '',
    })
    const controller = new SystemDnsController({ platform: 'darwin', runner, backupFilePath: backupPath })

    await controller.configure()

    expect(hasCall(calls, 'networksetup', ['-setdnsservers', 'Wi-Fi', '127.0.0.1'])).toBe(true)
    const backup = JSON.parse(await readFile(backupPath, 'utf8')) as {
      target: string
      mode: string
      servers: string[]
    }
    expect(backup.target).toBe('Wi-Fi')
    expect(backup.mode).toBe('static')
    expect(backup.servers).toEqual(['8.8.8.8', '1.1.1.1'])
  })

  it('restores multiple servers via networksetup', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'networksetup -listallnetworkservices': 'Wi-Fi',
      'networksetup -getdnsservers Wi-Fi': '8.8.8.8\n1.1.1.1',
      'networksetup -setdnsservers Wi-Fi 127.0.0.1': '',
      'networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1': '',
    })
    const controller = new SystemDnsController({ platform: 'darwin', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'networksetup', ['-setdnsservers', 'Wi-Fi', '8.8.8.8', '1.1.1.1'])).toBe(true)
  })

  it('restores an empty DNS list with Empty', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'networksetup -listallnetworkservices': 'Wi-Fi',
      'networksetup -getdnsservers Wi-Fi': "There aren't any DNS Servers set on Wi-Fi",
      'networksetup -setdnsservers Wi-Fi 127.0.0.1': '',
      'networksetup -setdnsservers Wi-Fi Empty': '',
    })
    const controller = new SystemDnsController({ platform: 'darwin', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'networksetup', ['-setdnsservers', 'Wi-Fi', 'Empty'])).toBe(true)
  })
})

describe('SystemDnsController (linux)', () => {
  it('configures and restores via resolvectl', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'resolvectl status': 'Global:          n/a\nLink 2 (ens33):      192.168.1.5\n',
      'resolvectl dns ens33': 'Link 2 (ens33): 1.1.1.1',
      'resolvectl dns ens33 127.0.0.1': '',
      'resolvectl flush-caches': '',
      'resolvectl dns ens33 1.1.1.1': '',
    })
    const controller = new SystemDnsController({ platform: 'linux', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'resolvectl', ['dns', 'ens33', '127.0.0.1'])).toBe(true)
    expect(hasCall(calls, 'resolvectl', ['dns', 'ens33', '1.1.1.1'])).toBe(true)
  })

  it('falls back to nmcli when resolvectl is unavailable', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'nmcli -t -f DEVICE,STATE device status': 'eth0:connected\nlo:unmanaged',
      'nmcli -t -f IP4.DNS device show eth0': 'IP4.DNS[1]:9.9.9.9\nIP4.DNS[2]:1.1.1.1',
      'nmcli con mod eth0 ipv4.dns 127.0.0.1': '',
      'nmcli con up eth0': '',
      'nmcli con mod eth0 ipv4.dns 9.9.9.9 1.1.1.1': '',
    })
    const controller = new SystemDnsController({ platform: 'linux', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'nmcli', ['con', 'mod', 'eth0', 'ipv4.dns', '9.9.9.9 1.1.1.1'])).toBe(true)
  })

  it('restores an empty DNS list by reverting the interface', async () => {
    const backupPath = await tempBackupPath()
    const { runner, calls } = scriptedRunner({
      'resolvectl status': 'Link 2 (ens33): 192.168.1.5',
      'resolvectl dns ens33': 'Link 2 (ens33): n/a',
      'resolvectl dns ens33 127.0.0.1': '',
      'resolvectl flush-caches': '',
      'resolvectl revert ens33': '',
    })
    const controller = new SystemDnsController({ platform: 'linux', runner, backupFilePath: backupPath })

    await controller.configure()
    await controller.restore()

    expect(hasCall(calls, 'resolvectl', ['revert', 'ens33'])).toBe(true)
  })
})

describe('SystemDnsController.isConfigured', () => {
  it('returns true when a backup already exists', async () => {
    const backupPath = await tempBackupPath()
    const { runner } = scriptedRunner({})
    const controller = new SystemDnsController({ platform: 'darwin', runner, backupFilePath: backupPath })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(backupPath, JSON.stringify({ platform: 'darwin', target: 'Wi-Fi', servers: [], mode: 'dhcp' }))

    expect(await controller.isConfigured()).toBe(true)
  })

  it('returns false when the current servers do not point at 127.0.0.1', async () => {
    const backupPath = await tempBackupPath()
    const { runner } = scriptedRunner({
      'netsh interface show interface': WINDOWS_INTERFACES,
      'netsh interface ipv4 show dns name=Ethernet':
        '   DNS servers configured through DHCP:  10.0.0.1',
    })
    const controller = new SystemDnsController({ platform: 'win32', runner, backupFilePath: backupPath })

    expect(await controller.isConfigured()).toBe(false)
  })
})