import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importEntries, parseBulkPaste, parseFile, previewImport, validateEntries } from './import'
import { signChallengeToken } from './challenge-token'

const dirs: string[] = []
async function tempDir(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'focuslock-import-')); dirs.push(dir); return dir }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('import parsing', () => {
  it('parses TXT bulk paste and validates/deduplicates domains', () => {
    const parsed = parseBulkPaste('Example.com\n# comment\nwww.example.com\nbad domain\n')
    const result = validateEntries(parsed.entries)
    expect(result.valid.map((entry) => entry.domain)).toEqual(['example.com'])
    expect(result.duplicates).toEqual(['example.com'])
    expect(result.invalid).toHaveLength(1)
  })

  it('parses CSV, hosts, and FocusLock JSON exports', async () => {
    const dir = await tempDir()
    const csv = join(dir, 'list.csv'); const hosts = join(dir, 'list.hosts'); const json = join(dir, 'export.json')
    await writeFile(csv, 'domain,category\nexample.com,work\n', 'utf8')
    await writeFile(hosts, '0.0.0.0 ads.example.com tracker.example.com\n127.0.0.1 localhost\n', 'utf8')
    await writeFile(json, JSON.stringify({ blockedDomains: ['json.example.com'], categories: { social: { domains: ['social.example.com'] } } }), 'utf8')
    expect((await parseFile(csv, 'csv')).entries).toEqual([{ domain: 'example.com', category: 'work' }])
    expect((await parseFile(hosts, 'hosts')).entries.map((entry) => entry.domain)).toEqual(['ads.example.com', 'tracker.example.com'])
    expect((await parseFile(json, 'json')).entries.map((entry) => entry.domain)).toEqual(['json.example.com', 'social.example.com'])
  })

  it('generates bounded previews with invalid-row feedback', () => {
    expect(previewImport([{ domain: 'valid.example' }, { domain: 'no spaces allowed' }], 1)).toEqual([{ domain: 'valid.example', category: 'غير مصنّف', valid: true }])
  })
})

describe('importEntries', () => {
  it('requires an import challenge token and atomically adds only new valid domains', async () => {
    const dir = await tempDir(); await writeFile(join(dir, 'blocklist.txt'), 'existing.example\n', 'utf8')
    await expect(importEntries([{ domain: 'new.example' }], 'nope', { baseDir: dir })).rejects.toThrow('Invalid challenge token')
    const progress: string[] = []
    const result = await importEntries([{ domain: 'new.example' }, { domain: 'existing.example' }, { domain: 'bad domain' }], signChallengeToken('import_entries'), { baseDir: dir, onProgress: (event) => progress.push(event.phase) })
    expect(result).toEqual({ added: 1, duplicates: 1, invalid: 1, total: 3 })
    expect(await readFile(join(dir, 'blocklist.txt'), 'utf8')).toBe('existing.example\nnew.example\n')
    expect(progress).toContain('complete')
  })
})
