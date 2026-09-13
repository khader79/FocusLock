import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram'
import { createServer, type Server as TcpServer, type Socket as TcpSocket } from 'node:net'
import { DnsCache, type DnsCacheOptions } from './cache'
import {
  minimalResponse,
  parseQuestion,
  parseResponseStats,
  replyFromQuery,
  rewriteMessageId,
  RCODE_NXDOMAIN,
  RCODE_SERVFAIL,
  type DnsQuestion,
} from './dns-packet'
import { TokenBucket } from './limiter'
import type { BlockRuleMatcher } from './matcher'
import { StatsTable } from './stats'
import { resolveWithFailover, type Upstream } from './upstream'

export interface DnsFilterOptions {
  matcher: BlockRuleMatcher
  upstreams: Upstream[]
  cache?: DnsCache
  limiter?: TokenBucket
  stats?: StatsTable
  listenHost?: string
  listenPort?: number
  cacheOptions?: DnsCacheOptions
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 53

/**
 * Local DNS filter server (127.0.0.1:53, UDP + TCP). The resolve pipeline for
 * every query is:
 *   rate limit → parse → match (exceptions first, then exact → wildcard →
 *   regex → keyword) → block as NXDOMAIN OR serve from cache → resolve via
 *   the upstream chain with failover → cache the response.
 * This module is Electron-free and can run in any Node context.
 */
export class DnsFilterServer {
  private matcher: BlockRuleMatcher
  private readonly upstreams: Upstream[]
  private readonly cache: DnsCache
  private readonly limiter: TokenBucket
  private readonly stats: StatsTable
  private readonly listenHost: string
  private readonly listenPort: number

  private udp: UdpSocket | null = null
  private tcp: TcpServer | null = null
  private running = false

  constructor(options: DnsFilterOptions) {
    this.matcher = options.matcher
    this.upstreams = options.upstreams
    this.cache = options.cache ?? new DnsCache(options.cacheOptions)
    this.limiter = options.limiter ?? new TokenBucket({ capacity: 1000, refillPerSecond: 1000 })
    this.stats = options.stats ?? new StatsTable()
    this.listenHost = options.listenHost ?? DEFAULT_HOST
    this.listenPort = options.listenPort ?? DEFAULT_PORT
  }

  get isRunning(): boolean {
    return this.running
  }

  get statsTable(): StatsTable {
    return this.stats
  }

  /** Swaps the live matcher (blocklist changes take effect immediately). */
  updateMatcher(matcher: BlockRuleMatcher): void {
    this.matcher = matcher
  }

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    const udp = await this.bindUdp()
    let tcp: TcpServer
    try {
      tcp = await this.bindTcp()
    } catch (err) {
      await this.closeSocket(udp)
      throw err
    }

    udp.on('message', (message: Buffer, rinfo: RemoteInfo) => {
      void this.resolve(message).then((response) => {
        if (this.running && this.udp === udp) {
          udp.send(response, rinfo.port, rinfo.address)
        }
      })
    })

    tcp.on('connection', (socket: TcpSocket) => this.handleTcpConnection(socket))

    this.udp = udp
    this.tcp = tcp
    this.running = true
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return
    }
    this.running = false

    const udp = this.udp
    const tcp = this.tcp
    this.udp = null
    this.tcp = null

    await Promise.all([udp ? this.closeSocket(udp) : Promise.resolve(), tcp ? this.closeServer(tcp) : Promise.resolve()])
  }

  /** Full resolution pipeline. Returns the raw response message to relay. */
  async resolve(message: Buffer): Promise<Buffer> {
    this.stats.recordQuery()

    let question: DnsQuestion
    try {
      question = parseQuestion(message)
    } catch {
      const id = message.length >= 2 ? message.readUInt16BE(0) : 0
      return minimalResponse(id, RCODE_SERVFAIL)
    }

    if (!this.limiter.tryTake()) {
      this.stats.recordDrop()
      return replyFromQuery(message, RCODE_SERVFAIL)
    }

    const verdict = this.matcher.isBlocked(question.qname)
    if (verdict.blocked) {
      this.stats.recordBlock(question.qname, verdict.rule)
      return replyFromQuery(message, RCODE_NXDOMAIN)
    }

    const cacheKey = this.cache.key(question.qname, question.qtype, question.qclass)
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      this.stats.recordCacheHit()
      return rewriteMessageId(cached.buffer, question.id)
    }
    this.stats.recordCacheMiss()

    try {
      const { response } = await resolveWithFailover(this.upstreams, message)
      const responseStats = parseResponseStats(response)
      this.cache.store(cacheKey, response, responseStats)
      return rewriteMessageId(response, question.id)
    } catch {
      this.stats.recordUpstreamFailure()
      return replyFromQuery(message, RCODE_SERVFAIL)
    }
  }

  private handleTcpConnection(socket: TcpSocket): void {
    // DNS over TCP: each message is prefixed with a 2-byte length.
    let pending = Buffer.alloc(0)

    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])

      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0)
        if (pending.length < 2 + length) {
          break
        }
        const message = pending.subarray(2, 2 + length)
        pending = pending.subarray(2 + length)

        void this.resolve(message).then((response) => {
          if (socket.destroyed) {
            return
          }
          const framed = Buffer.allocUnsafe(2 + response.length)
          framed.writeUInt16BE(response.length, 0)
          response.copy(framed, 2)
          socket.write(framed)
        })
      }
    })

    socket.on('error', () => {
      socket.destroy()
    })
  }

  private bindUdp(): Promise<UdpSocket> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4')

      const onError = (err: Error): void => {
        socket.removeAllListeners('listening')
        reject(err)
      }
      socket.once('error', onError)
      socket.once('listening', () => {
        socket.off('error', onError)
        socket.on('error', (err: Error) => {
          console.error('[dns-filter] udp socket error:', err)
        })
        resolve(socket)
      })

      socket.bind(this.listenPort, this.listenHost)
    })
  }

  private bindTcp(): Promise<TcpServer> {
    return new Promise((resolve, reject) => {
      const server = createServer()

      const onError = (err: Error): void => {
        server.removeAllListeners('listening')
        reject(err)
      }
      server.once('error', onError)
      server.once('listening', () => {
        server.off('error', onError)
        server.on('error', (err: Error) => {
          console.error('[dns-filter] tcp server error:', err)
        })
        resolve(server)
      })

      server.listen(this.listenPort, this.listenHost)
    })
  }

  private closeSocket(socket: UdpSocket): Promise<void> {
    return new Promise((resolve) => {
      socket.close(() => resolve())
    })
  }

  private closeServer(server: TcpServer): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }
}