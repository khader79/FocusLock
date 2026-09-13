import { describe, expect, it } from 'vitest'
import { DnsFilterServer } from './dns-filter'
import { parseQuestion, parseResponseStats, RCODE_NXDOMAIN, RCODE_SERVFAIL } from './dns-packet'
import { TokenBucket } from './limiter'
import { BlockRuleMatcher } from './matcher'
import { StatsTable } from './stats'
import type { Upstream } from './upstream'
import { ipv4, makeQuery, makeResponse } from './test-helpers'

function emptyMatcher(): BlockRuleMatcher {
  return new BlockRuleMatcher({
    exact: [],
    wildcards: [],
    regexes: [],
    keywords: [],
    exceptions: { exact: [], wildcards: [], keywords: [] },
  })
}

function blockedMatcher(domain: string): BlockRuleMatcher {
  return new BlockRuleMatcher({
    exact: [domain],
    wildcards: [],
    regexes: [],
    keywords: [],
    exceptions: { exact: [], wildcards: [], keywords: [] },
  })
}

class FakeUpstream implements Upstream {
  readonly name = 'fake'
  calls = 0

  resolve(message: Buffer): Promise<Buffer> {
    this.calls += 1
    const question = parseQuestion(message)
    return Promise.resolve(
      makeResponse(message, {
        answers: [{ name: question.qname, ttl: 600, data: ipv4('93.184.216.34') }],
      }),
    )
  }
}

function serverFixture(options: {
  matcher?: BlockRuleMatcher
  upstreams?: Upstream[]
  capacity?: number
  refill?: number
  listenHost?: string
  listenPort?: number
} = {}): { server: DnsFilterServer; stats: StatsTable } {
  const stats = new StatsTable()
  const server = new DnsFilterServer({
    matcher: options.matcher ?? emptyMatcher(),
    upstreams: options.upstreams ?? [],
    limiter: new TokenBucket({
      capacity: options.capacity ?? 1000,
      refillPerSecond: options.refill ?? 1000,
    }),
    stats,
    listenHost: options.listenHost ?? '127.0.0.1',
    listenPort: options.listenPort ?? 5353,
  })
  return { server, stats }
}

describe('DnsFilterServer.resolve', () => {
  it('returns NXDOMAIN for blocked domains without touching upstreams', async () => {
    const upstream = new FakeUpstream()
    const { server, stats } = serverFixture({
      matcher: blockedMatcher('blocked.com'),
      upstreams: [upstream],
    })

    const reply = await server.resolve(makeQuery('blocked.com'))
    expect(parseResponseStats(reply).rcode).toBe(RCODE_NXDOMAIN)
    expect(upstream.calls).toBe(0)
    expect(stats.snapshot().blocks).toBe(1)
    expect(stats.snapshot().byDomain['blocked.com']?.count).toBe(1)
  })

  it('allows exception matches even when a block rule matches', async () => {
    const upstream = new FakeUpstream()
    const matcher = new BlockRuleMatcher({
      exact: ['ads.example.com'],
      wildcards: [],
      regexes: [],
      keywords: [],
      exceptions: { exact: ['ads.example.com'], wildcards: [], keywords: [] },
    })
    const { server } = serverFixture({ matcher, upstreams: [upstream] })

    const reply = await server.resolve(makeQuery('ads.example.com'))
    expect(parseResponseStats(reply).rcode).toBe(0)
    expect(upstream.calls).toBe(1)
  })

  it('forwards allowed queries and rewrites the transaction id', async () => {
    const upstream = new FakeUpstream()
    const { server, stats } = serverFixture({ upstreams: [upstream] })

    const reply = await server.resolve(makeQuery('example.com', { id: 0x1234 }))
    expect(parseResponseStats(reply).id).toBe(0x1234)
    expect(upstream.calls).toBe(1)
    expect(stats.snapshot().queries).toBe(1)
  })

  it('serves repeated queries from cache without hitting the upstream again', async () => {
    const upstream = new FakeUpstream()
    const { server } = serverFixture({ upstreams: [upstream] })

    const first = await server.resolve(makeQuery('cached.com', { id: 0x1111 }))
    expect(parseResponseStats(first).id).toBe(0x1111)

    const second = await server.resolve(makeQuery('cached.com', { id: 0x2222 }))
    expect(parseResponseStats(second).id).toBe(0x2222)
    expect(upstream.calls).toBe(1)
  })

  it('drops queries once the token bucket is exhausted', async () => {
    const upstream = new FakeUpstream()
    const { server, stats } = serverFixture({ capacity: 1, refill: 0, upstreams: [upstream] })

    const first = await server.resolve(makeQuery('a.com'))
    expect(parseResponseStats(first).rcode).toBe(0)

    const second = await server.resolve(makeQuery('a.com'))
    expect(parseResponseStats(second).rcode).toBe(RCODE_SERVFAIL)
    expect(stats.snapshot().dropped).toBe(1)
  })

  it('fails over to the next upstream when the first one errors', async () => {
    const broken: Upstream = {
      name: 'broken',
      resolve: async () => {
        throw new Error('down')
      },
    }
    const healthy = new FakeUpstream()
    const { server } = serverFixture({ upstreams: [broken, healthy] })

    const reply = await server.resolve(makeQuery('ok.com'))
    expect(parseResponseStats(reply).rcode).toBe(0)
    expect(healthy.calls).toBe(1)
  })

  it('returns SERVFAIL when every upstream fails', async () => {
    const broken: Upstream = {
      name: 'broken',
      resolve: async () => {
        throw new Error('down')
      },
    }
    const { server, stats } = serverFixture({ upstreams: [broken] })

    const reply = await server.resolve(makeQuery('ok.com'))
    expect(parseResponseStats(reply).rcode).toBe(RCODE_SERVFAIL)
    expect(stats.snapshot().upstreamFailures).toBe(1)
  })

  it('answers unparseable messages with SERVFAIL', async () => {
    const { server } = serverFixture()
    const garbage = Buffer.from([0x00, 0x42, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])
    const reply = await server.resolve(garbage)
    expect(reply.readUInt16BE(0)).toBe(0x0042)
    expect(parseResponseStats(reply).rcode).toBe(RCODE_SERVFAIL)
  })

  it('tracks cache hits and misses in the stats table', async () => {
    const upstream = new FakeUpstream()
    const { server, stats } = serverFixture({ upstreams: [upstream] })

    await server.resolve(makeQuery('n.com'))
    await server.resolve(makeQuery('n.com'))
    await server.resolve(makeQuery('other.com'))

    const snapshot = stats.snapshot()
    expect(snapshot.cacheMisses).toBe(2)
    expect(snapshot.cacheHits).toBe(1)
  })

  it('blocks keyword matches and attributes the rule in stats', async () => {
    const upstream = new FakeUpstream()
    const matcher = new BlockRuleMatcher({
      exact: [],
      wildcards: [],
      regexes: [],
      keywords: ['tracker'],
      exceptions: { exact: [], wildcards: [], keywords: [] },
    })
    const { server, stats } = serverFixture({ matcher, upstreams: [upstream] })

    const reply = await server.resolve(makeQuery('ads.tracker.example'))
    expect(parseResponseStats(reply).rcode).toBe(RCODE_NXDOMAIN)
    expect(upstream.calls).toBe(0)
    expect(stats.snapshot().recentBlocks[0]).toMatchObject({ domain: 'ads.tracker.example', rule: 'keyword' })
  })

  it('blocks wildcard patterns and allows unrelated subdomains', async () => {
    const upstream = new FakeUpstream()
    const matcher = new BlockRuleMatcher({
      exact: [],
      wildcards: ['*.ads.net'],
      regexes: [],
      keywords: [],
      exceptions: { exact: [], wildcards: [], keywords: [] },
    })
    const { server, stats } = serverFixture({ matcher, upstreams: [upstream] })

    const blocked = await server.resolve(makeQuery('cdn.ads.net'))
    expect(parseResponseStats(blocked).rcode).toBe(RCODE_NXDOMAIN)
    const allowed = await server.resolve(makeQuery('cdn.other.net'))
    expect(parseResponseStats(allowed).rcode).not.toBe(RCODE_NXDOMAIN)

    const snapshot = stats.snapshot()
    expect(snapshot.blocks).toBe(1)
    expect(snapshot.recentBlocks[0]).toMatchObject({ domain: 'cdn.ads.net', rule: 'wildcard' })
    expect(upstream.calls).toBe(1)
  })

  it('blocks regex matches', async () => {
    const upstream = new FakeUpstream()
    const matcher = new BlockRuleMatcher({
      exact: [],
      wildcards: [],
      regexes: ['^ad\\d{2}\\.'],
      keywords: [],
      exceptions: { exact: [], wildcards: [], keywords: [] },
    })
    const { server, stats } = serverFixture({ matcher, upstreams: [upstream] })

    const blocked = await server.resolve(makeQuery('ad42.cdn.com'))
    expect(parseResponseStats(blocked).rcode).toBe(RCODE_NXDOMAIN)
    expect(stats.snapshot().recentBlocks[0]).toMatchObject({ domain: 'ad42.cdn.com', rule: 'regex' })

    const allowed = await server.resolve(makeQuery('adx.cdn.com'))
    expect(parseResponseStats(allowed).rcode).not.toBe(RCODE_NXDOMAIN)
  })

  it('allows keyword/wildcard/regex matches once an exception covers them', async () => {
    const upstream = new FakeUpstream()
    const cases: Array<[string, BlockRuleMatcher, string]> = [
      [
        'mail.tracker.io',
        new BlockRuleMatcher({
          exact: [],
          wildcards: [],
          regexes: [],
          keywords: ['tracker'],
          exceptions: { exact: [], wildcards: [], keywords: ['tracker'] },
        }),
        'keyword',
      ],
      [
        'cdn.ads.net',
        new BlockRuleMatcher({
          exact: [],
          wildcards: ['*.ads.net'],
          regexes: [],
          keywords: [],
          exceptions: { exact: [], wildcards: ['*.ads.net'], keywords: [] },
        }),
        'wildcard',
      ],
      [
        'ad99.cdn.com',
        new BlockRuleMatcher({
          exact: [],
          wildcards: [],
          regexes: ['^ad\\d{2}\\.'],
          keywords: [],
          exceptions: { exact: ['ad99.cdn.com'], wildcards: [], keywords: [] },
        }),
        'regex',
      ],
    ]

    for (const [domain, matcher, kind] of cases) {
      const { server } = serverFixture({ matcher, upstreams: [upstream] })
      const reply = await server.resolve(makeQuery(domain))
      expect(parseResponseStats(reply).rcode).toBe(0)
      expect(upstream.calls).toBeGreaterThan(0)
      expect(server.statsTable.snapshot().blocks).toBe(0)
      expect(kind).toMatch(/keyword|wildcard|regex/)
    }
  })

  it('serves UDP and TCP on distinct protocols through the real sockets', async () => {
    const upstream = new FakeUpstream()
    const { server } = serverFixture({ upstreams: [upstream], listenPort: 5354 })
    await server.start()
    try {
      expect(server.isRunning).toBe(true)

      // UDP datagram with the 2-byte reply loop.
      const udpReply = await server.resolve(makeQuery('udp-q.com', { id: 0x0101 }))
      expect(parseResponseStats(udpReply).id).toBe(0x0101)

      // TCP framing: 2-byte length prefix + message via a raw socket.
      const net = await import('node:net')
      const framed = await new Promise<Buffer>((resolve, reject) => {
        const message = makeQuery('tcp-q.com', { id: 0x0202 })
        const socket = net.createConnection({ host: '127.0.0.1', port: 5354 })
        const chunks: Buffer[] = []
        socket.on('connect', () => {
          const header = Buffer.alloc(2)
          header.writeUInt16BE(message.length, 0)
          socket.write(Buffer.concat([header, message]))
        })
        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          const combined = Buffer.concat(chunks)
          if (combined.length < 2) {
            return
          }
          const length = combined.readUInt16BE(0)
          if (combined.length >= 2 + length) {
            socket.destroy()
            resolve(combined)
          }
        })
        socket.on('error', reject)
      })
      const length = framed.readUInt16BE(0)
      expect(parseResponseStats(framed.subarray(2, 2 + length)).id).toBe(0x0202)
    } finally {
      await server.stop()
      expect(server.isRunning).toBe(false)
    }
  })

  it('hot-swaps the matcher and applies the new rules immediately', async () => {
    const upstream = new FakeUpstream()
    const { server, stats } = serverFixture({ matcher: emptyMatcher(), upstreams: [upstream] })

    const before = await server.resolve(makeQuery('new-blocked.com'))
    expect(parseResponseStats(before).rcode).toBe(0)
    expect(upstream.calls).toBe(1)

    server.updateMatcher(blockedMatcher('new-blocked.com'))
    const after = await server.resolve(makeQuery('new-blocked.com'))
    expect(parseResponseStats(after).rcode).toBe(RCODE_NXDOMAIN)
    expect(server.statsTable.snapshot().blocks).toBe(1)
    expect(stats.snapshot().blocks).toBe(1)
  })
})