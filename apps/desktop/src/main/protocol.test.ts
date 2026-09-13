import { describe, expect, it, vi } from 'vitest'
import {
  FOCUSLOCK_PROTOCOL,
  installFocusLockProtocol,
  isOpenFocusLockUrl,
  parseFocusLockUrl,
  type ProtocolRegistration,
} from './protocol'

describe('parseFocusLockUrl', () => {
  it('parses focuslock://open', () => {
    expect(parseFocusLockUrl('focuslock://open')).toEqual({ command: 'open' })
  })

  it('is case-insensitive', () => {
    expect(parseFocusLockUrl('FOCUSLOCK://Open')).toEqual({ command: 'open' })
  })

  it('accepts a single-slash form and extra query/path segments', () => {
    expect(parseFocusLockUrl('focuslock:open')).toEqual({ command: 'open' })
    expect(parseFocusLockUrl('focuslock://open?source=tray')).toEqual({ command: 'open' })
  })

  it('rejects unknown commands and foreign schemes', () => {
    expect(parseFocusLockUrl('focuslock://stop')).toEqual({ command: 'unknown' })
    expect(parseFocusLockUrl('focuslock://open-other')).toEqual({ command: 'unknown' })
    expect(parseFocusLockUrl('https://open')).toEqual({ command: 'unknown' })
    expect(parseFocusLockUrl('')).toEqual({ command: 'unknown' })
  })
})

describe('isOpenFocusLockUrl', () => {
  it('is true only for open commands', () => {
    expect(isOpenFocusLockUrl('focuslock://open')).toBe(true)
    expect(isOpenFocusLockUrl('focuslock://settings')).toBe(false)
  })
})

describe('installFocusLockProtocol', () => {
  const register = vi.fn<ProtocolRegistration>()

  it('registers the bare protocol when packaged', () => {
    register.mockReturnValue(true)
    const ok = installFocusLockProtocol(register, {
      isPackaged: true,
      execPath: 'C:\\FocusLock\\FocusLock.exe',
      launchArg: undefined,
    })
    expect(ok).toBe(true)
    expect(register).toHaveBeenCalledWith(FOCUSLOCK_PROTOCOL)
  })

  it('registers the protocol against electron.exe plus the dev entry script', () => {
    register.mockReturnValue(true)
    const ok = installFocusLockProtocol(register, {
      isPackaged: false,
      execPath: 'C:\\electron\\electron.exe',
      launchArg: 'C:\\focuslock\\out\\main\\index.js',
    })
    expect(ok).toBe(true)
    expect(register).toHaveBeenCalledWith(FOCUSLOCK_PROTOCOL, 'C:\\electron\\electron.exe', [
      'C:\\focuslock\\out\\main\\index.js',
    ])
  })

  it('propagates registration failures', () => {
    register.mockReturnValue(false)
    const ok = installFocusLockProtocol(register, {
      isPackaged: true,
      execPath: 'x',
      launchArg: undefined,
    })
    expect(ok).toBe(false)
  })
})