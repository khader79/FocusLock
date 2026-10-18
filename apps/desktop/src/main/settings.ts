import { readFile, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'
import { join } from 'node:path'

/**
 * Persisted app settings (settings.json in the user data directory). The file
 * is a flat JSON object of booleans; currently only `silent_mode` exists.
 */

export interface AppSettings {
  /** Hides the tray icon, notifications and sounds when true. */
  silent_mode: boolean
}

export function defaultSettings(): AppSettings {
  return { silent_mode: false }
}

export function settingsFilePath(userDataDir: string): string {
  return join(userDataDir, 'settings.json')
}

export async function readSettings(path: string): Promise<AppSettings> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return defaultSettings()
    }
    const silentMode = (parsed as Record<string, unknown>)['silent_mode']
    return { silent_mode: silentMode === true }
  } catch {
    return defaultSettings()
  }
}

export async function writeSettings(path: string, settings: AppSettings): Promise<void> {
  await writeFile(path, JSON.stringify(settings, null, 2) + EOL, 'utf8')
}

export function isSilentMode(settings: AppSettings): boolean {
  return settings.silent_mode === true
}