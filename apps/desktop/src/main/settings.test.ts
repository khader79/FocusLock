import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultSettings,
  isSilentMode,
  readSettings,
  settingsFilePath,
  writeSettings,
} from './settings'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-settings-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('settingsFilePath', () => {
  it('places settings.json inside the given user data directory', () => {
    expect(settingsFilePath('C:\\Users\\me\\AppData\\Roaming\\focuslock')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\focuslock\\settings.json',
    )
  })
})

describe('readSettings / writeSettings', () => {
  it('round-trips a silent_mode value', async () => {
    const dir = await tempDir()
    const path = settingsFilePath(dir)
    await writeSettings(path, { silent_mode: true })
    expect(await readSettings(path)).toEqual({ silent_mode: true })
  })

  it('defaults to silent_mode off when the file is missing', async () => {
    const dir = await tempDir()
    expect(await readSettings(settingsFilePath(dir))).toEqual(defaultSettings())
  })

  it('falls back to defaults on invalid JSON', async () => {
    const dir = await tempDir()
    const path = settingsFilePath(dir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{not json', 'utf8')
    expect(await readSettings(path)).toEqual(defaultSettings())
  })

  it('ignores non-boolean silent_mode values', async () => {
    const dir = await tempDir()
    const path = settingsFilePath(dir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{"silent_mode": "yes"}', 'utf8')
    expect(await readSettings(path)).toEqual({ silent_mode: false })
  })
})

describe('isSilentMode', () => {
  it('reports the silent mode flag', () => {
    expect(isSilentMode({ silent_mode: true })).toBe(true)
    expect(isSilentMode({ silent_mode: false })).toBe(false)
    expect(isSilentMode(defaultSettings())).toBe(false)
  })
})