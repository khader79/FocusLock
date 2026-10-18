import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signChallengeToken } from './challenge-token'
import { collectExportData, exportData, resetExportBaseDir, setExportBaseDir } from './export'
import { importEntries, parseFile, resetImportBaseDir, setImportBaseDir } from './import'

describe('export → import round-trip', () => {
  let src: string
  let dst: string
  let exportToken: string

  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), 'focuslock-src-'))
    dst = await mkdtemp(join(tmpdir(), 'focuslock-dst-'))
    exportToken = signChallengeToken('export')
    setExportBaseDir(src)
    setImportBaseDir(dst)
  })

  afterEach(async () => {
    resetExportBaseDir()
    resetImportBaseDir()
    await Promise.all([rm(src, { recursive: true, force: true }), rm(dst, { recursive: true, force: true })])
  })

  async function seedSource(domainsByCategory: Record<string, string[]>): Promise<string[]> {
    const all: string[] = []
    const categories: Record<string, { enabled: boolean; domains: string[] }> = {}
    for (const [id, domains] of Object.entries(domainsByCategory)) {
      categories[id] = { enabled: true, domains }
      all.push(...domains)
    }
    await writeFile(join(src, 'categories.json'), `${JSON.stringify(categories)}\n`, 'utf8')
    await writeFile(join(src, 'category-presets.json'), `${JSON.stringify({})}\n`, 'utf8')
    await writeFile(join(src, 'blocklist.txt'), '', 'utf8')
    return all
  }

  it('round-trips the effective blocking set through a JSON export', async () => {
    const expected = await seedSource({
      'math': ['math-portal.example'],
      'school': ['classroom.example', 'canvas.example'],
      'sites': ['manual.example'],
    })

    const exportedFile = join(dst, 'backup.json')
    await exportData('json', exportedFile, exportToken)

    const parsed = await parseFile(exportedFile, 'json')
    expect(parsed.warnings).toEqual([])
    const imported = await importEntries(parsed.entries, signChallengeToken('import_entries'), { baseDir: dst })

    expect(imported.added).toBe(expected.length)
    expect(imported.invalid).toBe(0)
    expect(imported.duplicates).toBe(0)

    const written = (await readFile(join(dst, 'blocklist.txt'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line !== '')
      .sort()
    expect(written).toEqual([...expected].sort())

    const rebuilt = await import('./dns/rules-store').then((m) =>
      m.loadDnsRules({
        blocklistPath: join(dst, 'blocklist.txt'),
        categoriesPath: join(dst, 'categories.json'),
        rulesPath: join(dst, 'dns-rules.json'),
      }),
    )
    expect(new Set(rebuilt.exact)).toEqual(new Set(expected))
  })

  it('round-trips plain blocklist patterns through TXT and hosts exports', async () => {
    await writeFile(join(src, 'blocklist.txt'), 'a.example\nb.example\n', 'utf8')

    const txt = join(dst, 'export.txt')
    await exportData('txt', txt, exportToken)
    const txtParsed = await parseFile(txt, 'txt')
    expect(txtParsed.entries.map((entry) => entry.domain).sort()).toEqual(['a.example', 'b.example'])

    const hosts = join(dst, 'export.hosts')
    await exportData('hosts', hosts, exportToken)
    const hostsParsed = await parseFile(hosts, 'hosts')
    expect(hostsParsed.entries.map((entry) => entry.domain).sort()).toEqual(['a.example', 'b.example'])
  })

  it('refuses to export when a token for a different action or no data dir is configured', async () => {
    await seedSource({ 'sites': ['a.example'] })
    const tokens = [signChallengeToken('pause'), '', 'forged.token.value']
    for (const token of tokens) {
      await expect(exportData('json', join(dst, 'x.json'), token)).rejects.toThrow()
    }
    resetExportBaseDir()
    await expect(exportData('json', join(dst, 'x.json'), exportToken)).rejects.toThrow(/not configured/)
  })

  it('reflects silent mode and date metadata in the exported snapshot', async () => {
    await seedSource({ 'sites': ['a.example'] })
    await writeFile(join(src, 'blocklist.txt'), 'a.example\n', 'utf8')
    await writeFile(join(src, 'settings.json'), `${JSON.stringify({ silent_mode: true })}\n`, 'utf8')
    const data = await collectExportData()
    expect(data.version).toBe('1.0')
    expect(data.settings).toEqual({ silent_mode: true })
    expect(new Date(data.exported_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
    expect(data.patterns).toEqual(['a.example'])
  })

  it('still ships every category (including disabled) inside the JSON export', async () => {
    await seedSource({ 'sites': ['a.example'] })
    await writeFile(
      join(src, 'categories.json'),
      `${JSON.stringify({ 'sites': { enabled: true, domains: ['a.example'] }, 'off': { enabled: false, domains: ['b.example'] } })}\n`,
      'utf8',
    )
    const data = await collectExportData()
    expect(data.categories.some((category) => (category as { id?: string }).id === 'off')).toBe(true)
  })
})