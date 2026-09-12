import { app, Menu } from 'electron'

/**
 * App-level lockdown, run once at startup before any window exists:
 *  - strips the application menu bar
 *  - denies any attempt to open a new window, navigate away from the app, or
 *    use reload/devtools/close shortcuts (F11, Ctrl/Cmd+W, Ctrl/Cmd+R,
 *    Ctrl+Shift+I)
 *
 * Per-window trap behaviour (kiosk mode, close prevention) lives in
 * createWindow(); this covers every WebContents globally, including the main
 * window.
 */
export function hardenApp(): void {
  Menu.setApplicationMenu(null)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') {
        return
      }

      const key = input.key.toLowerCase()
      const controlOrMeta = input.control || input.meta

      if (key === 'f11') {
        event.preventDefault()
        return
      }

      if (controlOrMeta && !input.alt && !input.shift && key === 'w') {
        event.preventDefault()
        return
      }

      if (controlOrMeta && !input.alt && key === 'r') {
        event.preventDefault()
        return
      }

      if (controlOrMeta && input.shift && !input.alt && key === 'i') {
        event.preventDefault()
        return
      }
    })
  })
}