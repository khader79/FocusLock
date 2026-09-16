import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyHostsToFile,
  computeEffectiveDomains,
  readBlocklistFile,
  readCategoriesFile,
} from './blocker-core'
import { DnsCache } from './dns/cache'
import { DnsFilterServer } from './dns/dns-filter'
import { TokenBucket } from './dns/limiter'
import { BlockRuleMatcher, hasBlockingRules, type RulePatterns } from './dns/matcher'
import { isDnsFilterEnabled, loadDnsRules } from './dns/rules-store'
import { StatsTable } from './dns/stats'
import { SystemDnsController } from './dns/system-dns'
import { createDefaultUpstreams } from './dns/upstream'

export const ENFORCER_POLL_INTERVAL_MS = 5_000
export const ENFORCER_LISTEN_HOST = '127.0.0.1'
export const ENFORCER_LISTEN_PORT = 53

const RATE_LIMIT_QPS = 1000

export interface EnforcerDataPaths {
  blocklistPath: string
  categoriesPath: string
  rulesPath: string
  statsPath: string
  backupPath: string
}

/**
 * Data files live in the GUI's userData directory, not the SYSTEM account's.
 * The service is launched with --userDataPath so it reads (and writes back)
 * the exact same files as the interactive app.
 */
export function enforcerDataPaths(userDataPath: string): EnforcerDataPaths {
  return {
    blocklistPath: join(userDataPath, 'blocklist.txt'),
    categoriesPath: join(userDataPath, 'categories.json'),
    rulesPath: join(userDataPath, 'dns-rules.json'),
    statsPath: join(userDataPath, 'dns-stats.json'),
    backupPath: join(userDataPath, 'dns-backup.json'),
  }
}

export interface EnforcerOptions {
  pollIntervalMs?: number
  applyHosts?: typeof applyHostsToFile
  isDnsEnabled?: typeof isDnsFilterEnabled
  loadRules?: typeof loadDnsRules
  systemDns?: SystemDnsController
}

export interface EnforcerHandle {
  sync: () => Promise<void>
  stop: () => void
}

/**
 * Headless enforcement: keeps the hosts-file block and the local DNS filter
 * (127.0.0.1:53) alive without a window, tray or IPC, so blocking continues
 * even while the GUI process is hidden. Launched by the installed Windows
 * service with the GUI's userData directory; polls the rule files every few
 * seconds and re-applies changes. When blocking rules exist the OS resolver is
 * pointed at the local filter (original servers backed up); the resolver is
 * restored whenever the filter stops or the DNS rules are disabled.
 */
export async function startEnforcer(
  userDataPath: string,
  options: EnforcerOptions = {},
): Promise<EnforcerHandle> {
  const paths = enforcerDataPaths(userDataPath)
  const pollIntervalMs = options.pollIntervalMs ?? ENFORCER_POLL_INTERVAL_MS
  const applyHosts = options.applyHosts ?? applyHostsToFile
  const isDnsEnabled = options.isDnsEnabled ?? isDnsFilterEnabled
  const loadRules = options.loadRules ?? loadDnsRules
  const systemDns = options.systemDns ?? new SystemDnsController({ backupFilePath: paths.backupPath })

  let server: DnsFilterServer | null = null
  let stats: StatsTable | null = null
  let lastHostsFingerprint: string | null = null
  let lastRulesFingerprint: string | null = null
  let routingEnabled = false

  const readRulesRaw = async (): Promise<string> => {
    try {
      return await readFile(paths.rulesPath, 'utf8')
    } catch {
      return ''
    }
  }

  const reloadMatcher = async (): Promise<void> => {
    if (server === null) {
      return
    }
    server.updateMatcher(new BlockRuleMatcher(await loadRules(paths)))
  }

  const persistStats = async (): Promise<void> => {
    if (stats === null) {
      return
    }
    try {
      await stats.saveFile(paths.statsPath)
    } catch (err) {
      console.error('[enforcer] failed to persist DNS stats:', err)
    }
  }

  const configureSystemDns = async (): Promise<void> => {
    try {
      await systemDns.configure()
      routingEnabled = true
    } catch (err) {
      routingEnabled = false
      console.error('[enforcer] could not configure the OS resolver:', err)
    }
  }

  const restoreSystemDns = async (): Promise<void> => {
    try {
      await systemDns.restore()
    } catch (err) {
      console.error('[enforcer] failed to restore the OS resolver:', err)
    }
    routingEnabled = false
  }

  const startDnsServer = async (): Promise<void> => {
    if (server !== null) {
      return
    }
    if (!(await isDnsEnabled(paths.rulesPath))) {
      return
    }

    stats = new StatsTable()
    try {
      await stats.loadFile(paths.statsPath)
    } catch (err) {
      console.error('[enforcer] failed to load DNS stats:', err)
    }

    const patterns: RulePatterns = await loadRules(paths)

    const next = new DnsFilterServer({
      matcher: new BlockRuleMatcher(patterns),
      upstreams: createDefaultUpstreams(),
      cache: new DnsCache(),
      limiter: new TokenBucket({ capacity: RATE_LIMIT_QPS, refillPerSecond: RATE_LIMIT_QPS }),
      stats,
      listenHost: ENFORCER_LISTEN_HOST,
      listenPort: ENFORCER_LISTEN_PORT,
    })

    try {
      await next.start()
    } catch (err) {
      console.error('[enforcer] DNS filter failed to bind 127.0.0.1:53:', err)
      stats = null
      return
    }

    server = next

    // Once the filter is bound, route the OS resolver through it (only when
    // there is something to enforce) so the preset lists block in silent mode
    // too. The resolver is restored before the server is ever stopped.
    if (hasBlockingRules(patterns)) {
      await configureSystemDns()
    }

    lastRulesFingerprint = await readRulesRaw()
  }

  const stopDnsServer = async (): Promise<void> => {
    if (server === null) {
      return
    }
    const current = server
    server = null
    // Restore the resolver while the filter is still answering, then stop it.
    if (routingEnabled) {
      await restoreSystemDns()
    }
    await current.stop()
    stats = null
    lastRulesFingerprint = null
  }

  const syncOnce = async (): Promise<void> => {
    try {
      // The DNS filter follows the rules' enable flag: start it when DNS
      // filtering is on, stop it (and restore the resolver) when it is off.
      if (await isDnsEnabled(paths.rulesPath)) {
        await startDnsServer()
      } else if (server !== null) {
        await stopDnsServer()
      }

      const blocklist = await readBlocklistFile(paths.blocklistPath)
      const categories = await readCategoriesFile(paths.categoriesPath)
      const domains = computeEffectiveDomains(blocklist, categories)
      const hostsFingerprint = domains.join('\n')
      if (hostsFingerprint !== lastHostsFingerprint) {
        await applyHosts(domains)
        lastHostsFingerprint = hostsFingerprint
        await reloadMatcher()
      }

      if (server !== null) {
        const rulesRaw = await readRulesRaw()
        if (rulesRaw !== lastRulesFingerprint) {
          lastRulesFingerprint = rulesRaw
          await reloadMatcher()
        }
      }

      await persistStats()
    } catch (err) {
      console.error('[enforcer] sync failed:', err)
    }
  }

  await syncOnce()

  const timer = setInterval(() => {
    void syncOnce()
  }, pollIntervalMs)

  return {
    sync: syncOnce,
    stop: () => {
      clearInterval(timer)
      void stopDnsServer().catch((err) => {
        console.error('[enforcer] failed to stop DNS server:', err)
      })
    },
  }
}