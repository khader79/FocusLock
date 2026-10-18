import { Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import trayActiveIconUrl from './assets/tray.png?asset'
import trayPausedIconUrl from './assets/tray-paused.png?asset'

/**
 * Locked actions available from the tray context menu. Every 🔒 action is a
 * protected action: the challenge runs in a dedicated modal window and the
 * action is executed only after a verified, short-lived token is returned.
 */
export type LockedAction = 'pause' | 'settings' | 'toggle_silent_mode' | 'quit'

/**
 * Runtime app state. Drives the tray menu status label, the tooltip and the
 * icon color (green = active, gray = paused).
 */
export type TrayStatus = 'active' | 'paused'

export interface TrayOptions {
  /** Restores the hidden window (tray left-click and "Open FocusLock"). */
  onOpen: () => void
  /** Runs a locked action through the challenge gate (modal + token + audit). */
  runProtectedAction: (action: LockedAction) => Promise<void>
}

export interface TrayController {
  getStatus(): TrayStatus
  setStatus(status: TrayStatus): void
  /** Destroys the native tray icon (used to toggle silent mode). */
  dispose(): void
}

const STATUS_LABELS: Record<TrayStatus, string> = {
  active: 'Status: Active',
  paused: 'Status: Paused',
}

const STATUS_TOOLTIPS: Record<TrayStatus, string> = {
  active: 'FocusLock — Active',
  paused: 'FocusLock — Paused',
}

// NativeImage must be created from a filesystem path; the ?asset import
// resolves to the emitted asset path at runtime.
function loadIcon(assetUrl: string): NativeImage {
  const image = nativeImage.createFromPath(assetUrl)
  if (image.isEmpty()) {
    throw new Error(`Failed to load tray icon from "${assetUrl}".`)
  }
  return image
}

/**
 * Creates the system tray. All tray state (status) lives here so the icon
 * color, tooltip and menu status label always stay in sync.
 */
export function setupTray(options: TrayOptions): TrayController {
  let status: TrayStatus = 'active'
  let tray: Tray | null = null

  const iconFor = (next: TrayStatus): NativeImage =>
    next === 'active' ? loadIcon(trayActiveIconUrl) : loadIcon(trayPausedIconUrl)

  const render = (): void => {
    if (tray === null) {
      return
    }

    // Icon color + tooltip follow the current state (green active / gray paused).
    tray.setImage(iconFor(status))
    tray.setToolTip(STATUS_TOOLTIPS[status])

    const template: MenuItemConstructorOptions[] = [
      { label: 'Open FocusLock', click: () => options.onOpen() },
      // Disabled status label, rebuilt whenever the state changes.
      { label: STATUS_LABELS[status], enabled: false },
      { type: 'separator' },
      {
        label: 'Pause 15 min 🔒',
        click: () => {
          void options.runProtectedAction('pause')
        },
      },
      {
        label: 'Settings 🔒',
        click: () => {
          void options.runProtectedAction('settings')
        },
      },
      {
        label: 'Silent mode (hide tray) 🔒',
        click: () => {
          void options.runProtectedAction('toggle_silent_mode')
        },
      },
      { type: 'separator' },
      {
        label: 'Quit 🔒',
        click: () => {
          void options.runProtectedAction('quit')
        },
      },
    ]

    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  tray = new Tray(iconFor(status))

  // Left-click on the tray icon restores the hidden window.
  tray.on('click', () => options.onOpen())

  render()

  return {
    getStatus: () => status,
    setStatus: (next) => {
      if (next === status) {
        return
      }

      status = next
      render()
    },
    dispose: () => {
      const current = tray
      tray = null
      current?.destroy()
    },
  }
}