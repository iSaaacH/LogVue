import '@shared/types/api' // registers the window.api global type
import type { CreateSessionInput, SessionMetadata } from '@shared/types/session'
import type {
  BatchImportRequest,
  HubLogRef,
  ImportRequest,
  NewSessionImportRequest
} from '@shared/types/import'
import type { SessionQuery } from '@shared/types/query'
import type { FtcScoutEventSearchRequest, FtcScoutSyncRequest } from '@shared/types/ftcscout'

/** Thin, typed wrappers over the preload bridge — one call site per channel. */
export const api = {
  getInfo: () => window.api.invoke('app:getInfo'),
  openThirdPartyNotices: () => window.api.invoke('app:openThirdPartyNotices'),
  mcp: {
    status: () => window.api.invoke('mcp:status'),
    agentOpModeStatus: () => window.api.invoke('mcp:agentOpModeStatus'),
    setAgentOpModeControlEnabled: (enabled: boolean) =>
      window.api.invoke('mcp:setAgentOpModeControlEnabled', enabled)
  },
  settings: {
    get: () => window.api.invoke('settings:get'),
    pickRoot: () => window.api.invoke('settings:pickArchiveRoot'),
    setRoot: (path: string) => window.api.invoke('settings:setArchiveRoot', path),
    setTeamNumber: (teamNumber: number | null) =>
      window.api.invoke('settings:setTeamNumber', teamNumber),
    setAdbAddress: (address: string) => window.api.invoke('settings:setAdbAddress', address),
    pickHubLogFolder: () => window.api.invoke('settings:pickHubLogFolder'),
    setHubDataSource: (source: 'adb' | 'folder') =>
      window.api.invoke('settings:setHubDataSource', source),
    setHubLogFolder: (path: string | null) => window.api.invoke('settings:setHubLogFolder', path),
    setFolderTimeOffsetMinutes: (minutes: number) =>
      window.api.invoke('settings:setFolderTimeOffsetMinutes', minutes),
    setConfirmDeletePopulatedSessions: (confirm: boolean) =>
      window.api.invoke('settings:setConfirmDeletePopulatedSessions', confirm)
  },
  simulation: {
    getControlsWindow: () => window.api.invoke('simulation:getControlsWindow'),
    openControls: () => window.api.invoke('simulation:openControls'),
    closeControls: () => window.api.invoke('simulation:closeControls'),
    pinControls: (pinned: boolean) => window.api.invoke('simulation:pinControls', pinned),
    getStatus: () => window.api.invoke('simulation:getStatus'),
    pickProject: () => window.api.invoke('simulation:pickProject'),
    pickRlog: () => window.api.invoke('simulation:pickRlog'),
    reportError: (title: string, message: string) =>
      window.api.invoke('simulation:reportError', title, message),
    discoverProject: (projectDirectory: string) =>
      window.api.invoke('simulation:discoverProject', projectDirectory),
    buildProject: (projectDirectory: string) =>
      window.api.invoke('simulation:buildProject', projectDirectory),
    listCatalog: (projectDirectory: string) =>
      window.api.invoke('simulation:listCatalog', projectDirectory),
    init: (config: import('@shared/types/simulation').SimulationStartConfig) =>
      window.api.invoke('simulation:init', config),
    start: () => window.api.invoke('simulation:start'),
    pause: () => window.api.invoke('simulation:pause'),
    resume: () => window.api.invoke('simulation:resume'),
    step: (count = 1) => window.api.invoke('simulation:step', count),
    advance: (durationSeconds: number) =>
      window.api.invoke('simulation:advance', durationSeconds),
    runUntil: (
      config: import('@shared/types/simulation').SimulationStartConfig | null,
      targetTimeSeconds: number
    ) => window.api.invoke('simulation:runUntil', config, targetTimeSeconds),
    stop: () => window.api.invoke('simulation:stop'),
    onStatus: (handler: Parameters<typeof window.api.onSimulationStatus>[0]) =>
      window.api.onSimulationStatus(handler),
    onStderr: (handler: Parameters<typeof window.api.onSimulationStderr>[0]) =>
      window.api.onSimulationStderr(handler),
    publishGamepads: (frame: import('@shared/types/simulation').SimulationGamepadFrame) =>
      window.api.publishSimulationGamepads(frame)
  },
  archive: {
    tree: () => window.api.invoke('archive:tree'),
    getSession: (path: string) => window.api.invoke('archive:getSession', path),
    listFiles: (path: string) => window.api.invoke('archive:listFiles', path),
    showFolder: (path: string) => window.api.invoke('archive:showFolder', path),
    showFile: (path: string, filename: string) => window.api.invoke('archive:showFile', path, filename),
    openFile: (path: string, filename: string) => window.api.invoke('archive:openFile', path, filename),
    createSession: (input: CreateSessionInput) => window.api.invoke('archive:createSession', input),
    updateMeta: (path: string, patch: Partial<SessionMetadata>) =>
      window.api.invoke('archive:updateMeta', path, patch),
    deleteSessionSummary: (path: string) => window.api.invoke('archive:deleteSessionSummary', path),
    deleteSession: (path: string) => window.api.invoke('archive:deleteSession', path),
    promoteFolder: (path: string) => window.api.invoke('archive:promoteFolder', path),
    readNotes: (path: string) => window.api.invoke('archive:readNotes', path),
    writeNotes: (path: string, md: string) => window.api.invoke('archive:writeNotes', path, md),
    rebuildIndex: () => window.api.invoke('archive:rebuildIndex')
  },
  index: {
    query: (query: SessionQuery) => window.api.invoke('index:query', query),
    queryLogs: (query: SessionQuery) => window.api.invoke('index:queryLogs', query),
    librarySize: () => window.api.invoke('index:librarySize')
  },
  adb: {
    status: () => window.api.invoke('adb:status'),
    connect: () => window.api.invoke('adb:connect'),
    listHubLogs: () => window.api.invoke('adb:listHubLogs'),
    getHubTime: () => window.api.invoke('adb:getHubTime'),
    ignoreHubLog: (entry: HubLogRef) => window.api.invoke('adb:ignoreHubLog', entry),
    unignoreHubLog: (remotePath: string) => window.api.invoke('adb:unignoreHubLog', remotePath)
  },
  import: {
    toSession: (req: ImportRequest) => window.api.invoke('import:toSession', req),
    batchToSession: (req: BatchImportRequest) => window.api.invoke('import:batchToSession', req),
    toNewSession: (req: NewSessionImportRequest) => window.api.invoke('import:toNewSession', req)
  },
  tasks: {
    list: () => window.api.invoke('tasks:list')
  },
  ftcscout: {
    searchEvents: (req: FtcScoutEventSearchRequest) => window.api.invoke('ftcscout:searchEvents', req),
    syncEvent: (req: FtcScoutSyncRequest) => window.api.invoke('ftcscout:syncEvent', req)
  }
}
