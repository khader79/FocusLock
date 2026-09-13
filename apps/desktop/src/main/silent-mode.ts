import type { AppSettings } from './settings'

export interface SilentNotification {
  title: string
  body: string
}

/**
 * Effects the controller applies to the rest of the app whenever the silent
 * mode value changes. Injected so this module stays free of Electron (and
 * therefore unit-testable).
 */
export interface SilentModeEffects {
  /** Creates (true) or destroys (false) the tray icon. */
  setTrayVisible: (visible: boolean) => void
  /** Called whenever the silent mode value changes. */
  onChanged?: (enabled: boolean) => void
  /** Shows a desktop notification (no-op without this, unused in silent mode). */
  notify?: (options: SilentNotification) => void
  /** Plays a sound (no-op without this, unused in silent mode). */
  beep?: () => void
}

export interface SilentModeOptions {
  initial: boolean
  persist?: (enabled: boolean) => Promise<void>
  effects: SilentModeEffects
}

/**
 * Tracks and applies the silent mode setting. When enabled:
 *  - the tray icon is hidden (window reopens via Start Menu, focuslock:// or
 *    the global hotkey),
 *  - notifications and sounds are suppressed.
 */
export class SilentModeController {
  private enabled: boolean
  private readonly persist: (enabled: boolean) => Promise<void>
  private readonly effects: SilentModeEffects

  constructor(options: SilentModeOptions) {
    this.enabled = options.initial
    this.persist = options.persist ?? (async () => undefined)
    this.effects = options.effects
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) {
      return
    }
    this.enabled = enabled
    await this.persist(enabled)
    this.effects.setTrayVisible(!enabled)
    this.effects.onChanged?.(enabled)
  }

  /** Shows a notification unless silent mode suppresses it. */
  notify(options: SilentNotification): void {
    if (this.enabled) {
      return
    }
    this.effects.notify?.(options)
  }

  /** Plays a sound unless silent mode suppresses it. */
  ring(): void {
    if (this.enabled) {
      return
    }
    this.effects.beep?.()
  }
}

export interface LoadSilentModeDeps {
  read: () => Promise<AppSettings>
  persist: (settings: AppSettings) => Promise<void>
  effects: SilentModeEffects
}

/** Reads the persisted settings and builds a controller over them. */
export async function loadSilentModeController(
  deps: LoadSilentModeDeps,
): Promise<SilentModeController> {
  const settings = await deps.read()
  return new SilentModeController({
    initial: settings.silent_mode === true,
    persist: async (enabled) => deps.persist({ silent_mode: enabled }),
    effects: deps.effects,
  })
}