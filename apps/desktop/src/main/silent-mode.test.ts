import { describe, expect, it, vi } from 'vitest'
import { loadSilentModeController, SilentModeController, type SilentModeEffects } from './silent-mode'

function effectsSpies(): {
  effects: SilentModeEffects
  notifications: Array<{ title: string; body: string }>
  beeps: number[]
  trayStates: boolean[]
  changes: boolean[]
} {
  const notifications: Array<{ title: string; body: string }> = []
  const beeps: number[] = []
  const trayStates: boolean[] = []
  const changes: boolean[] = []
  return {
    effects: {
      setTrayVisible: (visible) => trayStates.push(visible),
      onChanged: (enabled) => changes.push(enabled),
      notify: (options) => notifications.push(options),
      beep: () => beeps.push(1),
    },
    notifications,
    beeps,
    trayStates,
    changes,
  }
}

function makeController(initial: boolean): {
  controller: SilentModeController
  persist: ReturnType<typeof vi.fn>
  effects: ReturnType<typeof effectsSpies>
} {
  const persist = vi.fn().mockResolvedValue(undefined)
  const effects = effectsSpies()
  const controller = new SilentModeController({ initial, persist, effects: effects.effects })
  return { controller, persist, effects }
}

describe('SilentModeController', () => {
  it('starts from the provided initial value', () => {
    const { controller } = makeController(true)
    expect(controller.isEnabled()).toBe(true)
  })

  it('persists and applies effects when enabled', async () => {
    const { controller, persist, effects } = makeController(false)
    await controller.setEnabled(true)
    expect(persist).toHaveBeenCalledWith(true)
    expect(effects.trayStates).toEqual([false]) // tray hidden
    expect(effects.changes).toEqual([true])
  })

  it('re-applies the tray when disabled', async () => {
    const { controller, effects } = makeController(true)
    await controller.setEnabled(false)
    expect(effects.trayStates).toEqual([true]) // tray shown again
    expect(effects.changes).toEqual([false])
  })

  it('is a no-op when the value does not change', async () => {
    const { controller, persist, effects } = makeController(false)
    await controller.setEnabled(false)
    expect(persist).not.toHaveBeenCalled()
    expect(effects.trayStates).toEqual([])
  })

  it('suppresses notifications and sounds in silent mode', () => {
    const { controller, effects } = makeController(true)
    controller.notify({ title: 't', body: 'b' })
    controller.ring()
    expect(effects.notifications).toEqual([])
    expect(effects.beeps).toEqual([])
  })

  it('lets notifications and sounds through outside silent mode', () => {
    const { controller, effects } = makeController(false)
    controller.notify({ title: 't', body: 'b' })
    controller.ring()
    expect(effects.notifications).toEqual([{ title: 't', body: 'b' }])
    expect(effects.beeps).toEqual([1])
  })
})

describe('loadSilentModeController', () => {
  it('boots with the persisted silent mode value', async () => {
    const read = vi.fn().mockResolvedValue({ silent_mode: true })
    const persist = vi.fn().mockResolvedValue(undefined)
    const controller = await loadSilentModeController({
      read,
      persist,
      effects: effectsSpies().effects,
    })
    expect(controller.isEnabled()).toBe(true)

    await controller.setEnabled(false)
    expect(persist).toHaveBeenCalledWith({ silent_mode: false })
  })
})