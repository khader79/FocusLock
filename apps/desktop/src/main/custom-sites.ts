import { verifyTokenForAction } from './challenge-token'
import { auditLog } from './audit-log'
import {
  buildSiteVariants,
  nextCustomSiteId,
  normalizeCustomSiteUrl,
  readCustomSites,
  writeCustomSites,
  type Site,
} from './custom-sites-store'

/**
 * Custom website blocking API.
 *
 * Every mutation requires a valid challenge token minted for the matching
 * action (`add_custom_site` / `remove_custom_site`); invalid or mismatched
 * tokens throw. After each mutation the DNS matcher is rebuilt and the
 * blocker re-applied through the injectable {@link CustomSitesEffects}.
 *
 * Electron-free: the real effects are wired by `index.ts` via
 * {@link setCustomSitesEffects}, keeping this module (and its tests) running
 * under plain Node/vitest.
 */

export type { Site }

export interface CustomSitesEffects {
  /** Rebuild + swap the DNS matcher so the new rules take effect immediately. */
  rebuildMatcher: () => Promise<void>
  /** Re-apply the host-level blocker (e.g. requestBlockerApply). */
  reapplyBlocker: () => void
}

let effects: CustomSitesEffects | null = null

/** Wires the real DNS/blocker effects. Pass null to clear (tests). */
export function setCustomSitesEffects(value: CustomSitesEffects | null): void {
  effects = value
}

let baseDirOverride: string | null = null

/** Sets the default data dir used by {@link addSite} & co. when no baseDir is passed. */
export function setCustomSitesBaseDir(baseDir: string): void {
  baseDirOverride = baseDir
}

export function resetCustomSitesBaseDir(): void {
  baseDirOverride = null
}

function resolveBaseDir(explicit?: string): string {
  const baseDir = explicit ?? baseDirOverride
  if (baseDir === null) {
    throw new Error('Custom sites base directory is not configured.')
  }
  return baseDir
}

function requireToken(token: string, expectedAction: 'add_custom_site' | 'remove_custom_site'): void {
  verifyTokenForAction(token, expectedAction)
}

/** Normalizes a URL/domain into variants; throws on invalid input. */
export function normalizeSiteInput(input: string): string {
  return normalizeCustomSiteUrl(input)
}

/** Builds `[domain, *.domain, www.domain]` matching variants for a domain. */
export function variantsFor(domain: string): string[] {
  return buildSiteVariants(domain)
}

async function applyEffects(): Promise<void> {
  const current = effects
  if (current === null) {
    return
  }
  await current.rebuildMatcher()
  current.reapplyBlocker()
}

/** Adds a custom site after extracting its domain from a URL or bare domain. */
export async function addSite(input: string, token: string, options: { baseDir?: string } = {}): Promise<Site> {
  requireToken(token, 'add_custom_site')

  const domain = normalizeCustomSiteUrl(input)
  const baseDir = resolveBaseDir(options.baseDir)

  const existing = await readCustomSites(baseDir)
  const site: Site = {
    id: nextCustomSiteId(existing),
    domain,
    variants: buildSiteVariants(domain),
    addedAt: new Date().toISOString(),
  }

  await writeCustomSites(baseDir, [...existing, site])
  await applyEffects()
  auditLog('add_custom_site', true, { id: site.id, domain })

  return site
}

/** Removes a custom site by id. */
export async function removeSite(id: number, token: string, options: { baseDir?: string } = {}): Promise<void> {
  requireToken(token, 'remove_custom_site')

  const baseDir = resolveBaseDir(options.baseDir)
  const existing = await readCustomSites(baseDir)
  const remaining = existing.filter((site) => site.id !== id)
  if (remaining.length === existing.length) {
    throw new Error(`Custom site not found: id ${id}.`)
  }

  await writeCustomSites(baseDir, remaining)
  await applyEffects()
  auditLog('remove_custom_site', true, { id })
}

/**
 * Adds many sites from newline-separated input in one transaction. Throws if
 * any line is invalid, leaving the store untouched. Returns the number added.
 */
export async function bulkAdd(text: string, token: string, options: { baseDir?: string } = {}): Promise<number> {
  requireToken(token, 'add_custom_site')

  const baseDir = resolveBaseDir(options.baseDir)
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const now = new Date().toISOString()
  const existing = await readCustomSites(baseDir)
  let nextId = nextCustomSiteId(existing)
  const records: Site[] = lines.map((line) => {
    const domain = normalizeCustomSiteUrl(line)
    const site: Site = {
      id: nextId,
      domain,
      variants: buildSiteVariants(domain),
      addedAt: now,
    }
    nextId += 1
    return site
  })

  await writeCustomSites(baseDir, [...existing, ...records])
  await applyEffects()
  auditLog('add_custom_site', true, { bulk: records.length })

  return records.length
}

/** Lists custom sites, optionally filtered by a domain substring. */
export async function listSites(filter?: string): Promise<Site[]> {
  const baseDir = resolveBaseDir()
  const all = await readCustomSites(baseDir)
  const needle = filter?.trim().toLowerCase() ?? ''
  if (needle === '') {
    return all
  }
  return all.filter(
    (site) => site.domain.includes(needle) || site.variants.some((variant) => variant.includes(needle)),
  )
}