import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SimulationCatalog,
  SimulationGamepadRuntimeStatus,
  SimulationGamepadSource,
  SimulationProject,
  SimulationRunnerStatus,
  SimulationStartConfig,
  SimulationStatus
} from '@shared/types/simulation'
import { api } from '../api/client'
import { useKeyboardGamepad } from '../hooks/useKeyboardGamepad'
import {
  readBrowserGamepad,
  useBrowserControllers,
  type BrowserController
} from '../hooks/useBrowserGamepads'
import {
  parseProgramSelectionKey,
  parseStoredControllerIndex,
  programMatches,
  programSelectionKey,
  reconcileProgramSelection,
  type ProgramSelection
} from '../lib/simulationSelection'

const DEFAULT_RATE_HZ = 50
const DEFAULT_STALE_MS = 250
const DEFAULT_RLOG_PORT = '5800'
const EMPTY_CATALOG: SimulationCatalog = { plugins: [], opModes: [], scenarios: [] }
const CONTROLLER_1_STORAGE_KEY = 'logvue.sim.controller1'
const CONTROLLER_2_STORAGE_KEY = 'logvue.sim.controller2'

type Slot = 1 | 2

export default function SimulateWorkspace({ compact = false }: { compact?: boolean }): JSX.Element {
  const [detached, setDetached] = useState(compact)
  const [pinned, setPinned] = useState(true)
  const [status, setStatus] = useState<SimulationStatus | null>(null)
  const [projectDirectory, setProjectDirectory] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.project') ?? ''
  )
  const [project, setProject] = useState<SimulationProject | null>(null)
  const [catalog, setCatalog] = useState<SimulationCatalog>(EMPTY_CATALOG)
  const [selectedProgram, setSelectedProgram] = useState<ProgramSelection | null>(null)
  const [scenarioId, setScenarioId] = useState('')
  const [gamepad1Source, setGamepad1Source] = useState<SimulationGamepadSource>({ kind: 'NONE' })
  const [gamepad2Source, setGamepad2Source] = useState<SimulationGamepadSource>({ kind: 'NONE' })
  const [keyboardEnabled, setKeyboardEnabled] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.keyboard') === 'true'
  )
  const [controller1, setController1] = useState<number | null>(() =>
    parseStoredControllerIndex(globalThis.localStorage?.getItem(CONTROLLER_1_STORAGE_KEY) ?? null)
  )
  const [controller2, setController2] = useState<number | null>(() =>
    parseStoredControllerIndex(globalThis.localStorage?.getItem(CONTROLLER_2_STORAGE_KEY) ?? null)
  )
  const [fastTarget, setFastTarget] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.fastTarget') ?? '1.0'
  )
  const [rateHz, setRateHz] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.rateHz') ?? String(DEFAULT_RATE_HZ)
  )
  const [rlogPort, setRlogPort] = useState(
    () => globalThis.localStorage?.getItem('logvue.sim.rlogPort') ?? DEFAULT_RLOG_PORT
  )
  const [busy, setBusy] = useState<string | null>(null)
  const lastReportedError = useRef<{ message: string; at: number } | null>(null)
  const reportedStatusError = useRef<string | null>(null)
  const hydratedPid = useRef<number | null>(null)
  const catalogHydratedPid = useRef<number | null>(null)
  const { controllers, lastActivatedIndex, supported: gamepadsSupported } = useBrowserControllers()

  useEffect(() => {
    if (compact) document.title = 'LogVue — Driving controls'
  }, [compact])

  useEffect(() => {
    let alive = true
    void api.simulation.getControlsWindow().then(value => { if (alive) setDetached(value) })
    const unsubscribe = window.api.onSimulationControlsWindow(setDetached)
    const syncBindings = (event: StorageEvent): void => {
      if (event.key === 'logvue.sim.keyboard') setKeyboardEnabled(event.newValue === 'true')
      if (event.key === CONTROLLER_1_STORAGE_KEY) setController1(parseStoredControllerIndex(event.newValue))
      if (event.key === CONTROLLER_2_STORAGE_KEY) setController2(parseStoredControllerIndex(event.newValue))
    }
    window.addEventListener('storage', syncBindings)
    return () => { alive = false; unsubscribe(); window.removeEventListener('storage', syncBindings) }
  }, [])

  useEffect(() => {
    globalThis.localStorage?.setItem('logvue.sim.keyboard', String(keyboardEnabled))
  }, [keyboardEnabled])

  const phase = status?.phase ?? 'idle'
  const sessionActive = Boolean(status?.pid)
    || ['starting', 'initialized', 'running', 'paused', 'stopping'].includes(phase)
  const configLocked = sessionActive

  const reportError = useCallback((title: string, error: unknown): void => {
    const message = messageOf(error)
    const now = Date.now()
    if (
      lastReportedError.current?.message === message
      && now - lastReportedError.current.at < 1_000
    ) return
    lastReportedError.current = { message, at: now }
    void api.simulation.reportError(title, message).catch(() => undefined)
  }, [])

  const acceptCatalog = useCallback((discovered: SimulationCatalog) => {
    setCatalog(discovered)
    setScenarioId('')
    setSelectedProgram((current) => reconcileProgramSelection(discovered.opModes, current))
  }, [])

  const loadProject = useCallback(async (directory: string, refreshCatalog = true) => {
    if (!directory) return
    setBusy('discover')
    try {
      const discovered = await api.simulation.discoverProject(directory)
      setProject(discovered)
      setProjectDirectory(discovered.projectDirectory)
      globalThis.localStorage?.setItem('logvue.sim.project', discovered.projectDirectory)
      if (refreshCatalog) {
        try {
          const discoveredCatalog = await api.simulation.listCatalog(discovered.projectDirectory)
          acceptCatalog(discoveredCatalog)
        } catch (error) {
          setCatalog(EMPTY_CATALOG)
          setSelectedProgram(null)
          setScenarioId('')
          reportError(
            'Catalog unavailable',
            discovered.buildAvailable
              ? `Catalog unavailable. Build the robot project, then refresh. ${messageOf(error)}`
              : messageOf(error)
          )
        }
      }
    } catch (error) {
      setProject(null)
      setCatalog(EMPTY_CATALOG)
      setSelectedProgram(null)
      setScenarioId('')
      reportError('Could not load simulation project', error)
    } finally {
      setBusy(null)
    }
  }, [acceptCatalog, reportError])

  useEffect(() => {
    let alive = true
    api.simulation
      .getStatus()
      .then((next) => alive && setStatus(next))
      .catch((error) => alive && reportError('Could not read simulation status', error))
    const unsubscribe = api.simulation.onStatus((next) => setStatus(next))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [reportError])

  useEffect(() => {
    if (!projectDirectory || project || sessionActive) return
    void loadProject(projectDirectory)
  }, [loadProject, project, projectDirectory, sessionActive])

  // Recover immutable setup after renderer reload while the main-owned sim-cli is still running.
  useEffect(() => {
    if (!status?.pid || !status.config || hydratedPid.current === status.pid) return
    hydratedPid.current = status.pid
    setGamepad1Source(status.config.gamepad1)
    setGamepad2Source(status.config.gamepad2)
    setRateHz(String(status.config.rateHz ?? DEFAULT_RATE_HZ))
    setRlogPort(String(status.config.rlogPort ?? Number(DEFAULT_RLOG_PORT)))
    setSelectedProgram({
      pluginId: status.config.pluginId ?? '',
      opModeId: status.config.opModeId
    })
    setScenarioId(status.config.scenarioId ?? '')
    if (status.project) {
      setProject(status.project)
      setProjectDirectory(status.project.projectDirectory)
    }
  }, [status])

  useEffect(() => {
    globalThis.localStorage?.setItem('logvue.sim.fastTarget', fastTarget)
  }, [fastTarget])

  useEffect(() => {
    const value = Number(rateHz)
    if (Number.isFinite(value) && value >= 1 && value <= 1000) {
      globalThis.localStorage?.setItem('logvue.sim.rateHz', rateHz)
    }
  }, [rateHz])

  useEffect(() => {
    if (
      !status?.pid ||
      !status.project ||
      catalog.opModes.length > 0 ||
      catalogHydratedPid.current === status.pid
    ) return
    catalogHydratedPid.current = status.pid
    let alive = true
    api.simulation
      .listCatalog(status.project.projectDirectory)
      .then((discovered) => {
        if (!alive) return
        setCatalog(discovered)
        setSelectedProgram((current) => reconcileProgramSelection(discovered.opModes, current))
      })
      .catch((error) => alive && reportError('Could not read OpMode catalog', error))
    return () => {
      alive = false
    }
  }, [catalog.opModes.length, reportError, status?.pid, status?.project])

  useEffect(() => {
    if (!status?.lastError) {
      reportedStatusError.current = null
      return
    }
    const key = `${status.lastError.code}:${status.lastError.message}`
    if (reportedStatusError.current === key) return
    reportedStatusError.current = key
    reportError('Simulation failed', status.lastError.message)
  }, [reportError, status?.lastError])

  useEffect(() => {
    if (validRlogPort(rlogPort)) {
      globalThis.localStorage?.setItem('logvue.sim.rlogPort', rlogPort)
    }
  }, [rlogPort])

  useEffect(() => {
    persistControllerIndex(CONTROLLER_1_STORAGE_KEY, controller1)
  }, [controller1])

  useEffect(() => {
    persistControllerIndex(CONTROLLER_2_STORAGE_KEY, controller2)
  }, [controller2])

  useEffect(() => {
    if (lastActivatedIndex === null) return
    const candidate = controllers.find(
      ({ index, mapping }) => index === lastActivatedIndex && mapping === 'standard'
    )
    if (!candidate) return
    if (gamepad1Source.kind === 'LIVE' && controller1 === null && !keyboardEnabled) {
      setController1(candidate.index)
    } else if (
      gamepad2Source.kind === 'LIVE' &&
      controller2 === null &&
      controller1 !== candidate.index
    ) {
      setController2(candidate.index)
    }
  }, [controller1, controller2, controllers, gamepad1Source.kind, gamepad2Source.kind, lastActivatedIndex, keyboardEnabled])

  const inputOwner = compact || !detached
  const publishGamepad1 = inputOwner && sessionActive && status?.config?.gamepad1.kind === 'LIVE'
  const publishGamepad2 = inputOwner && sessionActive && status?.config?.gamepad2.kind === 'LIVE'
  const keyboard = useKeyboardGamepad(Boolean(publishGamepad1 && keyboardEnabled && phase === 'running'))
  const keyboardRead = useRef(keyboard.read)
  keyboardRead.current = keyboard.read
  useEffect(() => {
    if (!publishGamepad1 && !publishGamepad2) return
    let animationFrame = 0
    const publish = (): void => {
      api.simulation.publishGamepads({
        gamepad1: publishGamepad1 ? keyboardEnabled ? keyboardRead.current() : readBrowserGamepad(compact && !document.hasFocus() ? null : controller1) : undefined,
        gamepad2: publishGamepad2 ? readBrowserGamepad(compact && !document.hasFocus() ? null : controller2) : undefined
      })
      animationFrame = window.requestAnimationFrame(publish)
    }
    publish()
    return () => window.cancelAnimationFrame(animationFrame)
  }, [compact, controller1, controller2, publishGamepad1, publishGamepad2, keyboardEnabled])

  const chooseProject = async (): Promise<void> => {
    setBusy('pick-project')
    try {
      const selected = await api.simulation.pickProject()
      if (selected) await loadProject(selected)
    } catch (error) {
      reportError('Could not choose simulation project', error)
    } finally {
      setBusy(null)
    }
  }

  const buildProject = async (): Promise<void> => {
    if (!projectDirectory) return
    setBusy('build')
    try {
      const result = await api.simulation.buildProject(projectDirectory)
      setProject(result.project)
      acceptCatalog(result.catalog)
    } catch {
      // The main process owns the build task and reports its failure there.
    } finally {
      setBusy(null)
    }
  }

  const refreshCatalog = async (): Promise<void> => {
    if (!projectDirectory) return
    setBusy('refresh')
    try {
      const discoveredCatalog = await api.simulation.listCatalog(projectDirectory)
      acceptCatalog(discoveredCatalog)
    } catch (error) {
      reportError('Could not refresh OpMode catalog', error)
    } finally {
      setBusy(null)
    }
  }

  const chooseRlog = async (slot: Slot): Promise<void> => {
    try {
      const path = await api.simulation.pickRlog()
      if (!path) return
      if (slot === 1) setGamepad1Source({ kind: 'RLOG', path })
      else setGamepad2Source({ kind: 'RLOG', path })
    } catch (error) {
      reportError('Could not choose RLOG input', error)
    }
  }

  const configuredSession = (): SimulationStartConfig | null => {
    const requestedRateHz = Number(rateHz)
    if (!Number.isFinite(requestedRateHz) || requestedRateHz < 1 || requestedRateHz > 1000) {
      reportError('Invalid simulation setup', 'Update rate must be from 1 to 1000 Hz.')
      return null
    }
    const selected = catalog.opModes.find((program) => programMatches(program, selectedProgram))
    const validationError = validateSetup({
      project,
      programSelected: selected !== undefined,
      gamepad1Source,
      gamepad2Source,
      controller1,
      controller2,
      controllers,
      keyboardEnabled,
      rlogPort
    })
    if (validationError) {
      reportError('Invalid simulation setup', validationError)
      return null
    }
    if (!project || !selected) return null
    return {
      projectDirectory: project.projectDirectory,
      opModeId: selected.id,
      pluginId: selected.pluginId,
      scenarioId: scenarioId || undefined,
      gamepad1: gamepad1Source,
      gamepad2: gamepad2Source,
      rateHz: requestedRateHz,
      staleMs: DEFAULT_STALE_MS,
      rlogPort: Number(rlogPort)
    }
  }

  const initializeSession = async (): Promise<void> => {
    const config = configuredSession()
    if (!config) return
    setBusy('init')
    try {
      setStatus(await api.simulation.init(config))
    } catch (error) {
      reportError('Could not initialize simulation', error)
    } finally {
      setBusy(null)
    }
  }

  const command = async (
    name: string,
    action: () => Promise<SimulationStatus>
  ): Promise<void> => {
    setBusy(name)
    try {
      setStatus(await action())
    } catch (error) {
      reportError(`Simulation ${name} failed`, error)
    } finally {
      setBusy(null)
    }
  }

  const runFast = async (): Promise<void> => {
    const targetTimeSeconds = Number(fastTarget)
    if (!Number.isFinite(targetTimeSeconds) || targetTimeSeconds <= 0) {
      reportError('Invalid fast run', 'Target simulation time must be finite and positive.')
      return
    }
    const config = sessionActive ? null : configuredSession()
    if (!sessionActive && !config) return
    await command('run fast', () => api.simulation.runUntil(config, targetTimeSeconds))
  }

  const displayedProject = status?.project ?? project
  const opModes = catalog.opModes
  const selectedProgramKey = selectedProgram ? programSelectionKey(selectedProgram) : ''
  const selectedOpMode = opModes.find((program) => programMatches(program, selectedProgram))
  const scenarios = selectedOpMode
    ? catalog.scenarios.filter(({ pluginId }) => pluginId === selectedOpMode.pluginId)
    : []
  const selectedScenario = scenarios.find(({ id }) => id === scenarioId)
  const runner = status?.runner
  const selectedRateHz = Number(rateHz)
  const effectiveDtSeconds = runner?.dtSeconds
    ?? 1 / (Number.isFinite(selectedRateHz) && selectedRateHz > 0
      ? selectedRateHz
      : DEFAULT_RATE_HZ)
  const currentTimeSeconds = runner?.timeSeconds ?? 0
  const primaryControlLabel = busy === 'init'
    ? 'Initializing…'
    : busy === 'start'
      ? 'Starting…'
      : phase === 'initialized'
        ? 'Start'
        : phase === 'running'
          ? 'Pause'
          : phase === 'paused'
            ? 'Run'
            : phase === 'starting'
              ? 'Initializing…'
              : phase === 'stopping'
                ? 'Stopping…'
                : 'Init'
  const primaryControlDisabled = busy !== null
    || (sessionActive && !['initialized', 'running', 'paused'].includes(phase))

  const runPrimaryControl = (): void => {
    if (!sessionActive) {
      void initializeSession()
    } else if (phase === 'initialized') {
      void command('start', api.simulation.start)
    } else if (phase === 'running') {
      void command('pause', api.simulation.pause)
    } else if (phase === 'paused') {
      void command('resume', api.simulation.resume)
    }
  }

  if (compact) return (
    <div className="sim-mini">
      <header className="sim-mini-header">
        <div><strong>Driving controls</strong><small>{selectedOpMode?.name ?? 'Robot simulation'}</small></div>
        <button className="ghost sm" onClick={() => void api.simulation.closeControls()}>Full setup ↗</button>
      </header>
      <div className="sim-mini-status">
        <span className={`sim-state-badge ${phase}`}><span className="dot" />{phase}</span>
        <span className="sim-mini-time">{formatSimTime(runner?.timeSeconds ?? 0)}</span>
        <label><input type="checkbox" checked={pinned} onChange={event => {
          const value = event.target.checked
          void api.simulation.pinControls(value).then(() => setPinned(value))
        }} /> Stay on top</label>
      </div>
      <div className="sim-mini-actions">
        <button onClick={runPrimaryControl} disabled={primaryControlDisabled || !sessionActive}>{primaryControlLabel}</button>
        <button className="ghost" disabled={busy !== null || phase !== 'paused'} onClick={() => void command('step', () => api.simulation.step(1))}>Step</button>
        <button className="ghost sim-mini-stop" disabled={!sessionActive || busy !== null} onClick={() => void command('stop', api.simulation.stop)}>Stop</button>
      </div>
      {gamepad1Source.kind === 'LIVE' ? <>
        <label className="sim-mini-source">Drive with
          <select aria-label="Driving input" value={keyboardEnabled ? 'keyboard' : controller1 ?? ''}
            onChange={event => {
              setKeyboardEnabled(event.target.value === 'keyboard')
              setController1(event.target.value === 'keyboard' || event.target.value === '' ? null : Number(event.target.value))
            }}>
            <option value="keyboard">Keyboard</option><option value="">Choose controller…</option>
            {controllers.filter(c => c.mapping === 'standard').map(c => <option key={c.index} value={c.index}>{c.id}</option>)}
          </select>
        </label>
        {keyboardEnabled ? <div className="sim-keyboard-pad sim-mini-pad" tabIndex={0}
          onPointerDown={keyboard.onFocus}
          onFocus={keyboard.onFocus} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) keyboard.onBlur() }}
          aria-label="Keyboard driving area. Focus here to drive; leave to release all controls.">
          <strong>Click here to drive</strong>
          <p><kbd>W A S D</kbd> move · <kbd>Q E</kbd> turn</p>
          <div className="sim-mini-holds">
            {([['Space', 'Aim'], ['KeyI', 'Intake'], ['KeyK', 'Shoot']] as const).map(([code, label]) =>
              <button key={code} className="ghost" disabled={phase !== 'running'}
                onPointerDown={event => {
                  event.preventDefault()
                  event.currentTarget.closest<HTMLElement>('.sim-keyboard-pad')?.focus()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  keyboard.onFocus()
                  keyboard.press(code)
                }} onPointerUp={() => keyboard.release(code)} onPointerCancel={() => keyboard.release(code)}
                onLostPointerCapture={() => keyboard.release(code)}>{label}</button>)}
          </div>
          <p><kbd>Space</kbd> aim · <kbd>I</kbd> intake · <kbd>K</kbd> shoot</p>
          <p><kbd>X</kbd> eject · <kbd>T</kbd> tip HIVE</p>
          <small>Hold a key or button. Switching windows releases controls.</small>
        </div> : <p className="sim-mini-help">RB aim · RT shoot · LT intake<br />Right stick move · Left stick turn</p>}
      </> : <p className="sim-mini-help">Gamepad 1 uses {gamepad1Source.kind}. Open Full setup to change sources for a new session.</p>}
      <footer className="sim-mini-footer">
        <span className={runner?.gamepad1?.connected ? 'connected' : ''}>{runner?.gamepad1?.connected ? '● Input connected' : '○ Input released'}</span>
        <span>{runner?.rlog?.running ? formatRlogEndpoint(runner.rlog) : 'Viewer offline'}</span>
      </footer>
      {status?.lastError && <p role="alert" className="sim-mini-error">{status.lastError.message}</p>}
      {!sessionActive && <p className="sim-mini-help">Open Full setup to initialise a new simulation.</p>}
    </div>
  )

  return (
    <div className="simulate-workspace">
      <div className="sim-detach-bar">
        <span>{detached ? 'Driving controls are in the floating panel.' : 'Keep the field visible while you drive.'}</span>
        <button className="ghost sm" disabled={!sessionActive} onClick={() => void api.simulation.openControls().catch(error => reportError('Could not detach controls', error))}>
          {detached ? 'Show mini controls ↗' : 'Mini controls ↗'}
        </button>
      </div>
      <div className="sim-grid">
        <div className="sim-column">
          <section className="sim-card">
            <div className="sim-card-header sim-project-header">
              <h2>Robot project</h2>
              <div className="sim-project-picker">
                {configLocked && <span className="sim-lock">Locked for this session</span>}
                <button
                  type="button"
                  className="ghost sm"
                  disabled={configLocked || busy !== null}
                  onClick={() => void chooseProject()}
                >
                  Choose…
                </button>
              </div>
            </div>
            <div className="sim-card-body">
              <div className="sim-form-grid">
                {displayedProject && (
                  <div className="sim-field sim-project-summary-field">
                    <span className="sim-field-label">Project</span>
                    <div className="sim-project-summary">
                      <div className="sim-project-name">{displayedProject.manifest.name}</div>
                      <span
                        className="sim-project-info"
                        title={`Launch command: ${displayedProject.launchCommand.join(' ')}`}
                        aria-label={`Launch command: ${displayedProject.launchCommand.join(' ')}`}
                        tabIndex={0}
                      >
                        i
                      </span>
                      <span className="pill imported">Manifest loaded</span>
                    </div>
                  </div>
                )}

                <div className={`sim-field ${displayedProject ? 'sim-opmode-field' : 'full'}`}>
                  <label htmlFor="sim-opmode">OpMode</label>
                  <select
                    id="sim-opmode"
                    value={selectedProgramKey}
                    disabled={configLocked || busy !== null || opModes.length === 0}
                    onChange={(event) => {
                      setSelectedProgram(parseProgramSelectionKey(event.target.value))
                      setScenarioId('')
                    }}
                  >
                    {opModes.length === 0 && <option value="">No OpModes discovered</option>}
                    {selectedProgram && !selectedOpMode && (
                      <option value={selectedProgramKey}>
                        {selectedProgram.pluginId
                          ? `${selectedProgram.pluginId} · ${selectedProgram.opModeId}`
                          : selectedProgram.opModeId}
                      </option>
                    )}
                    {opModes.map((opMode) => (
                      <option
                        key={programSelectionKey({ pluginId: opMode.pluginId, opModeId: opMode.id })}
                        value={programSelectionKey({ pluginId: opMode.pluginId, opModeId: opMode.id })}
                      >
                        {opMode.group ? `${opMode.group} · ` : ''}
                        {opMode.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sim-field sim-scenario-field">
                  <label htmlFor="sim-scenario">Scenario</label>
                  <select
                    id="sim-scenario"
                    value={scenarioId}
                    disabled={configLocked || busy !== null || !selectedOpMode}
                    onChange={(event) => setScenarioId(event.target.value)}
                  >
                    <option value="">Default initialization</option>
                    {scenarioId && !scenarios.some(({ id }) => id === scenarioId) && (
                      <option value={scenarioId}>{scenarioId}</option>
                    )}
                    {scenarios.map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        {scenario.name}
                      </option>
                    ))}
                  </select>
                  <span className="sim-field-help">
                    {selectedScenario?.description ||
                      (scenarios.length > 0
                        ? 'Optional robot-defined starting conditions.'
                        : 'This robot plugin does not declare additional scenarios.')}
                  </span>
                </div>
                <div className="sim-field sim-project-rate-field">
                  <label htmlFor="sim-update-rate">Update rate (Hz)</label>
                  <div className="sim-project-rate-row">
                    <input
                      id="sim-update-rate"
                      type="number"
                      min="1"
                      max="1000"
                      step="1"
                      value={rateHz}
                      disabled={configLocked || busy === 'init'}
                      onChange={(event) => setRateHz(event.target.value)}
                    />
                    <div className="sim-project-actions">
                      <button
                        type="button"
                        className="ghost primary-control"
                        disabled={configLocked || busy !== null || !displayedProject}
                        onClick={() => void refreshCatalog()}
                      >
                        {busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog'}
                      </button>
                      {displayedProject?.buildAvailable && (
                        <button
                          type="button"
                          className="primary-control"
                          disabled={configLocked || busy !== null}
                          onClick={() => void buildProject()}
                        >
                          {busy === 'build' ? 'Building…' : 'Build'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Session inputs</h2>
              </div>
              {configLocked && <span className="sim-lock">Source modes locked for this session</span>}
            </div>
            <div className="sim-card-body">
              <div className="sim-inputs">
                <GamepadSourcePicker
                  slot={1}
                  source={gamepad1Source}
                  controllerIndex={controller1}
                  controllers={controllers}
                  lastActivatedIndex={lastActivatedIndex}
                  gamepadsSupported={gamepadsSupported}
                  sourceLocked={configLocked || busy === 'init'}
                  onSource={setGamepad1Source}
                  onController={setController1}
                  onPickRlog={() => void chooseRlog(1)}
                  keyboardEnabled={keyboardEnabled}
                  onKeyboard={setKeyboardEnabled}
                />
                <GamepadSourcePicker
                  slot={2}
                  source={gamepad2Source}
                  controllerIndex={controller2}
                  controllers={controllers}
                  lastActivatedIndex={lastActivatedIndex}
                  gamepadsSupported={gamepadsSupported}
                  sourceLocked={configLocked || busy === 'init'}
                  onSource={setGamepad2Source}
                  onController={setController2}
                  onPickRlog={() => void chooseRlog(2)}
                />
              </div>
              {keyboardEnabled && gamepad1Source.kind === 'LIVE' && (
                <div className="sim-keyboard-pad" tabIndex={0} onFocus={keyboard.onFocus} onBlur={keyboard.onBlur} onPointerDown={keyboard.onFocus}
                  aria-label="Keyboard driving area. Focus here to drive; leave to release all controls.">
                  <strong>Click here to drive with the keyboard</strong>
                  <p><kbd>W A S D</kbd> move · <kbd>Q E</kbd> turn · <kbd>Space</kbd> hold rear aim</p>
                  <p><kbd>I</kbd> intake · <kbd>K</kbd> aim + shoot · <kbd>X</kbd> eject · <kbd>T</kbd> tip HIVE (simulation)</p>
                  <small>Hold keys while running. Leaving this area, switching windows, or pausing releases controls.</small>
                </div>
              )}
              <p className="sim-control-guide">Pinkbacks controller: right stick moves, left stick turns, RB aims rear shooter, LT intakes, RT aims + shoots, X ejects, D-pad down tips HIVE in simulation.</p>
              <div className="sim-session-options">
                <div className="sim-field">
                  <label htmlFor="sim-fast-target">Run until (s)</label>
                  <input
                    id="sim-fast-target"
                    type="number"
                    min={currentTimeSeconds + effectiveDtSeconds}
                    max={currentTimeSeconds + effectiveDtSeconds * 10_000}
                    step={effectiveDtSeconds}
                    value={fastTarget}
                    disabled={busy !== null}
                    onChange={(event) => setFastTarget(event.target.value)}
                  />
                </div>
                <div className="sim-field">
                  <label htmlFor="sim-rlog-port">RLOG listen port</label>
                  <input
                    id="sim-rlog-port"
                    type="number"
                    min="0"
                    max="65535"
                    step="1"
                    value={rlogPort}
                    disabled={configLocked || busy === 'init'}
                    onChange={(event) => setRlogPort(event.target.value)}
                  />
                  <span className="sim-field-help">
                    Use 5802 if 5800 is occupied by a Limelight, or 0 to choose a free port.
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="sim-column">
          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Session control</h2>
              </div>
              <PhaseBadge phase={phase} pid={status?.pid ?? null} />
            </div>
            <div className="sim-card-body">
              <div className="sim-runtime">
                <div>
                  <div className="sim-time">{formatSimTime(runner?.timeSeconds ?? 0)}</div>
                  <div className="sim-time-label">
                    simulation time · tick {runner?.tick ?? 0}
                  </div>
                </div>
                <div className="sim-controls">
                  <button
                    type="button"
                    className="ghost sm sim-stop-control"
                    disabled={!sessionActive || busy !== null}
                    onClick={() => void command('stop', api.simulation.stop)}
                  >
                    {busy === 'stop' ? 'Stopping…' : 'Stop'}
                  </button>
                  <button
                    type="button"
                    className="primary-control sim-primary-control"
                    disabled={primaryControlDisabled}
                    onClick={runPrimaryControl}
                  >
                    {primaryControlLabel}
                  </button>
                  <button
                    type="button"
                    className="ghost sm sim-step-control"
                    disabled={busy !== null || phase !== 'paused'}
                    onClick={() => void command('step', () => api.simulation.step(1))}
                  >
                    Step
                  </button>
                  <button
                    type="button"
                    className="ghost sm sim-fast-control"
                    disabled={busy !== null || (sessionActive && phase !== 'paused')}
                    onClick={() => void runFast()}
                  >
                    {busy === 'run fast' ? 'Running…' : 'Run fast'}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="sim-card">
            <div className="sim-card-header">
              <div>
                <h2>Runtime</h2>
              </div>
            </div>
            <div className="sim-card-body compact">
              {runner ? (
                <div className="sim-metrics">
                  <Metric label="Pacing" value={`${runner.rateHz} Hz · ${(runner.dtSeconds * 1000).toFixed(1)} ms`} />
                  <InputMetric slot={1} runtime={runner.gamepad1} />
                  <InputMetric slot={2} runtime={runner.gamepad2} />
                  <Metric
                    label="RLOG server"
                    value={
                      runner.rlog?.running
                        ? formatRlogEndpoint(runner.rlog)
                        : runner.rlog?.enabled
                          ? 'starting'
                          : 'off'
                    }
                    tone={runner.rlog?.running ? 'good' : undefined}
                  />
                </div>
              ) : (
                <div className="sim-empty-runtime">
                  Runtime metrics appear after the CLI accepts the session configuration.
                </div>
              )}
              {status?.lastError && status.stderrTail.length > 0 && (
                <details className="sim-diagnostics">
                  <summary>CLI diagnostics</summary>
                  <pre>{status.stderrTail.slice(-12).join('\n')}</pre>
                </details>
              )}
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}

function PhaseBadge({ phase, pid }: { phase: string; pid: number | null }): JSX.Element {
  const processState = pid !== null ? ` · PID ${pid}` : phase === 'stopped' ? ' · exited' : ''
  return (
    <div className={`sim-state-badge ${phase}`}>
      <span className="dot" />
      <span>{phase}{processState}</span>
    </div>
  )
}

function GamepadSourcePicker({
  slot,
  source,
  controllerIndex,
  controllers,
  lastActivatedIndex,
  gamepadsSupported,
  sourceLocked,
  onSource,
  onController,
  onPickRlog,
  keyboardEnabled = false,
  onKeyboard
}: {
  slot: Slot
  source: SimulationGamepadSource
  controllerIndex: number | null
  controllers: BrowserController[]
  lastActivatedIndex: number | null
  gamepadsSupported: boolean
  sourceLocked: boolean
  onSource: (source: SimulationGamepadSource) => void
  onController: (index: number | null) => void
  onPickRlog: () => void
  keyboardEnabled?: boolean
  onKeyboard?: (enabled: boolean) => void
}): JSX.Element {
  const controller = controllers.find(({ index }) => index === controllerIndex)
  const standardControllers = controllers.filter(({ mapping }) => mapping === 'standard')
  const hasNonStandard = controllers.some(({ mapping }) => mapping !== 'standard')

  const selectKind = (kind: SimulationGamepadSource['kind']): void => {
    if (kind === 'NONE') onSource({ kind: 'NONE' })
    else if (kind === 'LIVE') onSource({ kind: 'LIVE' })
    else onSource({ kind: 'RLOG', path: source.kind === 'RLOG' ? source.path : '' })
  }

  return (
    <div className="sim-input-card">
      <div className="sim-input-card-head">
        <strong>Gamepad {slot}</strong>
        <span className="sim-input-status">{source.kind}</span>
      </div>
      <div className="sim-source-tabs" aria-label={`Gamepad ${slot} source`}>
        {(['NONE', 'LIVE', 'RLOG'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`sim-source-tab ${source.kind === kind ? 'active' : ''}`}
            disabled={sourceLocked}
            onClick={() => selectKind(kind)}
          >
            {kind}
          </button>
        ))}
      </div>
      <div className="sim-source-detail">
        {source.kind === 'NONE' && (
          <p className="sim-source-neutral">sim-cli samples a complete neutral gamepad on every tick.</p>
        )}
        {source.kind === 'LIVE' && (
          <>
            <select
              aria-label={`Physical controller for Gamepad ${slot}`}
              value={keyboardEnabled ? 'keyboard' : controllerIndex ?? ''}
              disabled={!gamepadsSupported && !onKeyboard}
              onChange={(event) =>
                {
                  const isKeyboard = event.target.value === 'keyboard'
                  onKeyboard?.(isKeyboard)
                  onController(isKeyboard || event.target.value === '' ? null : Number(event.target.value))
                }
              }
            >
              <option value="">Select a controller…</option>
              {onKeyboard && <option value="keyboard">Keyboard · WASD + aim / intake / shoot</option>}
              {controllerIndex !== null && !controller && (
                <option value={controllerIndex}>Controller {controllerIndex + 1} · disconnected</option>
              )}
              {standardControllers.map((item) => (
                <option key={item.index} value={item.index}>
                  {item.id} {item.index === lastActivatedIndex ? '· active' : ''}
                </option>
              ))}
            </select>
            <div className={`sim-controller-hint ${controller?.connected ? 'connected' : ''}`}>
              <span className="dot" />
              <span>
                {keyboardEnabled ? 'Keyboard selected. Focus the driving area below after starting.' : !gamepadsSupported
                  ? 'The browser Gamepad API is unavailable.'
                  : controller?.connected
                    ? sourceLocked
                      ? 'Connected. You can rebind this LIVE source while the simulation runs.'
                      : 'Connected with Chromium standard mapping.'
                    : hasNonStandard
                      ? 'Press any button. A detected controller needs a standard mapping for v1.'
                      : 'Press any button so Chromium can discover the controller.'}
              </span>
            </div>
          </>
        )}
        {source.kind === 'RLOG' && (
          <>
            <div className="sim-path-row">
              <div className="sim-path-value" title={source.path}>
                {source.path || 'No RLOG selected'}
              </div>
              <button type="button" className="ghost sm" disabled={sourceLocked} onClick={onPickRlog}>
                Choose…
              </button>
            </div>
            <div className="sim-controller-hint connected">
              <span className="dot" />
              <span>Stop and start a fresh session to rewind playback.</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'good' | 'warn'
}): JSX.Element {
  return (
    <div className="sim-metric-row">
      <span>{label}</span>
      <span className={`sim-metric-value ${tone ?? ''}`}>{value}</span>
    </div>
  )
}

function InputMetric({
  slot,
  runtime
}: {
  slot: Slot
  runtime: SimulationGamepadRuntimeStatus | undefined
}): JSX.Element {
  if (!runtime) return <Metric label={`Gamepad ${slot}`} value="waiting" />
  const value =
    runtime.mode === 'LIVE'
      ? runtime.stale
        ? 'LIVE · stale → neutral'
        : runtime.connected
          ? `LIVE · fresh${runtime.ageMillis === null ? '' : ` ${Math.round(runtime.ageMillis)} ms`}`
          : 'LIVE · disconnected → neutral'
      : runtime.mode === 'RLOG'
        ? 'RLOG · sampled by tick'
        : 'NONE · neutral'
  return (
    <Metric
      label={`Gamepad ${slot}`}
      value={value}
      tone={runtime.mode === 'LIVE' && runtime.connected && !runtime.stale ? 'good' : runtime.stale ? 'warn' : undefined}
    />
  )
}

function validateSetup({
  project,
  programSelected,
  gamepad1Source,
  gamepad2Source,
  controller1,
  controller2,
  controllers,
  keyboardEnabled = false,
  rlogPort
}: {
  project: SimulationProject | null
  programSelected: boolean
  gamepad1Source: SimulationGamepadSource
  gamepad2Source: SimulationGamepadSource
  controller1: number | null
  controller2: number | null
  controllers: BrowserController[]
  keyboardEnabled?: boolean
  rlogPort: string
}): string | null {
  if (!project) return 'Choose a valid robot project before starting.'
  if (!programSelected) return 'Choose an OpMode before starting.'
  if (!validRlogPort(rlogPort)) return 'RLOG port must be a whole number from 0 to 65535.'
  if (gamepad1Source.kind === 'RLOG' && !gamepad1Source.path) return 'Choose the Gamepad 1 RLOG.'
  if (gamepad2Source.kind === 'RLOG' && !gamepad2Source.path) return 'Choose the Gamepad 2 RLOG.'
  if (
    gamepad1Source.kind === 'LIVE' &&
    !keyboardEnabled &&
    (controller1 === null || !controllers.some(({ index, mapping }) => index === controller1 && mapping === 'standard'))
  ) {
    return 'Connect and choose a standard-mapped controller for Gamepad 1.'
  }
  if (
    gamepad2Source.kind === 'LIVE' &&
    (controller2 === null || !controllers.some(({ index, mapping }) => index === controller2 && mapping === 'standard'))
  ) {
    return 'Connect and choose a standard-mapped controller for Gamepad 2.'
  }
  return null
}

function persistControllerIndex(key: string, index: number | null): void {
  if (index === null) globalThis.localStorage?.removeItem(key)
  else globalThis.localStorage?.setItem(key, String(index))
}

function validRlogPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const port = Number(value)
  return Number.isInteger(port) && port >= 0 && port <= 65535
}

function formatSimTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds % 60).toFixed(3).padStart(6, '0')}`
}

function formatRlogEndpoint(rlog: NonNullable<SimulationRunnerStatus['rlog']>): string {
  const address = rlog.bindAddress || '127.0.0.1'
  const port = rlog.actualPort ?? rlog.requestedPort
  return port === undefined ? address : `${address}:${port}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
