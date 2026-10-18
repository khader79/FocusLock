import { readFile, rm, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Persisted config for the blocked sites / apps feature:
 *  - blocklist.txt     (plain domains, same file the hosts blocker consumes)
 *  - categories.json   (category -> { enabled, domains })
 *  - blocked-apps.json (array of app names)
 *
 * All files live in app.getPath('userData'), matching the existing blocker.
 */

export interface Category {
  enabled: boolean
  domains: string[]
}

function baseDir(): string {
  return app.getPath('userData')
}

export function blocklistFilePath(): string {
  return join(baseDir(), 'blocklist.txt')
}

export function categoriesFilePath(): string {
  return join(baseDir(), 'categories.json')
}

export function blockedAppsFilePath(): string {
  return join(baseDir(), 'blocked-apps.json')
}

function parseDomainLines(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().toLowerCase()
    if (line === '' || line.startsWith('#') || line.includes(' ') || line.includes('\t')) {
      continue
    }
    if (!seen.has(line)) {
      seen.add(line)
      out.push(line)
    }
  }

  return out
}

export async function readBlockedDomains(): Promise<string[]> {
  try {
    return parseDomainLines(await readFile(blocklistFilePath(), 'utf8'))
  } catch {
    return []
  }
}

export async function writeBlockedDomains(domains: string[]): Promise<void> {
  const normalized = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))]
  const content = normalized.length > 0 ? `${normalized.join(EOL)}${EOL}` : ''
  await writeFile(blocklistFilePath(), content, 'utf8')
}

export async function readCategories(): Promise<Record<string, Category>> {
  try {
    const raw = await readFile(categoriesFilePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, Category>
    }
    return {}
  } catch {
    return {}
  }
}

export async function writeCategories(categories: Record<string, Category>): Promise<void> {
  await writeFile(categoriesFilePath(), JSON.stringify(categories, null, 2), 'utf8')
}

export async function readBlockedApps(): Promise<string[]> {
  try {
    const raw = await readFile(blockedAppsFilePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

export async function writeBlockedApps(apps: string[]): Promise<void> {
  const normalized = [...new Set(apps.map((a) => a.trim()).filter((a) => a !== ''))]
  await writeFile(blockedAppsFilePath(), JSON.stringify(normalized, null, 2), 'utf8')
}

/**
 * The full set of domains to block = explicit blocklist + domains of every
 * enabled category. Used when applying the hosts file after protected edits.
 */
export async function computeEffectiveDomains(): Promise<string[]> {
  const [explicit, categories] = await Promise.all([readBlockedDomains(), readCategories()])

  const set = new Set(explicit)
  for (const category of Object.values(categories)) {
    if (!category.enabled) {
      continue
    }
    for (const domain of category.domains) {
      const normalized = domain.trim().toLowerCase()
      if (normalized !== '' && !normalized.includes(' ') && !normalized.includes('\t') && !normalized.startsWith('#')) {
        set.add(normalized)
      }
    }
  }

  return [...set]
}

/** Deletes every persisted protection rule (used by the uninstall action). */
export async function wipeProtectionData(): Promise<void> {
  await Promise.all(
    [blocklistFilePath(), categoriesFilePath(), blockedAppsFilePath()].map((path) =>
      rm(path, { force: true }),
    ),
  )
}