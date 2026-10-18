import { describe, expect, it, vi } from 'vitest'
import { installOpenWindowHotkey, OPEN_WINDOW_ACCELERATOR } from './hotkey'

describe('installOpenWindowHotkey', () => {
  it('registers the Ctrl+Alt+Shift+F accelerator', () => {
    let registered: string | null = null
    let fired = false
    const ok = installOpenWindowHotkey({
      register: (accelerator, callback) => {
        registered = accelerator
        callback()
        return true
      },
      onOpen: () => {
        fired = true
      },
    })

    expect(ok).toBe(true)
    expect(registered).toBe(OPEN_WINDOW_ACCELERATOR)
    expect(OPEN_WINDOW_ACCELERATOR).toContain('Alt+Shift+F')
    expect(fired).toBe(true)
  })

  it('returns false when the combination is taken', () => {
    const register = vi.fn().mockReturnValue(false)
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ok = installOpenWindowHotkey({ register, onOpen: () => undefined })
    expect(ok).toBe(false)
    expect(register).toHaveBeenCalledOnce()
    logSpy.mockRestore()
  })
})