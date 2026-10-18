import { readFile, rename, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'

export interface BlockEvent {
  ts: number
  domain: string
  rule: string
}

export interface BlockAggregate {
  count: number
  firstSeen: number
  lastSeen: number
}

export interface StatsSnapshot {
  queries: number
  blocks: number
  blocksToday: number
  cacheHits: number
  cacheMisses: number
  dropped: number
  upstreamFailures: number
  byDomain: Record<string, BlockAggregate>
  recentBlocks: BlockEvent[]
  topDomains: Array<{ domain: string; count: number }>
}

interface PersistedStats {
  queries: number
  cacheHits: number
  cacheMisses: number
  dropped: number
  upstreamFailures: number
  blocksByDay: Record<string, number>
  byDomain: Record<string, BlockAggregate>
  recentBlocks: BlockEvent[]
}

const RECENT_LIMIT = 100

/**
 * In-memory aggregate table of DNS filter activity (every block, dropped
 * queries, cache behavior and upstream failures) with JSON persistence.
 * "Table" here is a Map keyed by domain/date — the same shape a SQL table
 * would expose via queries like totalBlocks() / topDomains() / blocksToday().
 */
export class StatsTable {
  private queries = 0
  private cacheHits = 0
  private cacheMisses = 0
  private dropped = 0
  private upstreamFailures = 0
  private blocksByDay = new Map<string, number>()
  private byDomain = new Map<string, BlockAggregate>()
  private recentBlocks: BlockEvent[] = []

  recordQuery(): void {
    this.queries += 1
  }

  recordCacheHit(): void {
    this.cacheHits += 1
  }

  recordCacheMiss(): void {
    this.cacheMisses += 1
  }

  recordDrop(): void {
    this.dropped += 1
  }

  recordUpstreamFailure(): void {
    this.upstreamFailures += 1
  }

  recordBlock(domain: string, rule: string, now: number = Date.now()): void {
    const day = dateKey(now)

    this.blocksByDay.set(day, (this.blocksByDay.get(day) ?? 0) + 1)

    const aggregate = this.byDomain.get(domain)
    if (aggregate === undefined) {
      this.byDomain.set(domain, { count: 1, firstSeen: now, lastSeen: now })
    } else {
      aggregate.count += 1
      aggregate.lastSeen = now
    }

    this.recentBlocks.push({ ts: now, domain, rule })
    if (this.recentBlocks.length > RECENT_LIMIT) {
      this.recentBlocks = this.recentBlocks.slice(-RECENT_LIMIT)
    }
  }

  totalBlocks(): number {
    let total = 0
    for (const count of this.blocksByDay.values()) {
      total += count
    }
    return total
  }

  blocksToday(now: number = Date.now()): number {
    return this.blocksByDay.get(dateKey(now)) ?? 0
  }

  topDomains(limit = 10): Array<{ domain: string; count: number }> {
    return [...this.byDomain.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([domain, aggregate]) => ({ domain, count: aggregate.count }))
  }

  snapshot(now: number = Date.now()): StatsSnapshot {
    return {
      queries: this.queries,
      blocks: this.totalBlocks(),
      blocksToday: this.blocksToday(now),
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      dropped: this.dropped,
      upstreamFailures: this.upstreamFailures,
      byDomain: Object.fromEntries(this.byDomain.entries()),
      recentBlocks: [...this.recentBlocks],
      topDomains: this.topDomains(10),
    }
  }

  toJSON(): PersistedStats {
    return {
      queries: this.queries,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      dropped: this.dropped,
      upstreamFailures: this.upstreamFailures,
      blocksByDay: Object.fromEntries(this.blocksByDay.entries()),
      byDomain: Object.fromEntries(this.byDomain.entries()),
      recentBlocks: this.recentBlocks,
    }
  }

  static fromJSON(data: PersistedStats): StatsTable {
    const stats = new StatsTable()
    stats.queries = data.queries
    stats.cacheHits = data.cacheHits
    stats.cacheMisses = data.cacheMisses
    stats.dropped = data.dropped
    stats.upstreamFailures = data.upstreamFailures
    stats.blocksByDay = new Map(Object.entries(data.blocksByDay ?? {}))
    stats.byDomain = new Map(Object.entries(data.byDomain ?? {}))
    stats.recentBlocks = Array.isArray(data.recentBlocks) ? data.recentBlocks.slice(-RECENT_LIMIT) : []
    return stats
  }

  async loadFile(filePath: string): Promise<void> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const existing = StatsTable.fromJSON(parsed as PersistedStats)
        this.queries = existing.queries
        this.cacheHits = existing.cacheHits
        this.cacheMisses = existing.cacheMisses
        this.dropped = existing.dropped
        this.upstreamFailures = existing.upstreamFailures
        this.blocksByDay = existing.blocksByDay
        this.byDomain = existing.byDomain
        this.recentBlocks = existing.recentBlocks
      }
    } catch {
      // Missing or corrupt stats file: start from an empty table.
    }
  }

  async saveFile(filePath: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`
    await writeFile(tmpPath, JSON.stringify(this.toJSON(), null, 2) + EOL, 'utf8')
    await rename(tmpPath, filePath)
  }
}

function dateKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}