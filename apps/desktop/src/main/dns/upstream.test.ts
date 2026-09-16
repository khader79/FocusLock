import { describe, expect, it } from 'vitest'
import { makeQuery, makeResponse } from './test-helpers'
import { DohUpstream, resolveWithFailover, UdpUpstream, type Upstream, type UdpSocket } from './upstream'

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

describe('UdpUpstream', () => {
  interface FakeSocket {
    socket: UdpSocket
    sent: Buffer[]
    emitMessage: (data: Buffer) => void
    errored: Error | null
    closed: boolean
  }

  function fakeSocketFactory(reply: (query: Buffer) => Buffer | null): FakeSocket {
    const state: FakeSocket = {
      socket: {
        once: () => undefined as unknown,
        removeAllListeners: () => undefined as unknown,
        send: (_message, _port, _address, callback) => {
          state.sent.push(_message)
          const result = reply(_message)
          if (result !== null) {
            state.emitMessage(result)
          }
          callback(null)
        },
        close: () => {
          state.closed = true
        },
      },
      sent: [],
      emitMessage: () => undefined,
      errored: null,
      closed: false,
    }
    const handlers: {
      message?: (data: Buffer) => void
      error?: (err: Error) => void
    } = {}
    state.socket.once = (event: 'message' | 'error', listener: unknown) => {
      if (event === 'message') {
        handlers.message = listener as (data: Buffer) => void
      } else {
        handlers.error = listener as (err: Error) => void
      }
      return undefined as unknown
    }
    state.socket.removeAllListeners = () => {
      handlers.message = undefined
      handlers.error = undefined
      return undefined as unknown
    }
    state.emitMessage = (data: Buffer) => {
      handlers.message?.(data)
    }
    return state
  }

  it('sends the raw query over UDP and returns the raw response', async () => {
    const query = makeQuery('example.com', { id: 0xabcd })
    const response = makeResponse(query)
    const fake = fakeSocketFactory(() => response)
    const upstream = new UdpUpstream('cloudflare', '1.1.1.1', {
      socketFactory: () => fake.socket,
    })

    const result = await upstream.resolve(query)

    expect(result.equals(response)).toBe(true)
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]?.equals(query)).toBe(true)
  })

  it('ignores responses with a mismatched transaction id', async () => {
    const query = makeQuery('example.com', { id: 0xabcd })
    const correct = makeResponse(query)
    const wrong = makeResponse(makeQuery('example.com', { id: 0x0001 }))
    const fake = fakeSocketFactory(() => null)
    const upstream = new UdpUpstream('cloudflare', '1.1.1.1', {
      socketFactory: () => fake.socket,
    })

    const pending = upstream.resolve(query)
    fake.emitMessage(wrong)
    fake.emitMessage(correct)

    await expect(pending).resolves.toEqual(correct)
  })

  it('throws on SERVFAIL responses', async () => {
    const query = makeQuery('example.com')
    const servfail = makeResponse(query, { rcode: 2 })
    const fake = fakeSocketFactory(() => servfail)
    const upstream = new UdpUpstream('cloudflare', '1.1.1.1', {
      socketFactory: () => fake.socket,
    })

    await expect(upstream.resolve(query)).rejects.toThrow(/SERVFAIL/)
    expect(fake.closed).toBe(true)
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