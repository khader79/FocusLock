import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Persisted custom-site blocking store: one JSON array keyed by numeric id.
 * Pure I/O + URL normalization — no Electron, no app imports — so the DNS
 * rules matcher can read it without creating module cycles.
 */

export interface Site {
  id: number
  domain: string
  variants: string[]
  addedAt: string
}

export function customSitesFilePath(baseDir: string): string {
  return join(baseDir, 'custom-sites.json')
}

/** Reads the custom sites array; returns [] when missing or corrupt. */
export async function readCustomSites(baseDir: string): Promise<Site[]> {
  try {
    const raw = await readFile(customSitesFilePath(baseDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (entry): entry is Site =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Site).id === 'number' &&
        typeof (entry as Site).domain === 'string',
    )
  } catch {
    return []
  }
}

/** Writes the custom sites array atomically (tmp file + rename). */
export async function writeCustomSites(baseDir: string, sites: Site[]): Promise<void> {
  const target = customSitesFilePath(baseDir)
  const tmpPath = `${target}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(sites, null, 2)}\n`, 'utf8')
  await rename(tmpPath, target)
}

/** The next id to hand out: one above the current maximum, or 1 when empty. */
export function nextCustomSiteId(sites: Site[]): number {
  let max = 0
  for (const site of sites) {
    if (site.id > max) {
      max = site.id
    }
  }
  return max + 1
}

/**
 * Extracts the bare blocking domain from a URL or a bare-domain input.
 *
 * - "https://www.example.com/path?q=1"     -> "example.com"
 * - "www.example.com"                       -> "example.com"
 * - "example.com"                           -> "example.com"
 *
 * Throws on anything that is not a valid http(s) URL or a plausible domain.
 */
export function normalizeCustomSiteUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new Error('Custom site must not be empty.')
  }

  let candidate: string
  if (/^[a-z0-9.-]+$/i.test(trimmed) && trimmed.includes('.')) {
    // Bare-domain shorthand, no scheme.
    candidate = trimmed
  } else {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error(`Invalid custom site URL: "${input}".`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Custom site URL must use http or https: "${input}".`)
    }
    if (parsed.hostname === '') {
      throw new Error(`Custom site URL has no hostname: "${input}".`)
    }
    candidate = parsed.hostname
  }

  // Strip a leading "www." so "https://www.example.com" and "example.com"
  // normalize to the same domain.
  let domain = candidate.toLowerCase().replace(/\.+$/, '')
  if (domain.startsWith('www.')) {
    domain = domain.slice(4)
  }

  if (!isValidDomain(domain)) {
    throw new Error(`Invalid custom site domain: "${domain}".`)
  }

  return domain
}

/**
 * The three matching variants for a domain: the bare domain, a wildcard for
 * every subdomain, and the www hostname. All three feed the DNS matcher.
 */
export function buildSiteVariants(domain: string): string[] {
  return [`${domain}`, `*.${domain}`, `www.${domain}`]
}

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function isValidDomain(domain: string): boolean {
  if (domain.length > 253 || domain.split('.').some((label) => label.length > 63)) {
    return false
  }
  if (!domain.includes('.')) {
    return false
  }
  return domain.split('.').every((label) => DOMAIN_LABEL.test(label))
}