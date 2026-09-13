import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export const DAILY_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

// Prefer the biggest lists first so bootstrap makes progress in a sensible
// order. Expected counts are the round figures advertised per list.
export interface CategoryPreset {
  id: string
  name_ar: string
  name_en: string
  url: string
  expected_count: number
  color: string
  icon: string
}

export const CATEGORY_PRESETS: CategoryPreset[] = [
  {
    id: 'porn',
    name_ar: 'محتوى إباحي',
    name_en: 'Adult Content',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/nsfw.txt',
    expected_count: 800_000,
    color: '#e74c3c',
    icon: '🔞',
  },
  {
    id: 'gambling',
    name_ar: 'قمار',
    name_en: 'Gambling',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/gambling.txt',
    expected_count: 150_000,
    color: '#f39c12',
    icon: '🎰',
  },
  {
    id: 'ads',
    name_ar: 'الإعلانات',
    name_en: 'Advertisements',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt',
    expected_count: 100_000,
    color: '#9b59b6',
    icon: '📢',
  },
  {
    id: 'social',
    name_ar: 'وسائل التواصل الاجتماعي',
    name_en: 'Social Media',
    url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/social.txt',
    expected_count: 30_000,
    color: '#3498db',
    icon: '💬',
  },
  ]

export interface CategoryState {
  enabled: boolean
  /** ISO timestamp of the last successful download. */
  lastUpdatedAt?: string
  /** Server Last-Modified header, replayed as If-Modified-Since. */
  lastModified?: string
  /** Unique domains written to the list file on the last download. */
  count?: number
}

export type CategoryStateFile = Record<string, CategoryState>

/** Presets enabled on a first run (safe, non-sensitive categories only). */
export const DEFAULT_ENABLED_PRESETS: readonly string[] = ['ads', 'social']

export function findPreset(id: string): CategoryPreset | undefined {
  return CATEGORY_PRESETS.find((preset) => preset.id === id)
}

// --- Paths -------------------------------------------------------------------

export function categoryStateFilePath(baseDir: string): string {
  return join(baseDir, 'category-presets.json')
}

export function categoryListsDir(baseDir: string): string {
  return join(baseDir, 'category-lists')
}

export function categoryListPath(baseDir: string, id: string): string {
  return join(categoryListsDir(baseDir), `${id}.txt`)
}

// --- State file ---------------------------------------------------------------

export async function categoryStateExists(baseDir: string): Promise<boolean> {
  try {
    await readFile(categoryStateFilePath(baseDir), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function readCategoryState(baseDir: string): Promise<CategoryStateFile> {
  try {
    const raw = await readFile(categoryStateFilePath(baseDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as CategoryStateFile
    }
    return {}
  } catch {
    return {}
  }
}

/** Writes the state file atomically (tmp file + rename). */
export async function writeCategoryState(baseDir: string, state: CategoryStateFile): Promise<void> {
  const target = categoryStateFilePath(baseDir)
  const tmpPath = `${target}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmpPath, target)
}

/**
 * Reads the plain-domain list files of every enabled preset AND enabled custom
 * category, then merges them into one deduplicated array. Fed into the DNS
 * matcher through loadDnsRules.
 */
export async function readEnabledPresetDomains(baseDir: string): Promise<string[]> {
  const state = await readCategoryState(baseDir)
  const customs = await readCustomCategories(baseDir)
  const domains = new Set<string>()

  for (const preset of CATEGORY_PRESETS) {
    if (!state[preset.id]?.enabled) {
      continue
    }
    try {
      await appendListFile(categoryListPath(baseDir, preset.id), domains)
    } catch {
      // Missing/unreadable list file: the preset is enabled but not yet
      // downloaded, so it contributes nothing.
    }
  }

  for (const custom of customs) {
    if (!custom.enabled) {
      continue
    }
    try {
      await appendListFile(categoryListPath(baseDir, custom.id), domains)
    } catch {
      // Same tolerance for a custom category whose list has not landed yet.
    }
  }

  return [...domains]
}

async function appendListFile(filePath: string, domains: Set<string>): Promise<void> {
  const raw = await readFile(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const entry = normalizeEntry(line)
    if (entry !== '') {
      domains.add(entry)
    }
  }
}

/** Normalizes one source line to a bare lowercase domain, or '' if unusable. */
export function normalizeEntry(line: string): string {
  const trimmed = line.trim().toLowerCase().replace(/\.+$/, '')
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.includes(' ') || trimmed.includes('\t')) {
    return ''
  }
  return trimmed
}

// --- Download ----------------------------------------------------------------

export type DownloadStatus = 'ok' | 'not-modified' | 'error'

export interface DownloadResult {
  status: DownloadStatus
  /** Unique domains written to disk (only when status === 'ok'). */
  count?: number
  /** Bytes received from the server (only when status === 'ok'). */
  bytes?: number
  /** Server Last-Modified header to replay next time (only when status === 'ok'). */
  lastModified?: string
  error?: string
}

export type CategoryProgressPhase = 'start' | 'download' | 'done'

export interface CategoryProgress {
  presetId: string
  phase: CategoryProgressPhase
  receivedBytes: number
  domains: number
}

export interface DownloadCategoryOptions {
  /** HTTP Last-Modified from a previous run, sent as If-Modified-Since. */
  lastModified?: string
  onProgress?: (progress: CategoryProgress) => void
}

function httpsGet(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => resolve(res))
    req.on('error', reject)
  })
}

/** Writes one line, waiting for the write buffer to drain when full. */
function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (stream.write(line)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => stream.once('drain', resolve))
}

/**
 * Streams a preset's raw list to `<targetPath>` line by line (never buffering
 * the whole body), deduplicating as it goes, then atomically renames the temp
 * file over the target. The previous target is untouched until the full body
 * has downloaded and validated.
 */
export async function downloadCategoryList(
  preset: CategoryPreset,
  targetPath: string,
  options: DownloadCategoryOptions = {},
): Promise<DownloadResult> {
  const headers: Record<string, string> = {}
  if (options.lastModified) {
    headers['If-Modified-Since'] = options.lastModified
  }

  let res: IncomingMessage
  try {
    res = await httpsGet(preset.url, headers)
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }

  if (res.statusCode === 304) {
    res.resume()
    return { status: 'not-modified' }
  }
  if (res.statusCode !== 200) {
    res.resume()
    const code = res.statusCode ?? 0
    if (code >= 300 && code < 400) {
      return { status: 'error', error: `Unexpected redirect (HTTP ${code}) for "${preset.url}".` }
    }
    return { status: 'error', error: `HTTP ${code} for "${preset.url}".` }
  }

  const tmpPath = `${targetPath}.tmp`
  const seen = new Set<string>()
  let receivedBytes = 0
  let linesProcessed = 0

  try {
    await mkdir(join(targetPath, '..'), { recursive: true })
    const out = createWriteStream(tmpPath)

    res.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length
    })

    const report = (phase: CategoryProgressPhase): void => {
      options.onProgress?.({
        presetId: preset.id,
        phase,
        receivedBytes,
        domains: seen.size,
      })
    }

    report('start')

    const rl = createInterface({ input: res, crlfDelay: Infinity })
    for await (const line of rl) {
      linesProcessed += 1
      const entry = normalizeEntry(line)
      if (entry !== '' && !seen.has(entry)) {
        seen.add(entry)
        await writeLine(out, `${entry}\n`)
      }
      if (linesProcessed % 10_000 === 0) {
        report('download')
      }
    }

    out.end()
    await new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve())
      out.on('error', (err) => reject(err))
    })

    await rename(tmpPath, targetPath)
    report('done')

    return {
      status: 'ok',
      count: seen.size,
      bytes: receivedBytes,
      lastModified: res.headers['last-modified'],
    }
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    return { status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

// --- High-level category operations ------------------------------------------

export interface CategoryOps {
  baseDir?: string
  onRulesChanged?: () => Promise<void>
  onProgress?: (preset: CategoryPreset, progress: CategoryProgress) => void
}

let defaultBaseDir: string | undefined

/** Sets the default data directory (the GUI's userData dir at startup). */
export function setCategoryBaseDir(baseDir: string): void {
  defaultBaseDir = baseDir
}

/** Clears the default data directory. Intended for tests. */
export function resetCategoryBaseDir(): void {
  defaultBaseDir = undefined
}

function resolveBaseDir(baseDir: string | undefined): string {
  if (baseDir !== undefined && baseDir !== '') {
    return baseDir
  }
  if (defaultBaseDir !== undefined) {
    return defaultBaseDir
  }
  throw new Error('Category data directory is not set. Call setCategoryBaseDir() or pass options.baseDir.')
}

/**
 * Downloads a preset by id and swaps the list file. On success it persists the
 * new state (timestamp + Last-Modified) and, when the preset is enabled,
 * triggers onRulesChanged to rebuild the DNS matcher.
 */
export async function updateCategory(id: string, options: CategoryOps = {}): Promise<DownloadResult> {
  const baseDir = resolveBaseDir(options.baseDir)
  const preset = findPreset(id)
  if (preset === undefined) {
    throw new Error(`Unknown category preset: "${id}".`)
  }

  const state = await readCategoryState(baseDir)
  const previous = state[id]

  const result = await downloadCategoryList(
    preset,
    categoryListPath(baseDir, id),
    {
      lastModified: previous?.lastModified,
      onProgress: (progress) => options.onProgress?.(preset, progress),
    },
  )

  if (result.status === 'ok') {
    state[id] = {
      ...previous,
      enabled: previous?.enabled ?? false,
      lastUpdatedAt: new Date().toISOString(),
      lastModified: result.lastModified,
      count: result.count,
    }
    await writeCategoryState(baseDir, state)
    if (state[id]?.enabled) {
      await options.onRulesChanged?.()
    }
  } else if (result.status === 'error') {
    throw new Error(`Failed to update category "${id}": ${result.error}`)
  }

  return result
}

/**
 * Enables a category after a verified challenge token: downloads its list
 * (if not current), flips the flag and rebuilds the matcher. The token itself
 * is validated by the protected-action layer before this runs.
 */
export async function enableCategory(
  id: string,
  _challengeToken: string,
  options: CategoryOps = {},
): Promise<void> {
  const baseDir = resolveBaseDir(options.baseDir)
  const preset = findPreset(id)
  if (preset === undefined) {
    throw new Error(`Unknown category preset: "${id}".`)
  }

  const state = await readCategoryState(baseDir)
  const current = state[id]

  // If we already have a downloaded list, just flip the flag and reapply.
  const result =
    current?.lastUpdatedAt !== undefined
      ? await updateCategory(id, options)
      : await downloadCategoryList(
          preset,
          categoryListPath(baseDir, id),
          { onProgress: (progress) => options.onProgress?.(preset, progress) },
        )

  if (result.status === 'error') {
    throw new Error(`Failed to enable category "${id}": ${result.error}`)
  }

  state[id] = {
    enabled: true,
    lastUpdatedAt: current?.lastUpdatedAt ?? new Date().toISOString(),
    lastModified: result.lastModified ?? current?.lastModified,
    count: result.count ?? current?.count,
  }
  await writeCategoryState(baseDir, state)
  await options.onRulesChanged?.()
}

/**
 * Disables a category after a verified challenge token: keeps the downloaded
 * list on disk (so it can re-enable instantly) but removes its patterns from
 * the matcher.
 */
export async function disableCategory(
  id: string,
  _challengeToken: string,
  options: CategoryOps = {},
): Promise<void> {
  const baseDir = resolveBaseDir(options.baseDir)
  if (findPreset(id) === undefined) {
    throw new Error(`Unknown category preset: "${id}".`)
  }

  const state = await readCategoryState(baseDir)
  if (state[id] === undefined || !state[id]?.enabled) {
    return
  }

  state[id] = { ...state[id], enabled: false }
  await writeCategoryState(baseDir, state)
  await options.onRulesChanged?.()
}

/** Re-downloads every enabled preset and rebuilds the matcher afterwards. */
export async function refreshEnabledCategories(options: CategoryOps = {}): Promise<void> {
  const baseDir = resolveBaseDir(options.baseDir)
  const state = await readCategoryState(baseDir)
  const enabledIds = CATEGORY_PRESETS.filter((preset) => state[preset.id]?.enabled).map(
    (preset) => preset.id,
  )

  for (const id of enabledIds) {
    await updateCategory(id, { ...options, baseDir })
  }
}

/**
 * First-run bootstrap: initializes the preset state (default-enabled set),
 * downloads every enabled preset's list, then rebuilds the matcher.
 * Subsequent calls only top up lists that are still missing.
 */
export async function bootstrapCategories(options: CategoryOps = {}): Promise<void> {
  const baseDir = resolveBaseDir(options.baseDir)
  const isFirstRun = !(await categoryStateExists(baseDir))

  if (isFirstRun) {
    const state: CategoryStateFile = {}
    for (const preset of CATEGORY_PRESETS) {
      state[preset.id] = { enabled: DEFAULT_ENABLED_PRESETS.includes(preset.id) }
    }
    await writeCategoryState(baseDir, state)
  }

  const state = await readCategoryState(baseDir)
  for (const preset of CATEGORY_PRESETS) {
    if (!state[preset.id]?.enabled) {
      continue
    }
    // First run always downloads; on later boots skip presets whose list file
    // already exists (the daily updater keeps them fresh). The matcher is
    // rebuilt exactly once, after all downloads complete.
    if (isFirstRun || state[preset.id]?.lastUpdatedAt === undefined) {
      await updateCategory(preset.id, { baseDir, onProgress: options.onProgress })
    }
  }

  await options.onRulesChanged?.()
}

/**
 * Schedules a background refresh of every enabled preset every 24h. Returns a
 * handle to stop the timer.
 */
export function scheduleDailyUpdate(options: CategoryOps = {}): { stop: () => void } {
  const timer = setInterval(() => {
    void refreshEnabledCategories(options).catch((err) => {
      console.error('[categories] daily update failed:', err)
    })
  }, DAILY_UPDATE_INTERVAL_MS)

  return {
    stop: () => clearInterval(timer),
  }
}

// --- Custom categories ---------------------------------------------------------

export interface CustomCategory {
  id: string
  name: string
  url: string
  color: string
  icon: string
  enabled: boolean
  lastUpdatedAt?: string
  lastModified?: string
  count?: number
}

export interface AddCustomCategoryInput {
  name: string
  url: string
  color: string
}

export function customCategoriesFilePath(baseDir: string): string {
  return join(baseDir, 'custom-categories.json')
}

export async function readCustomCategories(baseDir: string): Promise<CustomCategory[]> {
  try {
    const raw = await readFile(customCategoriesFilePath(baseDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CustomCategory[]) : []
  } catch {
    return []
  }
}

/** Writes the custom categories array atomically (tmp file + rename). */
export async function writeCustomCategories(
  baseDir: string,
  categories: CustomCategory[],
): Promise<void> {
  const target = customCategoriesFilePath(baseDir)
  const tmpPath = `${target}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(categories, null, 2)}\n`, 'utf8')
  await rename(tmpPath, target)
}

function validateCategoryUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid category URL: "${url}".`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Category URL must use http or https.')
  }
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? 'custom' : slug
}

function randomSuffix(length: number): string {
  return Math.random().toString(36).slice(2, 2 + length)
}

function presetForCustom(custom: CustomCategory): CategoryPreset {
  return {
    id: custom.id,
    name_ar: custom.name,
    name_en: custom.name,
    url: custom.url,
    expected_count: 0,
    color: custom.color,
    icon: custom.icon,
  }
}

/**
 * Downloads a custom category's list, persists it in custom-categories.json
 * (enabled by default) and rebuilds the matcher so its domains take effect.
 */
export async function addCustomCategory(
  input: AddCustomCategoryInput,
  options: CategoryOps = {},
): Promise<CategoryInfo> {
  const baseDir = resolveBaseDir(options.baseDir)
  const name = input.name.trim()
  if (name === '') {
    throw new TypeError('Category name must be a non-empty string.')
  }
  const url = input.url.trim()
  validateCategoryUrl(url)
  const color = input.color.trim() === '' ? '#7c3aed' : input.color.trim()

  const id = `${slugify(name)}-${randomSuffix(4)}`
  const preset = presetForCustom({ id, name, url, color, icon: '🏷️', enabled: true })
  const result = await downloadCategoryList(preset, categoryListPath(baseDir, id), {
    onProgress: (progress) => options.onProgress?.(preset, progress),
  })
  if (result.status === 'error') {
    throw new Error(`Failed to download custom category "${name}": ${result.error}`)
  }

  const custom: CustomCategory = {
    id,
    name,
    url,
    color,
    icon: preset.icon,
    enabled: true,
    lastUpdatedAt: new Date().toISOString(),
    lastModified: result.lastModified,
    count: result.count,
  }
  await writeCustomCategories(baseDir, [...(await readCustomCategories(baseDir)), custom])
  await options.onRulesChanged?.()

  return customToInfo(custom)
}

/** Removes a custom category: drops its entry and its downloaded list file. */
export async function removeCustomCategory(id: string, options: CategoryOps = {}): Promise<void> {
  const baseDir = resolveBaseDir(options.baseDir)
  const customs = await readCustomCategories(baseDir)
  const next = customs.filter((custom) => custom.id !== id)
  if (next.length === customs.length) {
    return
  }
  await writeCustomCategories(baseDir, next)
  await rm(categoryListPath(baseDir, id), { force: true }).catch(() => undefined)
  await options.onRulesChanged?.()
}

/** Re-downloads a custom category's list using its persisted Last-Modified. */
export async function updateCustomCategory(id: string, options: CategoryOps = {}): Promise<DownloadResult> {
  const baseDir = resolveBaseDir(options.baseDir)
  const custom = (await readCustomCategories(baseDir)).find((entry) => entry.id === id)
  if (custom === undefined) {
    throw new Error(`Unknown custom category: "${id}".`)
  }

  const preset = presetForCustom(custom)
  const result = await downloadCategoryList(preset, categoryListPath(baseDir, id), {
    lastModified: custom.lastModified,
    onProgress: (progress) => options.onProgress?.(preset, progress),
  })

  if (result.status === 'ok') {
    custom.lastUpdatedAt = new Date().toISOString()
    custom.lastModified = result.lastModified
    custom.count = result.count
    await writeCustomCategories(
      baseDir,
      (await readCustomCategories(baseDir)).map((entry) => (entry.id === id ? custom : entry)),
    )
    if (custom.enabled) {
      await options.onRulesChanged?.()
    }
  } else if (result.status === 'error') {
    throw new Error(`Failed to update custom category "${id}": ${result.error}`)
  }

  return result
}

// --- Unified views and dispatchers ---------------------------------------------

export type CategoryKind = 'preset' | 'custom'

export interface CategoryInfo {
  id: string
  kind: CategoryKind
  name: string
  name_en?: string
  icon: string
  color: string
  url: string
  expectedCount?: number
  enabled: boolean
  count?: number
  lastUpdatedAt?: string
  lastModified?: string
}

function customToInfo(custom: CustomCategory): CategoryInfo {
  return {
    id: custom.id,
    kind: 'custom',
    name: custom.name,
    icon: custom.icon,
    color: custom.color,
    url: custom.url,
    enabled: custom.enabled,
    count: custom.count,
    lastUpdatedAt: custom.lastUpdatedAt,
    lastModified: custom.lastModified,
  }
}

/** Returns every category (built-in presets + customs) with live state. */
export async function readCategoriesOverview(baseDir: string): Promise<CategoryInfo[]> {
  const state = await readCategoryState(baseDir)
  const customs = await readCustomCategories(baseDir)

  const presets: CategoryInfo[] = CATEGORY_PRESETS.map((preset) => ({
    id: preset.id,
    kind: 'preset',
    name: preset.name_ar,
    name_en: preset.name_en,
    icon: preset.icon,
    color: preset.color,
    url: preset.url,
    expectedCount: preset.expected_count,
    enabled: state[preset.id]?.enabled ?? false,
    count: state[preset.id]?.count,
    lastUpdatedAt: state[preset.id]?.lastUpdatedAt,
    lastModified: state[preset.id]?.lastModified,
  }))

  return [...presets, ...customs.map(customToInfo)]
}

/**
 * Enables or disables ANY category (preset or custom). No challenge happens
 * here: the caller decides whether a token is required (disabling a built-in
 * goes through the protected-action gate; enabling and custom edits do not).
 */
export async function setCategoryEnabled(
  id: string,
  enabled: boolean,
  options: CategoryOps = {},
): Promise<void> {
  const baseDir = resolveBaseDir(options.baseDir)
  const preset = findPreset(id)
  if (preset !== undefined) {
    if (enabled) {
      await enableCategory(id, 'challenge-token-verified-upstream', options)
    } else {
      await disableCategory(id, 'challenge-token-verified-upstream', options)
    }
    return
  }

  const customs = await readCustomCategories(baseDir)
  const custom = customs.find((entry) => entry.id === id)
  if (custom === undefined) {
    throw new Error(`Unknown category: "${id}".`)
  }

  if (enabled) {
    if (custom.lastUpdatedAt === undefined) {
      const result = await downloadCategoryList(
        presetForCustom(custom),
        categoryListPath(baseDir, id),
        { onProgress: (progress) => options.onProgress?.(presetForCustom(custom), progress) },
      )
      if (result.status === 'error') {
        throw new Error(`Failed to enable category "${id}": ${result.error}`)
      }
      custom.lastUpdatedAt = new Date().toISOString()
      custom.lastModified = result.lastModified
      custom.count = result.count
    }
    custom.enabled = true
  } else {
    custom.enabled = false
  }

  await writeCustomCategories(
    baseDir,
    customs.map((entry) => (entry.id === id ? custom : entry)),
  )
  await options.onRulesChanged?.()
}

/**
 * Re-downloads any category's list (preset or custom). Dispatches to the right
 * implementation based on whether the id is a built-in preset.
 */
export async function updateCategoryEntry(
  id: string,
  options: CategoryOps = {},
): Promise<DownloadResult> {
  if (findPreset(id) !== undefined) {
    return updateCategory(id, options)
  }
  return updateCustomCategory(id, options)
}

// --- Pattern search (for the "View Patterns" modal) -----------------------------

const patternCache = new Map<string, { mtimeMs: number; size: number; lines: string[] }>()

export interface PatternSearchResult {
  total: number
  domains: string[]
}

const PATTERN_RESULT_CAP = 500

/**
 * Filters a category's downloaded list by substring. Results are cached per
 * file and invalidated when the file changes on disk.
 */
export async function searchCategoryPatterns(
  baseDir: string,
  id: string,
  query: string,
): Promise<PatternSearchResult> {
  const filePath = categoryListPath(baseDir, id)
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return { total: 0, domains: [] }
  }

  const key = filePath
  const cached = patternCache.get(key)
  if (cached === undefined || cached.mtimeMs !== fileStat.mtimeMs || cached.size !== fileStat.size) {
    const raw = await readFile(filePath, 'utf8')
    const lines = raw
      .split(/\r?\n/)
      .map(normalizeEntry)
      .filter((line) => line !== '')
    patternCache.set(key, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, lines })
  }

  const lines = patternCache.get(key)?.lines ?? []
  const needle = query.trim().toLowerCase()
  const domains =
    needle === '' ? lines.slice(0, PATTERN_RESULT_CAP) : lines.filter((line) => line.includes(needle))
  return {
    total: needle === '' ? lines.length : domains.length,
    domains: domains.slice(0, PATTERN_RESULT_CAP),
  }
}