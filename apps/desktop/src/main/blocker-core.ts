import { readFile, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'

const FOCUSLOCK_START = '# === FOCUSLOCK START ==='
const FOCUSLOCK_END = '# === FOCUSLOCK END ==='

export interface Category {
  enabled: boolean
  domains: string[]
}

export function hostsFilePath(): string {
  if (process.platform === 'win32') {
    return 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  }

  return '/etc/hosts'
}

export function parseBlocklist(raw: string): string[] {
  const seen = new Set<string>()
  const domains: string[] = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.includes(' ') || line.includes('\t')) {
      continue
    }

    const lower = line.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      domains.push(lower)
    }
  }

  return domains
}

/** Lower-cases and de-duplicates domain candidates, keeping only bare hosts. */
export function normalizeDomains(domains: Iterable<string>): string[] {
  const normalized = new Set<string>()
  for (const domain of domains) {
    const lower = domain.trim().toLowerCase()
    if (lower !== '' && !lower.includes(' ') && !lower.includes('\t') && !lower.includes('#')) {
      normalized.add(lower)
    }
  }

  return [...normalized]
}

export async function readBlocklistFile(filePath: string): Promise<string[]> {
  try {
    return parseBlocklist(await readFile(filePath, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return []
    }

    throw new Error(`Failed to read blocklist at "${filePath}": ${String(err)}`)
  }
}

export async function readCategoriesFile(
  filePath: string,
): Promise<Record<string, Category>> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, Category>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * The full set of domains to block = explicit blocklist + domains of every
 * enabled category.
 */
export function computeEffectiveDomains(
  blocklistDomains: string[],
  categories: Record<string, Category>,
): string[] {
  const set = new Set(blocklistDomains)

  for (const category of Object.values(categories)) {
    if (!category.enabled) {
      continue
    }
    for (const domain of category.domains) {
      const normalized = domain.trim().toLowerCase()
      if (
        normalized !== '' &&
        !normalized.includes(' ') &&
        !normalized.includes('\t') &&
        !normalized.startsWith('#')
      ) {
        set.add(normalized)
      }
    }
  }

  return [...set]
}

export function removeBlock(content: string): string {
  const lines = content.split(/\r?\n/)

  const startIndex = lines.findIndex((line) => line.trim() === FOCUSLOCK_START)
  if (startIndex === -1) {
    return content
  }

  const endIndex = lines.findIndex((line) => line.trim() === FOCUSLOCK_END)
  if (endIndex === -1 || endIndex < startIndex) {
    return lines.slice(0, startIndex).join(EOL)
  }

  return [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)].join(EOL)
}

export function buildBlock(domains: string[]): string {
  const lines: string[] = [FOCUSLOCK_START]

  for (const domain of domains) {
    lines.push(`0.0.0.0 ${domain}`, `:: ${domain}`)
  }

  lines.push(FOCUSLOCK_END)

  return lines.join(EOL)
}

/**
 * Rewrites the hosts file so exactly the given domains resolve to 0.0.0.0.
 * Pure file I/O (no Electron APIs), so it can run unchanged inside a worker
 * thread.
 */
export async function applyHostsToFile(
  domains: string[],
  targetPath = hostsFilePath(),
): Promise<void> {
  const normalized = normalizeDomains(domains)

  // Reading the system hosts file needs no elevated privileges.
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new Error(`Failed to read hosts file at "${targetPath}": ${String(err)}`)
    }
    content = ''
  }

  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  }

  const withoutBlock = removeBlock(content)
  const separator = withoutBlock.trimEnd() === '' ? '' : EOL
  const nextContents = `${withoutBlock.trimEnd()}${separator}${buildBlock(normalized)}${EOL}`

  // === ADMIN REQUIRED ===
  // Writing to the system hosts file needs elevated privileges:
  //  - Windows: the app must be started as Administrator (UAC elevation).
  //  - macOS/Linux: the app must be started with sudo.
  // With no elevation this writeFile rejects with EACCES/EPERM, so the
  // app cannot actually block anything.
  try {
    await writeFile(targetPath, nextContents, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `Not enough permissions to write the hosts file at "${targetPath}". ` +
          'Run the app with administrator privileges (Windows) or sudo (macOS/Linux).',
      )
    }

    throw new Error(`Failed to write hosts file at "${targetPath}": ${String(err)}`)
  }
}