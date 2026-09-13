import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockRuleMatcher, type RulePatterns } from './matcher'
import { isDnsFilterEnabled, loadDnsRules } from './rules-store'

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

describe('loadDnsRules', () => {
  let dir: string
  let blocklistPath: string
  let categoriesPath: string
  let rulesPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'focuslock-rules-'))
    blocklistPath = join(dir, 'blocklist.txt')
    categoriesPath = join(dir, 'categories.json')
    rulesPath = join(dir, 'dns-rules.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('merges the blocklist, enabled categories, presets, rule file and custom sites', async () => {
    await writeFile(blocklistPath, 'BLOCKLIST.example\n\ndupe.example\n# comment\ndupe.example\n', 'utf8')
    await writeJson(categoriesPath, {
      'custom-cat': { enabled: true, domains: ['CatDomain.example\n', '  spaced.example '] },
      'disabled-cat': { enabled: false, domains: ['nogood.example'] },
    })
    // Enable the "social" preset with an on-disk list file.
    await writeJson(join(dir, 'category-presets.json'), {
      social: { enabled: true, lastUpdatedAt: '2026-01-01T00:00:00Z' },
      ads: { enabled: false },
    })
    await mkdir(join(dir, 'category-lists'), { recursive: true })
    await writeFile(join(dir, 'category-lists', 'social.txt'), 'from-social.example\nfrom-social.example\n', 'utf8')
    await writeJson(rulesPath, {
      enabled: true,
      exact: ['from-rules.example'],
      wildcards: ['*.wild-rules.example'],
      regexes: ['^ad\\d+\\.rules\\.example$'],
      keywords: ['banner'],
      exceptions: { exact: ['keep.example'], wildcards: ['*.keep.example'], keywords: ['newsletter'] },
    })
    await writeJson(join(dir, 'custom-sites.json'), [
      { id: 1, domain: 'mydark.example', variants: ['mydark.example', '*.mydark.example', 'www.mydark.example'], addedAt: '2026-01-01T00:00:00Z' },
    ])

    const patterns = await loadDnsRules({ blocklistPath, categoriesPath, rulesPath })

    expect(new Set(patterns.exact)).toEqual(
      new Set([
        'blocklist.example',
        'dupe.example',
        'catdomain.example',
        'spaced.example',
        'from-social.example',
        'from-rules.example',
        'mydark.example',
        'www.mydark.example',
      ]),
    )
    expect(new Set(patterns.wildcards)).toEqual(
      new Set(['*.wild-rules.example', '*.mydark.example']),
    )
    expect(patterns.regexes).toEqual(['^ad\\d+\\.rules\\.example$'])
    expect(patterns.keywords).toEqual(['banner'])
    expect(patterns.exceptions).toEqual({
      exact: ['keep.example'],
      wildcards: ['*.keep.example'],
      keywords: ['newsletter'],
    })
  })

  it('ignores disabled presets and disabled categories', async () => {
    await writeFile(blocklistPath, 'blocked.example\n', 'utf8')
    await writeJson(categoriesPath, {
      'dead-cat': { enabled: false, domains: ['nope.example'] },
    })
    await writeJson(join(dir, 'category-presets.json'), {
      porn: { enabled: false, lastUpdatedAt: '2026-01-01T00:00:00Z' },
    })
    await mkdir(join(dir, 'category-lists'), { recursive: true })
    await writeFile(join(dir, 'category-lists', 'porn.txt'), 'adult-content.example\n', 'utf8')
    await writeFile(rulesPath, 'THIS_IS_NOT_JSON{', 'utf8')

    const patterns = await loadDnsRules({ blocklistPath, categoriesPath, rulesPath })
    expect(patterns.exact).toContain('blocked.example')
    expect(patterns.exact).not.toContain('nope.example')
    expect(patterns.exact).not.toContain('adult-content.example')
  })

  it('handles missing files as empty inputs', async () => {
    const patterns = await loadDnsRules({
      blocklistPath: join(dir, 'does-not-exist.txt'),
      categoriesPath: join(dir, 'no-categories.json'),
      rulesPath: join(dir, 'no-rules.json'),
    })
    expect(patterns).toEqual({
      exact: [],
      wildcards: [],
      regexes: [],
      keywords: [],
      exceptions: { exact: [], wildcards: [], keywords: [] },
    })
  })

  it('normalizes and deduplicates dotted and generic-case domains across sources', async () => {
    await writeFile(blocklistPath, 'Example.COM.\nexample.com.\n', 'utf8')
    await writeJson(categoriesPath, { cat: { enabled: true, domains: ['example.com.'] } })
    await writeJson(join(dir, 'category-presets.json'), {})
    await writeJson(rulesPath, { enabled: true, exact: ['EXAMPLE.com.'] })
    await writeJson(join(dir, 'custom-sites.json'), [])

    const patterns = await loadDnsRules({ blocklistPath, categoriesPath, rulesPath })
    expect(patterns.exact.filter((domain) => domain.startsWith('example.com'))).toEqual(['example.com'])
  })

  it('reports the enabled flag faithfully and defaults to enabled', async () => {
    await writeJson(rulesPath, { enabled: true })
    await expect(isDnsFilterEnabled(rulesPath)).resolves.toBe(true)

    await writeJson(rulesPath, { enabled: false })
    await expect(isDnsFilterEnabled(rulesPath)).resolves.toBe(false)

    await writeFile(rulesPath, 'not json{', 'utf8')
    await expect(isDnsFilterEnabled(rulesPath)).resolves.toBe(true)
  })

  it('never blocks plain rule sets the wrong way: the resulting matcher blocks exactly the merged set', async () => {
    await writeFile(blocklistPath, 'exact-hit.example\n', 'utf8')
    await writeJson(categoriesPath, {})
    await writeJson(join(dir, 'category-presets.json'), {})
    await writeJson(rulesPath, {
      enabled: true,
      wildcards: ['*.sub-hit.example'],
      keywords: ['trackradar'],
      exceptions: { exact: ['allow.example'], wildcards: [], keywords: [] },
    })
    await writeJson(join(dir, 'custom-sites.json'), [])

    const patterns: RulePatterns = await loadDnsRules({ blocklistPath, categoriesPath, rulesPath })
    const matcher = new BlockRuleMatcher(patterns)

    expect(matcher.isBlocked('exact-hit.example').blocked).toBe(true)
    expect(matcher.isBlocked('sub.sub-hit.example').blocked).toBe(true)
    expect(matcher.isBlocked('trackradar.example').blocked).toBe(true)
    expect(matcher.isBlocked('clear.example').blocked).toBe(false)
  })
})