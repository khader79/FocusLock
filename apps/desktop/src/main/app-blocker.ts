import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { verifyTokenForAction } from './challenge-token'
import { auditLog } from './audit-log'

/**
 * Windows application blocking.
 *
 * blockApp/unblockApp gate every mutation behind a valid challenge token, then
 * apply three layers: an Image File Execution Options Debugger override, inbound
 * + outbound Windows Firewall rules, and a process watcher (500 ms) that
 * terminates the app on sight and records kills to `app-blocker-stats.json`.
 *
 * Electron-free: commands run through the injectable {@link WindowsCommandRunner}
 * (reg.exe / netsh.exe / tasklist.exe) and the native file dialog is injected via
 * {@link setAppPicker} — so this module (and its tests) run under plain Node.
 */

export interface AppInfo {
  name: string
  executable: string | null
  icon: string | null
  source: 'start-menu' | 'registry'
}

export interface BlockedAppEntry {
  name: string
  exePath: string
  addedAt: string
}

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export interface WindowsCommandRunner {
  run(program: string, args: readonly string[]): CommandResult
}

export const defaultCommandRunner: WindowsCommandRunner = {
  run(program, args) {
    const result = spawnSync(program, [...args], { encoding: 'utf8', windowsHide: true })
    return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  },
}

export type AppPicker = () => Promise<AppInfo | null>

let registeredPicker: AppPicker | null = null
let baseDirOverride: string | null = null

/** Registers the native (Electron `dialog`) app picker used by {@link pickApp}. */
export function setAppPicker(picker: AppPicker | null): void {
  registeredPicker = picker
}

export function setAppBlockerBaseDir(baseDir: string): void {
  baseDirOverride = baseDir
}

export function resetAppBlockerBaseDir(): void {
  baseDirOverride = null
}

function resolveBaseDir(explicit?: string): string {
  const baseDir = explicit ?? baseDirOverride
  if (baseDir === null) {
    throw new Error('App blocker base directory is not configured.')
  }
  return baseDir
}

// --- Persisted blocked-apps store ---------------------------------------------

export function blockedAppsFilePath(baseDir: string): string {
  return join(baseDir, 'app-blocker.json')
}

export function readBlockedApps(baseDir: string): BlockedAppEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(blockedAppsFilePath(baseDir), 'utf8'))
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (entry): entry is BlockedAppEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as BlockedAppEntry).name === 'string' &&
        typeof (entry as BlockedAppEntry).exePath === 'string',
    )
  } catch {
    return []
  }
}

export function writeBlockedApps(baseDir: string, entries: BlockedAppEntry[]): void {
  const target = blockedAppsFilePath(baseDir)
  const tmpPath = `${target}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, target)
}

// --- Kill statistics -------------------------------------------------------------

export interface KillRecord {
  ts: string
  process: string
  pid: number
}

export function killStatsFilePath(baseDir: string): string {
  return join(baseDir, 'app-blocker-stats.json')
}

function readKillRecords(baseDir: string): KillRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(killStatsFilePath(baseDir), 'utf8'))
    return Array.isArray(parsed) ? (parsed as KillRecord[]) : []
  } catch {
    return []
  }
}

/** Appends a terminated-process record (capped at the last 200 kills). */
export function logAppKill(baseDir: string, processName: string, pid: number): void {
  const records = readKillRecords(baseDir)
  records.push({ ts: new Date().toISOString(), process: processName, pid })
  while (records.length > 200) {
    records.shift()
  }
  const target = killStatsFilePath(baseDir)
  const tmpPath = `${target}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
  renameSync(tmpPath, target)
}

// --- IFEO + firewall layer --------------------------------------------------------

const IFEO_ROOT = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options'
const IFEO_DEBUGGER = '%windir%\\System32\\systray.exe'

export function ifeoKeyFor(exeName: string): string {
  return `${IFEO_ROOT}\\${exeName}`
}

export function firewallRuleName(friendlyName: string): string {
  return `FocusLock Block ${friendlyName}`
}

// --- Process watcher ---------------------------------------------------------------

export interface ProcessScanner {
  listProcesses(runner: WindowsCommandRunner): Array<{ pid: number; name: string }>
}

export const tasklistScanner: ProcessScanner = {
  listProcesses(runner) {
    const result = runner.run('tasklist', ['/fo', 'csv', '/nh'])
    return parseTasklistCsv(result.stdout)
  },
}

/** Parses `tasklist /fo csv /nh` output into `{ name, pid }` rows. */
export function parseTasklistCsv(output: string): Array<{ pid: number; name: string }> {
  const processes: Array<{ pid: number; name: string }> = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)",/)
    if (match === null) {
      continue
    }
    const name = match[1] ?? ''
    const pid = Number(match[2])
    if (name !== '' && Number.isInteger(pid)) {
      processes.push({ name, pid })
    }
  }
  return processes
}

export interface ProcessWatcherOptions {
  intervalMs?: number
  scanner?: ProcessScanner
  runner?: WindowsCommandRunner
  getBlockedExeNames?: () => Array<string> | Promise<Array<string>>
  onKill?: (blocked: { name: string; pid: number }) => void
}

export interface ProcessWatcher {
  start(): void
  stop(): void
  readonly running: boolean
}

/**
 * Terminates any running process whose image name is in the block list, every
 * `intervalMs` (default 500 ms per spec). Failures to kill are swallowed but
 * still reported through `onKill` (the kill is recorded regardless).
 */
export function createProcessWatcher(options: ProcessWatcherOptions): ProcessWatcher {
  const intervalMs = options.intervalMs ?? 500
  const scanner = options.scanner ?? tasklistScanner
  const runner = options.runner ?? defaultCommandRunner
  const blockedNameLoader = options.getBlockedExeNames ?? (async () => [])
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  const tick = (): void => {
    void (async () => {
      let blockedNames: string[]
      try {
        blockedNames = await blockedNameLoader()
      } catch {
        return
      }
      if (blockedNames.length === 0) {
        return
      }

      let processes: Array<{ pid: number; name: string }>
      try {
        processes = scanner.listProcesses(runner)
      } catch {
        return
      }

      const targets = new Set(blockedNames.map((name) => name.toLowerCase()))
      for (const proc of processes) {
        if (!targets.has(proc.name.toLowerCase())) {
          continue
        }
        try {
          process.kill(proc.pid)
        } catch {
          // The process may have exited in between; the kill is still recorded.
        }
        options.onKill?.({ name: proc.name, pid: proc.pid })
      }
    })()
  }

  return {
    start(): void {
      if (running) {
        return
      }
      running = true
      timer = setInterval(tick, intervalMs)
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer)
      }
      timer = null
      running = false
    },
    get running(): boolean {
      return running
    },
  }
}

let activeWatcher: ProcessWatcher | null = null

function ensureWatcher(baseDir: string, scanner?: ProcessScanner): void {
  if (activeWatcher !== null && activeWatcher.running) {
    return
  }
  const watcher = createProcessWatcher({
    intervalMs: 500,
    scanner,
    getBlockedExeNames: async () => readBlockedApps(baseDir).map((entry) => basename(entry.exePath)),
    onKill: ({ name, pid }) => logAppKill(baseDir, name, pid),
  })
  activeWatcher = watcher
  watcher.start()
}

function stopWatcher(): void {
  if (activeWatcher !== null) {
    activeWatcher.stop()
    activeWatcher = null
  }
}

interface BlockAppOptions {
  baseDir?: string
  runner?: WindowsCommandRunner
  scanner?: ProcessScanner
}

/**
 * Blocks an app: persists the entry, adds the IFEO Debugger override, blocks
 * inbound + outbound firewall traffic and starts the process watcher.
 */
export async function blockApp(exePath: string, token: string, options: BlockAppOptions = {}): Promise<BlockedAppEntry> {
  verifyTokenForAction(token, 'block_app')

  if (!exePath.trim().toLowerCase().endsWith('.exe')) {
    throw new Error(`Not an executable path: "${exePath}".`)
  }

  const baseDir = resolveBaseDir(options.baseDir)
  const runner = options.runner ?? defaultCommandRunner
  const exeName = basename(exePath)
  const friendlyName = exeName.replace(/\.exe$/i, '')
  const entry: BlockedAppEntry = { name: friendlyName, exePath, addedAt: new Date().toISOString() }

  const entries = readBlockedApps(baseDir)
  if (!entries.some((existing) => existing.exePath.toLowerCase() === exePath.toLowerCase())) {
    writeBlockedApps(baseDir, [...entries, entry])
  }

  const key = ifeoKeyFor(exeName)
  runner.run('reg', ['add', `"${key}"`, '/v', 'Debugger', '/t', 'REG_SZ', '/d', `"${IFEO_DEBUGGER}"`, '/f'])

  const ruleName = firewallRuleName(friendlyName)
  const firewallArgs = ['advfirewall', 'firewall', 'add', 'rule', `name="${ruleName}"`]
  runner.run('netsh', [...firewallArgs, 'dir=in', `program="${exePath}"`, 'action=block', 'enable=yes'])
  runner.run('netsh', [...firewallArgs, 'dir=out', `program="${exePath}"`, 'action=block', 'enable=yes'])

  ensureWatcher(baseDir, options.scanner)
  auditLog('block_app', true, { name: friendlyName, exePath })

  return entry
}

/**
 * Unblocks an app: removes the entry, the IFEO override and the firewall rules,
 * and stops the watcher once nothing remains blocked.
 */
export async function unblockApp(name: string, token: string, options: BlockAppOptions = {}): Promise<void> {
  verifyTokenForAction(token, 'unblock_app')

  const baseDir = resolveBaseDir(options.baseDir)
  const runner = options.runner ?? defaultCommandRunner

  const entries = readBlockedApps(baseDir)
  const entry = entries.find((existing) => existing.name.toLowerCase() === name.toLowerCase())
  if (entry === undefined) {
    throw new Error(`No blocked app named "${name}".`)
  }

  const remaining = entries.filter((existing) => existing.name.toLowerCase() !== name.toLowerCase())
  writeBlockedApps(baseDir, remaining)

  const exeName = basename(entry.exePath)
  runner.run('reg', ['delete', `"${ifeoKeyFor(exeName)}"`, '/f'])
  runner.run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name="${firewallRuleName(entry.name)}"`])

  if (remaining.length === 0) {
    stopWatcher()
  }
  auditLog('unblock_app', true, { name: entry.name })
}

// --- App discovery -----------------------------------------------------------------

export interface AppDiscoverySources {
  startMenuProgramData: () => string | null
  startMenuUser: () => string | null
  readdir: (dir: string) => string[]
  registryRoots: () => string[]
  registrySubkeys: (key: string) => string[]
  registryValues: (key: string) => Record<string, string>
  resolveShortcutTarget: (lnkPath: string) => string | null
  encodeIcon: (iconPath: string | null) => string | null
}

export const defaultDiscoverySources: AppDiscoverySources = {
  startMenuProgramData: () =>
    process.env.ProgramData === undefined
      ? null
      : join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  startMenuUser: () =>
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  readdir: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => join(dir, entry.name))
    } catch {
      return []
    }
  },
  registryRoots: () => [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ],
  registrySubkeys: (key) => queryRegistrySubkeys(key),
  registryValues: (key) => queryRegistryValues(key),
  resolveShortcutTarget: () => null,
  encodeIcon: (iconPath) => encodeIcon(iconPath),
}

/** Parses `reg query <key>` output lines into a `{ valueName: value }` map. */
export function parseRegistryValueLines(lines: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of lines) {
    const match = line.match(/^\s+(.+?)\s+(?:REG_SZ|REG_EXPAND_SZ)\s+(.*)$/)
    if (match === null) {
      continue
    }
    values[match[1] ?? ''] = match[2] ?? ''
  }
  return values
}

export function queryRegistryValues(
  key: string,
  runner: WindowsCommandRunner = defaultCommandRunner,
): Record<string, string> {
  const result = runner.run('reg', ['query', `"${key}"`])
  return parseRegistryValueLines(result.stdout.split(/\r?\n/))
}

export function queryRegistrySubkeys(
  key: string,
  runner: WindowsCommandRunner = defaultCommandRunner,
): string[] {
  const result = runner.run('reg', ['query', `"${key}"`])
  const subkeys: string[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith('    ') && !line.startsWith('\t')) {
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('HKEY_') && trimmed !== key) {
      subkeys.push(trimmed)
    }
  }
  return subkeys
}

/** Resolves an .exe path from the advertised install values (DisplayIcon > UninstallString). */
export function parseInstalledExe(values: Record<string, string>): string | null {
  for (const raw of [values['DisplayIcon'] ?? '', values['UninstallString'] ?? '', values['InstallLocation'] ?? '']) {
    const cleaned = stripValueDecoration(raw)
    if (cleaned !== '' && cleaned.toLowerCase().endsWith('.exe')) {
      return cleaned
    }
  }
  return null
}

function stripValueDecoration(value: string): string {
  return value
    .replace(/,\d+$/, '')
    .replace(/^"(.*)"$/, '$1')
    .trim()
}

/**
 * Encodes an icon file as a base64 data URI. Only image files are embedded
 * directly; .exe icons are left null rather than requiring shell extraction.
 */
export function encodeIcon(iconPath: string | null): string | null {
  if (iconPath === null) {
    return null
  }
  const cleaned = stripValueDecoration(iconPath)
  const ext = extname(cleaned).toLowerCase()
  if (ext !== '.ico' && ext !== '.png' && ext !== '.bmp' && ext !== '.jpg' && ext !== '.jpeg' && ext !== '.svg') {
    return null
  }
  try {
    const bytes = readFileSync(cleaned)
    const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

function collectLnkFiles(dir: string, readdir: (dir: string) => string[], depth = 0): string[] {
  const files: string[] = []
  for (const entry of readdir(dir)) {
    if (entry.toLowerCase().endsWith('.lnk')) {
      files.push(entry)
    } else if (depth < 2) {
      files.push(...collectLnkFiles(entry, readdir, depth + 1))
    }
  }
  return files
}

/**
 * Enumerates installed apps from the Start Menu (program data + user) and the
 * classic Uninstall registry keys. Registry entries are preferred on name
 * collisions because they carry executables/icons.
 */
export function listInstalledApps(
  sources: AppDiscoverySources = defaultDiscoverySources,
  _runner: WindowsCommandRunner = defaultCommandRunner,
): AppInfo[] {
  const apps: AppInfo[] = []
  const seen = new Set<string>()

  for (const root of sources.registryRoots()) {
    for (const subkey of sources.registrySubkeys(root)) {
      const values = sources.registryValues(subkey)
      const name = values['DisplayName'] ?? (subkey.split('\\').pop() ?? '')
      if (name === '') {
        continue
      }
      const executable = parseInstalledExe(values)
      const icon = sources.encodeIcon(values['DisplayIcon'] ?? null)
      const dedupeKey = `${name}|${executable ?? ''}`.toLowerCase()
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        apps.push({ name, executable, icon, source: 'registry' })
      }
    }
  }

  const registryNames = new Set(apps.filter((app) => app.source === 'registry').map((app) => app.name.toLowerCase()))
  for (const dir of [sources.startMenuProgramData(), sources.startMenuUser()]) {
    if (dir === null) {
      continue
    }
    for (const lnkPath of collectLnkFiles(dir, sources.readdir)) {
      const name = basename(lnkPath).replace(/\.lnk$/i, '')
      if (name === '' || registryNames.has(name.toLowerCase())) {
        continue
      }
      const executable = sources.resolveShortcutTarget(lnkPath)
      apps.push({ name, executable, icon: null, source: 'start-menu' })
    }
  }

  return apps
}

/** Builds an AppInfo for a user-picked executable. */
export function appInfoFromExePath(exePath: string): AppInfo {
  return {
    name: basename(exePath).replace(/\.exe$/i, ''),
    executable: exePath,
    icon: encodeIcon(exePath),
    source: 'start-menu',
  }
}

/** Opens the native file picker (must be registered via {@link setAppPicker}). */
export async function pickApp(picker: AppPicker = registeredPickerChecked()): Promise<AppInfo | null> {
  return picker()
}

function registeredPickerChecked(): AppPicker {
  if (registeredPicker === null) {
    throw new Error('No app picker configured. Register one with setAppPicker.')
  }
  return registeredPicker
}