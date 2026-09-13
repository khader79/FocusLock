/**
 * Custom URL protocol handler for the "focuslock://" scheme.
 *
 * Actual Windows registry registration is handled by Electron's
 * app.setAsDefaultProtocolClient() (called from index.ts via
 * installFocusLockProtocol), which writes the HKCU\Software\Classes\focuslock
 * keys with a shell/open/command pointing back at this executable. This module
 * stays Electron-free so the parsing logic is unit-testable.
 */

export const FOCUSLOCK_PROTOCOL = 'focuslock'

export type FocusLockUrlResult = { command: 'open' } | { command: 'unknown' }

/**
 * Parses an URL argument received when the app was launched for the
 * focuslock:// scheme, e.g. "focuslock://open" (case-insensitive).
 */
export function parseFocusLockUrl(raw: string): FocusLockUrlResult {
  const url = String(raw).trim().toLowerCase()
  const schemePrefix = `${FOCUSLOCK_PROTOCOL}:`
  if (!url.startsWith(schemePrefix)) {
    return { command: 'unknown' }
  }

  const rest = url.startsWith(`${FOCUSLOCK_PROTOCOL}://`)
    ? url.slice(schemePrefix.length + 2)
    : url.slice(schemePrefix.length)
  const path = rest.replace(/^\/+/, '').split(/[/?#]/)[0] ?? ''

  if (path === 'open') {
    return { command: 'open' }
  }
  return { command: 'unknown' }
}

/** True when the argument is a focuslock://open deep link. */
export function isOpenFocusLockUrl(raw: string): boolean {
  return parseFocusLockUrl(raw).command === 'open'
}

export type ProtocolRegistration = (
  protocol: string,
  execPath?: string,
  args?: string[],
) => boolean

export interface InstallProtocolOptions {
  /** Packaged apps register the bare protocol against the app executable. */
  isPackaged: boolean
  execPath: string
  /** process.argv[1]; in dev this is the entry script Electron needs to relaunch with. */
  launchArg: string | undefined
}

/**
 * Registers this executable as the default handler for focuslock://. In dev
 * the running executable is electron.exe, so it must be told which script to
 * launch when Windows spawns it for the scheme.
 */
export function installFocusLockProtocol(
  register: ProtocolRegistration,
  options: InstallProtocolOptions,
): boolean {
  if (options.isPackaged || options.launchArg === undefined) {
    return register(FOCUSLOCK_PROTOCOL)
  }
  return register(FOCUSLOCK_PROTOCOL, options.execPath, [options.launchArg])
}