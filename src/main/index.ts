import { join } from 'path'
import { app, BrowserWindow, shell } from 'electron'
import { registerIpcHandlers } from './ipc/registry'
import { emitIpcEvent } from './ipc/events'
import { getSettings } from './config/settings'
import { closeIndex, ensureIndexBuilt } from './services/index/indexService'
import { startArchiveWatcher, stopArchiveWatcher } from './services/watcher/Watcher'
import { startMcpServer, stopMcpServer } from './mcp/server'
import {
  setAgentOpModeControlEnabled,
  startAgentOpModeService,
  stopAgentOpModeService
} from './services/opmode/service'
import { getSimulationService } from './services/simulation/service'
import { ownsSimulationInputs, registerSimulationMainWindow } from './simulationControls'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'LogVue',
    autoHideMenuBar: true,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Hard security boundary (ARCHITECTURE.md §2): the renderer reaches the
      // OS only through the allow-listed preload bridge.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium may visibility-throttle Gamepad API polling otherwise. The
      // simulator still owns pacing; this only keeps its latest-value input fresh.
      backgroundThrottling: false
    }
  })

  registerSimulationMainWindow(win)
  const simulationSenderId = win.webContents.id
  let uiLossHandled = false
  const failClosedForUiLoss = (reason: string): void => {
    if (uiLossHandled) return
    uiLossHandled = true
    void setAgentOpModeControlEnabled(false).catch((error) => {
      console.error(`Failed to release the agent OpMode lease after ${reason}:`, error)
    })
    if (ownsSimulationInputs(simulationSenderId)) getSimulationService(emitIpcEvent).failClose(reason)
  }

  // The operator gate must not remain armed without a working, visible LogVue UI.
  // Any release failure still falls back to the robot-side five-second watchdog.
  win.webContents.on('render-process-gone', () => failClosedForUiLoss('renderer exit'))
  win.webContents.on(
    'did-fail-load',
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame) failClosedForUiLoss('renderer load failure')
    }
  )
  win.webContents.on('did-finish-load', () => {
    uiLossHandled = false
  })
  win.on('unresponsive', () => failClosedForUiLoss('renderer becoming unresponsive'))
  win.on('responsive', () => {
    uiLossHandled = false
  })
  win.on('closed', () => failClosedForUiLoss('window close'))

  win.on('ready-to-show', () => win.show())

  // External links open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // In dev, electron-vite serves the renderer over HTTP with HMR; in prod we
  // load the built file.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  // The lease heartbeat lives in a worker thread so synchronous archive/index work
  // in Electron main cannot starve the robot's five-second dead-man timer.
  startAgentOpModeService()
  // Cold start (§6.2): open the index for the saved archive root and build it if
  // empty/stale, before the renderer asks for anything. The index is disposable,
  // so a failure here (e.g. a locked/corrupt file) must not block the UI.
  try {
    const root = getSettings().archiveRoot
    ensureIndexBuilt(root)
    startArchiveWatcher(root)
  } catch (err) {
    console.error('Index build on startup failed (will run without index):', err)
  }
  createWindow()
  void startMcpServer(app.getVersion()).catch((err) => {
    console.error('MCP server failed to start (LogVue will continue without it):', err)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  getSimulationService(emitIpcEvent).dispose()
  void stopMcpServer()
  void stopAgentOpModeService()
  stopArchiveWatcher()
  closeIndex()
})
