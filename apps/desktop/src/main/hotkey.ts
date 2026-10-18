/**
 * System-wide hotkey that reopens the (possibly hidden) FocusLock window. The
 * window can be hidden by close-to-tray and by silent mode, where a global
 * key is the only quick way back in other than the Start Menu shortcut or a
 * focuslock://open deep link.
 *
 * Registration is injected so this module is unit-testable without Electron.
 */

export const OPEN_WINDOW_ACCELERATOR = 'CommandOrControl+Alt+Shift+F'

export interface InstallHotkeyOptions {
  register: (accelerator: string, callback: () => void) => boolean
  onOpen: () => void
}

/**
 * Registers Ctrl+Alt+Shift+F (Ctrl maps to CommandOrControl on Windows) as a
 * global hotkey. Returns false when another application already owns the
 * combination.
 */
export function installOpenWindowHotkey(options: InstallHotkeyOptions): boolean {
  const ok = options.register(OPEN_WINDOW_ACCELERATOR, () => options.onOpen())
  if (!ok) {
    console.error('[hotkey] failed to register global hotkey (already in use?)')
  }
  return ok
}