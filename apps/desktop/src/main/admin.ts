import { app, Menu } from 'electron'

/**
 * App-level lockdown, run once at startup before any window exists:
 *  - strips the application menu bar
 *  - denies any attempt to open a new window or navigate away from the app
 *
 * NOTE: the old per-window trapping behaviour (kiosk mode, close prevention)
 * lives in createWindow() and has been replaced by close-to-tray. The previous
 * before-input-event handler is REMOVED: F11 / Ctrl/Cmd+W / Ctrl/Cmd+R and
 * Ctrl+Shift+I are no longer blocked, so the app behaves like a normal window.
 */
export function hardenApp(): void {
  Menu.setApplicationMenu(null)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
  })
}