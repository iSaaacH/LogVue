/**
 * The IPC contract — the single source of truth for what the app can do.
 *
 * Each entry is `channel: (request) => Promise<response>`. `main/ipc/registry.ts`
 * implements exactly these; `preload` exposes a typed `invoke` over them; the
 * renderer calls them through `window.api.invoke`. Adding a capability = adding
 * one entry here (see ARCHITECTURE.md §5).
 *
 * Phase 0 only defines the smoke-test channels that prove the wiring end-to-end.
 */

import type {
  AppSettings,
  CreateSessionInput,
  DeleteSessionSummary,
  FolderFile,
  Session,
  SessionMetadata,
  SessionNode
} from './session'
import type { AdbStatus, HubLog, HubTimeSample } from './hublog'
import type { LogQueryRow, SessionQuery, SessionQueryResult } from './query'
import type {
  BatchImportRequest,
  HubLogRef,
  ImportRequest,
  ImportResult,
  NewSessionImportRequest,
  NewSessionImportResult
} from './import'
import type { Task } from './tasks'
import type { AgentOpModeLeaseStatus } from './opmode'
import type {
  SimulationBuildResult,
  SimulationCatalog,
  SimulationGamepadFrame,
  SimulationProject,
  SimulationStatus,
  SimulationStderrEvent,
  SimulationStartConfig
} from './simulation'
import type {
  FtcScoutEventSearchRequest,
  FtcScoutEventSearchResult,
  FtcScoutSyncRequest,
  FtcScoutSyncResult
} from './ftcscout'

export interface AppInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: NodeJS.Platform
}

/** Live state and stable client configuration for LogVue's MCP endpoint. */
export interface McpStatus {
  running: boolean
  discoveryReady: boolean
  bridgeReady: boolean
  endpoint: string
  discoveryPath: string
  bridgePath: string
  lastRequestAt: string | null
}

export interface ArchiveChangedEvent {
  root: string
  paths: string[]
  reason: 'archive_changed'
}

/** Main-to-renderer push channels and their payloads. */
export interface IpcEvents {
  'archive:changed': ArchiveChangedEvent
  'tasks:update': Task
  'simulation:status': SimulationStatus
  'simulation:stderr': SimulationStderrEvent
  'simulation:controlsWindow': boolean
}

/** High-rate renderer-to-main messages. These deliberately do not use invoke/reply IPC. */
export interface IpcSends {
  'simulation:gamepads': SimulationGamepadFrame
}

export interface IpcApi {
  /** Round-trip smoke test: renderer → main → renderer. */
  'app:ping': (msg: string) => Promise<string>
  /** Versions/platform, proving main can answer typed queries. */
  'app:getInfo': () => Promise<AppInfo>
  /** Open the bundled third-party license notices in the system viewer. */
  'app:openThirdPartyNotices': () => Promise<void>

  // ── RobotSim (standalone CLI process) ─────────────────────
  'simulation:getStatus': () => Promise<SimulationStatus>
  'simulation:getControlsWindow': () => Promise<boolean>
  'simulation:openControls': () => Promise<void>
  'simulation:closeControls': () => Promise<void>
  'simulation:pinControls': (pinned: boolean) => Promise<void>
  'simulation:pickProject': () => Promise<string | null>
  'simulation:pickRlog': () => Promise<string | null>
  'simulation:reportError': (title: string, message: string) => Promise<void>
  'simulation:discoverProject': (projectDirectory: string) => Promise<SimulationProject>
  'simulation:buildProject': (projectDirectory: string) => Promise<SimulationBuildResult>
  'simulation:listCatalog': (projectDirectory: string) => Promise<SimulationCatalog>
  'simulation:init': (config: SimulationStartConfig) => Promise<SimulationStatus>
  'simulation:start': () => Promise<SimulationStatus>
  'simulation:pause': () => Promise<SimulationStatus>
  'simulation:resume': () => Promise<SimulationStatus>
  'simulation:step': (count?: number) => Promise<SimulationStatus>
  'simulation:advance': (durationSeconds: number) => Promise<SimulationStatus>
  'simulation:runUntil': (
    config: SimulationStartConfig | null,
    targetTimeSeconds: number
  ) => Promise<SimulationStatus>
  'simulation:stop': () => Promise<SimulationStatus>

  // ── MCP ────────────────────────────────────────────────────
  /** Whether the MCP endpoint, discovery file, and installed bridge are available. */
  'mcp:status': () => Promise<McpStatus>
  /** Runtime-only operator gate and robot lease heartbeat health (never credentials/nonces). */
  'mcp:agentOpModeStatus': () => Promise<AgentOpModeLeaseStatus>
  /** Arm/disarm the main-process robot lease. Always starts disabled on app launch. */
  'mcp:setAgentOpModeControlEnabled': (enabled: boolean) => Promise<AgentOpModeLeaseStatus>

  // ── settings / archive root ────────────────────────────────
  'settings:get': () => Promise<AppSettings>
  /** Native directory picker; returns the chosen path or null if cancelled. */
  'settings:pickArchiveRoot': () => Promise<string | null>
  'settings:setArchiveRoot': (path: string) => Promise<AppSettings>
  'settings:setTeamNumber': (teamNumber: number | null) => Promise<AppSettings>
  'settings:setAdbAddress': (address: string) => Promise<AppSettings>
  'settings:pickHubLogFolder': () => Promise<string | null>
  'settings:setHubDataSource': (source: AppSettings['hubDataSource']) => Promise<AppSettings>
  'settings:setHubLogFolder': (path: string | null) => Promise<AppSettings>
  'settings:setFolderTimeOffsetMinutes': (minutes: number) => Promise<AppSettings>
  'settings:setConfirmDeletePopulatedSessions': (confirm: boolean) => Promise<AppSettings>

  // ── archive / sessions (disk-backed; source of truth) ──────
  /** The session tree beneath the archive root. */
  'archive:tree': () => Promise<SessionNode[]>
  'archive:getSession': (path: string) => Promise<Session>
  /** The files physically inside a folder/session on disk — lets you see logs without importing. */
  'archive:listFiles': (path: string) => Promise<FolderFile[]>
  /** Reveal a session folder in the OS file manager. */
  'archive:showFolder': (path: string) => Promise<void>
  /** Reveal a session file in the OS file manager. */
  'archive:showFile': (path: string, filename: string) => Promise<void>
  /** Open a session file with the operating system's registered handler. */
  'archive:openFile': (path: string, filename: string) => Promise<void>
  'archive:createSession': (input: CreateSessionInput) => Promise<Session>
  'archive:updateMeta': (path: string, patch: Partial<SessionMetadata>) => Promise<Session>
  /** Recursively count the user data that deleting this session would remove. */
  'archive:deleteSessionSummary': (path: string) => Promise<DeleteSessionSummary>
  /** Permanently delete a session folder and all descendants. */
  'archive:deleteSession': (path: string) => Promise<DeleteSessionSummary>
  /** Write a `session.json` for a bare folder using discovery defaults (spec §4.2). */
  'archive:promoteFolder': (path: string) => Promise<Session>
  'archive:readNotes': (path: string) => Promise<string>
  'archive:writeNotes': (path: string, md: string) => Promise<void>
  /** Rebuild the disposable sqlite index from a full disk rescan (spec §13). */
  'archive:rebuildIndex': () => Promise<{ sessions: number; files: number }>
  /** Filter/search sessions via the index; returns matches + whole-archive facets (spec §12). */
  'index:query': (query: SessionQuery) => Promise<SessionQueryResult>
  /** Log-level filter/search — every imported log matching the query, newest-first (quick-find). */
  'index:queryLogs': (query: SessionQuery) => Promise<LogQueryRow[]>
  /** Total bytes of every indexed file — the library size pill on the tree root. */
  'index:librarySize': () => Promise<number>

  // ── ADB / Control Hub (read-only; spec §7) ─────────────────
  /** Connection status from `adb devices` (spec §7.1). */
  'adb:status': () => Promise<AdbStatus>
  /** Connect to the configured wireless Control Hub address. */
  'adb:connect': () => Promise<AdbStatus>
  /** List `.rlog` files on the hub with parsed metadata + import status (spec §7.2–7.3). */
  'adb:listHubLogs': () => Promise<HubLog[]>
  /** Current Control Hub clock sampled over adb, with local-clock offset. */
  'adb:getHubTime': () => Promise<HubTimeSample>
  /** Mark a remote hub log as ignored — hidden from the default view (spec §15). */
  'adb:ignoreHubLog': (entry: HubLogRef) => Promise<void>
  /** Reverse an ignore (spec §15). */
  'adb:unignoreHubLog': (remotePath: string) => Promise<void>

  // ── import (pull → copy → append → index; spec §7.4, §14) ──
  /** Import a remote log into an existing session. `duplicate` when already imported. */
  'import:toSession': (req: ImportRequest) => Promise<ImportResult>
  /**
   * Import several logs into one existing session. The loop lives in main so the whole
   * batch is a single progress task; a failed file yields a `failed` result rather than
   * abandoning the ones behind it. One result per requested log, in order.
   */
  'import:batchToSession': (req: BatchImportRequest) => Promise<ImportResult[]>
  /** Create a session from selected logs, then import them into it (spec §10). */
  'import:toNewSession': (req: NewSessionImportRequest) => Promise<NewSessionImportResult>

  // ── background tasks (activity toasts) ─────────────────────
  /** Live + recently-finished tasks; replayed when a renderer mounts mid-flight. */
  'tasks:list': () => Promise<Task[]>

  // ── FTCScout (online fetch + sqlite cache; spec competition workflow) ──
  /** Search FTCScout events by name/code for the add-session dialog. */
  'ftcscout:searchEvents': (req: FtcScoutEventSearchRequest) => Promise<FtcScoutEventSearchResult[]>
  /** Sync team-specific official matches into an existing competition_event session. */
  'ftcscout:syncEvent': (req: FtcScoutSyncRequest) => Promise<FtcScoutSyncResult>
}

export type IpcChannel = keyof IpcApi
