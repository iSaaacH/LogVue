import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types/session'
import type { McpStatus } from '@shared/types/ipc'
import type { SimulationStatus } from '@shared/types/simulation'
import {
  useAdbStatus,
  useAgentOpModeStatus,
  useConnectAdb,
  useMcpStatus,
  useSetAgentOpModeControlEnabled
} from '../api/hooks'
import { api } from '../api/client'
import { useAppStore } from '../stores/appStore'

const MCP_ACTIVE_WINDOW_MS = 5 * 60 * 1000

interface Props {
  settings: AppSettings
  onSettings: () => void
  onMcpSetup: () => void
}

export default function Toolbar({ settings, onSettings, onMcpSetup }: Props): JSX.Element {
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)
  const { data: adb } = useAdbStatus()
  const { data: mcp } = useMcpStatus()
  const { data: agentOpMode } = useAgentOpModeStatus()
  const [simulationStatus, setSimulationStatus] = useState<SimulationStatus | null>(null)
  const setAgentOpModeControl = useSetAgentOpModeControlEnabled()
  const connect = useConnectAdb()
  const sourceIsFolder = settings.hubDataSource === 'folder'
  const sourceName = sourceIsFolder ? 'Folder Import' : 'Control Hub'
  const sourceConnected = sourceIsFolder ? !!settings.hubLogFolder : !!adb?.connected
  const sourceLabel = sourceIsFolder
    ? settings.hubLogFolder
      ? 'folder source'
      : 'folder not set'
    : adb?.adbMissing
      ? 'adb not found'
      : 'Connect ADB'
  const simulationActive = Boolean(simulationStatus?.pid)
    || ['starting', 'initialized', 'running', 'paused', 'stopping'].includes(simulationStatus?.phase ?? '')

  useEffect(() => {
    let alive = true
    let receivedStatusEvent = false
    const unsubscribe = api.simulation.onStatus((next) => {
      receivedStatusEvent = true
      if (alive) setSimulationStatus(next)
    })
    void api.simulation.getStatus().then((next) => {
      if (alive && !receivedStatusEvent) setSimulationStatus(next)
    }).catch(() => undefined)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="brand">LogVue</span>
      </div>

      <div className="view-switch">
        <div className="tabs" role="tablist" aria-label="View">
          <button
            className={`tab ${view === 'archive' ? 'active' : ''}`}
            role="tab"
            aria-selected={view === 'archive'}
            onClick={() => setView('archive')}
          >
            Library
          </button>
          <button
            className={`tab ${view === 'simulate' ? 'active' : ''}${simulationActive ? ` sim-session-active ${simulationStatus?.phase ?? ''}` : ''}`}
            role="tab"
            aria-selected={view === 'simulate'}
            aria-label={simulationActive ? `Simulate, session ${simulationStatus?.phase}` : undefined}
            title={simulationActive ? `Simulation session ${simulationStatus?.phase}` : undefined}
            onClick={() => setView('simulate')}
          >
            <span>Simulate</span>
            {simulationActive && <span className="sim-tab-dot" aria-hidden="true" />}
          </button>
          <button
            className={`tab ${view === 'device' ? 'active' : ''}`}
            role="tab"
            aria-selected={view === 'device'}
            onClick={() => setView('device')}
          >
            Control Hub
          </button>
        </div>
      </div>

      <div className="toolbar-right">
        <button type="button" className="ghost sm sim-mini-launch"
          title="Open the floating driving panel above AdvantageScope"
          onClick={() => void api.simulation.openControls().catch(error =>
            api.simulation.reportError('Could not open mini controls',error instanceof Error?error.message:String(error)))}>
          Mini controls ↗
        </button>
        {agentOpMode?.operatorEnabled && (
          <button
            type="button"
            className="source-status agent-control-live"
            title="Disable agent OpMode control immediately"
            disabled={setAgentOpModeControl.isPending}
            onClick={() => setAgentOpModeControl.mutate(false)}
          >
            <span className="dot" />
            <span>
              {setAgentOpModeControl.isPending
                ? 'Disabling agent control…'
                : `Agent control ${agentOpMode.state === 'active' ? 'ON' : agentOpMode.state}`}
            </span>
            {!setAgentOpModeControl.isPending && <span className="agent-control-disable">· disable</span>}
          </button>
        )}

        <SourceBadge
          connected={sourceConnected}
          label={sourceLabel}
          sourceName={sourceName}
          address={settings.adbAddress}
          adbSource={!sourceIsFolder}
          connecting={connect.isPending}
          onConnect={!sourceIsFolder && !adb?.adbMissing ? () => connect.mutate() : undefined}
        />

        <McpBadge status={mcp} onClick={onMcpSetup} />

        <button className="ghost sm" onClick={onSettings}>
          Settings
        </button>
      </div>
    </header>
  )
}

function McpBadge({ status, onClick }: { status: McpStatus | undefined; onClick: () => void }): JSX.Element {
  const available = !!status?.running && !!status.discoveryReady && !!status.bridgeReady
  const lastRequestMs = status?.lastRequestAt ? Date.parse(status.lastRequestAt) : Number.NaN
  const [, refreshClock] = useState(0)

  useEffect(() => {
    if (!available || !Number.isFinite(lastRequestMs)) return
    const remainingMs = lastRequestMs + MCP_ACTIVE_WINDOW_MS - Date.now()
    if (remainingMs <= 0) return
    const timer = window.setTimeout(() => refreshClock((tick) => tick + 1), remainingMs)
    return () => window.clearTimeout(timer)
  }, [available, lastRequestMs])

  const recentlyUsed =
    available && Number.isFinite(lastRequestMs) && Date.now() - lastRequestMs < MCP_ACTIVE_WINDOW_MS
  const availabilityLabel = !status
    ? 'MCP checking…'
    : available
      ? recentlyUsed
        ? 'MCP active'
        : 'MCP ready'
      : status.running
        ? 'MCP setup incomplete'
        : 'MCP unavailable'
  const stateClass = recentlyUsed ? 'active' : available ? 'ready' : 'off'

  return (
    <button
      type="button"
      className={`source-status mcp-status ${stateClass}`}
      title={`${availabilityLabel}. Open MCP setup instructions.`}
      onClick={onClick}
    >
      <span className="dot" />
      <span>MCP</span>
    </button>
  )
}

function SourceBadge({
  connected,
  label,
  sourceName,
  address,
  adbSource,
  connecting,
  onConnect
}: {
  connected: boolean
  label: string
  sourceName: string
  address: string
  adbSource: boolean
  connecting: boolean
  onConnect?: () => void
}): JSX.Element {
  const connectable = !!onConnect && !connected
  const displayLabel = adbSource
    ? connecting
      ? 'Connecting ADB…'
      : connected
        ? 'ADB connected'
        : 'Connect ADB'
    : label
  return (
    <button
      type="button"
      className={`source-status source-connection-status ${connected ? 'ok' : 'off'}${connectable ? ' connectable' : ''}${connecting ? ' connecting' : ''}`}
      title={
        connectable
          ? `Connect ADB to ${address}`
          : `${sourceName}: ${connected ? 'connected' : 'disconnected'}`
      }
      onClick={connectable ? onConnect : undefined}
      disabled={!connectable || connecting}
    >
      <span className="dot" />
      <span>{displayLabel}</span>
    </button>
  )
}
