import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signChallengeToken } from './challenge-token'
import {
  resetCustomSitesBaseDir,
  setCustomSitesBaseDir,
  setCustomSitesEffects,
  addSite,
  removeSite,
  bulkAdd,
  listSites,
} from './custom-sites'
import {
  writeCustomSites,
  normalizeCustomSiteUrl,
  buildSiteVariants,
  type Site,
} from './custom-sites-store'
import { setAuditLogBaseDir } from './audit-log'
import { loadDnsRules } from './dns/rules-store'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-custom-sites-'))
  dirs.push(dir)
  return dir
}

async function readSitesFile(baseDir: string): Promise<Site[]> {
  return JSON.parse(await readFile(join(baseDir, 'custom-sites.json'), 'utf8')) as Site[]
}

describe('normalizeCustomSiteUrl / buildSiteVariants', () => {
  it('extracts the bare domain from a full URL (spec example)', () => {
    expect(normalizeCustomSiteUrl('https://www.example.com/path?q=1')).toBe('example.com')
  })

  it('strips www from bare-domain shorthand', () => {
    expect(normalizeCustomSiteUrl('www.example.com')).toBe('example.com')
  })

  it('keeps a plain domain as-is', () => {
    expect(normalizeCustomSiteUrl('example.com')).toBe('example.com')
  })

  it('keeps non-www subdomains', () => {
    expect(normalizeCustomSiteUrl('sub.example.com')).toBe('sub.example.com')
  })

  it('lowercases mixed-case input', () => {
    expect(normalizeCustomSiteUrl('HTTPS://WWW.EXAMPLE.COM/Path')).toBe('example.com')
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeCustomSiteUrl('ftp://example.com/')).toThrow(/http or https/)
  })

  it('rejects empty and malformed input', () => {
    expect(() => normalizeCustomSiteUrl('')).toThrow()
    expect(() => normalizeCustomSiteUrl('not a url')).toThrow(/Invalid/)
    expect(() => normalizeCustomSiteUrl('example')).toThrow(/Invalid/)
  })

  it('builds the spec variants array', () => {
    expect(buildSiteVariants('example.com')).toEqual(['example.com', '*.example.com', 'www.example.com'])
  })
})

describe('custom site mutations (challenge-gated)', () => {
  let baseDir: string
  let rebuildMatcher: ReturnType<typeof vi.fn>
  let reapplyBlocker: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    baseDir = await tempDir()
    setCustomSitesBaseDir(baseDir)
    setAuditLogBaseDir(baseDir)
    rebuildMatcher = vi.fn(async () => undefined)
    reapplyBlocker = vi.fn()
    setCustomSitesEffects({ rebuildMatcher, reapplyBlocker })
  })

  afterEach(() => {
    resetCustomSitesBaseDir()
    setCustomSitesEffects(null)
    setAuditLogBaseDir(null)
    vi.useRealTimers()
  })

  it('throws when the base directory is not configured', async () => {
    resetCustomSitesBaseDir()
    const token = signChallengeToken('add_custom_site')
    await expect(addSite('https://example.com', token)).rejects.toThrow(/not configured/)
  })

  it('rejects a token minted for a different action', async () => {
    const token = signChallengeToken('remove_custom_site')
    await expect(addSite('https://example.com', token)).rejects.toThrow(/minted for/)
  })

  it('rejects a tampered token', async () => {
    const token = signChallengeToken('add_custom_site')
    const tampered = `${token.slice(0, -5)}xxxxx`
    await expect(addSite('https://example.com', tampered)).rejects.toThrow(/signature mismatch/)
  })

  it('rejects an expired token', async () => {
    vi.useFakeTimers()
    const token = signChallengeToken('add_custom_site')
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await expect(addSite('https://example.com', token)).rejects.toThrow(/expired/)
  })

  it('adds a site, persists it, reapplies effects and audits', async () => {
    const site = await addSite('https://www.example.com/path?q=1', signChallengeToken('add_custom_site'))

    expect(site).toMatchObject({ id: 1, domain: 'example.com' })
    expect(site.variants).toEqual(['example.com', '*.example.com', 'www.example.com'])

    const persisted = await readSitesFile(baseDir)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.domain).toBe('example.com')

    expect(rebuildMatcher).toHaveBeenCalledOnce()
    expect(reapplyBlocker).toHaveBeenCalledOnce()

    const audit = await readFile(join(baseDir, 'audit.log'), 'utf8')
    expect(audit).toContain('"action":"add_custom_site"')
    expect(audit).toContain('"ok":true')
    expect(audit).toContain('"domain":"example.com"')
  })

  it('assigns incrementing ids across several adds', async () => {
    const add = (domain: string) => addSite(domain, signChallengeToken('add_custom_site'))
    expect((await add('https://first.com')).id).toBe(1)
    expect((await add('https://second.com')).id).toBe(2)
  })

  it('bulk-adds newline-separated input and returns the count', async () => {
    const count = await bulkAdd(
      'https://one.com\n\nwww.two.com\nthree.com',
      signChallengeToken('add_custom_site'),
    )
    expect(count).toBe(3)
    expect(await readSitesFile(baseDir)).toHaveLength(3)
    expect(rebuildMatcher).toHaveBeenCalledOnce()
  })

  it('bulk-add rolls back entirely when any line is invalid', async () => {
    await expect(
      bulkAdd('https://one.com\nnot a url', signChallengeToken('add_custom_site')),
    ).rejects.toThrow(/Invalid/)
    await expect(readdir(baseDir)).resolves.not.toContain('custom-sites.json')
    expect(rebuildMatcher).not.toHaveBeenCalled()
  })

  it('removes an existing site by id', async () => {
    const site = await addSite('https://example.com', signChallengeToken('add_custom_site'))
    const count = await bulkAdd('https://other.com', signChallengeToken('add_custom_site'))

    await removeSite(site.id, signChallengeToken('remove_custom_site'))

    const persisted = await readSitesFile(baseDir)
    expect(persisted).toHaveLength(count)
    expect(persisted.some((entry) => entry.id === site.id)).toBe(false)
    expect(rebuildMatcher).toHaveBeenCalled()

    const audit = await readFile(join(baseDir, 'audit.log'), 'utf8')
    expect(audit).toContain('"action":"remove_custom_site"')
  })

  it('rejects removal of a missing site', async () => {
    await expect(removeSite(999, signChallengeToken('remove_custom_site'))).rejects.toThrow(/not found/)
  })

  it('omits effects when none are wired', async () => {
    setCustomSitesEffects(null)
    const site = await addSite('https://example.com', signChallengeToken('add_custom_site'))
    expect(site.domain).toBe('example.com')
    expect(rebuildMatcher).not.toHaveBeenCalled()
  })
})

describe('listSites', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await tempDir()
    setCustomSitesBaseDir(baseDir)
    setAuditLogBaseDir(baseDir)
  })

  afterEach(() => {
    resetCustomSitesBaseDir()
    setAuditLogBaseDir(null)
  })

  it('returns every site without a filter', async () => {
    await writeCustomSites(baseDir, [
      { id: 1, domain: 'one.com', variants: buildSiteVariants('one.com'), addedAt: new Date().toISOString() },
      { id: 2, domain: 'two.com', variants: buildSiteVariants('two.com'), addedAt: new Date().toISOString() },
    ])
    const sites = await listSites()
    expect(sites).toHaveLength(2)
  })

  it('filters by domain substring', async () => {
    await writeCustomSites(baseDir, [
      { id: 1, domain: 'facebook.com', variants: buildSiteVariants('facebook.com'), addedAt: new Date().toISOString() },
      { id: 2, domain: 'twitter.com', variants: buildSiteVariants('twitter.com'), addedAt: new Date().toISOString() },
    ])
    expect((await listSites('book')).map((site) => site.domain)).toEqual(['facebook.com'])
    expect((await listSites('www.twit')).map((site) => site.domain)).toEqual(['twitter.com'])
  })

  it('returns [] when the store file is absent', async () => {
    expect(await listSites()).toEqual([])
  })
})

describe('rules-store integration', () => {
  it('feeds custom-site variants into the DNS matcher rule set', async () => {
    const baseDir = await tempDir()
    await writeCustomSites(baseDir, [
      { id: 1, domain: 'example.com', variants: buildSiteVariants('example.com'), addedAt: new Date().toISOString() },
    ])

    const rules = await loadDnsRules({
      blocklistPath: join(baseDir, 'blocklist.txt'),
      categoriesPath: join(baseDir, 'categories.json'),
      rulesPath: join(baseDir, 'dns-rules.json'),
    })

    expect(rules.exact).toContain('example.com')
    expect(rules.exact).toContain('www.example.com')
    expect(rules.wildcards).toContain('*.example.com')
  })
})

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})