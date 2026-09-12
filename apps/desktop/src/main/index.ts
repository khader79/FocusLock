import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
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
import { installBlocker } from './blocker'
import { startWatchdog } from './watchdog'

let currentChallenge: Challenge | null = null

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
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    frame: false,
    closable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')

  win.on('close', (event) => {
    event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  hardenApp()
  await installBlocker()
  startWatchdog()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
