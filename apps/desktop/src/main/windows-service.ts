import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_SERVICE_NAME = 'FocusLockService'
export const DEFAULT_SERVICE_DISPLAY_NAME = 'FocusLock Background Enforcement'
export const ENFORCER_FLAG = '--enforcer'
export const ENFORCER_USER_DATA_FLAG = '--userDataPath'

export interface ServiceRunner {
  sc: (args: readonly string[]) => Promise<string>
}

export const defaultServiceRunner: ServiceRunner = {
  sc: async (args) => {
    const result = await execFileAsync('sc.exe', [...args])
    return result.stdout
  },
}

export interface ServiceSpec {
  serviceName: string
  displayName: string
  binPath: string
}

/**
 * The service command line: the Electron binary in headless enforcer mode,
 * pointed at the interactive user's data directory.
 */
export function buildServiceSpec(
  exePath: string,
  userDataPath: string,
  serviceName = DEFAULT_SERVICE_NAME,
): ServiceSpec {
  return {
    serviceName,
    displayName: DEFAULT_SERVICE_DISPLAY_NAME,
    binPath: `"${exePath}" ${ENFORCER_FLAG} ${ENFORCER_USER_DATA_FLAG} "${userDataPath}"`,
  }
}

export interface ServiceLifecycle {
  installed: () => Promise<boolean>
  running: () => Promise<boolean>
  install: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  uninstall: () => Promise<void>
}

export async function installService(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): Promise<void> {
  await runner.sc([
    'create',
    spec.serviceName,
    `binPath= ${spec.binPath}`,
    'start= auto',
    `DisplayName= ${spec.displayName}`,
  ])
}

export async function startService(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): Promise<void> {
  await runner.sc(['start', spec.serviceName])
}

export async function stopService(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): Promise<void> {
  await runner.sc(['stop', spec.serviceName])
}

/** Stops the service if it is running, then deletes it. Never throws. */
export async function uninstallService(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): Promise<void> {
  try {
    await runner.sc(['stop', spec.serviceName])
  } catch {
    // Already stopped / not running; the delete below cleans up regardless.
  }
  try {
    await runner.sc(['delete', spec.serviceName])
  } catch {
    // Not installed; nothing left to remove.
  }
}

export async function isServiceInstalled(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): Promise<boolean> {
  try {
    const stdout = await runner.sc(['query', spec.serviceName])
    return stdout.includes('SERVICE_NAME:')
  } catch {
    return false
  }
}

export async function isServiceRunning(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): Promise<boolean> {
  try {
    const stdout = await runner.sc(['query', spec.serviceName])
    return /STATE\s*:\s*4\s+RUNNING/.test(stdout)
  } catch {
    return false
  }
}

/** Groups the standalone sc.exe calls behind one object (convenience + tests). */
export function createServiceLifecycle(
  spec: ServiceSpec,
  runner: ServiceRunner = defaultServiceRunner,
): ServiceLifecycle {
  return {
    installed: () => isServiceInstalled(spec, runner),
    running: () => isServiceRunning(spec, runner),
    install: () => installService(spec, runner),
    start: () => startService(spec, runner),
    stop: () => stopService(spec, runner),
    uninstall: () => uninstallService(spec, runner),
  }
}