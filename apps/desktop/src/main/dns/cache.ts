import { decrementTtls, type ResponseStats } from './dns-packet'

interface DnsCacheEntry {
  buffer: Buffer
  storedAt: number
  ttl: number
}

export interface DnsCacheOptions {
  /** Maximum number of cached DNS messages (LRU eviction). */
  maxEntries?: number
  /** Cap for positive (answered) responses, in seconds. */
  positiveTtl?: number
  /** Cap for negative responses (NXDOMAIN / empty answers), in seconds. */
  negativeTtl?: number
}

export interface CachedResponse {
  buffer: Buffer
  remaining: number
}

function defaultOptions(): Required<DnsCacheOptions> {
  return {
    maxEntries: 4096,
    positiveTtl: 300,
    negativeTtl: 30,
  }
}

/**
 * Generic least-recently-used cache backed by an insertion-ordered Map.
 * get() and set() both refresh recency.
 */
export class LruCache<V> {
  private readonly capacity: number
  private readonly map = new Map<string, V>()

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
  }

  get size(): number {
    return this.map.size
  }

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) {
      return undefined
    }
    // Refresh: delete + reinsert puts the key at the most-recent position.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    }
    this.map.set(key, value)

    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.map.delete(oldest)
      }
    }
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  delete(key: string): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

/**
 * DNS response cache. Stores raw response messages with a TTL derived from the
 * response's smallest record TTL, capped at 300s (and 30s for negative
 * responses). On a hit, returns a fresh buffer with elapsed TTLs decremented.
 */
export class DnsCache {
  private readonly options: Required<DnsCacheOptions>
  private readonly lru: LruCache<DnsCacheEntry>

  constructor(options: DnsCacheOptions = {}) {
    this.options = { ...defaultOptions(), ...options }
    this.lru = new LruCache(this.options.maxEntries)
  }

  get size(): number {
    return this.lru.size
  }

  clear(): void {
    this.lru.clear()
  }

  key(name: string, qtype: number, qclass: number): string {
    return `${name.toLowerCase()}|${qtype}|${qclass}`
  }

  store(key: string, response: Buffer, stats: ResponseStats, now: number = Date.now()): number {
    const isNegative = stats.rcode !== 0 || stats.ancount === 0
    const cap = isNegative ? this.options.negativeTtl : this.options.positiveTtl

    const minRecordTtl = Number.isFinite(stats.minTtl) ? Math.floor(stats.minTtl) : cap
    const ttl = Math.max(0, Math.min(cap, minRecordTtl))

    this.lru.set(key, {
      buffer: Buffer.from(response),
      storedAt: now,
      ttl,
    })
    return ttl
  }

  get(key: string, now: number = Date.now()): CachedResponse | undefined {
    const entry = this.lru.get(key)
    if (entry === undefined) {
      return undefined
    }

    const elapsed = Math.max(0, Math.floor((now - entry.storedAt) / 1000))
    if (elapsed >= entry.ttl) {
      this.lru.delete(key)
      return undefined
    }

    return {
      buffer: decrementTtls(entry.buffer, elapsed),
      remaining: entry.ttl - elapsed,
    }
  }
}