import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '@shared/types/api'
import type { IpcApi, IpcEvents } from '@shared/types/ipc'

function subscribe<K extends keyof IpcEvents>(
  channel: K,
  handler: (payload: IpcEvents[K]) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: IpcEvents[K]) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

/**
 * The entire bridge: one generic, typed `invoke`. No raw `ipcRenderer`, `fs`, or
 * `child_process` is ever handed to the renderer (ARCHITECTURE.md §2).
 */
const api: Api = {
  invoke<K extends keyof IpcApi>(channel: K, ...args: Parameters<IpcApi[K]>) {
    return ipcRenderer.invoke(channel, ...args) as ReturnType<IpcApi[K]>
  },
  onArchiveChanged(handler) {
    return subscribe('archive:changed', handler)
  },
  onTaskUpdate(handler) {
    return subscribe('tasks:update', handler)
  },
  onSimulationStatus(handler) {
    return subscribe('simulation:status', handler)
  },
  onSimulationStderr(handler) {
    return subscribe('simulation:stderr', handler)
  },
  publishSimulationGamepads(frame) {
    ipcRenderer.send('simulation:gamepads', frame)
  },
  onSimulationControlsWindow(handler) {
    return subscribe('simulation:controlsWindow', handler)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Should never happen (contextIsolation is on) — fail loud rather than
  // silently leaking a less-safe path.
  throw new Error('contextIsolation must be enabled')
}
