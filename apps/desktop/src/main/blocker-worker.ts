import { parentPort, workerData } from 'node:worker_threads'
import {
  applyHostsToFile,
  computeEffectiveDomains,
  readBlocklistFile,
  readCategoriesFile,
} from './blocker-core'

/**
 * Paths and timing resolved in the main process (which has Electron) and
 * passed in here. This thread never touches Electron: it only reads the
 * blocklist/categories files and rewrites the OS hosts file, regardless of
 * whether any app window is open.
 */
interface BlockerWorkerData {
  blocklistPath: string
  categoriesPath: string
  hostsPath: string
  refreshIntervalMs: number
}

const config = workerData as BlockerWorkerData

async function apply(): Promise<void> {
  const [blocklistDomains, categories] = await Promise.all([
    readBlocklistFile(config.blocklistPath),
    readCategoriesFile(config.categoriesPath),
  ])

  const effective = computeEffectiveDomains(blocklistDomains, categories)
  await applyHostsToFile(effective, config.hostsPath)
}

function reportError(err: unknown): void {
  parentPort?.postMessage({ type: 'error', error: String(err) })
}

// Initial application right after the thread starts. The main process waits
// for "applied"/"error" so installBlocker() only resolves once the first
// hosts write has run.
apply()
  .then(() => parentPort?.postMessage({ type: 'applied' }))
  .catch(reportError)

const timer = setInterval(() => {
  apply().catch(reportError)
}, config.refreshIntervalMs)

parentPort?.on('message', (message: { type: string }) => {
  if (message.type === 'apply') {
    apply().catch(reportError)
    return
  }

  if (message.type === 'stop') {
    clearInterval(timer)
    parentPort?.postMessage({ type: 'stopped' })
    // Closing the port lets this thread shut down cleanly.
    parentPort?.close()
  }
})