import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  diffIndex,
  generateChallenge,
  isComplete,
  progress,
  type Challenge,
  type Difficulty,
} from '@focuslock/core'
import modalHtmlUrl from './challenge-modal.html?asset'
import { signChallengeToken, verifyTokenForAction, type TokenClaims } from './challenge-token'
import { auditLog } from './audit-log'

export { assertValidChallengeToken } from './challenge-token'
export type { TokenClaims } from './challenge-token'

export type ProtectedAction =
  | 'settings'
  | 'pause'
  | 'remove_site'
  | 'remove_app'
  | 'add_site'
  | 'add_app'
  | 'toggle_category'
  | 'toggle_silent_mode'
  | 'add_custom_site'
  | 'remove_custom_site'
  | 'block_app'
  | 'unblock_app'
  | 'add_rule'
  | 'remove_rule'
  | 'update_rule'
  | 'quit'
  | 'uninstall'
  | 'export'
  | 'import_entries'

/**
 * Challenge difficulty used for each protected action. The harder the
 * consequence, the harder the gate.
 */
export const DIFFICULTY_MAP: Record<ProtectedAction, number> = {
  add_site: 2,
  add_app: 2,
  remove_site: 2,
  remove_app: 3,
  add_custom_site: 2,
  remove_custom_site: 2,
  block_app: 3,
  unblock_app: 3,
  toggle_category: 3,
  toggle_silent_mode: 3,
  add_rule: 3,
  remove_rule: 3,
  update_rule: 3,
  settings: 3,
  pause: 4,
  export: 3,
  import_entries: 3,
  uninstall: 5,
  quit: 5,
}

/** Executes a protected action once its challenge token has been verified. */
export type ProtectedActionExecutor = (
  payload: unknown,
  challengeToken: string,
) => Promise<void> | void

const executors = new Map<ProtectedAction, ProtectedActionExecutor>()

/** Registers the real implementation for a protected action. */
export function registerProtectedActionExecutor(
  action: ProtectedAction,
  executor: ProtectedActionExecutor,
): void {
  executors.set(action, executor)
}

// --- Challenge modal window ---------------------------------------------------

interface ChallengeSession {
  action: ProtectedAction
  challenge: Challenge
}

let session: ChallengeSession | null = null
let sessionResolve: ((token: string | null) => void) | null = null
let modalWindow: BrowserWindow | null = null

function finishChallenge(token: string | null): void {
  const resolve = sessionResolve
  session = null
  sessionResolve = null

  if (modalWindow !== null && !modalWindow.isDestroyed()) {
    modalWindow.close()
  }

  resolve?.(token)
}

function openModal(action: ProtectedAction): void {
  const parent = BrowserWindow.getAllWindows()[0]

  modalWindow = new BrowserWindow({
    width: 800,
    height: 600,
    center: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent,
    modal: parent !== undefined,
    title: `FocusLock — ${action}`,
    webPreferences: {
      preload: join(__dirname, '../preload/challenge-modal.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  })

  modalWindow.on('closed', () => {
    modalWindow = null
  })

  // Closing the modal window counts as cancelling the challenge.
  modalWindow.on('close', () => {
    finishChallenge(null)
  })

  void modalWindow.loadFile(modalHtmlUrl)
}

// --- IPC (modal <-> main) -----------------------------------------------------

let ipcRegistered = false

/** Registers the modal IPC handlers once. Call before the first requestChallenge. */
export function initProtectedActions(): void {
  if (ipcRegistered) {
    return
  }
  ipcRegistered = true

  ipcMain.handle('protected:challenge:data', () => {
    if (session === null) {
      return null
    }
    return {
      text: session.challenge.text,
      action: session.action,
      difficulty: session.challenge.difficulty,
      expiresAt: session.challenge.expiresAt.getTime(),
    }
  })

  ipcMain.handle('protected:challenge:result', (_event, typed: unknown) => {
    if (session === null || typeof typed !== 'string') {
      return { ok: false }
    }

    if (isComplete(typed, session.challenge.text)) {
      const token = signChallengeToken(session.action)
      finishChallenge(token)
      return { ok: true }
    }

    return {
      ok: false,
      errorAt: diffIndex(typed, session.challenge.text),
      progress: progress(typed, session.challenge.text),
    }
  })

  ipcMain.handle('protected:challenge:cancel', () => {
    finishChallenge(null)
    return null
  })
}

/**
 * Asks the user to complete a typing challenge in a dedicated modal window.
 * Resolves with a short-lived (5 min) JWT on success, or null on cancel/fail.
 */
export function requestChallenge(action: ProtectedAction): Promise<string | null> {
  if (session !== null) {
    return Promise.resolve(null)
  }

  return new Promise<string | null>((resolve) => {
    const challenge = generateChallenge(DIFFICULTY_MAP[action] as Difficulty)
    session = { action, challenge }
    sessionResolve = resolve
    openModal(action)
  })
}

/**
 * Performs a protected action after verifying its challenge token:
 *   1. Verifies the token (signature, action match, expiry) — throws on failure.
 *   2. Executes the registered real action.
 *   3. Appends the outcome to the audit log.
 */
export async function executeProtectedAction(
  action: ProtectedAction,
  payload: unknown,
  challengeToken: string,
): Promise<void> {
  let claims: TokenClaims
  try {
    claims = verifyTokenForAction(challengeToken, action)
  } catch (err) {
    auditLog(action, false, { error: err instanceof Error ? err.message : String(err) })
    throw err
  }

  const executor = executors.get(action)
  if (executor === undefined) {
    const err = new Error(`No executor registered for protected action "${action}".`)
    auditLog(action, false, { error: err.message })
    throw err
  }

  await executor(payload, challengeToken)
  auditLog(action, true, { claims })
}
