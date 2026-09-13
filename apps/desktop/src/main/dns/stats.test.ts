import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StatsTable } from './stats'

const X = new Date('2026-01-15T10:00:00Z').getTime()

describe('StatsTable', () => {
  it('aggregates blocks per domain and per day', () => {
    const stats = new StatsTable()
    stats.recordBlock('blocked.com', 'exact', X)
    stats.recordBlock('blocked.com', 'exact', X + 1000)
    stats.recordBlock('other.com', 'wildcard', X)

    expect(stats.totalBlocks()).toBe(3)
    expect(stats.blocksToday(X)).toBe(3)
    expect(stats.topDomains()).toEqual([
      { domain: 'blocked.com', count: 2 },
      { domain: 'other.com', count: 1 },
    ])
  })

  it('resets the daily counter on a new day', () => {
    const stats = new StatsTable()
    stats.recordBlock('a.com', 'exact', X)
    const nextDay = new Date('2026-01-16T00:00:00Z').getTime()
    expect(stats.blocksToday(nextDay)).toBe(0)
    stats.recordBlock('a.com', 'exact', nextDay)
    expect(stats.blocksToday(nextDay)).toBe(1)
  })

  it('tracks cache, drops and upstream failures', () => {
    const stats = new StatsTable()
    stats.recordQuery()
    stats.recordQuery()
    stats.recordCacheHit()
    stats.recordCacheMiss()
    stats.recordDrop()
    stats.recordUpstreamFailure()
    stats.recordBlock('x.com', 'keyword', X)

    const snapshot = stats.snapshot(X)
    expect(snapshot.queries).toBe(2)
    expect(snapshot.cacheHits).toBe(1)
    expect(snapshot.cacheMisses).toBe(1)
    expect(snapshot.dropped).toBe(1)
    expect(snapshot.upstreamFailures).toBe(1)
    expect(snapshot.blocks).toBe(1)
  })

  it('persists and reloads from JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'focuslock-stats-'))
    const filePath = join(dir, 'stats.json')
    try {
      const stats = new StatsTable()
      stats.recordQuery()
      stats.recordBlock('a.com', 'exact', X)
      stats.recordBlock('b.com', 'keyword', X)
      await stats.saveFile(filePath)

      const reloaded = new StatsTable()
      await reloaded.loadFile(filePath)
      expect(reloaded.totalBlocks()).toBe(2)
      expect(reloaded.blocksToday(X)).toBe(2)
      expect(reloaded.snapshot(X).queries).toBe(1)
      expect(reloaded.snapshot(X).byDomain['a.com']?.count).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores a missing stats file', async () => {
    const stats = new StatsTable()
    await stats.loadFile(join(tmpdir(), 'does-not-exist.json'))
    expect(stats.totalBlocks()).toBe(0)
  })
})