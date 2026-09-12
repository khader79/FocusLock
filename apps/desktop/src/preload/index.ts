import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  newChallenge: (difficulty: number) => ipcRenderer.invoke('challenge:new', difficulty),
  check: (typed: string) => ipcRenderer.invoke('challenge:check', typed),
  giveup: () => ipcRenderer.invoke('challenge:giveup'),
})
