import { createSocket } from 'node:dgram'
import { join } from 'node:path'
import { app } from 'electron'
import { DnsCache } from './dns/cache'
import { DnsFilterServer } from './dns/dns-filter'
import { buildQuery, QTYPE_A } from './dns/dns-packet'
import { TokenBucket } from './dns/limiter'
import { BlockRuleMatcher, hasBlockingRules, type RulePatterns } from './dns/matcher'
import { isDnsFilterEnabled, loadDnsRules } from './dns/rules-store'
import { StatsTable, type StatsSnapshot } from './dns/stats'
import { SystemDnsController } from './dns/system-dns'
import { createDefaultUpstreams } from './dns/upstream'

export const DNS_LISTEN_HOST = '127.0.0.1'
export const DNS_LISTEN_PORT = 53

const RATE_LIMIT_QPS = 1000
const PROBE_TIMEOUT_MS = 1_000

let server: DnsFilterServer | null = null
let stats: StatsTable | null = null
let routingEnabled = false

export interface DnsDataPaths {
  blocklistPath: string
  categoriesPath: string
  rulesPath: string
  statsPath: string
  backupPath: string
}

export function dnsDataPaths(): DnsDataPaths {
  const dir = app.getPath('userData')
  return {
    blocklistPath: join(dir, 'blocklist.txt'),
    categoriesPath: join(dir, 'categories.json'),
    rulesPath: join(dir, 'dns-rules.json'),
    statsPath: join(dir, 'dns-stats.json'),
    backupPath: join(dir, 'dns-backup.json'),
  }
}

/**
 * Starts the local DNS filter server on 127.0.0.1:53 using the persisted
 * blocklist/categories/DNS rules. When the filter has blocking rules, the OS
 * resolver is pointed at the local server (its original servers are backed
 * up) so those rules actually take effect. Returns false when DNS filtering
 * is disabled or when binding fails (port 53 + ADMIN REQUIRED). Never throws.
 */
export async function startDnsService(): Promise<boolean> {
  if (server !== null) {
    return true
  }

  const paths = dnsDataPaths()
  if (!(await isDnsFilterEnabled(paths.rulesPath))) {
    return false
  }

  stats = new StatsTable()
  await stats.loadFile(paths.statsPath)

  const patterns = await loadDnsRules(paths)

  const next = new DnsFilterServer({
    matcher: new BlockRuleMatcher(patterns),
    upstreams: createDefaultUpstreams(),
    cache: new DnsCache(),
    limiter: new TokenBucket({ capacity: RATE_LIMIT_QPS, refillPerSecond: RATE_LIMIT_QPS }),
    stats,
    listenHost: DNS_LISTEN_HOST,
    listenPort: DNS_LISTEN_PORT,
  })

  try {
    await next.start()
  } catch (err) {
    stats = null
    console.error('[dns] failed to bind 127.0.0.1:53 (run with admin privileges):', err)
    return false
  }

  server = next

  // Only route the OS resolver through the filter when blocking rules exist,
  // so a device's DNS is never touched unless there is something to enforce.
  if (hasBlockingRules(patterns)) {
    await configureSystemDns()
  }

  return true
}

/**
 * Stops the server and persists the stats table. The OS resolver is restored
 * to the backed-up servers FIRST, while the filter is still bound, so the
 * device can never be left pointing at a dead local resolver.
 */
export async function stopDnsService(): Promise<void> {
  const current = server
  server = null
  if (current !== null) {
    await restoreSystemDns()
    routingEnabled = false
    await current.stop()
    await persistStats()
  }
}

/**
 * Rebuilds the matcher from the persisted rule files and swaps it in while the
 * server keeps running. Called after protected edits to the blocklist, and
 * (re)points the OS resolver at the local server once blocking rules exist.
 */
export async function reloadDnsRules(): Promise<void> {
  if (server === null) {
    return
  }
  const paths = dnsDataPaths()
  const patterns: RulePatterns = await loadDnsRules(paths)
  server.updateMatcher(new BlockRuleMatcher(patterns))
  if (hasBlockingRules(patterns)) {
    await configureSystemDns()
  }
}

/**
 * Points the OS resolver at the local filter. Idempotent: the controller
 * skips the work when the original servers were already backed up. A failure
 * just means the resolver keeps its current (original) servers, which is
 * always safe.
 */
async function configureSystemDns(): Promise<void> {
  try {
    await createSystemDnsController().configure()
    routingEnabled = true
  } catch (err) {
    routingEnabled = false
    console.error(
      '[dns] could not configure the OS resolver (run with admin privileges):',
      err,
    )
  }
}

/**
 * Reverts the OS resolver to the servers recorded before configure().
 * Compatibility hook kept for callers from older builds.
 */
export async function configureSystemDnsOnInstall(): Promise<void> {
  await configureSystemDns()
}

/** Reverts the OS resolver to the servers recorded before configure(). */
export async function restoreSystemDns(): Promise<void> {
  try {
    await createSystemDnsController().restore()
  } catch (err) {
    console.error('[dns] failed to restore the system DNS:')
    console.error(err)
  }
  routingEnabled = false
}

/** True while the local filter is running AND the OS resolver points at it. */
export function isDnsRoutingLocal(): boolean {
  return routingEnabled
}

/** True when the OS resolver currently points at the local filter. */
export async function isSystemDnsPointingLocal(): Promise<boolean> {
  try {
    return await createSystemDnsController().isConfigured()
  } catch {
    return false
  }
}

/**
 * Probes 127.0.0.1:53 with a real DNS query. True when anything answers,
 * whether it is this app's in-process filter, the background service's, or
 * another resolver on the same port. Used at startup to avoid clobbering an
 * already-running local server and to detect stale resolvers.
 */
export function probeLocalDnsServer(
  host: string = DNS_LISTEN_HOST,
  port: number = DNS_LISTEN_PORT,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let socket
    try {
      socket = createSocket('udp4')
    } catch {
      resolvePromise(false)
      return
    }

    let settled = false
    const finish = (result: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Socket already closed.
      }
      resolvePromise(result)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('message', () => finish(true))

    const query = buildQuery({ id: 0xbeef, name: 'focuslock.local.probe', qtype: QTYPE_A })
    socket.send(query, port, host, (err) => {
      if (err) {
        finish(false)
      }
    })
  })
}

export function getDnsStatsSnapshot(): StatsSnapshot | null {
  return stats?.snapshot() ?? null
}

function createSystemDnsController(): SystemDnsController {
  return new SystemDnsController({ backupFilePath: dnsDataPaths().backupPath })
}

async function persistStats(): Promise<void> {
  const current = stats
  if (current === null) {
    return
  }
  await current.saveFile(dnsDataPaths().statsPath)
}