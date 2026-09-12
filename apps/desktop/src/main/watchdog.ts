import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const WATCHDOG_INTERVAL_MS = 5_000

const PID_FILE_NAME = 'watchdog.pid'
const LOG_FILE_ENV = process.env['FOCUSLOCK_WATCHDOG_LOG']

let watchdogTimer: NodeJS.Timeout | null = null
let logFilePath: string | null = null

export function getLogFilePath(): string {
  if (logFilePath !== null) {
    return logFilePath
  }

  if (LOG_FILE_ENV) {
    logFilePath = LOG_FILE_ENV
    return logFilePath
  }

  try {
    logFilePath = join(app.getPath('logs'), 'watchdog.log')
  } catch {
    logFilePath = join(app.getPath('userData'), 'watchdog.log')
  }

  return logFilePath
}

export function getPidFilePath(): string {
  return join(app.getPath('userData'), PID_FILE_NAME)
}

export function writeLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    appendFileSync(getLogFilePath(), line, 'utf8')
  } catch (err) {
    console.error('[watchdog] failed to write log:', err)
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process still exists but is owned by another user/level.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function restartApp(): void {
  const args = process.argv.slice(1)
  writeLog(`restart: spawning detached "${process.execPath}" with args: ${args.join(' ')}`)

  // On Windows this uses child_process.spawn with process.execPath (the app
  // binary). detached + unref let the new process survive the death of this one.
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function ensureSingleInstance(): void {
  const pidFile = getPidFilePath()
  const currentPid = process.pid

  let recordedPid = -1
  try {
    recordedPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  } catch {
    // No lock file yet (first run) — nothing to compare against.
  }

  if (Number.isInteger(recordedPid) && recordedPid > 0 && recordedPid !== currentPid) {
    if (isProcessAlive(recordedPid)) {
      writeLog(`duplicate instance detected (pid ${recordedPid}) -> terminating it`)
      try {
        process.kill(recordedPid)
        writeLog(`terminated duplicate instance pid ${recordedPid}`)
      } catch (err) {
        writeLog(`failed to terminate duplicate instance pid ${recordedPid}: ${String(err)}`)
      }
    } else {
      writeLog(`stale lock file references dead pid ${recordedPid} -> ignoring`)
    }
  }

  writeFileSync(pidFile, String(currentPid), 'utf8')
}

function registerRestartHandlers(): void {
  process.on('exit', () => {
    writeLog('process "exit" event fired -> restarting app')
    restartApp()
  })

  process.on('SIGTERM', () => {
    writeLog('SIGTERM received -> restarting app')
    restartApp()
    process.exit(0)
  })

  process.on('SIGINT', () => {
    writeLog('SIGINT received -> restarting app')
    restartApp()
    process.exit(0)
  })
}

// NOTE: On Windows a hard kill (Task Manager "End process", `taskkill /F`)
// calls TerminateProcess, which does NOT fire JS exit/signal handlers. This
// watchdog therefore survives graceful kills (WM_CLOSE, taskkill, SIGTERM-ish)
// but not force-kills; a separate detached supervisor process would be needed
// to guarantee restart on hard kill.
export function startWatchdog(): NodeJS.Timeout {
  if (watchdogTimer !== null) {
    return watchdogTimer
  }

  writeLog('watchdog started')
  registerRestartHandlers()
  ensureSingleInstance()

  watchdogTimer = setInterval(() => {
    ensureSingleInstance()
  }, WATCHDOG_INTERVAL_MS)

  return watchdogTimer
}
