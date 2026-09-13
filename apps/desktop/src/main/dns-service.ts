import { join } from 'node:path'
import { app } from 'electron'
import { DnsCache } from './dns/cache'
import { DnsFilterServer } from './dns/dns-filter'
import { TokenBucket } from './dns/limiter'
import { BlockRuleMatcher } from './dns/matcher'
import { isDnsFilterEnabled, loadDnsRules } from './dns/rules-store'
import { StatsTable, type StatsSnapshot } from './dns/stats'
import { SystemDnsController } from './dns/system-dns'
import { createDefaultUpstreams } from './dns/upstream'

export const DNS_LISTEN_HOST = '127.0.0.1'
export const DNS_LISTEN_PORT = 53

const RATE_LIMIT_QPS = 1000

let server: DnsFilterServer | null = null
let stats: StatsTable | null = null

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
 * blocklist/categories/DNS rules. Returns false when DNS filtering is disabled
 * or when binding fails (port 53 + ADMIN REQUIRED). Never throws.
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

  const next = new DnsFilterServer({
    matcher: new BlockRuleMatcher(await loadDnsRules(paths)),
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
  return true
}

/** Stops the server and persists the stats table. */
export async function stopDnsService(): Promise<void> {
  const current = server
  server = null
  if (current !== null) {
    await current.stop()
    await persistStats()
  }
}

/**
 * Rebuilds the matcher from the persisted rule files and swaps it in while the
 * server keeps running. Called after protected edits to the blocklist.
 */
export async function reloadDnsRules(): Promise<void> {
  if (server === null) {
    return
  }
  const paths = dnsDataPaths()
  server.updateMatcher(new BlockRuleMatcher(await loadDnsRules(paths)))
}

/**
 * Points the OS resolver at the local filter. Only meaningful the first time
 * ("install"); stores a backup of the original DNS servers for restore().
 * Throws when the local server is not running or admin rights are missing.
 */
export async function configureSystemDnsOnInstall(): Promise<void> {
  if (server === null) {
    throw new Error('[dns] cannot configure system DNS: local DNS server is not running')
  }
  await createSystemDnsController().configure()
}

/** Reverts the OS resolver to the servers recorded before configure(). */
export async function restoreSystemDns(): Promise<void> {
  await createSystemDnsController().restore()
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