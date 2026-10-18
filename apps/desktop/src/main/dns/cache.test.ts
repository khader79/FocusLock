import { describe, expect, it } from 'vitest'
import { DnsCache, LruCache } from './cache'
import { parseResponseStats } from './dns-packet'
import { ipv4, makeQuery, makeResponse } from './test-helpers'

describe('LruCache', () => {
  it('evicts the least recently used entry when over capacity', () => {
    const cache = new LruCache<string>(2)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('2')
  })

  it('refreshes recency on get', () => {
    const cache = new LruCache<string>(2)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.get('a') // 'a' becomes most recent
    cache.set('c', '3')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('1')
  })
})

describe('DnsCache', () => {
  function responseWithTtl(minTtl: number, rcode = 0): Buffer {
    return makeResponse(makeQuery('cached.com'), {
      rcode,
      answers: [{ name: 'cached.com', ttl: minTtl, data: ipv4('1.2.3.4') }],
    })
  }

  it('caps positive TTLs at 300 seconds', () => {
    const cache = new DnsCache()
    const response = responseWithTtl(3600)
    const stats = parseResponseStats(response)
    const ttl = cache.store(cache.key('cached.com', 1, 1), response, stats, 0)
    expect(ttl).toBe(300)
  })

  it('caps negative responses at 30 seconds', () => {
    const cache = new DnsCache()
    const response = responseWithTtl(3600, 3) // NXDOMAIN
    const stats = parseResponseStats(response)
    const ttl = cache.store(cache.key('cached.com', 1, 1), response, stats, 0)
    expect(ttl).toBe(30)
  })

  it('returns hits with remaining TTL and decremented record TTLs', () => {
    const cache = new DnsCache()
    const response = responseWithTtl(300)
    const stats = parseResponseStats(response)
    cache.store(cache.key('cached.com', 1, 1), response, stats, 0)

    const hit = cache.get(cache.key('cached.com', 1, 1), 100_000)
    expect(hit).toBeDefined()
    expect(hit!.remaining).toBe(200)
    expect(parseResponseStats(hit!.buffer).minTtl).toBe(200)
  })

  it('expires entries after their TTL elapses', () => {
    const cache = new DnsCache({ negativeTtl: 10 })
    const response = responseWithTtl(300)
    const stats = parseResponseStats(response)
    const key = cache.key('cached.com', 1, 1)
    cache.store(key, response, stats, 0)

    expect(cache.get(key, 299_999)).toBeDefined()
    expect(cache.get(key, 300_000)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('evicts old entries when the cache fills up', () => {
    const cache = new DnsCache({ maxEntries: 2, positiveTtl: 300 })
    const store = (domain: string, ttl: number): void => {
      const response = makeResponse(makeQuery(domain), {
        answers: [{ name: domain, ttl, data: ipv4('1.2.3.4') }],
      })
      cache.store(cache.key(domain, 1, 1), response, parseResponseStats(response), 0)
    }
    store('one.com', 300)
    store('two.com', 300)
    store('three.com', 300)
    expect(cache.size).toBe(2)
    expect(cache.get(cache.key('one.com', 1, 1))).toBeUndefined()
  })
})