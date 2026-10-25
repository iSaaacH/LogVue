import { BrowserWindow } from 'electron'
import { join } from 'path'
import { emitIpcEvent } from './ipc/events'
import { getSimulationService } from './services/simulation/service'

let mainWindow: BrowserWindow | null = null
let controlsWindow: BrowserWindow | null = null

export function registerSimulationMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

export function simulationControlsDetached(): boolean {
  return controlsWindow !== null && !controlsWindow.isDestroyed()
}

/** Only one renderer can publish LIVE inputs, including during window handover. */
export function ownsSimulationInputs(senderId: number): boolean {
  const owner = simulationControlsDetached() ? controlsWindow : mainWindow
  return !!owner && !owner.isDestroyed() && owner.webContents.id === senderId
}

export async function openSimulationControls(): Promise<void> {
  if (simulationControlsDetached()) {
    controlsWindow!.restore()
    controlsWindow!.focus()
    return
  }
  const win = new BrowserWindow({
    width: 410, height: 470, minWidth: 360, minHeight: 450,
    title: 'LogVue — Driving controls', show: false, alwaysOnTop: true,
    autoHideMenuBar: true, backgroundColor: '#0e1116',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  controlsWindow = win
  const service = getSimulationService(emitIpcEvent)
  service.releaseLiveInputs()
  emitIpcEvent('simulation:controlsWindow', true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('blur', () => service.releaseLiveInputs())
  win.on('hide', () => service.releaseLiveInputs())
  win.on('minimize', () => service.releaseLiveInputs())
  win.on('unresponsive', () => service.failClose('driving controls unresponsive'))
  win.webContents.on('render-process-gone', () => {
    service.failClose('driving controls renderer exited')
    if (!win.isDestroyed()) win.close()
  })
  win.on('closed', () => {
    service.releaseLiveInputs()
    controlsWindow = null
    emitIpcEvent('simulation:controlsWindow', false)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  win.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
    win.show()
    win.focus()
  })
  try {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      const url = new URL(devUrl)
      url.searchParams.set('simulationControls', '1')
      await win.loadURL(url.toString())
    } else {
      await win.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { simulationControls: '1' }
      })
    }
  } catch (error) {
    if (!win.isDestroyed()) win.close()
    throw error
  }
}

export function closeSimulationControls(): void {
  controlsWindow?.close()
}

export function pinSimulationControls(pinned: boolean): void {
  controlsWindow?.setAlwaysOnTop(pinned === true)
}
