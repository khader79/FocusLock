import { randomInt } from 'node:crypto'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, shell } from 'electron'
import {
  diffIndex,
  generateChallenge,
  isComplete,
  progress,
  WORDS,
  type Challenge,
  type Difficulty,
} from '@focuslock/core'
import { hardenApp } from './admin'
import {
  appInfoFromExePath,
  listInstalledApps,
  pickApp,
  readBlockedApps,
  setAppBlockerBaseDir,
  setAppPicker,
  type AppInfo,
} from './app-blocker'
import { setAuditLogBaseDir } from './audit-log'
import { installBlocker, requestBlockerApply } from './blocker'
import {
  addCustomCategory,
  bootstrapCategories,
  readCategoriesOverview,
  removeCustomCategory,
  scheduleDailyUpdate,
  searchCategoryPatterns,
  setCategoryBaseDir,
  setCategoryEnabled,
  updateCategoryEntry,
} from './categories'
import { bulkAdd, listSites, setCustomSitesBaseDir, setCustomSitesEffects } from './custom-sites'
import {
  configureSystemDnsOnInstall,
  reloadDnsRules,
  restoreSystemDns,
  startDnsService,
  stopDnsService,
} from './dns-service'
import { startEnforcer } from './enforcer'
import { installOpenWindowHotkey } from './hotkey'
import {
  executeProtectedAction,
  initProtectedActions,
  requestChallenge,
} from './protected-actions'
import { registerProtectedExecutors } from './protected-executors'
import { exportData, exportEncrypted, setExportBaseDir, type ExportFormat } from './export'
import { importEntries, parseBulkPaste, parseColdTurkeyExports, parseFile, parseUrl, setImportBaseDir, setImportEffects, validateEntries, type ImportEntry } from './import'
import { installFocusLockProtocol } from './protocol'
import {
  loadRules,
  setRuleContextProvider,
  setRulesBaseDir,
  startRulesEngine,
  stopRulesEngine,
} from './rules'
import { readSettings, settingsFilePath, writeSettings } from './settings'
import {
  loadSilentModeController,
  type SilentModeController,
  type SilentModeEffects,
} from './silent-mode'
import { setupTray, type TrayController } from './tray'
import { startWatchdog, stopWatchdog } from './watchdog'

let currentChallenge: Challenge | null = null
let mainWindowRef: BrowserWindow | null = null

function broadcastState(data: Record<string, unknown>): void {
  try {
    mainWindowRef?.webContents.send('focuslock:state-change', data)
  } catch {
    // Window may be closed
  }
}

// Guards the window 'close' handler. It stays false so that closing the window
// only hides it to the tray; it becomes true in exactly one place: the "quit"
// protected action, executed only after its challenge token was verified.
let isQuitting = false

// 15-minute pause: tray status flips to "paused" and back to "active" after
// the timer fires.
const PAUSE_MILLIS = 15 * 60 * 1000
let pauseTimer: NodeJS.Timeout | null = null

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let silent: SilentModeController | null = null

export interface CheckResult {
  ok: boolean
  errorAt: number
  progress: number
}

export interface GiveUpResult {
  ok: boolean
  idleWord: string
}

function isValidDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
}

function pickIdleWord(): string {
  return WORDS[randomInt(WORDS.length)]!
}

// Focuses the main window, creating it lazily if it was closed. Safe to call
// from the hotkey, deep link or second-instance handlers before/after startup.
function focusWindow(): void {
  if (!app.isReady()) {
    return
  }
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

// The challenge handlers below belong to the main window's own focus-session
// flow (start/check/give-up). Protected capability changes are NOT handled
// here: they all go through requestChallenge + executeProtectedAction (see
// tray.ts / protected-actions.ts), so no IPC handler mutates protected state
// without a verified challenge token.
function registerIpcHandlers(): void {
  ipcMain.handle('challenge:new', (_event, difficulty: unknown): Challenge => {
    if (!isValidDifficulty(difficulty)) {
      throw new Error(
        `Invalid difficulty "${String(difficulty)}". Expected an integer from 1 to 5.`,
      )
    }

    currentChallenge = generateChallenge(difficulty)
    return currentChallenge
  })

  ipcMain.handle('challenge:check', (_event, typed: unknown): CheckResult => {
    if (typeof typed !== 'string') {
      throw new Error('typed must be a string.')
    }

    if (currentChallenge === null) {
      return { ok: false, errorAt: -1, progress: 0 }
    }

    const target = currentChallenge.text

    return {
      ok: isComplete(typed, target),
      errorAt: diffIndex(typed, target),
      progress: progress(typed, target),
    }
  })

  ipcMain.handle('challenge:giveup', (): GiveUpResult => {
    currentChallenge = null

    return { ok: true, idleWord: pickIdleWord() }
  })

  ipcMain.handle('settings:silent:get', () => silent?.isEnabled() ?? false)

  // --- Import / export IPC -----------------------------------------------------
  ipcMain.handle('imports:choose-file', async () => {
    const result = await dialog.showOpenDialog({ title: 'Import blocklist', properties: ['openFile'], filters: [{ name: 'Supported lists', extensions: ['txt', 'csv', 'json', 'hosts'] }] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('imports:preview', async (_event, request: unknown) => {
    const body = request as { kind?: unknown; value?: unknown }
    const kind = body.kind; const value = typeof body.value === 'string' ? body.value : ''
    const parsed = kind === 'file' ? await parseFile(value) : kind === 'url' ? await parseUrl(value) : kind === 'cold-turkey' ? await parseColdTurkeyExports(value || undefined) : parseBulkPaste(value)
    return { ...parsed, validation: validateEntries(parsed.entries) }
  })
  ipcMain.handle('imports:commit', async (_event, entries: unknown) => {
    if (!Array.isArray(entries)) throw new TypeError('Import entries must be an array.')
    const token = await requestChallenge('import_entries')
    if (token === null) return null
    return importEntries(entries as ImportEntry[], token)
  })
  ipcMain.handle('exports:choose-path', async (_event, format: unknown) => {
    const extension = format === 'txt' || format === 'csv' || format === 'hosts' ? format : format === 'encrypted' ? 'focuslock' : 'json'
    const result = await dialog.showSaveDialog({ title: 'Export FocusLock data', defaultPath: `focuslock-export.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] })
    return result.canceled ? null : (result.filePath ?? null)
  })
  ipcMain.handle('exports:create', async (_event, request: unknown): Promise<boolean> => {
    const body = request as { path?: unknown; format?: unknown; password?: unknown }
    if (typeof body.path !== 'string' || body.path.trim() === '') throw new TypeError('Export path must be a non-empty string.')
    const token = await requestChallenge('export')
    if (token === null) return false
    if (body.format === 'encrypted') await exportEncrypted(body.path, typeof body.password === 'string' ? body.password : '', token)
    else await exportData((body.format === 'txt' || body.format === 'csv' || body.format === 'hosts' ? body.format : 'json') as ExportFormat, body.path, token)
    return true
  })

  // "rules:list" is read-only; every mutation (across all three rule actions)
  // runs through the protected-action challenge gate so a caller can never add,
  // remove or update a rule without presenting a valid token.
   ipcMain.handle('rules:list', () => loadRules())

   ipcMain.handle('rules:mutate', async (payload: unknown) => {
     const result = await runRuleMutation('add_rule', payload)
     broadcastState({ categories: await readCategoriesOverview(app.getPath('userData')) })
     return result
   })

   async function runRuleMutation(
    action: 'add_rule' | 'remove_rule' | 'update_rule',
    payload: unknown,
  ): Promise<boolean> {
    const token = await requestChallenge(action)
    if (token === null) return false
    try {
      await executeProtectedAction(action, payload, token)
      return true
    } catch (err) {
      console.error(`[rules] protected ${action} failed:`, err)
      return false
    }
  }

  ipcMain.handle('rules:add', (_event, rule: unknown) => runRuleMutation('add_rule', { rule }))
  ipcMain.handle('rules:remove', (_event, id: unknown) => runRuleMutation('remove_rule', { id }))
  ipcMain.handle('rules:update', (_event, id: unknown, rule: unknown) =>
    runRuleMutation('update_rule', { id, rule }),
  )

  // Toggling silent mode is a protected capability (it changes how visible the
  // app is), so it runs through the same challenge gate as every other change.
  ipcMain.handle('settings:silent:toggle', async () => {
    if (silent === null) {
      return false
    }
    const token = await requestChallenge('toggle_silent_mode')
    if (token === null) {
      return false
    }
    try {
      await executeProtectedAction('toggle_silent_mode', undefined, token)
      return true
    } catch (err) {
      console.error('[silent-mode] toggle failed:', err)
      return false
    }
  })

  // --- Category IPC handlers ---------------------------------------------------

  ipcMain.handle('categories:list', async () => {
    const baseDir = app.getPath('userData')
    return readCategoriesOverview(baseDir)
  })

   ipcMain.handle('categories:toggle', async (_event, id: unknown): Promise<boolean> => {
     if (typeof id !== 'string' || id.trim() === '') {
       throw new TypeError('Category id must be a non-empty string.')
     }
     const baseDir = app.getPath('userData')
     const overview = await readCategoriesOverview(baseDir)
     const info = overview.find((entry) => entry.id === id)
     if (info === undefined) {
       throw new Error(`Unknown category: "${id}".`)
     }

     if (info.enabled) {
       const token = await requestChallenge('toggle_category')
       if (token === null) {
         return false
       }
       try {
         await executeProtectedAction('toggle_category', { id, target: 'disable' }, token)
         broadcastState({ status: 'active' })
         return true
       } catch (err) {
         console.error('[categories] protected disable failed:', err)
         return false
       }
     }

     try {
       await setCategoryEnabled(id, true, { baseDir, onRulesChanged: () => reloadDnsRules() })
       broadcastState({ status: 'active' })
       return true
     } catch (err) {
       console.error('[categories] enable failed:', err)
       return false
     }
   })

  ipcMain.handle('categories:update', async (_event, id: unknown) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('Category id must be a non-empty string.')
    }
    const baseDir = app.getPath('userData')
    return updateCategoryEntry(id, { baseDir, onRulesChanged: () => reloadDnsRules() })
  })

  ipcMain.handle(
    'categories:patterns',
    async (_event, id: unknown, query: unknown): Promise<{ total: number; domains: string[] }> => {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new TypeError('Category id must be a non-empty string.')
      }
      const baseDir = app.getPath('userData')
      return searchCategoryPatterns(baseDir, id, typeof query === 'string' ? query : '')
    },
  )

  ipcMain.handle(
    'categories:add',
    async (_event, payload: unknown) => {
      const baseDir = app.getPath('userData')
      const { name, url, color } = (payload ?? {}) as Record<string, unknown>
      if (typeof name !== 'string' || name.trim() === '') {
        throw new TypeError('Category name must be a non-empty string.')
      }
      if (typeof url !== 'string' || url.trim() === '') {
        throw new TypeError('Category URL must be a non-empty string.')
      }
      if (typeof color !== 'string') {
        throw new TypeError('Category color must be a string.')
      }
       return addCustomCategory({ name, url, color }, { baseDir, onRulesChanged: async () => { await reloadDnsRules(); broadcastState({}) } })
    },
  )

  ipcMain.handle('categories:remove', async (_event, id: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('Category id must be a non-empty string.')
    }
    const baseDir = app.getPath('userData')
    await removeCustomCategory(id, { baseDir, onRulesChanged: async () => { await reloadDnsRules(); broadcastState({}) } })
    broadcastState({})
    return true
  })

  // --- Custom site IPC handlers ---------------------------------------------------

  ipcMain.handle('custom-sites:list', async (_event, filter: unknown) => {
    return listSites(typeof filter === 'string' ? filter : undefined)
  })

   ipcMain.handle('custom-sites:add', async (_event, input: unknown): Promise<boolean> => {
     if (typeof input !== 'string' || input.trim() === '') {
       throw new TypeError('Custom site input must be a non-empty string.')
     }
     const token = await requestChallenge('add_custom_site')
     if (token === null) {
       return false
     }
     try {
       await executeProtectedAction('add_custom_site', { input }, token)
       broadcastState({})
       return true
     } catch (err) {
       console.error('[custom-sites] add failed:', err)
       return false
     }
   })

   ipcMain.handle('custom-sites:remove', async (_event, id: unknown): Promise<boolean> => {
     if (typeof id !== 'number' || !Number.isInteger(id)) {
       throw new TypeError('Custom site id must be an integer.')
     }
     const token = await requestChallenge('remove_custom_site')
     if (token === null) {
       return false
     }
     try {
       await executeProtectedAction('remove_custom_site', { id }, token)
       broadcastState({})
       return true
     } catch (err) {
       console.error('[custom-sites] remove failed:', err)
       return false
     }
   })

  ipcMain.handle('custom-sites:bulk', async (_event, text: unknown): Promise<number> => {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new TypeError('Custom site list must be a non-empty string.')
    }
    const token = await requestChallenge('add_custom_site')
    if (token === null) {
      return 0
    }
    try {
      return await bulkAdd(text, token)
    } catch (err) {
      console.error('[custom-sites] bulk add failed:', err)
      return 0
    }
  })

  // --- App blocking IPC handlers (Windows only) -----------------------------------

  ipcMain.handle('apps:list', async () => {
    if (process.platform !== 'win32') {
      return []
    }
    return listInstalledApps()
  })

  ipcMain.handle('apps:blocked', async () => {
    if (process.platform !== 'win32') {
      return []
    }
    return readBlockedApps(app.getPath('userData'))
  })

  ipcMain.handle('apps:pick', async (): Promise<AppInfo | null> => {
    if (process.platform !== 'win32') {
      return null
    }
    return pickApp()
  })

  ipcMain.handle('apps:block', async (_event, exePath: unknown): Promise<boolean> => {
    if (process.platform !== 'win32') {
      return false
    }
    if (typeof exePath !== 'string' || exePath.trim() === '') {
      throw new TypeError('exePath must be a non-empty string.')
    }
    const token = await requestChallenge('block_app')
    if (token === null) {
      return false
    }
    try {
      await executeProtectedAction('block_app', { exePath }, token)
      return true
    } catch (err) {
      console.error('[apps] block failed:', err)
      return false
    }
  })

  ipcMain.handle('apps:unblock', async (_event, name: unknown): Promise<boolean> => {
    if (process.platform !== 'win32') {
      return false
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('App name must be a non-empty string.')
    }
    const token = await requestChallenge('unblock_app')
    if (token === null) {
      return false
    }
    try {
      await executeProtectedAction('unblock_app', { name }, token)
      return true
    } catch (err) {
      console.error('[apps] unblock failed:', err)
      return false
    }
  })
}

// Flips the tray to "paused" for 15 minutes, then back to "active".
function beginPause(): void {
  if (pauseTimer !== null) {
    clearTimeout(pauseTimer)
  }

  tray?.setStatus('paused')

  pauseTimer = setTimeout(() => {
    pauseTimer = null
    tray?.setStatus('active')
  }, PAUSE_MILLIS)
}

function createWindow(): BrowserWindow {
  // Normal window: resizable, minimizable, standard frame with close/minimize
  // buttons, visible in the taskbar. The old kiosk/fullscreen/always-on-top/
  // closable:false/skipTaskbar/frame:false trapping properties are gone.
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    resizable: true,
    minimizable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  })

  mainWindow = win
  mainWindowRef = win

  // Closing the window no longer destroys it or quits the app: it hides to the
  // tray while the process keeps running in the background. Only when
  // isQuitting is true (set by the verified "quit" protected action) is the
  // close allowed to proceed.
  win.on('close', (event) => {
    if (isQuitting) {
      return
    }

    event.preventDefault()
    win.hide()
  })

  win.on('closed', () => {
    mainWindow = null
    mainWindowRef = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function runProtectedActionFromChrome(action: Parameters<typeof requestChallenge>[0]): Promise<void> {
  return (async () => {
    const token = await requestChallenge(action)
    if (token === null) {
      return
    }
    try {
      await executeProtectedAction(action, undefined, token)
    } catch (err) {
      console.error('[protected-action] execution failed:', err)
    }
  })()
}

// Tray lifecycle. In silent mode there is no tray at all; the window reopens
// via the Start Menu shortcut, a focuslock://open deep link or the global
// hotkey instead.
function createTray(): TrayController | null {
  if (tray !== null) {
    return tray
  }
  tray = setupTray({
    onOpen: () => focusWindow(),
    runProtectedAction: runProtectedActionFromChrome,
  })
  return tray
}

function destroyTray(): void {
  tray?.dispose()
  tray = null
}

const silentEffects: SilentModeEffects = {
  setTrayVisible: (visible) => {
    if (visible) {
      createTray()
    } else {
      destroyTray()
    }
  },
  notify: (options) => {
    new Notification(options).show()
  },
  beep: () => {
    shell.beep()
  },
}

// Headless enforcement mode: the installed Windows service launches this same
// binary with --enforcer (and --userDataPath pointing at the interactive user's
// data directory). No window, tray, hotkey, IPC or single-instance lock here —
// blocking just runs in the background.
function enforcerUserDataPath(): string | undefined {
  const flagIndex = process.argv.indexOf('--userDataPath')
  if (flagIndex === -1) {
    return undefined
  }
  const value = process.argv[flagIndex + 1]
  return value !== undefined && value !== '' ? value : undefined
}

if (process.argv.includes('--enforcer')) {
  const userDataPath = enforcerUserDataPath()
  if (userDataPath === undefined) {
    console.error('[enforcer] missing --userDataPath <dir>; exiting.')
    app.exit(1)
  } else {
    app.disableHardwareAcceleration()
    void app
      .whenReady()
      .then(() => startEnforcer(userDataPath))
      .catch((err) => {
        console.error('[enforcer] failed to start:', err)
        app.exit(1)
      })
  }
} else {
  // Single-instance: a second launch (Start Menu shortcut, focuslock:// deep
  // link) forwards control to the running copy and focuses the window instead of
  // starting a second process.
  const hasSingleInstanceLock = app.requestSingleInstanceLock()

  if (!hasSingleInstanceLock) {
    app.quit()
  } else {
    app.on('second-instance', () => focusWindow())

    // URL protocol handler (macOS/desktop): focuslock://open focuses the window.
    app.on('open-url', (event, url) => {
      event.preventDefault()
      if (url.toLowerCase().startsWith('focuslock://open')) {
        focusWindow()
      }
    })

    app.whenReady().then(async () => {
      hardenApp()
      await installBlocker()
      // Local DNS filter (127.0.0.1:53). On success, point the OS resolver at it
      // ("install" step); requires admin privileges for both.
      if (await startDnsService()) {
        try {
          await configureSystemDnsOnInstall()
        } catch (err) {
          console.error('[dns] system DNS configuration failed (needs admin):', err)
        }
      }
      startWatchdog()
      initProtectedActions()

      const userDataPath = app.getPath('userData')

      // Category presets: seed the default-enabled lists on first run (ads +
      // social) and refresh them every 24h. Each change rebuilds the matcher.
      setCategoryBaseDir(userDataPath)
      void bootstrapCategories({ onRulesChanged: () => reloadDnsRules() }).catch((err) => {
        console.error('[categories] bootstrap failed:', err)
      })
      scheduleDailyUpdate({ onRulesChanged: () => reloadDnsRules() })

      // Custom sites: persist under userData and rebuild the DNS matcher +
      // hosts blocker on every mutation (effect wiring lives here so the module
      // itself stays Electron-free).
      setCustomSitesBaseDir(userDataPath)
      setCustomSitesEffects({
        rebuildMatcher: () => reloadDnsRules(),
        reapplyBlocker: () => requestBlockerApply(),
      })

      // Imports use the same blocklist as manual entries and refresh both
      // enforcement layers only after their atomic write succeeds.
      setImportBaseDir(userDataPath)
      setImportEffects(async () => {
        await reloadDnsRules()
        requestBlockerApply()
      })
      setExportBaseDir(userDataPath)

      // App blocking (Windows only): commands + watcher are electron-free in
      // app-blocker.ts; base dir, the native picker and the audit log dir are
      // wired here.
      setAppBlockerBaseDir(userDataPath)
      setAuditLogBaseDir(app.getPath('logs'))
      setAppPicker(async () => {
        const result = await dialog.showOpenDialog({
          title: 'Select an application to block',
          properties: ['openFile'],
          filters: [{ name: 'Applications', extensions: ['exe'] }],
        })
        const filePath = result.filePaths[0]
        return filePath === undefined ? null : appInfoFromExePath(filePath)
      })

      // Rules engine: persists under userData and re-evaluates the active
      // actions every 30s against a live context provider wired here (the
      // module itself stays Electron-free). The session clock starts when the
      // app becomes ready.
      const sessionStartedAt = Date.now()
      setRulesBaseDir(userDataPath)
      setRuleContextProvider(() => ({
        now: new Date(),
        network: { ssid: '', type: 'unknown' },
        active_app: null,
        session_start: new Date(sessionStartedAt),
      }))
      startRulesEngine()

      silent = await loadSilentModeController({
        read: () => readSettings(settingsFilePath(userDataPath)),
        persist: (settings) => writeSettings(settingsFilePath(userDataPath), settings),
        effects: silentEffects,
      })

      // Custom URL protocol: app.setAsDefaultProtocolClient writes the Windows
      // registry keys (HKCU\Software\Classes\focuslock) so the OS launches this
      // executable for "focuslock://open".
      installFocusLockProtocol(
        (protocol, execPath, args) => {
          if (execPath === undefined) {
            return app.setAsDefaultProtocolClient(protocol)
          }
          return app.setAsDefaultProtocolClient(protocol, execPath, args)
        },
        {
          isPackaged: app.isPackaged,
          execPath: process.execPath,
          launchArg: process.argv[1] === undefined ? undefined : resolve(process.argv[1]),
        },
      )

      // System-wide hotkey to reopen the hidden window: Ctrl+Alt+Shift+F.
      installOpenWindowHotkey({
        register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
        onOpen: () => focusWindow(),
      })

      registerIpcHandlers()
      registerProtectedExecutors({
        getMainWindow: () => mainWindow,
        beginPause,
        startDns: () => startDnsService(),
        stopDns: () => stopDnsService(),
        restoreSystemDns: () => restoreSystemDns(),
        getSilentMode: () => silent?.isEnabled() ?? false,
        setSilentMode: (enabled) => silent?.setEnabled(enabled) ?? Promise.resolve(),
        quit: () => {
          isQuitting = true
          // Stop the watchdog so the intentional quit isn't resurrected by its
          // process "exit" / SIGTERM / SIGINT restart handlers.
          stopWatchdog()
          // app.quit() closes all windows; the 'close' handler checks isQuitting
          // and now lets the window actually close instead of hiding to tray.
          app.quit()
        },
      })
      createWindow()

      // The tray only exists when silent mode is off.
      if (!silent.isEnabled()) {
        createTray()
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow()
        }
      })
    })

    app.on('will-quit', () => {
      globalShortcut.unregisterAll()
      stopRulesEngine()
    })
  }
}

app.on('window-all-closed', () => {
  // Keep the app alive in the background (tray) even with no visible window.
  // The app only exits through the verified "quit"/"uninstall" actions, which
  // set isQuitting, so this deliberately does NOT call app.quit(). For the
  // headless service this no-op also keeps the process alive with no windows.
})
