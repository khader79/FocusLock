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
import { BlockRuleMatcher } from './dns/matcher'
import { isDnsFilterEnabled, loadDnsRules } from './dns/rules-store'
import { StatsTable } from './dns/stats'
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
  }
}

export interface EnforcerOptions {
  pollIntervalMs?: number
  applyHosts?: typeof applyHostsToFile
  isDnsEnabled?: typeof isDnsFilterEnabled
  loadRules?: typeof loadDnsRules
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
 * seconds and re-applies changes.
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

  let server: DnsFilterServer | null = null
  let stats: StatsTable | null = null
  let lastHostsFingerprint: string | null = null
  let lastRulesFingerprint: string | null = null

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

    const next = new DnsFilterServer({
      matcher: new BlockRuleMatcher(await loadRules(paths)),
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
    lastRulesFingerprint = await readRulesRaw()
  }

  const syncOnce = async (): Promise<void> => {
    try {
      await startDnsServer()

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
    stop: () => clearInterval(timer),
  }
}