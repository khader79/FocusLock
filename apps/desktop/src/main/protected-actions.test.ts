import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { signChallengeToken, verifyTokenForAction } from './challenge-token'
import {
  DIFFICULTY_MAP,
  executeProtectedAction,
  initProtectedActions,
  requestChallenge,
  registerProtectedActionExecutor,
  type ProtectedAction,
} from './protected-actions'

// --- electron + asset mocks ---------------------------------------------------

const electronMocks = vi.hoisted(() => {
  const windows: Array<{ close: () => void; on: () => void; loadFile: () => unknown; isDestroyed: () => boolean }> = []
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    windows,
    handlers,
    createWindow: () => {
      const win = {
        isDestroyed: () => false,
        close: vi.fn(),
        on: vi.fn(),
        loadFile: vi.fn().mockResolvedValue(undefined),
      }
      windows.push(win)
      return win
    },
  }
})

const auditMocks = vi.hoisted(() => ({ auditLog: vi.fn() }))

vi.mock('electron', () => ({
  BrowserWindow: class {
    static getAllWindows() {
      return electronMocks.windows
    }
    constructor() {
      Object.assign(this, electronMocks.createWindow())
    }
  },
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void electronMocks.handlers.set(channel, fn) },
}))

vi.mock('./challenge-modal.html?asset', () => ({ default: 'challenge-modal.html' }))
vi.mock('./audit-log', () => ({ auditLog: auditMocks.auditLog }))

const PROTECTED_ACTIONS: ProtectedAction[] = [
  'settings',
  'pause',
  'remove_site',
  'remove_app',
  'add_site',
  'add_app',
  'toggle_category',
  'toggle_silent_mode',
  'add_custom_site',
  'remove_custom_site',
  'block_app',
  'unblock_app',
  'add_rule',
  'remove_rule',
  'update_rule',
  'quit',
  'uninstall',
  'export',
  'import_entries',
]

describe('DIFFICULTY_MAP', () => {
  it('covers every protected action exactly once', () => {
    expect(Object.keys(DIFFICULTY_MAP).sort()).toEqual([...PROTECTED_ACTIONS].sort())
  })

  it('uses only valid difficulties (1..5)', () => {
    for (const difficulty of Object.values(DIFFICULTY_MAP)) {
      expect(Number.isInteger(difficulty)).toBe(true)
      expect(difficulty).toBeGreaterThanOrEqual(1)
      expect(difficulty).toBeLessThanOrEqual(5)
    }
  })

  it('ramps difficulty with consequence severity', () => {
    expect(DIFFICULTY_MAP.quit).toBe(5)
    expect(DIFFICULTY_MAP.uninstall).toBe(5)
    expect(DIFFICULTY_MAP.pause).toBe(4)
    expect(DIFFICULTY_MAP.settings).toBe(3)
    expect(DIFFICULTY_MAP.toggle_category).toBe(3)
    expect(DIFFICULTY_MAP.add_site).toBe(2)
    expect(DIFFICULTY_MAP.remove_site).toBe(2)
  })
})

describe('registerProtectedActionExecutor / executeProtectedAction', () => {
  let executorImpl: ReturnType<typeof vi.fn>

  beforeEach(() => {
    auditMocks.auditLog.mockClear()
    executorImpl = vi.fn().mockResolvedValue(undefined)
  })

  it('runs the registered executor and audits success', async () => {
    registerProtectedActionExecutor('pause', executorImpl)
    const token = signChallengeToken('pause')

    await executeProtectedAction('pause', { until: '08:00' }, token)

    expect(executorImpl).toHaveBeenCalledTimes(1)
    expect(executorImpl).toHaveBeenCalledWith({ until: '08:00' }, token)
    expect(auditMocks.auditLog).toHaveBeenCalledWith('pause', true, expect.objectContaining({ claims: expect.any(Object) }))
  })

  it('audits and throws when no executor is registered, without running anything', async () => {
    const token = signChallengeToken('remove_app')
    await expect(executeProtectedAction('remove_app', {}, token)).rejects.toThrow(/No executor registered/)
    expect(auditMocks.auditLog).toHaveBeenCalledWith('remove_app', false, expect.objectContaining({ error: expect.stringContaining('No executor') }))
  })

  it('rejects a forged token before calling the executor', async () => {
    registerProtectedActionExecutor('quit', executorImpl)

    await expect(executeProtectedAction('quit', {}, 'forged.token.value')).rejects.toThrow(/signature mismatch/)
    expect(executorImpl).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).toHaveBeenCalledWith('quit', false, expect.any(Object))
  })

  it('rejects a token minted for another action', async () => {
    registerProtectedActionExecutor('quit', executorImpl)
    const token = signChallengeToken('pause')

    await expect(executeProtectedAction('quit', {}, token)).rejects.toThrow(/minted for "pause"/)
    expect(executorImpl).not.toHaveBeenCalled()
    expect(auditMocks.auditLog).toHaveBeenCalledWith('quit', false, expect.any(Object))
  })

  it('propagates executor failures without a success audit entry', async () => {
    executorImpl.mockRejectedValue(new Error('boom'))
    registerProtectedActionExecutor('settings', executorImpl)
    const token = signChallengeToken('settings')

    await expect(executeProtectedAction('settings', {}, token)).rejects.toThrow('boom')
    expect(auditMocks.auditLog).not.toHaveBeenCalledWith('settings', true, expect.anything())
  })
})

describe('requestChallenge + modal IPC flow', () => {
  let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>

  beforeAll(() => {
    initProtectedActions()
  })

  beforeEach(() => {
    handlers = electronMocks.handlers
  })

  async function submitCorrectAnswer(action: ProtectedAction): Promise<string> {
    const dataHandler = handlers.get('protected:challenge:data')!
    const data = (await dataHandler(null)) as { text: string; action: string; difficulty: number }
    expect(data.action).toBe(action)
    expect(data.difficulty).toBe(DIFFICULTY_MAP[action])

    const resultHandler = handlers.get('protected:challenge:result')!
    const result = (await resultHandler(null, data.text)) as { ok: boolean }
    expect(result.ok).toBe(true)
    return data.text
  }

  it('solves a challenge end-to-end and yields a verifiable token', async () => {
    const pending = requestChallenge('toggle_category')
    const text = await submitCorrectAnswer('toggle_category')

    const token = await pending
    expect(typeof token).toBe('string')
    expect(verifyTokenForAction(token!, 'toggle_category').action).toBe('toggle_category')
    expect(Array.from(text)).toHaveLength(text.length) // sanity: real challenge text flowed back
  })

  it('rejects a wrong answer and keeps the challenge open', async () => {
    const pending = requestChallenge('pause')
    const dataHandler = handlers.get('protected:challenge:data')!
    const data = (await dataHandler(null)) as { text: string }

    const resultHandler = handlers.get('protected:challenge:result')!
    const wrong = await resultHandler(null, data.text.slice(0, -1))
    expect(wrong).toMatchObject({ ok: false, errorAt: expect.any(Number), progress: expect.any(Number) })

    const again = await resultHandler(null, data.text)
    expect(again).toMatchObject({ ok: true })
    expect(await pending).toEqual(expect.any(String))
  })

  it('submitting non-string input is refused while the session stays open', async () => {
    const pending = requestChallenge('export')
    const resultHandler = handlers.get('protected:challenge:result')!
    expect(await resultHandler(null, 42)).toEqual({ ok: false })
    expect(await handlers.get('protected:challenge:data')!(null)).not.toBeNull()
    await handlers.get('protected:challenge:cancel')!(null)
    await pending
  })

  it('cancelling resolves with null', async () => {
    const pending = requestChallenge('import_entries')
    await handlers.get('protected:challenge:cancel')!(null)
    await expect(pending).resolves.toBeNull()
  })

  it('returns null immediately when a challenge is already in progress', async () => {
    const first = requestChallenge('add_rule')
    const second = requestChallenge('add_rule')
    await expect(second).resolves.toBeNull()
    await handlers.get('protected:challenge:cancel')!(null)
    await first
  })

  it('exposes challenge data as null once the session is done', async () => {
    const pending = requestChallenge('remove_rule')
    await submitCorrectAnswer('remove_rule')
    await pending
    expect(await handlers.get('protected:challenge:data')!(null)).toBeNull()
  })

  it('surfaces cancel as a null token so no action can be executed', async () => {
    const impl = vi.fn()
    registerProtectedActionExecutor('uninstall', impl)
    const pending = requestChallenge('uninstall')
    await handlers.get('protected:challenge:cancel')!(null)
    const token = await pending
    expect(token).toBeNull()
    await expect(executeProtectedAction('uninstall', {}, String(token))).rejects.toThrow()
    expect(impl).not.toHaveBeenCalled()
  })
})