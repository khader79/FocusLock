import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signChallengeToken } from './challenge-token'
import { setAuditLogBaseDir } from './audit-log'
import {
  resetAppBlockerBaseDir,
  setAppBlockerBaseDir,
  blockApp,
  unblockApp,
  readBlockedApps,
  parseTasklistCsv,
  parseRegistryValueLines,
  parseInstalledExe,
  encodeIcon,
  appInfoFromExePath,
  listInstalledApps,
  createProcessWatcher,
  logAppKill,
  pickApp,
  type WindowsCommandRunner,
  type ProcessScanner,
} from './app-blocker'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-app-blocker-'))
  dirs.push(dir)
  return dir
}

function fakeRunner(calls: string[][] = []): WindowsCommandRunner {
  return {
    run(program, args) {
      calls.push([program, ...args])
      return { status: 0, stdout: '', stderr: '' }
    },
  }
}



describe('parseTasklistCsv', () => {
  it('parses rows and skips unparseable lines', () => {
    expect(
      parseTasklistCsv(
        '"Image Name","PID","Session Name"\n"notepad.exe","1234","Console"\n"bad row"\n',
      ),
    ).toEqual([{ name: 'notepad.exe', pid: 1234 }])
  })

  it('returns [] for empty input', () => {
    expect(parseTasklistCsv('')).toEqual([])
  })
})

describe('parseRegistryValueLines', () => {
  it('parses REG_SZ values into a map', () => {
    expect(
      parseRegistryValueLines([
        '    DisplayName    REG_SZ    Steam',
        '    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Steam',
        '  (blank line should be skipped)',
      ]),
    ).toEqual({ DisplayName: 'Steam', InstallLocation: 'C:\\Program Files (x86)\\Steam' })
  })
})

describe('parseInstalledExe', () => {
  it('resolves the exe from DisplayIcon (strips trailing ,0)', () => {
    expect(parseInstalledExe({ DisplayIcon: 'C:\\Steam\\steam.exe,0' })).toBe('C:\\Steam\\steam.exe')
  })

  it('returns null when DisplayIcon points at an icon file, not an exe', () => {
    expect(parseInstalledExe({ DisplayIcon: 'C:\\Steam\\steam.ico,0' })).toBeNull()
  })

  it('falls back to UninstallString', () => {
    expect(
      parseInstalledExe({ UninstallString: '"C:\\Uninstall.exe"' }),
    ).toBe('C:\\Uninstall.exe')
  })

  it('falls back to InstallLocation (if it ends with .exe)', () => {
    expect(parseInstalledExe({ InstallLocation: 'C:\\App\\app.exe' })).toBe('C:\\App\\app.exe')
  })

  it('returns null when no candidate is an exe', () => {
    expect(parseInstalledExe({ DisplayName: 'Steam', InstallLocation: 'C:\\Steam' })).toBeNull()
  })
})

describe('encodeIcon', () => {
  it('encodes a PNG file as a data URI', async () => {
    const dir = await tempDir()
    const iconPath = join(dir, 'icon.png')
    await writeFile(iconPath, Buffer.from('fake-png-bytes'))
    expect(encodeIcon(iconPath)).toBe('data:image/png;base64,ZmFrZS1wbmctYnl0ZXM=')
  })

  it('encodes an ICO file as a data URI', async () => {
    const dir = await tempDir()
    const iconPath = join(dir, 'icon.ico')
    await writeFile(iconPath, Buffer.from('ico-bytes'))
    expect(encodeIcon(iconPath)).toBe('data:image/ico;base64,aWNvLWJ5dGVz')
  })

  it('strips trailing ,0 before reading', async () => {
    const dir = await tempDir()
    const iconPath = join(dir, 'icon.png')
    await writeFile(iconPath, Buffer.from('bytes'))
    expect(encodeIcon(`${iconPath},0`)).toContain('data:image/png;base64,')
  })

  it('returns null for .exe files (no shell extraction)', () => {
    expect(encodeIcon('C:\\Windows\\notepad.exe')).toBeNull()
  })

  it('returns null when the file does not exist', () => {
    expect(encodeIcon('C:\\nonexistent\\icon.png')).toBeNull()
  })

  it('returns null when the path is null', () => {
    expect(encodeIcon(null)).toBeNull()
  })
})

describe('appInfoFromExePath', () => {
  it('derives name and null icon for a .exe', () => {
    expect(appInfoFromExePath('C:\\Program Files\\Discord\\Discord.exe')).toEqual({
      name: 'Discord',
      executable: 'C:\\Program Files\\Discord\\Discord.exe',
      icon: null,
      source: 'start-menu',
    })
  })
})

describe('listInstalledApps', () => {
  it('lists registry entries', () => {
    const apps = listInstalledApps(
      {
        startMenuProgramData: () => null,
        startMenuUser: () => null,
        readdir: () => [],
        registryRoots: () => ['HKLM\\Uninstall'],
        registrySubkeys: () => ['HKLM\\Uninstall\\Steam'],
        registryValues: () => ({ DisplayName: 'Steam', DisplayIcon: 'C:\\Steam\\icon.png,0' }),
        resolveShortcutTarget: () => null,
        encodeIcon: (path) => (path !== null ? `encoded:${path}` : null),
      },
      fakeRunner(),
    )
    expect(apps).toEqual([
      { name: 'Steam', executable: null, icon: 'encoded:C:\\Steam\\icon.png,0', source: 'registry' },
    ])
  })

  it('deduplicates start-menu entries whose name already exists in the registry', () => {
    const apps = listInstalledApps(
      {
        startMenuProgramData: () => join('start', 'menu', 'Programs'),
        startMenuUser: () => null,
        readdir: (dir) =>
          dir === join('start', 'menu', 'Programs')
            ? [join(dir, 'Discord.lnk')]
            : [],
        registryRoots: () => ['HKLM\\Uninstall'],
        registrySubkeys: () => ['HKLM\\Uninstall\\Discord'],
        registryValues: () => ({ DisplayName: 'Discord', UninstallString: 'C:\\Discord\\Discord.exe' }),
        resolveShortcutTarget: () => 'C:\\Discord\\Discord.exe',
        encodeIcon: () => null,
      },
      fakeRunner(),
    )
    expect(apps).toHaveLength(1)
    expect(apps[0]?.source).toBe('registry')
  })
})

describe('blockApp / unblockApp (challenge-gated mutations)', () => {
  let baseDir: string
  let runnerCalls: string[][]
  let fakeWinRunner: WindowsCommandRunner
  let fakeScanner: ProcessScanner
  let fakeProcKill: { mockRestore(): void }

  beforeEach(async () => {
    vi.useFakeTimers()
    baseDir = await tempDir()
    setAppBlockerBaseDir(baseDir)
    setAuditLogBaseDir(baseDir)
    runnerCalls = []
    fakeWinRunner = fakeRunner(runnerCalls)
    fakeScanner = {
      listProcesses: () => [],
    }
    fakeProcKill = vi.spyOn(process, 'kill').mockImplementation((() => true) as never)
  })

  afterEach(async () => {
    fakeProcKill.mockRestore()
    vi.useRealTimers()
    resetAppBlockerBaseDir()
    setAuditLogBaseDir(null)
  })

  it('rejects a token minted for the wrong action', async () => {
    const token = signChallengeToken('unblock_app')
    await expect(blockApp('C:\\App.exe', token)).rejects.toThrow(/minted for/)
  })

  it('rejects a non-.exe path', async () => {
    await expect(blockApp('C:\\App.txt', signChallengeToken('block_app'))).rejects.toThrow(/Not an executable/)
  })

  it('persists the entry, adds IFEO + firewall rules, and audits', async () => {
    await blockApp('C:\\Steam\\steam.exe', signChallengeToken('block_app'), {
      baseDir,
      runner: fakeWinRunner,
      scanner: fakeScanner,
    })

    const entries = readBlockedApps(baseDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: 'steam', exePath: 'C:\\Steam\\steam.exe' })

    expect(runnerCalls.some(([prog, ...args]) => prog === 'reg' && args.some((a) => a.includes('Image File Execution Options\\steam.exe')))).toBe(true)
    expect(runnerCalls.filter(([prog, ...args]) => prog === 'netsh' && args.includes('firewall') && args.includes('add'))).toHaveLength(2)

    const audit = await readFile(join(baseDir, 'audit.log'), 'utf8')
    expect(audit).toContain('"action":"block_app"')
    expect(audit).toContain('"name":"steam"')
  })

  it('deduplicates when the same exe path is already blocked', async () => {
    await blockApp('C:\\App.exe', signChallengeToken('block_app'), {
      baseDir,
      runner: fakeWinRunner,
      scanner: fakeScanner,
    })
    await blockApp('C:\\App.exe', signChallengeToken('block_app'), {
      baseDir,
      runner: fakeWinRunner,
      scanner: fakeScanner,
    })
    expect(readBlockedApps(baseDir)).toHaveLength(1)
  })

  it('removes an entry, deletes IFEO + firewall rules, and audits', async () => {
    await blockApp('C:\\App.exe', signChallengeToken('block_app'), {
      baseDir,
      runner: fakeWinRunner,
      scanner: fakeScanner,
    })
    await unblockApp('App', signChallengeToken('unblock_app'), { baseDir, runner: fakeWinRunner })

    expect(readBlockedApps(baseDir)).toEqual([])
    expect(runnerCalls.some(([prog, ...args]) => prog === 'reg' && args.includes('delete'))).toBe(true)
    expect(runnerCalls.some(([prog, ...args]) => prog === 'netsh' && args.includes('delete'))).toBe(true)

    const audit = await readFile(join(baseDir, 'audit.log'), 'utf8')
    expect(audit).toContain('"action":"unblock_app"')
    expect(audit).toContain('"name":"App"')
  })

  it('rejects removal of a name that is not currently blocked', async () => {
    await expect(unblockApp('Nope', signChallengeToken('unblock_app'))).rejects.toThrow(/No blocked app/)
  })
})

describe('process watcher', () => {
  it('kills a matching process and reports it via onKill', async () => {
    vi.useFakeTimers()
    const onKill = vi.fn()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never)
    const fakeScanner: ProcessScanner = {
      listProcesses: () => [{ pid: 42, name: 'steam.exe' }],
    }
    const watcher = createProcessWatcher({
      intervalMs: 500,
      scanner: fakeScanner,
      runner: fakeRunner(),
      getBlockedExeNames: () => ['steam.exe'],
      onKill,
    })

    watcher.start()
    expect(watcher.running).toBe(true)

    await vi.advanceTimersByTimeAsync(500)
    expect(onKill).toHaveBeenCalledWith({ name: 'steam.exe', pid: 42 })
    expect(killSpy).toHaveBeenCalledWith(42)

    watcher.stop()
    expect(watcher.running).toBe(false)
    killSpy.mockRestore()
    vi.useRealTimers()
  })

  it('writes a kill record to stats when a process is terminated', async () => {
    vi.useFakeTimers()
    const dir = await tempDir()
    const fakeScanner: ProcessScanner = {
      listProcesses: () => [{ pid: 99, name: 'Blocked.exe' }],
    }
    const watcher = createProcessWatcher({
      intervalMs: 500,
      scanner: fakeScanner,
      runner: fakeRunner(),
      getBlockedExeNames: () => ['blocked.exe'],
      onKill: ({ name, pid }) => logAppKill(dir, name, pid),
    })

    watcher.start()
    await vi.advanceTimersByTimeAsync(500)
    const stats = JSON.parse(await readFile(join(dir, 'app-blocker-stats.json'), 'utf8')) as Array<{ process: string; pid: number }>
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({ process: 'Blocked.exe', pid: 99 })
    watcher.stop()
    vi.useRealTimers()
  })

  it('does nothing when the block list is empty', async () => {
    vi.useFakeTimers()
    const onKill = vi.fn()
    const watcher = createProcessWatcher({
      intervalMs: 500,
      getBlockedExeNames: async () => [],
      onKill,
    })
    watcher.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(onKill).not.toHaveBeenCalled()
    watcher.stop()
    vi.useRealTimers()
  })

  it('ignores processes whose name is not in the block list', async () => {
    vi.useFakeTimers()
    const onKill = vi.fn()
    const watcher = createProcessWatcher({
      intervalMs: 500,
      scanner: { listProcesses: () => [{ pid: 1, name: 'notepad.exe' }] },
      getBlockedExeNames: async () => ['steam.exe'],
      onKill,
    })
    watcher.start()
    await vi.advanceTimersByTimeAsync(500)
    expect(onKill).not.toHaveBeenCalled()
    watcher.stop()
    vi.useRealTimers()
  })
})

describe('pickApp', () => {
  it('throws when no picker is registered', async () => {
    await expect(pickApp()).rejects.toThrow(/No app picker/)
  })
})

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})