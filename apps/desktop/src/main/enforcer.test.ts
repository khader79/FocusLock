import { writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enforcerDataPaths, startEnforcer, type EnforcerDataPaths } from './enforcer'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-enforcer-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('enforcerDataPaths', () => {
  it('derives every data file path from the userData directory', () => {
    const paths = enforcerDataPaths('C:\\Users\\me\\AppData\\Roaming\\focuslock')
    expect(paths).toEqual({
      blocklistPath: 'C:\\Users\\me\\AppData\\Roaming\\focuslock\\blocklist.txt',
      categoriesPath: 'C:\\Users\\me\\AppData\\Roaming\\focuslock\\categories.json',
      rulesPath: 'C:\\Users\\me\\AppData\\Roaming\\focuslock\\dns-rules.json',
      statsPath: 'C:\\Users\\me\\AppData\\Roaming\\focuslock\\dns-stats.json',
    })
  })
})

describe('startEnforcer', () => {
  async function seed(paths: EnforcerDataPaths, blocklist = ''): Promise<void> {
    await writeFile(paths.blocklistPath, blocklist, 'utf8')
    await writeFile(paths.categoriesPath, '{}', 'utf8')
    await writeFile(paths.rulesPath, JSON.stringify({ enabled: false }), 'utf8')
  }

  it('writes the hosts block from the blocklist and DNS rules when enabled', async () => {
    const dir = await tempDir()
    const paths = enforcerDataPaths(dir)
    await seed(paths, 'example.com\nyoutube.com\n')

    const applyHosts = vi.fn(async () => undefined)
    const handle = await startEnforcer(dir, {
      applyHosts,
      isDnsEnabled: async () => false,
    })
    handle.stop()

    expect(applyHosts).toHaveBeenCalledWith(['example.com', 'youtube.com'])
  })

  it('re-applies hosts when the blocklist file changes between syncs', async () => {
    const dir = await tempDir()
    const paths = enforcerDataPaths(dir)
    await seed(paths, 'example.com\n')

    const applyHosts = vi.fn(async () => undefined)
    const handle = await startEnforcer(dir, {
      applyHosts,
      isDnsEnabled: async () => false,
      loadRules: async () => ({
        exact: [],
        wildcards: [],
        regexes: [],
        keywords: [],
        exceptions: { exact: [], wildcards: [], keywords: [] },
      }),
    })

    await writeFile(paths.blocklistPath, 'example.com\nblocked.dev\n', 'utf8')
    await handle.sync()
    handle.stop()

    expect(applyHosts).toHaveBeenLastCalledWith(['example.com', 'blocked.dev'])
  })

  it('keeps previous hosts when the blocklist is unchanged', async () => {
    const dir = await tempDir()
    const paths = enforcerDataPaths(dir)
    await seed(paths, 'example.com\n')

    const applyHosts = vi.fn(async () => undefined)
    const handle = await startEnforcer(dir, {
      applyHosts,
      isDnsEnabled: async () => false,
    })

    await handle.sync()
    handle.stop()

    expect(applyHosts).toHaveBeenCalledTimes(1)
  })
})