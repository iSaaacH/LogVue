import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { AppInfo, IpcApi } from '@shared/types/ipc'
import { getSettings, saveSettings } from '../config/settings'
import * as archive from '../services/archive/ArchiveService'
import { readNotes } from '../services/archive/SessionStore'
import {
  ensureIndexBuilt,
  getIndexStore,
  librarySizeBytes,
  queryLogs,
  querySessions
} from '../services/index/indexService'
import { listHubLogs } from '../services/adb/hublogs'
import { getAdbClient, refreshAdbClient } from '../services/adb/runtime'
import { FtcScoutClient } from '../services/ftcscout/FtcScoutClient'
import { startArchiveWatcher } from '../services/watcher/Watcher'
import { getMcpStatus, refreshMcpDiscoveryFile } from '../mcp/server'
import {
  getAgentOpModeLeaseStatus,
  refreshAgentOpModeTarget,
  setAgentOpModeControlEnabled
} from '../services/opmode/service'
import { listTasks, startTask } from '../services/tasks/TaskService'
import {
  buildSimulationProject,
  discoverSimulationProject,
  listSimulationCatalog
} from '../services/simulation/project'
import { getSimulationService } from '../services/simulation/service'
import { emitIpcEvent } from './events'
import { closeSimulationControls, openSimulationControls, ownsSimulationInputs,
  pinSimulationControls, simulationControlsDetached } from '../simulationControls'
import { runImportTask, runNewSessionImportTask, runSingleImportTask } from '../services/import/importTask'
import {
  createSessionCommand,
  deleteSessionCommand,
  promoteFolderCommand,
  rebuildIndexCommand,
  syncFtcScoutEventCommand,
  updateMetaCommand,
  writeNotesCommand
} from '../commands'

const ftcScout = new FtcScoutClient()

function simulationService() {
  return getSimulationService(emitIpcEvent)
}

/** Every channel in the contract must have exactly one handler here. */
type Handlers = {
  [K in keyof IpcApi]: (
    ...args: Parameters<IpcApi[K]>
  ) => Awaited<ReturnType<IpcApi[K]>> | ReturnType<IpcApi[K]>
}

const handlers: Handlers = {
  // ── app ──
  'app:ping': async (msg) => `pong: ${msg}`,
  'app:getInfo': async (): Promise<AppInfo> => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }),
  'app:openThirdPartyNotices': async () => {
    const noticesPath = app.isPackaged
      ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
      : join(app.getAppPath(), 'THIRD_PARTY_NOTICES.txt')
    if (!existsSync(noticesPath)) throw new Error('Third-party notices are not available')
    const error = await shell.openPath(noticesPath)
    if (error) throw new Error(error)
  },

  // ── SpiderKit simulation ──
  'simulation:getStatus': async () => simulationService().getStatus(),
  'simulation:getControlsWindow': async () => simulationControlsDetached(),
  'simulation:openControls': openSimulationControls,
  'simulation:closeControls': async () => closeSimulationControls(),
  'simulation:pinControls': async (pinned) => pinSimulationControls(pinned),
  'simulation:pickProject': async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose robot simulation project',
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
  'simulation:pickRlog': async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose gamepad RLOG',
      properties: ['openFile'],
      filters: [{ name: 'RLOG files', extensions: ['rlog'] }]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
  'simulation:reportError': async (title, message) => {
    const task = startTask({
      kind: 'simulation',
      title: boundedTaskText(title, 'Simulation error', 120),
      determinate: false
    })
    task.fail(boundedTaskText(message, 'Unknown simulation error', 2_000))
  },
  'simulation:discoverProject': async (projectDirectory) =>
    discoverSimulationProject(projectDirectory),
  'simulation:buildProject': async (projectDirectory) => {
    const project = discoverSimulationProject(projectDirectory)
    const task = startTask({
      kind: 'simulation',
      title: `Building ${project.manifest.name}`,
      subtitle: 'Gradle · robot-local simulator'
    })
    task.setItems([
      { id: 'build', label: 'Build simulator', bytes: null },
      { id: 'catalog', label: 'Discover catalog', bytes: null }
    ])
    task.itemStatus('build', 'active', 'Starting Gradle…')
    let stage: 'build' | 'catalog' = 'build'
    try {
      const result = await buildSimulationProject(projectDirectory, project.platform, {
        onOutput: (_stream, line) => {
          const detail = usefulBuildLine(line)
          if (detail) task.itemDetail('build', detail)
        }
      })
      task.itemStatus('build', 'done', 'complete')
      stage = 'catalog'
      task.patch({ title: `Discovering ${project.manifest.name}` })
      task.itemStatus('catalog', 'active', 'Reading plugins and OpModes…')
      const catalog = await listSimulationCatalog(projectDirectory, project.platform)
      task.itemStatus(
        'catalog',
        'done',
        `${catalog.plugins.length} plugins · ${catalog.opModes.length} OpModes`
      )
      task.patch({ title: `Built ${project.manifest.name}` })
      task.succeed(`${catalog.opModes.length} OpModes discovered`)
      return { ...result, catalog }
    } catch (error) {
      task.itemStatus(stage, 'failed', error instanceof Error ? error.message : String(error))
      task.fail(error)
      throw error
    }
  },
  'simulation:listCatalog': async (projectDirectory) =>
    listSimulationCatalog(projectDirectory),
  'simulation:init': async (config) => simulationService().initialize(config),
  'simulation:start': async () => simulationService().start(),
  'simulation:pause': async () => simulationService().pause(),
  'simulation:resume': async () => simulationService().resume(),
  'simulation:step': async (count) => simulationService().step(count),
  'simulation:advance': async (durationSeconds) => simulationService().advance(durationSeconds),
  'simulation:runUntil': async (config, targetTimeSeconds) =>
    simulationService().runUntil(config, targetTimeSeconds),
  'simulation:stop': async () => simulationService().stop(),

  // ── MCP ──
  'mcp:status': async () => getMcpStatus(),
  'mcp:agentOpModeStatus': async () => getAgentOpModeLeaseStatus(),
  'mcp:setAgentOpModeControlEnabled': async (enabled) => setAgentOpModeControlEnabled(enabled),

  // ── settings / archive root ──
  'settings:get': async () => getSettings(),
  'settings:pickArchiveRoot': async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose FTC log library folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
  'settings:setArchiveRoot': async (path) => {
    const next = saveSettings({ archiveRoot: path })
    // A new root gets a fresh index built from its contents (§6.2).
    ensureIndexBuilt(next.archiveRoot)
    startArchiveWatcher(next.archiveRoot)
    refreshMcpDiscoveryFile()
    return next
  },
  'settings:setTeamNumber': async (teamNumber) => saveSettings({ teamNumber }),
  'settings:setAdbAddress': async (address) => {
    const trimmed = address.trim()
    if (!trimmed) throw new Error('Enter an ADB address before saving')
    const next = saveSettings({ adbAddress: trimmed })
    refreshAdbClient()
    await refreshAgentOpModeTarget()
    return next
  },
  'settings:pickHubLogFolder': async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose hub log folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
  'settings:setHubDataSource': async (source) => {
    const next = saveSettings({ hubDataSource: source })
    refreshAdbClient()
    await refreshAgentOpModeTarget()
    return next
  },
  'settings:setHubLogFolder': async (path) => {
    const next = saveSettings({ hubLogFolder: path })
    refreshAdbClient()
    return next
  },
  'settings:setFolderTimeOffsetMinutes': async (minutes) => {
    if (!Number.isFinite(minutes)) throw new Error('Enter a valid folder time correction')
    const next = saveSettings({ folderTimeOffsetMinutes: minutes })
    refreshAdbClient()
    return next
  },
  'settings:setConfirmDeletePopulatedSessions': async (confirm) =>
    saveSettings({ confirmDeletePopulatedSessions: confirm }),

  // ── archive / sessions ──
  'archive:tree': async () => archive.scanTree(getSettings().archiveRoot ?? ''),
  'archive:getSession': async (path) => archive.getSession(path),
  'archive:listFiles': async (path) => archive.listFolderFiles(path),
  'archive:showFolder': async (path) => {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  },
  'archive:showFile': async (path, filename) => {
    shell.showItemInFolder(join(path, filename))
  },
  'archive:openFile': async (path, filename) => {
    const error = await shell.openPath(join(path, filename))
    if (error) throw new Error(error)
  },
  'archive:createSession': async (input) =>
    createSessionCommand(getSettings().archiveRoot, input),
  'archive:updateMeta': async (path, patch) =>
    updateMetaCommand(getSettings().archiveRoot, path, patch),
  'archive:deleteSessionSummary': async (path) =>
    archive.deleteSessionSummary(getSettings().archiveRoot, path),
  'archive:deleteSession': async (path) =>
    deleteSessionCommand(getSettings().archiveRoot, path),
  'archive:promoteFolder': async (path) =>
    promoteFolderCommand(getSettings().archiveRoot, path),
  'archive:readNotes': async (path) => readNotes(path),
  'archive:writeNotes': async (path, md) =>
    writeNotesCommand(getSettings().archiveRoot, path, md),
  /**
   * `rebuild` is synchronous (readdirSync + sync sqlite) and blocks main start to
   * finish, so it can't report how far along it is — the task is indeterminate and
   * the toast shimmers. Yield once first so the "started" snapshot reaches the
   * renderer before the event loop stalls.
   */
  'archive:rebuildIndex': async () => {
    const task = startTask({
      kind: 'reindex',
      title: 'Rebuilding index',
      subtitle: 'Full rescan of the library',
      determinate: false,
      badge: 'DB LOCKED'
    })
    await new Promise((resolve) => setImmediate(resolve))
    try {
      const counts = rebuildIndexCommand(getSettings().archiveRoot)
      task.patch({ title: 'Index rebuilt' })
      task.succeed(`${counts.sessions} sessions · ${counts.files} files`)
      return counts
    } catch (err) {
      task.fail(err)
      throw err
    }
  },
  'index:query': async (query) => querySessions(getSettings().archiveRoot, query),
  'index:queryLogs': async (query) => queryLogs(getSettings().archiveRoot, query),
  'index:librarySize': async () => librarySizeBytes(getSettings().archiveRoot),

  // ── ADB / Control Hub ──
  'adb:status': async () => getAdbClient().getStatus(),
  'adb:connect': async () => {
    const address = getSettings().adbAddress
    const task = startTask({
      kind: 'adb',
      title: 'Connecting ADB',
      subtitle: address,
      determinate: false
    })
    // Let the renderer receive the running snapshot before adb can spend several
    // seconds waiting for an unreachable wireless target.
    await new Promise((resolve) => setImmediate(resolve))
    try {
      const status = await getAdbClient().connect(address)
      task.succeed(`Connected to ${status.device ?? address}`)
      return status
    } catch (err) {
      task.fail(err)
      // The task is the user-facing failure surface. Returning a disconnected
      // status keeps an expected unreachable-device attempt from logging an
      // additional unhandled IPC stack in the terminal.
      return { connected: false }
    }
  },
  'adb:listHubLogs': async () => listHubLogs(getAdbClient(), getSettings().archiveRoot),
  'adb:getHubTime': async () => {
    const sample = await getAdbClient().getTimeSample()
    const localMidpointMs = sample.localBeforeMs + (sample.localAfterMs - sample.localBeforeMs) / 2
    return {
      ...sample,
      offsetMs: Math.round(localMidpointMs - sample.hubNowMs),
      roundTripMs: sample.localAfterMs - sample.localBeforeMs
    }
  },
  'adb:ignoreHubLog': async (entry) => {
    getIndexStore(getSettings().archiveRoot)?.ignoreHubLog(entry)
  },
  'adb:unignoreHubLog': async (remotePath) => {
    getIndexStore(getSettings().archiveRoot)?.unignoreHubLog(remotePath)
  },

  // ── import ──
  // Single-file imports use the same activity task as batch imports, so quick imports
  // and suggested-log imports have visible progress too.
  'import:toSession': async (req) => runSingleImportTask(getAdbClient(), getSettings().archiveRoot, req),
  'import:batchToSession': async (req) => runImportTask(getAdbClient(), getSettings().archiveRoot, req),
  'import:toNewSession': async (req) => runNewSessionImportTask(getAdbClient(), getSettings().archiveRoot, req),

  // ── background tasks ──
  'tasks:list': async () => listTasks(),

  // ── FTCScout ──
  'ftcscout:searchEvents': async (req) => ftcScout.searchEvents(req),
  'ftcscout:syncEvent': async (req) => {
    const task = startTask({
      kind: 'ftcscout',
      title: `Syncing ${req.eventCode.trim().toUpperCase()}`,
      subtitle: 'FTCScout · scaffolding matches',
      targetPath: req.eventPath
    })
    try {
      const result = await syncFtcScoutEventCommand(ftcScout, getSettings().archiveRoot, req, {
        onPlan: (matches) => task.setItems(matches.map((m) => ({ ...m, bytes: null }))),
        onMatchDone: (id, outcome) => task.itemStatus(id, 'done', outcome)
      })
      const label = result.event.name || result.event.code
      task.patch({ title: `Synced ${label}` })
      task.succeed(
        `${result.created} created · ${result.updated} updated · ${result.unchanged} unchanged`,
        req.eventPath
      )
      return result
    } catch (err) {
      task.fail(err)
      throw err
    }
  }
}

/** Wire every contract channel to its handler. Call once on app ready. */
export function registerIpcHandlers(): void {
  for (const channel of Object.keys(handlers) as (keyof IpcApi)[]) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown
    ipcMain.handle(channel, (_event, ...args) => handler(...args))
  }
  ipcMain.on('simulation:gamepads', (event, frame) => {
    if (!ownsSimulationInputs(event.sender.id)) return
    try {
      simulationService().publishGamepads(frame)
    } catch (error) {
      console.error('Rejected simulation gamepad frame:', error)
    }
  })
}

function usefulBuildLine(value: string): string | null {
  const line = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim()
  if (!line) return null
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

function boundedTaskText(value: string, fallback: string, maxLength: number): string {
  const text = value.trim() || fallback
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}
