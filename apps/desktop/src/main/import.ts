import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { auditLog } from './audit-log'
import { verifyTokenForAction } from './challenge-token'

export type ImportFormat = 'txt' | 'csv' | 'json' | 'hosts'

export interface ImportEntry {
  domain: string
  category?: string
  source?: string
}

export interface ParsedData {
  entries: ImportEntry[]
  format: ImportFormat
  warnings: string[]
}

export interface ValidationResult {
  valid: ImportEntry[]
  invalid: Array<{ entry: ImportEntry; reason: string }>
  duplicates: string[]
}

export interface PreviewRow {
  domain: string
  category: string
  valid: boolean
  reason?: string
}

export interface ImportResult {
  added: number
  duplicates: number
  invalid: number
  total: number
}

export interface ImportProgress {
  phase: 'parsing' | 'validating' | 'importing' | 'complete'
  current: number
  total: number
}

export interface ImportOptions {
  baseDir?: string
  onProgress?: (progress: ImportProgress) => void
}

let configuredBaseDir: string | null = null
let onImported: (() => Promise<void> | void) | null = null

/** Configure the app data location once Electron has resolved userData. */
export function setImportBaseDir(baseDir: string): void { configuredBaseDir = baseDir }
export function resetImportBaseDir(): void { configuredBaseDir = null }
/** Lets the desktop bootstrap rebuild DNS/hosts rules after a successful import. */
export function setImportEffects(callback: (() => Promise<void> | void) | null): void { onImported = callback }

function emit(options: ImportOptions | undefined, phase: ImportProgress['phase'], current: number, total: number): void {
  options?.onProgress?.({ phase, current, total })
}

function resolveBaseDir(options?: ImportOptions): string {
  const baseDir = options?.baseDir ?? configuredBaseDir
  if (baseDir === null || baseDir === undefined) throw new Error('Import data directory is not configured.')
  return baseDir
}

function formatFromPath(path: string): ImportFormat {
  const extension = extname(path).toLowerCase()
  if (extension === '.txt') return 'txt'
  if (extension === '.csv') return 'csv'
  if (extension === '.json') return 'json'
  if (extension === '.hosts' || extension === '') return 'hosts'
  throw new Error(`Unsupported import format: "${extension}".`)
}

/** Reads and parses a .txt, .csv, .json, or .hosts file. */
export async function parseFile(path: string, format: ImportFormat = formatFromPath(path), options?: ImportOptions): Promise<ParsedData> {
  const content = await readFile(path, 'utf8')
  return parseText(content, format, options)
}

/** Parses a pasted blocklist without requiring a temporary file. */
export function parseBulkPaste(text: string, options?: ImportOptions): ParsedData {
  return parseText(text, 'txt', options)
}

/** Fetches an HTTP(S) blocklist then parses it using its URL extension (or TXT). */
export async function parseUrl(url: string, options?: ImportOptions): Promise<ParsedData> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Blocklist URL must use HTTP or HTTPS.')
  const response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Could not fetch blocklist: HTTP ${response.status}.`)
  const content = await response.text()
  if (content.length > 20 * 1024 * 1024) throw new Error('Blocklist is larger than 20 MB.')
  let format: ImportFormat = 'txt'
  try { format = formatFromPath(parsed.pathname) } catch { /* extensionless URLs are plain lists */ }
  return parseText(content, format, options)
}

/** Reads supported exports beneath Cold Turkey's shared ProgramData directory. */
export async function parseColdTurkeyExports(
  directory = 'C:\\ProgramData\\Cold Turkey',
  options?: ImportOptions,
): Promise<ParsedData> {
  const files = await collectExportFiles(directory)
  const entries: ImportEntry[] = []
  const warnings: string[] = []
  for (let index = 0; index < files.length; index += 1) {
    const path = files[index]!
    emit(options, 'parsing', index, files.length)
    try {
      const parsed = await parseFile(path, undefined, options)
      entries.push(...parsed.entries.map((entry) => ({ ...entry, source: 'Cold Turkey' })))
      warnings.push(...parsed.warnings.map((warning) => `${path}: ${warning}`))
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : 'could not parse file'}`)
    }
  }
  emit(options, 'parsing', files.length, files.length)
  return { entries, format: 'txt', warnings }
}

async function collectExportFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectExportFiles(path)))
    else if (entry.isFile() && ['.txt', '.csv', '.json', '.hosts'].includes(extname(entry.name).toLowerCase())) files.push(path)
  }
  return files
}

function parseText(content: string, format: ImportFormat, options?: ImportOptions): ParsedData {
  const warnings: string[] = []
  let entries: ImportEntry[]
  switch (format) {
    case 'csv': entries = parseCsv(content, warnings); break
    case 'json': entries = parseJson(content, warnings); break
    case 'hosts': entries = parseHosts(content, warnings); break
    case 'txt': entries = parseTxt(content); break
  }
  emit(options, 'parsing', entries.length, entries.length)
  return { entries, format, warnings }
}

function parseTxt(content: string): ImportEntry[] {
  return content.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean).map((domain) => ({ domain }))
}

function parseHosts(content: string, warnings: string[]): ImportEntry[] {
  const output: ImportEntry[] = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const fields = line.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean)
    if (fields.length < 2 || !/^(0\.0\.0\.0|127\.0\.0\.1|::1)$/.test(fields[0]!)) continue
    for (const domain of fields.slice(1)) {
      if (domain === 'localhost' || domain === 'localhost.localdomain') continue
      output.push({ domain })
    }
    if (fields.length > 2) warnings.push(`Line ${index + 1} contains multiple hostnames.`)
  }
  return output
}

function parseCsv(content: string, warnings: string[]): ImportEntry[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.flatMap((line, index) => {
    const fields = splitCsv(line)
    if (index === 0 && fields[0]?.trim().toLowerCase() === 'domain') return []
    if (fields.length < 1 || fields[0]!.trim() === '') { warnings.push(`Line ${index + 1} has no domain.`); return [] }
    return [{ domain: fields[0]!.trim(), category: fields[1]?.trim() || undefined }]
  })
}

function splitCsv(line: string): string[] {
  const fields: string[] = []; let field = ''; let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (char === '"' && line[index + 1] === '"') { field += '"'; index += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) { fields.push(field); field = '' }
    else field += char
  }
  fields.push(field); return fields
}

function parseJson(content: string, warnings: string[]): ImportEntry[] {
  const value: unknown = JSON.parse(content)
  if (Array.isArray(value)) return value.flatMap(toEntry)
  if (typeof value !== 'object' || value === null) throw new Error('JSON import must be an array or FocusLock export object.')
  const data = value as Record<string, unknown>
  const entries: ImportEntry[] = []
  if (Array.isArray(data.entries)) entries.push(...data.entries.flatMap(toEntry))
  if (Array.isArray(data.blockedDomains)) entries.push(...data.blockedDomains.filter((domain): domain is string => typeof domain === 'string').map((domain) => ({ domain })))
  if (Array.isArray(data.blockedSites)) entries.push(...data.blockedSites.flatMap(toEntry))
  if (data.categories && typeof data.categories === 'object') {
    for (const [category, record] of Object.entries(data.categories as Record<string, unknown>)) {
      const domains = (record as { domains?: unknown })?.domains
      if (Array.isArray(domains)) entries.push(...domains.filter((domain): domain is string => typeof domain === 'string').map((domain) => ({ domain, category })))
    }
  }
  if (entries.length === 0) warnings.push('No blocklist entries were found in the JSON export.')
  return entries
}

function toEntry(value: unknown): ImportEntry[] {
  if (typeof value === 'string') return [{ domain: value }]
  if (typeof value === 'object' && value !== null && typeof (value as { domain?: unknown }).domain === 'string') {
    const entry = value as { domain: string; category?: unknown }
    return [{ domain: entry.domain, category: typeof entry.category === 'string' ? entry.category : undefined }]
  }
  return []
}

function normalizeDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/\.+$/, '')
  try { if (domain.includes('://')) domain = new URL(domain).hostname.toLowerCase().replace(/^www\./, '') } catch { return null }
  if (domain.length > 253 || !domain.includes('.') || /[^a-z0-9.-]/.test(domain) || domain.split('.').some((label) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return null
  return domain
}

/** Normalizes entries and reports malformed and duplicate values without mutating anything. */
export function validateEntries(entries: ImportEntry[], options?: ImportOptions): ValidationResult {
  const valid: ImportEntry[] = []; const invalid: ValidationResult['invalid'] = []; const duplicates: string[] = []; const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const domain = normalizeDomain(entry.domain)
    if (domain === null) invalid.push({ entry, reason: 'Invalid domain.' })
    else if (seen.has(domain)) duplicates.push(domain)
    else { seen.add(domain); valid.push({ ...entry, domain }) }
    emit(options, 'validating', index + 1, entries.length)
  })
  return { valid, invalid, duplicates }
}

/** Produces a UI-safe sample of normalized import rows. */
export function previewImport(entries: ImportEntry[], limit = 100): PreviewRow[] {
  return entries.slice(0, Math.max(0, limit)).map((entry) => {
    const domain = normalizeDomain(entry.domain)
    return { domain: domain ?? entry.domain, category: entry.category ?? 'غير مصنّف', valid: domain !== null, ...(domain === null ? { reason: 'نطاق غير صالح' } : {}) }
  })
}

async function readDomains(baseDir: string): Promise<string[]> {
  try { return (await readFile(join(baseDir, 'blocklist.txt'), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } catch { return [] }
}

async function writeDomainsTransaction(baseDir: string, domains: string[]): Promise<void> {
  const target = join(baseDir, 'blocklist.txt'); const temp = `${target}.import-tmp`
  await writeFile(temp, `${domains.join('\n')}${domains.length ? '\n' : ''}`, 'utf8')
  await rename(temp, target)
}

/**
 * Commits valid, de-duplicated domains atomically. The token must be minted
 * for `import_entries`; a failed validation or write leaves blocklist.txt intact.
 */
export async function importEntries(entries: ImportEntry[], token: string, options?: ImportOptions): Promise<ImportResult> {
  try {
    verifyTokenForAction(token, 'import_entries')
    const validation = validateEntries(entries, options)
    const baseDir = resolveBaseDir(options); const existing = await readDomains(baseDir); const seen = new Set(existing.map((domain) => domain.toLowerCase()))
    const additions = validation.valid.filter((entry) => !seen.has(entry.domain) && (seen.add(entry.domain), true))
    emit(options, 'importing', 0, additions.length)
    await writeDomainsTransaction(baseDir, [...existing, ...additions.map((entry) => entry.domain)])
    emit(options, 'importing', additions.length, additions.length)
    await onImported?.()
    const result = { added: additions.length, duplicates: validation.duplicates.length + validation.valid.length - additions.length, invalid: validation.invalid.length, total: entries.length }
    auditLog('import_entries', true, result); emit(options, 'complete', result.total, result.total)
    return result
  } catch (error) {
    auditLog('import_entries', false, { error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
