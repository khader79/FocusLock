import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapCategories,
  CATEGORY_PRESETS,
  categoryStateExists,
  categoryListPath,
  disableCategory,
  downloadCategoryList,
  enableCategory,
  findPreset,
  normalizeEntry,
  readCategoryState,
  readCategoriesOverview,
  readCustomCategories,
  readEnabledPresetDomains,
  refreshEnabledCategories,
  resetCategoryBaseDir,
  scheduleDailyUpdate,
  setCategoryEnabled,
  searchCategoryPatterns,
  updateCategory,
  updateCategoryEntry,
  addCustomCategory,
  removeCustomCategory,
  setCategoryBaseDir,
  type CategoryProgress,
} from './categories'

const httpsMock = vi.hoisted(() => ({
  get: vi.fn(),
  lastOptions: undefined as { headers?: Record<string, string> } | undefined,
}))

vi.mock('node:https', async () => ({
  default: {
    get: (
      url: string,
      options: { headers?: Record<string, string> },
      callback: (res: IncomingMessage) => void,
    ) => {
      httpsMock.lastOptions = options
      return httpsMock.get(url, callback)
    },
  },
}))

function mockResponse(
  statusCode: number,
  body = '',
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = new PassThrough()
  Object.assign(stream, { statusCode, headers })
  // Deliver after a macrotask so readline has attached to the stream first.
  setTimeout(() => {
    stream.write(body)
    stream.end()
  }, 0)
  return stream as unknown as IncomingMessage
}

function presetByUrl(url: string): (typeof CATEGORY_PRESETS)[number] | undefined {
  return CATEGORY_PRESETS.find((preset) => preset.url === url)
}

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-categories-'))
  dirs.push(dir)
  return dir
}

async function setStateFile(dir: string, state: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, 'category-presets.json'), JSON.stringify(state), 'utf8')
}

async function writeListFile(dir: string, id: string, content: string): Promise<void> {
  const target = categoryListPath(dir, id)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

beforeEach(() => {
  httpsMock.get.mockReset()
  httpsMock.lastOptions = undefined
})

afterEach(async () => {
  resetCategoryBaseDir()
  httpsMock.get.mockReset()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('presets', () => {
  it('defines exactly the available four categories', () => {
    expect(CATEGORY_PRESETS.map((preset) => preset.id)).toEqual([
      'porn',
      'gambling',
      'ads',
      'social',
    ])
  })

  it('carries the requested fields on every preset', () => {
    for (const preset of CATEGORY_PRESETS) {
      expect(preset).toMatchObject({
        id: expect.any(String),
        name_ar: expect.any(String),
        name_en: expect.any(String),
        url: expect.stringMatching(/^https:\/\//),
        expected_count: expect.any(Number),
        color: expect.any(String),
        icon: expect.any(String),
      })
      expect(preset.url).toContain('raw.githubusercontent.com')
    }
  })

  it('resolves presets by id', () => {
    expect(findPreset('porn')?.name_en).toBe('Adult Content')
    expect(findPreset('does-not-exist')).toBeUndefined()
  })
})

describe('normalizeEntry', () => {
  it('lowercases and strips trailing dots', () => {
    expect(normalizeEntry('  BadExample.COM.  ')).toBe('badexample.com')
  })

  it('drops comments, blank lines and anything with whitespace', () => {
    expect(normalizeEntry('# comment')).toBe('')
    expect(normalizeEntry('')).toBe('')
    expect(normalizeEntry('0.0.0.0 example.com')).toBe('')
    expect(normalizeEntry('example.com evil.org')).toBe('')
  })
})

describe('downloadCategoryList', () => {
  const preset = CATEGORY_PRESETS.find((p) => p.id === 'ads')!

  it('streams, deduplicates and atomically swaps the list file', async () => {
    const dir = await tempDir()
    const target = categoryListPath(dir, 'ads')

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(200, 'Example.com\n# comment\nexample.com\n\nblocked.net\n'))
      return { on: vi.fn() }
    })

    const result = await downloadCategoryList(preset, target)

    expect(result.status).toBe('ok')
    expect(result.count).toBe(2)
    const content = await readFile(target, 'utf8')
    expect(content).toBe('example.com\nblocked.net\n')
    // Rollback safety: no temp file is left behind after a clean swap.
    await expect(readFile(`${target}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('forwards If-Modified-Since and reports not-modified on 304', async () => {
    const dir = await tempDir()
    const target = categoryListPath(dir, 'ads')

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(304))
      return { on: vi.fn() }
    })

    const result = await downloadCategoryList(preset, target, {
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    })

    expect(httpsMock.lastOptions?.headers?.['If-Modified-Since']).toBe(
      'Wed, 21 Oct 2026 07:28:00 GMT',
    )
    expect(result.status).toBe('not-modified')
  })

  it('keeps the previous file untouched on download failure', async () => {
    const dir = await tempDir()
    const target = categoryListPath(dir, 'ads')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'still-here.com\n', 'utf8')

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(503, 'Service Unavailable'))
      return { on: vi.fn() }
    })

    const result = await downloadCategoryList(preset, target)

    expect(result.status).toBe('error')
    expect(await readFile(target, 'utf8')).toBe('still-here.com\n')
    await expect(readFile(`${target}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('reports an error when the connection itself fails', async () => {
    const dir = await tempDir()
    httpsMock.get.mockImplementation(() => {
      throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')
    })

    const result = await downloadCategoryList(preset, categoryListPath(dir, 'ads'))
    expect(result.status).toBe('error')
    expect(result.error).toContain('ENOTFOUND')
  })

  it('fires progress callbacks for start and done', async () => {
    const dir = await tempDir()
    const target = categoryListPath(dir, 'ads')

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(200, 'one.com\ntwo.com\n'))
      return { on: vi.fn() }
    })

    const progress: CategoryProgress[] = []
    await downloadCategoryList(preset, target, { onProgress: (value) => progress.push(value) })

    expect(progress[0]?.phase).toBe('start')
    expect(progress[progress.length - 1]?.phase).toBe('done')
    expect(progress[progress.length - 1]?.domains).toBe(2)
  })
})

describe('state file', () => {
  it('writes and reads category state atomically', async () => {
    const dir = await tempDir()
    expect(await categoryStateExists(dir)).toBe(false)

    await setStateFile(dir, { ads: { enabled: true, count: 5 } })

    expect(await categoryStateExists(dir)).toBe(true)
    expect(await readCategoryState(dir)).toEqual({
      ads: { enabled: true, count: 5 },
    })
  })

  it('returns an empty map when no state exists yet', async () => {
    const dir = await tempDir()
    expect(await readCategoryState(dir)).toEqual({})
  })
})

describe('readEnabledPresetDomains', () => {
  it('merges domains from every enabled preset list', async () => {
    const dir = await tempDir()
    await setStateFile(dir, {
      ads: { enabled: true },
      social: { enabled: true },
      porn: { enabled: false },
    })
    await writeListFile(dir, 'ads', 'tracker.com\ntracker.com\n')
    await writeListFile(dir, 'social', 'social.net\n')

    const domains = await readEnabledPresetDomains(dir)
    expect(domains.sort()).toEqual(['social.net', 'tracker.com'])
  })

  it('ignores enabled presets with no downloaded list yet', async () => {
    const dir = await tempDir()
    await setStateFile(dir, { ads: { enabled: true } })

    expect(await readEnabledPresetDomains(dir)).toEqual([])
  })
})

describe('enableCategory / disableCategory / updateCategory', () => {
  it('enables: downloads the list, flips the flag and triggers a matcher reload', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    const onRulesChanged = vi.fn(async () => undefined)

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(
        mockResponse(200, 'porn-site.com\n', {
          'last-modified': 'Sun, 01 Jan 2026 00:00:00 GMT',
        }),
      )
      return { on: vi.fn() }
    })

    await enableCategory('porn', 'this-token-was-verified-upstream', {
      onRulesChanged,
    })

    expect(await readCategoryState(dir)).toEqual({
      porn: expect.objectContaining({ enabled: true, count: 1 }),
    })
    expect(await readFile(categoryListPath(dir, 'porn'), 'utf8')).toBe('porn-site.com\n')
    expect(onRulesChanged).toHaveBeenCalledTimes(1)
  })

  it('disables: keeps the list file but removes it from the matcher', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await setStateFile(dir, { social: { enabled: true, count: 1 } })
    await writeListFile(dir, 'social', 'social.net\n')
    const onRulesChanged = vi.fn(async () => undefined)

    await disableCategory('social', 'this-token-was-verified-upstream', {
      onRulesChanged,
    })

    expect((await readCategoryState(dir)).social?.enabled).toBe(false)
    expect(await readFile(categoryListPath(dir, 'social'), 'utf8')).toBe('social.net\n')
    expect(onRulesChanged).toHaveBeenCalledTimes(1)
  })

  it('update re-downloads atomically and swaps in the new list', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await setStateFile(dir, {
      ads: { enabled: true, lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' },
    })
    await writeListFile(dir, 'ads', 'old-tracker.com\n')

    const calls: string[] = []
    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      calls.push(httpsMock.lastOptions?.headers?.['If-Modified-Since'] ?? '')
      callback(mockResponse(200, 'new-tracker.com\n'))
      return { on: vi.fn() }
    })

    await updateCategory('ads')

    expect(await readFile(categoryListPath(dir, 'ads'), 'utf8')).toBe('new-tracker.com\n')
    expect(calls[0]).toBe('Wed, 21 Oct 2026 07:28:00 GMT')
    expect((await readCategoryState(dir)).ads?.lastUpdatedAt).toEqual(expect.any(String))
  })

  it('rejects unknown category ids', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await expect(updateCategory('nonexistent', { baseDir: dir })).rejects.toThrow(
      'Unknown category preset',
    )
  })

  it('throws when the base directory is not configured', async () => {
    await expect(updateCategory('ads')).rejects.toThrow('data directory is not set')
  })
})

describe('bootstrapCategories', () => {
  it('initializes defaults, downloads enabled presets on first run, then reloads', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    const onRulesChanged = vi.fn(async () => undefined)

    const downloaded: string[] = []
    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      const url = String(_url)
      downloaded.push(presetByUrl(url)?.id ?? 'unknown')
      callback(mockResponse(200, 'bootstrap-domain.com\n'))
      return { on: vi.fn() }
    })

    await bootstrapCategories({ onRulesChanged })

    // Only the default-enabled presets (ads, social) get downloaded.
    expect(downloaded).toEqual(['ads', 'social'])
    const state = await readCategoryState(dir)
    expect(state.ads?.enabled).toBe(true)
    expect(state.social?.enabled).toBe(true)
    expect(state.porn?.enabled).toBe(false)
    expect(onRulesChanged).toHaveBeenCalledTimes(1)
    expect(await readEnabledPresetDomains(dir)).toEqual(['bootstrap-domain.com'])
  })

  it('does not re-download existing presets on later runs', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await setStateFile(dir, { ads: { enabled: true, lastUpdatedAt: '2026-01-01T00:00:00.000Z' } })
    await writeListFile(dir, 'ads', 'already-there.com\n')

    const onRulesChanged = vi.fn(async () => undefined)
    const downloads = vi.fn()
    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      downloads()
      callback(mockResponse(200, 'never-called.com\n'))
      return { on: vi.fn() }
    })

    await bootstrapCategories({ onRulesChanged })

    expect(downloads).not.toHaveBeenCalled()
    expect(await readFile(categoryListPath(dir, 'ads'), 'utf8')).toBe('already-there.com\n')
  })
})

describe('refreshEnabledCategories', () => {
  it('re-downloads every enabled preset and reloads the matcher once each', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await setStateFile(dir, { ads: { enabled: true }, social: { enabled: true } })

    const onRulesChanged = vi.fn(async () => undefined)
    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(200, 'fresh.com\n'))
      return { on: vi.fn() }
    })

    await refreshEnabledCategories({ onRulesChanged })

    expect(httpsMock.get).toHaveBeenCalledTimes(2)
    expect(onRulesChanged).toHaveBeenCalledTimes(2)
    expect(await readEnabledPresetDomains(dir)).toEqual(['fresh.com'])
  })
})

describe('scheduleDailyUpdate', () => {
  it('registers a repeating timer and the stop handle clears it', () => {
    vi.useFakeTimers()
    try {
      const handle = scheduleDailyUpdate({})
      expect(vi.getTimerCount()).toBe(1)

      handle.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('custom categories', () => {
  it('addCustomCategory downloads, persists and enables a custom list', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    const onRulesChanged = vi.fn(async () => undefined)

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(200, 'custom-block.com\n', { 'last-modified': 'Sat, 12 Sep 2026 00:00:00 GMT' }))
      return { on: vi.fn() }
    })

    const info = await addCustomCategory(
      { name: 'إعلاناتي', url: 'https://example.com/custom.txt', color: '#ff0000' },
      { onRulesChanged },
    )

    expect(info.kind).toBe('custom')
    expect(info.enabled).toBe(true)
    expect(info.name).toBe('إعلاناتي')
    expect(info.count).toBe(1)
    expect((await readCustomCategories(dir)).some((c) => c.id === info.id)).toBe(true)
    expect(await readFile(categoryListPath(dir, info.id), 'utf8')).toBe('custom-block.com\n')
    expect(onRulesChanged).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid category URLs', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await expect(
      addCustomCategory({ name: 'Bad', url: 'not-a-url', color: '#000000' }, { baseDir: dir }),
    ).rejects.toThrow('Invalid category URL')
    await expect(
      addCustomCategory({ name: 'Bad', url: 'ftp://example.com/list.txt', color: '#000000' }, { baseDir: dir }),
    ).rejects.toThrow('must use http or https')
  })

  it('rejects an empty name', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await expect(
      addCustomCategory({ name: '  ', url: 'https://example.com/list.txt', color: '#000000' }, { baseDir: dir }),
    ).rejects.toThrow('non-empty string')
  })

  it('removeCustomCategory drops the entry, the list file and reloads', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(200, 'temporary.com\n'))
      return { on: vi.fn() }
    })
    const added = await addCustomCategory({ name: 'Temp', url: 'https://example.com/t.txt', color: '#000000' })

    const onRulesChanged = vi.fn(async () => undefined)
    await removeCustomCategory(added.id, { onRulesChanged })

    expect((await readCustomCategories(dir)).some((c) => c.id === added.id)).toBe(false)
    await expect(readFile(categoryListPath(dir, added.id), 'utf8')).rejects.toThrow()
    expect(onRulesChanged).toHaveBeenCalledTimes(1)
  })

  it('updateCategoryEntry re-downloads a custom category with If-Modified-Since', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    const onRulesChanged = vi.fn(async () => undefined)

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(
        mockResponse(200, 'new-custom-block.com\n', {
          'last-modified': 'Sat, 12 Sep 2026 00:00:00 GMT',
        }),
      )
      return { on: vi.fn() }
    })
    const added = await addCustomCategory({ name: 'Custom', url: 'https://example.com/c.txt', color: '#000000' })
    const headers: string[] = []
    httpsMock.lastOptions = undefined
    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      headers.push(httpsMock.lastOptions?.headers?.['If-Modified-Since'] ?? '')
      callback(mockResponse(200, 'fresher.com\n'))
      return { on: vi.fn() }
    })

    const result = await updateCategoryEntry(added.id, { onRulesChanged })

    expect(result.status).toBe('ok')
    expect(await readFile(categoryListPath(dir, added.id), 'utf8')).toBe('fresher.com\n')
    expect(headers[0]).toBe('Sat, 12 Sep 2026 00:00:00 GMT')
    expect(onRulesChanged).toHaveBeenCalled()
  })

  it('enabled custom lists feed the DNS matcher through readEnabledPresetDomains', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)

    httpsMock.get.mockImplementation((_url: string, callback: (res: IncomingMessage) => void) => {
      callback(mockResponse(200, 'custom-dns.com\n'))
      return { on: vi.fn() }
    })
    const added = await addCustomCategory({ name: 'DNS', url: 'https://example.com/d.txt', color: '#000000' })

    expect(await readEnabledPresetDomains(dir)).toEqual(['custom-dns.com'])
    await setCategoryEnabled(added.id, false, { baseDir: dir })
    expect(await readEnabledPresetDomains(dir)).toEqual([])
  })
})

describe('readCategoriesOverview', () => {
  it('merges built-in presets and customs with their live state', async () => {
    const dir = await tempDir()
    setCategoryBaseDir(dir)
    await setStateFile(dir, { ads: { enabled: true, count: 7 } })

    const overview = await readCategoriesOverview(dir)
    const ads = overview.find((c) => c.id === 'ads')
    expect(ads).toMatchObject({ kind: 'preset', name: 'الإعلانات', enabled: true, count: 7 })
    expect(overview.length).toBe(CATEGORY_PRESETS.length)
  })
})

describe('searchCategoryPatterns', () => {
  it('filters the downloaded list by substring and reports totals', async () => {
    const dir = await tempDir()
    const target = categoryListPath(dir, 'ads')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'tracker.com\ntracker2.com\nshop.com\n', 'utf8')

    const all = await searchCategoryPatterns(dir, 'ads', '')
    expect(all.total).toBe(3)
    expect(all.domains).toHaveLength(3)

    const filtered = await searchCategoryPatterns(dir, 'ads', 'tracker')
    expect(filtered.domains).toEqual(['tracker.com', 'tracker2.com'])
  })

  it('returns empty results for a missing list file', async () => {
    const dir = await tempDir()
    expect(await searchCategoryPatterns(dir, 'ads', 'x')).toEqual({ total: 0, domains: [] })
  })
})
