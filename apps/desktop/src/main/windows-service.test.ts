import { describe, expect, it } from 'vitest'
import {
  buildServiceSpec,
  DEFAULT_SERVICE_NAME,
  ENFORCER_FLAG,
  ENFORCER_USER_DATA_FLAG,
  installService,
  isServiceInstalled,
  isServiceRunning,
  startService,
  stopService,
  uninstallService,
  type ServiceRunner,
  type ServiceSpec,
} from './windows-service'

function spec(): ServiceSpec {
  return buildServiceSpec(
    'C:\\Program Files\\FocusLock\\FocusLock.exe',
    'C:\\Users\\me\\AppData\\Roaming\\focuslock',
  )
}

function scriptedRunner(behaviors: Record<string, string | Error>): ServiceRunner & {
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    sc: async (args) => {
      calls.push([...args])
      const behavior = behaviors[args[0] ?? ''] ?? ''
      if (behavior instanceof Error) {
        throw behavior
      }
      return behavior
    },
  }
}

describe('buildServiceSpec', () => {
  it('points the binary at the user data directory in enforcer mode', () => {
    const built = spec()
    expect(built.serviceName).toBe(DEFAULT_SERVICE_NAME)
    expect(built.binPath).toBe(
      `"C:\\Program Files\\FocusLock\\FocusLock.exe" ${ENFORCER_FLAG} ${ENFORCER_USER_DATA_FLAG} "C:\\Users\\me\\AppData\\Roaming\\focuslock"`,
    )
  })
})

describe('installService', () => {
  it('creates an auto-start service with the enforcer command line', async () => {
    const runner = scriptedRunner({})
    await installService(spec(), runner)

    expect(runner.calls).toEqual([
      [
        'create',
        DEFAULT_SERVICE_NAME,
        `binPath= "C:\\Program Files\\FocusLock\\FocusLock.exe" --enforcer --userDataPath "C:\\Users\\me\\AppData\\Roaming\\focuslock"`,
        'start= auto',
        'DisplayName= FocusLock Background Enforcement',
      ],
    ])
  })
})

describe('start / stop / uninstall', () => {
  it('starts and stops by service name', async () => {
    const runner = scriptedRunner({})
    await startService(spec(), runner)
    await stopService(spec(), runner)

    expect(runner.calls[0]).toEqual(['start', DEFAULT_SERVICE_NAME])
    expect(runner.calls[1]).toEqual(['stop', DEFAULT_SERVICE_NAME])
  })

  it('uninstall stops and deletes the service', async () => {
    const runner = scriptedRunner({})
    await uninstallService(spec(), runner)

    expect(runner.calls).toEqual([
      ['stop', DEFAULT_SERVICE_NAME],
      ['delete', DEFAULT_SERVICE_NAME],
    ])
  })

  it('uninstall tolerates an already-stopped service', async () => {
    const runner = scriptedRunner({ stop: new Error('service not running') })
    await expect(uninstallService(spec(), runner)).resolves.toBeUndefined()

    expect(runner.calls.map((call) => call[0])).toEqual(['stop', 'delete'])
  })
})

describe('isServiceInstalled / isServiceRunning', () => {
  it('reports installed when sc query lists the service', async () => {
    const runner = scriptedRunner({
      query: 'SERVICE_NAME: FocusLockService\nSTATE : 4  RUNNING',
    })
    expect(await isServiceInstalled(spec(), runner)).toBe(true)
    expect(await isServiceRunning(spec(), runner)).toBe(true)
  })

  it('reports not installed when sc query fails', async () => {
    const runner = scriptedRunner({ query: new Error('service does not exist') })
    expect(await isServiceInstalled(spec(), runner)).toBe(false)
    expect(await isServiceRunning(spec(), runner)).toBe(false)
  })

  it('reports stopped for a non-running service', async () => {
    const runner = scriptedRunner({ query: 'SERVICE_NAME: FocusLockService\nSTATE : 1  STOPPED' })
    expect(await isServiceRunning(spec(), runner)).toBe(false)
  })
})