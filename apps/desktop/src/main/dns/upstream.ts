import { createSocket } from 'node:dgram'
import { isResponse, parseResponseStats, RCODE_SERVFAIL } from './dns-packet'

export interface Upstream {
  name: string
  /** Resolves a raw DNS query message to a raw DNS response message. */
  resolve(message: Buffer): Promise<Buffer>
}

export interface DohUpstreamOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * The slice of dgram.Socket the UDP upstream uses. Kept structural so tests
 * can inject a lightweight fake instead of a real OS socket.
 */
export interface UdpSocket {
  once(event: 'message', listener: (data: Buffer) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
  removeAllListeners(): void
  send(message: Buffer, port: number, address: string, callback: (err: Error | null) => void): void
  close(): void
}

export interface UdpUpstreamOptions {
  timeoutMs?: number
  port?: number
  socketFactory?: () => UdpSocket
}

export interface FailoverResult {
  response: Buffer
  upstream: string
}

const DOH_TIME_OUT = 3_000
const UDP_TIME_OUT = 3_000
const UDP_PORT = 53

/**
 * Plain-DNS upstream over UDP. The server address must be an IP literal:
 * when the OS resolver is pointed at 127.0.0.1 (this app's filter), the
 * upstream itself cannot go through DNS resolution or the lookup would loop
 * back through the filter forever.
 */
export class UdpUpstream implements Upstream {
  readonly name: string
  readonly address: string
  private readonly port: number
  private readonly timeoutMs: number
  private readonly socketFactory: () => UdpSocket

  constructor(name: string, address: string, options: UdpUpstreamOptions = {}) {
    this.name = name
    this.address = address
    this.port = options.port ?? UDP_PORT
    this.timeoutMs = options.timeoutMs ?? UDP_TIME_OUT
    this.socketFactory = options.socketFactory ?? (() => createSocket('udp4') as unknown as UdpSocket)
  }

  async resolve(message: Buffer): Promise<Buffer> {
    const socket = this.socketFactory()
    const id = message.readUInt16BE(0)

    const response = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      let settled = false

      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.close()
      }
      const succeed = (buffer: Buffer): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolvePromise(buffer)
      }
      const fail = (err: Error): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        rejectPromise(err)
      }

      const timer = setTimeout(() => {
        fail(new Error(`${this.name}: UDP query to ${this.address} timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      socket.once('message', (data) => {
        if (settled || data.length < 12 || data.readUInt16BE(0) !== id) {
          return
        }
        succeed(data)
      })
      socket.once('error', fail)
      socket.send(message, this.port, this.address, (err) => {
        if (err instanceof Error) {
          fail(err)
        }
      })
    })

    if (!isResponse(response)) {
      throw new Error(`${this.name}: response is not a DNS message (QR flag not set)`)
    }
    if (parseResponseStats(response).rcode === RCODE_SERVFAIL) {
      throw new Error(`${this.name}: upstream returned SERVFAIL`)
    }
    return response
  }
}

/**
 * DNS-over-HTTPS upstream (RFC 8484). Sends the raw query as the POST body
 * with the application/dns-message content type and returns the raw response.
 */
export class DohUpstream implements Upstream {
  readonly name: string
  private readonly url: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(name: string, url: string, options: DohUpstreamOptions = {}) {
    this.name = name
    this.url = url
    this.timeoutMs = options.timeoutMs ?? DOH_TIME_OUT
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async resolve(message: Buffer): Promise<Buffer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/dns-message',
          accept: 'application/dns-message',
        },
        body: new Uint8Array(message),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`${this.name}: HTTP ${response.status} ${response.statusText}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (!isResponse(buffer)) {
        throw new Error(`${this.name}: response is not a DNS message (QR flag not set)`)
      }
      if (parseResponseStats(buffer).rcode === 2) {
        throw new Error(`${this.name}: upstream returned SERVFAIL`)
      }
      return buffer
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The default upstream chain, using plain DNS over UDP to fixed public IPs
 * (Cloudflare → Google → Quad9). IP literals are essential here: FocusLock
 * routes the OS resolver through the local filter on 127.0.0.1, so any
 * upstream that resolves by hostname would recurse back into the filter.
 */
export function createDefaultUpstreams(
  options: Pick<DohUpstreamOptions, 'timeoutMs'> & UdpUpstreamOptions = {},
): Upstream[] {
  return [
    new UdpUpstream('cloudflare', '1.1.1.1', options),
    new UdpUpstream('cloudflare', '1.0.0.1', options),
    new UdpUpstream('google', '8.8.8.8', options),
    new UdpUpstream('quad9', '9.9.9.9', options),
  ]
}

/**
 * Tries each upstream in order and returns the first usable response. A
 * response counts as usable when it has the QR flag set and its stats parse
 * cleanly. Throws when every upstream fails.
 */
export async function resolveWithFailover(
  upstreams: Upstream[],
  message: Buffer,
): Promise<FailoverResult> {
  if (upstreams.length === 0) {
    throw new Error('No DNS upstreams configured')
  }

  const errors: string[] = []
  for (const upstream of upstreams) {
    try {
      const response = await upstream.resolve(message)
      return { response, upstream: upstream.name }
    } catch (err) {
      errors.push(`${upstream.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  throw new Error(`All DNS upstreams failed: ${errors.join('; ')}`)
}