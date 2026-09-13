import { pbkdf2 as pbkdf2Callback, randomBytes, createCipheriv } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { auditLog } from './audit-log'
import { verifyTokenForAction } from './challenge-token'
import { defaultSettings, type AppSettings } from './settings'

const pbkdf2 = promisify(pbkdf2Callback)
const PBKDF2_ITERATIONS = 310_000

export type ExportFormat = 'txt' | 'csv' | 'json' | 'hosts'

export interface ExportMetadata {
  version: '1.0'
  exported_at: string
  patterns: string[]
  apps: string[]
  categories: unknown[]
  rules: unknown[]
  settings: AppSettings
}

export interface EncryptedBackup {
  version: '1.0'
  algorithm: 'aes-256-gcm'
  kdf: 'pbkdf2-sha512'
  iterations: number
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

let configuredBaseDir: string | null = null

/** Configure the user-data location during desktop startup. */
export function setExportBaseDir(baseDir: string): void { configuredBaseDir = baseDir }
export function resetExportBaseDir(): void { configuredBaseDir = null }

function baseDir(): string {
  if (configuredBaseDir === null) throw new Error('Export data directory is not configured.')
  return configuredBaseDir
}

async function readText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asCategories(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value as Record<string, unknown>).map(([id, category]) => ({ id, ...(typeof category === 'object' && category !== null ? category : { value: category }) }))
}

/** Reads a portable snapshot of all user-configured protection data. */
export async function collectExportData(): Promise<ExportMetadata> {
  const dir = baseDir()
  const [patternsText, apps, categories, presetCategories, rules, settings] = await Promise.all([
    readText(join(dir, 'blocklist.txt')),
    readJson(join(dir, 'blocked-apps.json')),
    readJson(join(dir, 'categories.json')),
    readJson(join(dir, 'category-presets.json')),
    readJson(join(dir, 'focus-rules.json')),
    readJson(join(dir, 'settings.json')),
  ])
  const patterns = patternsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  const allCategories = [...asCategories(categories), ...asCategories(presetCategories)]
  const normalizedSettings: AppSettings = typeof settings === 'object' && settings !== null && (settings as { silent_mode?: unknown }).silent_mode === true ? { silent_mode: true } : defaultSettings()
  return { version: '1.0', exported_at: new Date().toISOString(), patterns, apps: stringArray(apps), categories: allCategories, rules: Array.isArray(rules) ? rules : [], settings: normalizedSettings }
}

function categoryFor(pattern: string, categories: unknown[]): string {
  for (const category of categories) {
    if (typeof category !== 'object' || category === null) continue
    const record = category as { id?: unknown; domains?: unknown }
    if (Array.isArray(record.domains) && record.domains.includes(pattern)) return typeof record.id === 'string' ? record.id : ''
  }
  return ''
}

function csvEscape(value: string): string { return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value }

function serialize(data: ExportMetadata, format: ExportFormat): string {
  switch (format) {
    case 'txt': return data.patterns.length === 0 ? '' : `${data.patterns.join('\n')}\n`
    case 'hosts': return data.patterns.map((pattern) => `0.0.0.0 ${pattern}`).join('\n') + (data.patterns.length ? '\n' : '')
    case 'csv': return ['domain,category', ...data.patterns.map((pattern) => `${csvEscape(pattern)},${csvEscape(categoryFor(pattern, data.categories))}`)].join('\n') + '\n'
    case 'json': return `${JSON.stringify(data, null, 2)}\n`
  }
}

async function writeAtomically(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

function requireExportToken(token: string): void { verifyTokenForAction(token, 'export') }

/** Exports current protection data as TXT, CSV, JSON, or a hosts file. */
export async function exportData(format: ExportFormat, path: string, token: string): Promise<void> {
  try {
    requireExportToken(token)
    if (path.trim() === '') throw new Error('Export path must not be empty.')
    const data = await collectExportData()
    await writeAtomically(path, serialize(data, format))
    auditLog('export', true, { format, patterns: data.patterns.length, path })
  } catch (error) {
    auditLog('export', false, { format, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** Exports a password-encrypted JSON backup using AES-256-GCM and PBKDF2-SHA-512. */
export async function exportEncrypted(path: string, password: string, token: string): Promise<void> {
  try {
    requireExportToken(token)
    if (path.trim() === '') throw new Error('Export path must not be empty.')
    if (password.length === 0) throw new Error('Backup password must not be empty.')
    const data = await collectExportData()
    const salt = randomBytes(16); const iv = randomBytes(12)
    const key = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, 'sha512')
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
    const backup: EncryptedBackup = { version: '1.0', algorithm: 'aes-256-gcm', kdf: 'pbkdf2-sha512', iterations: PBKDF2_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    await writeAtomically(path, `${JSON.stringify(backup, null, 2)}\n`)
    auditLog('export', true, { format: 'encrypted', patterns: data.patterns.length, path })
  } catch (error) {
    auditLog('export', false, { format: 'encrypted', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** Builds a portable JSON sync payload for transfer to another FocusLock device. */
export async function generateSyncFile(token: string): Promise<Buffer> {
  try {
    requireExportToken(token)
    const data = await collectExportData()
    const sync = { sync_format: 'focuslock-sync', ...data }
    const result = Buffer.from(`${JSON.stringify(sync, null, 2)}\n`, 'utf8')
    auditLog('export', true, { format: 'sync', patterns: data.patterns.length })
    return result
  } catch (error) {
    auditLog('export', false, { format: 'sync', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
