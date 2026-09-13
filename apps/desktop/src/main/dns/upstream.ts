import { isResponse, parseResponseStats } from './dns-packet'

export interface Upstream {
  name: string
  /** Resolves a raw DNS query message to a raw DNS response message. */
  resolve(message: Buffer): Promise<Buffer>
}

export interface DohUpstreamOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface FailoverResult {
  response: Buffer
  upstream: string
}

const DOH_TIME_OUT = 3_000

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

/** The default DoH chain: Cloudflare → NextDNS → AdGuard. */
export function createDefaultUpstreams(options: DohUpstreamOptions = {}): Upstream[] {
  return [
    new DohUpstream('cloudflare', 'https://cloudflare-dns.com/dns-query', options),
    new DohUpstream('nextdns', 'https://dns.nextdns.io/dns-query', options),
    new DohUpstream('adguard', 'https://unfiltered.adguard-dns.com/dns-query', options),
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