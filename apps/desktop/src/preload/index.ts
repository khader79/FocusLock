import { contextBridge, ipcRenderer } from 'electron'

interface DashboardState {
  status: 'active' | 'paused'
  blockedToday: number
  lastUpdate: string | null
  unlockAttempts: number
  customSites: number
  customApps: number
}

const channel = 'focuslock:state-change'

const handlers = new Map<string, Set<(data: DashboardState) => void>>()

contextBridge.exposeInMainWorld('api', {
  newChallenge: (difficulty: number) => ipcRenderer.invoke('challenge:new', difficulty),
  check: (typed: string) => ipcRenderer.invoke('challenge:check', typed),
  giveup: () => ipcRenderer.invoke('challenge:giveup'),
  getSilentMode: () => ipcRenderer.invoke('settings:silent:get'),
  toggleSilentMode: () => ipcRenderer.invoke('settings:silent:toggle'),
  categoriesList: () => ipcRenderer.invoke('categories:list'),
  toggleCategory: (id: string) => ipcRenderer.invoke('categories:toggle', id),
  updateCategory: (id: string) => ipcRenderer.invoke('categories:update', id),
  searchCategoryPatterns: (id: string, query: string) =>
    ipcRenderer.invoke('categories:patterns', id, query),
  addCustomCategory: (input: { name: string; url: string; color: string }) =>
    ipcRenderer.invoke('categories:add', input),
  removeCustomCategory: (id: string) => ipcRenderer.invoke('categories:remove', id),
  rulesList: () => ipcRenderer.invoke('rules:list'),
  rulesAdd: (rule: unknown) => ipcRenderer.invoke('rules:add', rule),
  rulesRemove: (id: number) => ipcRenderer.invoke('rules:remove', id),
  rulesUpdate: (id: number, rule: unknown) => ipcRenderer.invoke('rules:update', id, rule),
  listSites: () => ipcRenderer.invoke('custom-sites:list'),
  addSite: (input: string) => ipcRenderer.invoke('custom-sites:add', input),
  removeSite: (id: number) => ipcRenderer.invoke('custom-sites:remove', id),
  listBlockedApps: () => ipcRenderer.invoke('apps:blocked'),
  blockApp: (exePath: string) => ipcRenderer.invoke('apps:block', exePath),
  unblockApp: (name: string) => ipcRenderer.invoke('apps:unblock', name),
  onStateChange: (callback: (data: DashboardState) => void) => {
    const callbacks = handlers.get(channel) ?? new Set()
    callbacks.add(callback)
    handlers.set(channel, callbacks)
    ipcRenderer.on(channel, (_event, data: DashboardState) => {
      const cbs = handlers.get(channel)
      cbs?.forEach((cb) => cb(data))
    })
  },
})
