import { contextBridge, ipcRenderer } from 'electron'

// Preload for the challenge modal window (see protected-actions.ts).
contextBridge.exposeInMainWorld('challengeModal', {
  getData: () => ipcRenderer.invoke('protected:challenge:data'),
  submit: (typed: string) => ipcRenderer.invoke('protected:challenge:result', typed),
  cancel: () => ipcRenderer.invoke('protected:challenge:cancel'),
})