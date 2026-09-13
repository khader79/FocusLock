import { describe, expect, it } from 'vitest'
import { makeQuery, makeResponse } from './test-helpers'
import { DohUpstream, resolveWithFailover, type Upstream } from './upstream'

type FetchCall = { url: string; init?: RequestInit }

function fakeFetch(
  responses: Buffer[],
  failWith?: Error,
): { fetchImpl: typeof fetch; calls: FetchCall[]; failures: number } {
  const calls: FetchCall[] = []
  const failures = { value: 0 }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (next === undefined) {
      return makeResponse(makeQuery('default.com'))
    }
    if (failWith !== undefined) {
      failures.value += 1
      throw failWith
    }
    return {
      ok: true,
      arrayBuffer: async () =>
        next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength),
    } as Response
  }) as typeof fetch
  return { fetchImpl, calls, failures: failures.value }
}

describe('DohUpstream', () => {
  it('sends the raw query as a DNS-over-HTTPS message', async () => {
    const expected = makeResponse(makeQuery('example.com'))
    const { fetchImpl, calls } = fakeFetch([expected])
    const upstream = new DohUpstream('cloudflare', 'https://cloudflare.test/dns-query', {
      fetchImpl,
    })

    const query = makeQuery('example.com')
    const result = await upstream.resolve(query)

    expect(result.equals(expected)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://cloudflare.test/dns-query')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/dns-message' })
    expect(Buffer.from(calls[0]?.init?.body as Uint8Array)).toEqual(query)
  })

  it('rejects non-OK HTTP responses', async () => {
    const calls: FetchCall[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return { ok: false, status: 403, statusText: 'Forbidden' } as Response
    }) as typeof fetch

    const upstream = new DohUpstream('cloudflare', 'https://cloudflare.test/dns-query', {
      fetchImpl,
    })
    await expect(upstream.resolve(makeQuery('example.com'))).rejects.toThrow(/HTTP 403/)
  })
})

describe('resolveWithFailover', () => {
  it('returns the first successful upstream', async () => {
    const throwing: Upstream = {
      name: 'bad',
      resolve: async () => {
        throw new Error('refused')
      },
    }
    const response = makeResponse(makeQuery('example.com'))
    const working: Upstream = {
      name: 'good',
      resolve: async () => response,
    }

    const result = await resolveWithFailover([throwing, working], makeQuery('example.com'))
    expect(result.upstream).toBe('good')
    expect(result.response.equals(response)).toBe(true)
  })

  it('throws when every upstream fails', async () => {
    const bad: Upstream = {
      name: 'a',
      resolve: async () => {
        throw new Error('boom')
      },
    }
    await expect(resolveWithFailover([bad, bad], makeQuery('example.com'))).rejects.toThrow(
      /All DNS upstreams failed/,
    )
  })

  it('throws when no upstreams are configured', async () => {
    await expect(resolveWithFailover([], makeQuery('example.com'))).rejects.toThrow(
      /No DNS upstreams/,
    )
  })
})