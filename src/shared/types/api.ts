import type { IpcApi, IpcEvents, IpcSends } from './ipc'

/**
 * The allow-listed surface exposed on `window.api` by the preload bridge.
 * A single generic `invoke` keeps the bridge tiny while staying fully typed
 * against the {@link IpcApi} contract.
 */
export interface Api {
  invoke<K extends keyof IpcApi>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): ReturnType<IpcApi[K]>
  onArchiveChanged(handler: (event: IpcEvents['archive:changed']) => void): () => void
  /** A full snapshot of one background task, pushed on every change. */
  onTaskUpdate(handler: (task: IpcEvents['tasks:update']) => void): () => void
  onSimulationStatus(handler: (status: IpcEvents['simulation:status']) => void): () => void
  onSimulationStderr(handler: (event: IpcEvents['simulation:stderr']) => void): () => void
  onSimulationControlsWindow(handler: (detached: boolean) => void): () => void
  /** Latest-value, one-way publish path; there is intentionally no promise per browser frame. */
  publishSimulationGamepads(frame: IpcSends['simulation:gamepads']): void
}

declare global {
  interface Window {
    api: Api
  }
}
