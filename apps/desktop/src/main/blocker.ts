import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { hostsFilePath } from './blocker-core'
import { assertValidChallengeToken } from './protected-actions'

export const REFRESH_INTERVAL_MS = 30_000

// Keep the original helper names available to callers that used them before
// the worker refactor.
export {
  applyHostsToFile as applyHosts,
  buildBlock,
  computeEffectiveDomains,
  hostsFilePath,
  parseBlocklist,
  readBlocklistFile,
  removeBlock,
} from './blocker-core'
export type { Category } from './blocker-core'

let worker: Worker | null = null
let stopping = false

function spawnWorker(): Worker {
  const w = new Worker(join(__dirname, 'blocker-worker.js'), {
    workerData: {
      blocklistPath: join(app.getPath('userData'), 'blocklist.txt'),
      categoriesPath: join(app.getPath('userData'), 'categories.json'),
      hostsPath: hostsFilePath(),
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    },
  })

  w.on('error', (err) => {
    console.error('[blocker] worker error:', err)
  })

  w.on('exit', (code) => {
    if (worker === w) {
      worker = null
    }
    if (!stopping) {
      console.error(`[blocker] worker exited unexpectedly (code ${code}), will respawn`)
    }
  })

  return w
}

/**
 * Starts the background blocker thread. Runs before any window is created and
 * keeps updating the hosts file while every window is hidden/minimized/closed.
 * Resolves once the worker has completed its first hosts write (or failed it).
 */
export async function installBlocker(): Promise<void> {
  if (worker !== null) {
    return
  }

  const w = spawnWorker()
  worker = w

  await new Promise<void>((resolve) => {
    const onMessage = (message: { type: string }): void => {
      if (message.type === 'applied' || message.type === 'error') {
        w.off('message', onMessage)
        resolve()
      }
    }
    w.on('message', onMessage)

    // Safety timeout so startup is never blocked by a stuck worker.
    const timer = setTimeout(() => {
      w.off('message', onMessage)
      resolve()
    }, 10_000)
    timer.unref?.()
  })
}

/**
 * Called by the watchdog on every tick: if the blocker thread died, respawns
 * it so blocking continues no matter what the UI is doing.
 */
export function ensureBlockerAlive(): void {
  if (stopping) {
    return
  }

  if (worker === null) {
    console.warn('[blocker] worker missing, respawning')
    worker = spawnWorker()
  }
}

/**
 * Asks the worker to immediately re-read the blocklist/categories and rewrite
 * the hosts file. Used by protected executors right after they edit those
 * files, so changes take effect without waiting for the next interval tick.
 */
export function requestBlockerApply(): void {
  worker?.postMessage({ type: 'apply' })
}

/**
 * Stops the background blocker. Protected entry point: the challenge token must
 * be a valid (unexpired) JWT minted for the "quit" or "uninstall" action.
 */
export function stopBlocker(challengeToken: string): void {
  const claims = assertValidChallengeToken(challengeToken)
  if (claims.action !== 'quit' && claims.action !== 'uninstall') {
    throw new Error(
      `Challenge token was minted for "${claims.action}"; ` +
        'only "quit" and "uninstall" may stop the blocker.',
    )
  }

  if (stopping) {
    return
  }
  stopping = true

  const w = worker
  worker = null
  if (w === null) {
    return
  }

  w.postMessage({ type: 'stop' })

  // Give the worker a brief moment to exit cleanly, then force-terminate so an
  // unresponsive thread can never keep the app alive.
  const forcedExit = setTimeout(() => {
    void w.terminate().catch(() => undefined)
  }, 2_000)
  forcedExit.unref?.()

  w.on('exit', () => {
    clearTimeout(forcedExit)
  })
}