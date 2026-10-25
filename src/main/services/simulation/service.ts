import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  SimulationGamepadFrame,
  SimulationGamepadSnapshot,
  SimulationPhase,
  SimulationPlatform,
  SimulationProject,
  SimulationRunnerStatus,
  SimulationStartConfig,
  SimulationStatus
} from '../../../shared/types/simulation'
import type { SimulationStderrEvent } from '../../../shared/types/simulation'
import {
  discoverSimulationProject,
  simulationPlatform,
  spawnCommand
} from './project'
import { SpiderKitSimProtocolClient, SpiderKitSimProtocolError } from './protocol'

const STATUS_POLL_MS = 250
const DEFAULT_RATE_HZ = 50
const BOUNDED_EXECUTION_TIMEOUT_MS = 5 * 60_000
const PROCESS_EXIT_GRACE_MS = 2_000
const PROCESS_KILL_TIMEOUT_MS = 1_000
const STDERR_TAIL_LINES = 100
const STDERR_LINE_LIMIT = 4_096

type SimulationEventSink = (
  ...event:
    | [channel: 'simulation:status', payload: SimulationStatus]
    | [channel: 'simulation:stderr', payload: SimulationStderrEvent]
) => void

type SpawnProcess = (
  projectDirectory: string,
  command: string[],
  cwd: string,
  platform: SimulationPlatform
) => ChildProcessWithoutNullStreams

export class SimulationService {
  private child: ChildProcessWithoutNullStreams | null = null
  private client: SpiderKitSimProtocolClient | null = null
  private project: SimulationProject | null = null
  private config: SimulationStartConfig | null = null
  private phase: SimulationPhase = 'idle'
  private runner: SimulationRunnerStatus | null = null
  private lastError: { code: string; message: string } | null = null
  private stderrTail: string[] = []
  private stderrBuffer = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private statusPollInFlight = false
  private latestGamepads: SimulationGamepadFrame | null = null
  private gamepadInFlight = false

  constructor(
    private readonly spawnProcess: SpawnProcess = (projectDirectory, command, cwd, platform) =>
      spawnCommand(projectDirectory, command, cwd, platform),
    private readonly emit: SimulationEventSink = () => undefined,
    private readonly platform: SimulationPlatform = simulationPlatform()
  ) {}

  getStatus(): SimulationStatus {
    return {
      phase: this.phase,
      pid: this.child?.pid ?? null,
      config: this.config ? structuredClone(this.config) : null,
      project: this.project ? structuredClone(this.project) : null,
      runner: this.runner ? structuredClone(this.runner) : null,
      lastError: this.lastError ? { ...this.lastError } : null,
      stderrTail: [...this.stderrTail]
    }
  }

  async initialize(input: SimulationStartConfig): Promise<SimulationStatus> {
    if (this.child) {
      throw new SpiderKitSimProtocolError('SESSION_ACTIVE', 'A SpiderKit Sim session is already active')
    }
    const { config, project, command, cwd } = await this.resolveStart(input)
    this.config = config
    this.project = project
    this.runner = null
    this.lastError = null
    this.stderrTail = []
    this.stderrBuffer = ''
    this.setPhase('starting')

    const args = serveArgs(config)
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnProcess(
        project.projectDirectory,
        [...command, ...args],
        cwd,
        this.platform
      )
    } catch (error) {
      this.recordFatal(error)
      throw error
    }
    this.child = child
    this.captureStderr(child)
    const client = new SpiderKitSimProtocolClient(child, (error) => this.handleProtocolFatal(client, error))
    this.client = client
    child.once('close', () => this.handleExit(child))
    try {
      const status = await client.request('hello', {}, 10_000)
      if (this.client !== client) {
        throw new SpiderKitSimProtocolError('SESSION_STOPPED', 'SpiderKit Sim stopped during startup')
      }
      this.applyRunnerStatus(status)
      if (this.phase === 'running' || this.phase === 'paused') this.startStatusPolling()
      return this.getStatus()
    } catch (error) {
      if (this.client === client) {
        this.recordFatal(error)
        client.terminate()
      }
      throw error
    }
  }

  async start(): Promise<SimulationStatus> {
    const status = await this.lifecycle('start')
    if (this.phase === 'running') this.startStatusPolling()
    return status
  }

  pause(): Promise<SimulationStatus> {
    return this.lifecycle('pause')
  }

  resume(): Promise<SimulationStatus> {
    return this.lifecycle('resume')
  }

  step(count = 1): Promise<SimulationStatus> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
      return Promise.reject(
        new SpiderKitSimProtocolError(
          'INVALID_STEP_COUNT',
          'Step count must be an integer from 1 to 10000'
        )
      )
    }
    return this.lifecycle('step', { count }, BOUNDED_EXECUTION_TIMEOUT_MS)
  }

  advance(durationSeconds: number): Promise<SimulationStatus> {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return Promise.reject(
        new SpiderKitSimProtocolError(
          'INVALID_DURATION',
          'Duration must be finite and positive'
        )
      )
    }
    return this.lifecycle('advance', { durationSeconds }, BOUNDED_EXECUTION_TIMEOUT_MS)
  }

  /**
   * Executes to one absolute simulation timestamp without wall-clock pacing.
   * An idle call owns process launch and initialization; SpiderKit's advance command owns the
   * START edge atomically and returns the worker in PAUSED.
   */
  async runUntil(
    input: SimulationStartConfig | null,
    targetTimeSeconds: number
  ): Promise<SimulationStatus> {
    if (!Number.isFinite(targetTimeSeconds) || targetTimeSeconds <= 0) {
      throw new SpiderKitSimProtocolError(
        'INVALID_TARGET_TIME',
        'Target simulation time must be finite and positive'
      )
    }
    if (!this.child) {
      if (!input) {
        throw new SpiderKitSimProtocolError(
          'SESSION_CONFIG_REQUIRED',
          'A session configuration is required when no simulation is active'
        )
      }
      validateTargetDuration(targetTimeSeconds, 0, 1 / (input.rateHz ?? DEFAULT_RATE_HZ))
      await this.initialize(input)
    } else if (input) {
      throw new SpiderKitSimProtocolError(
        'SESSION_ACTIVE',
        'A session configuration cannot replace an active simulation'
      )
    }

    if (!['initialized', 'paused'].includes(this.phase) || !this.runner) {
      throw new SpiderKitSimProtocolError(
        'NOT_BOUNDED_RUN_READY',
        'Run until is available before initialization or while paused'
      )
    }
    const durationSeconds = targetTimeSeconds - this.runner.timeSeconds
    const tolerance = validateTargetDuration(
      targetTimeSeconds,
      this.runner.timeSeconds,
      this.runner.dtSeconds
    )
    if (Math.abs(durationSeconds) <= tolerance) return this.getStatus()
    return this.advance(durationSeconds)
  }

  async stop(): Promise<SimulationStatus> {
    const client = this.client
    const child = this.child
    if (!client || !child) {
      if (this.phase !== 'error') this.setPhase('stopped')
      return this.getStatus()
    }
    this.setPhase('stopping')
    this.stopStatusPolling()
    this.latestGamepads = null
    try {
      const status = await client.request('stop', {}, 2_000)
      this.runner = status
      client.closeInput()
      if (!(await this.waitForProcessExit(child, PROCESS_EXIT_GRACE_MS))) {
        client.terminate()
        if (!(await this.waitForProcessExit(child, PROCESS_KILL_TIMEOUT_MS))) {
          throw new SpiderKitSimProtocolError(
            'PROCESS_EXIT_TIMEOUT',
            `SpiderKit Sim process ${child.pid ?? '<unknown>'} did not exit after stop`
          )
        }
      }
      return this.getStatus()
    } catch (error) {
      // EOF is the protocol's independent fail-close boundary if a stop reply is lost.
      client.closeInput()
      this.recordFatal(error)
      throw error
    }
  }

  /** Renderer loss must not leave live controls or a JVM session active. */
  failClose(_reason: string): void {
    const client = this.client
    if (!client) return
    this.setPhase('stopping')
    this.stopStatusPolling()
    this.latestGamepads = null
    this.closeInputWithFallback(client)
  }

  /** Synchronous app-shutdown edge: closing stdin makes SpiderKit Sim stop on EOF. */
  dispose(): void {
    this.stopStatusPolling()
    this.latestGamepads = null
    const client = this.client
    if (client) {
      this.setPhase('stopping')
      this.closeInputWithFallback(client)
    }
  }

  /** Clear held inputs when control ownership changes between renderers. */
  releaseLiveInputs(): void {
    const neutral = sanitizeGamepad({ connected: false } as SimulationGamepadSnapshot)
    this.publishGamepads({ gamepad1: neutral, gamepad2: neutral })
  }

  /** Latest-value mailbox fed by preload's one-way ipcRenderer.send path. */
  publishGamepads(frame: SimulationGamepadFrame): void {
    if (!this.client || !this.config || !['running', 'paused'].includes(this.phase)) return
    const next: SimulationGamepadFrame = {}
    if (this.config.gamepad1.kind === 'LIVE' && frame.gamepad1) {
      next.gamepad1 = sanitizeGamepad(frame.gamepad1)
    }
    if (this.config.gamepad2.kind === 'LIVE' && frame.gamepad2) {
      next.gamepad2 = sanitizeGamepad(frame.gamepad2)
    }
    if (!next.gamepad1 && !next.gamepad2) return
    this.latestGamepads = next
    this.flushLatestGamepads()
  }

  private async resolveStart(input: SimulationStartConfig): Promise<{
    config: SimulationStartConfig
    project: SimulationProject
    command: string[]
    cwd: string
  }> {
    const config = validateStartConfig(input)
    const project = discoverSimulationProject(config.projectDirectory, this.platform)
    return { config, project, command: project.launchCommand, cwd: project.workingDirectory }
  }

  private async lifecycle(
    command: 'start' | 'pause' | 'resume' | 'step' | 'advance',
    payload: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<SimulationStatus> {
    const client = this.client
    if (!client) throw new SpiderKitSimProtocolError('NO_SESSION', 'No SpiderKit Sim session is active')
    const status = await client.request(command, payload, timeoutMs)
    if (this.client === client) this.applyRunnerStatus(status)
    return this.getStatus()
  }

  private flushLatestGamepads(): void {
    const client = this.client
    const frame = this.latestGamepads
    if (!client || !frame || this.gamepadInFlight) return
    this.latestGamepads = null
    this.gamepadInFlight = true
    const payload: Record<string, unknown> = {}
    if (frame.gamepad1) payload.gamepad1 = toRunnerGamepad(frame.gamepad1)
    if (frame.gamepad2) payload.gamepad2 = toRunnerGamepad(frame.gamepad2)
    void client
      .request('gamepadUpdate', payload, 1_000)
      .then((status) => {
        if (this.client === client) this.runner = status
      })
      .catch(() => undefined)
      .finally(() => {
        this.gamepadInFlight = false
        if (this.client === client) this.flushLatestGamepads()
      })
  }

  private startStatusPolling(): void {
    this.stopStatusPolling()
    this.pollTimer = setInterval(() => {
      const client = this.client
      if (!client || this.statusPollInFlight || !['running', 'paused'].includes(this.phase)) return
      this.statusPollInFlight = true
      void client
        .request('status')
        .then((status) => {
          if (this.client === client) this.applyRunnerStatus(status)
        })
        .catch(() => undefined)
        .finally(() => {
          this.statusPollInFlight = false
        })
    }, STATUS_POLL_MS)
    this.pollTimer.unref()
  }

  private stopStatusPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.statusPollInFlight = false
  }

  private captureStderr(child: ChildProcessWithoutNullStreams): void {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (this.child !== child) return
      this.stderrBuffer += chunk
      let newline: number
      while ((newline = this.stderrBuffer.indexOf('\n')) >= 0) {
        const line = this.stderrBuffer.slice(0, newline).replace(/\r$/, '')
        this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
        this.recordStderr(line)
      }
      if (this.stderrBuffer.length > STDERR_LINE_LIMIT) {
        this.recordStderr(`${this.stderrBuffer.slice(0, STDERR_LINE_LIMIT)}…`)
        this.stderrBuffer = ''
      }
    })
  }

  private recordStderr(line: string): void {
    if (!line) return
    this.stderrTail.push(line)
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
    this.emit('simulation:stderr', { line })
  }

  private applyRunnerStatus(status: SimulationRunnerStatus): void {
    this.runner = status
    const phase: SimulationPhase =
      status.state === 'INITIALIZED'
        ? 'initialized'
        : status.state === 'RUNNING'
        ? 'running'
        : status.state === 'PAUSED'
          ? 'paused'
          : status.state === 'STOPPED'
            ? 'stopped'
            : 'error'
    if (phase === 'error') {
      this.lastError = {
        code: 'SPIDERKIT_SIM_FAILED',
        message:
          typeof status.failureMessage === 'string'
            ? status.failureMessage
            : 'SpiderKit Sim reported a failed session'
      }
    }
    this.setPhase(phase)
    if (phase === 'error' && this.client) {
      this.latestGamepads = null
      this.stopStatusPolling()
      this.closeInputWithFallback(this.client)
    }
  }

  private handleProtocolFatal(client: SpiderKitSimProtocolClient, error: Error): void {
    if (this.client !== client) return
    if (this.phase === 'stopping' || this.phase === 'stopped' || this.phase === 'error') return
    this.latestGamepads = null
    this.recordFatal(error)
    this.closeInputWithFallback(client)
  }

  private closeInputWithFallback(client: SpiderKitSimProtocolClient): void {
    client.closeInput()
    const fallback = setTimeout(() => {
      if (this.client === client) client.terminate()
    }, 1_000)
    fallback.unref()
  }

  private waitForProcessExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number
  ): Promise<boolean> {
    if (this.child !== child) return Promise.resolve(true)
    return new Promise((resolve) => {
      const onClose = (): void => {
        clearTimeout(timeout)
        resolve(true)
      }
      const timeout = setTimeout(() => {
        child.off('close', onClose)
        resolve(this.child !== child)
      }, timeoutMs)
      timeout.unref()
      child.once('close', onClose)
    })
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return
    const wasExpected = this.phase === 'stopping' || this.phase === 'stopped'
    this.stopStatusPolling()
    this.child = null
    this.client = null
    this.latestGamepads = null
    this.gamepadInFlight = false
    if (this.stderrBuffer) this.recordStderr(this.stderrBuffer)
    this.stderrBuffer = ''
    if (wasExpected) this.setPhase('stopped')
    else if (this.phase === 'error') this.emit('simulation:status', this.getStatus())
  }

  private recordFatal(error: unknown): void {
    const info = errorInfo(error)
    this.lastError = info
    this.stopStatusPolling()
    this.setPhase('error')
  }

  private setPhase(phase: SimulationPhase): void {
    this.phase = phase
    this.emit('simulation:status', this.getStatus())
  }
}

function validateStartConfig(input: SimulationStartConfig): SimulationStartConfig {
  if (!input || typeof input !== 'object') {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', 'Simulation config is required')
  }
  if (typeof input.projectDirectory !== 'string' || !input.projectDirectory.trim()) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', 'A SpiderKit simulation project is required')
  }
  if (typeof input.opModeId !== 'string' || !input.opModeId.trim() || input.opModeId.length > 500) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', 'A valid OpMode id is required')
  }
  optionalText(input.pluginId, 'pluginId')
  optionalText(input.scenarioId, 'scenarioId')
  validateParameters(input.parameters)
  validateSource(input.gamepad1, 'gamepad1')
  validateSource(input.gamepad2, 'gamepad2')
  numberOption(input.rateHz, 'rateHz', 1, 1000)
  numberOption(input.staleMs, 'staleMs', 1, 60_000, true)
  numberOption(input.rlogPort, 'rlogPort', 0, 65_535, true)
  return structuredClone(input)
}

function validateSource(
  source: SimulationStartConfig['gamepad1'],
  name: string
): void {
  if (!source || !['NONE', 'LIVE', 'RLOG'].includes(source.kind)) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', `${name} source is invalid`)
  }
  if (source.kind === 'RLOG') {
    if (!isAbsolute(source.path) || !existsSync(source.path) || !statSync(source.path).isFile()) {
      throw new SpiderKitSimProtocolError('RLOG_NOT_FOUND', `${name} RLOG path does not exist`)
    }
  }
}

function optionalText(value: string | undefined, name: string): void {
  if (value !== undefined && (!value.trim() || value.length > 500 || /[\0\r\n]/.test(value))) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', `${name} is invalid`)
  }
}

function validateParameters(parameters: Record<string, string> | undefined): void {
  if (parameters === undefined) return
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', 'parameters must be a string map')
  }
  const entries = Object.entries(parameters)
  if (entries.length > 100) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', 'parameters cannot contain more than 100 entries')
  }
  for (const [key, value] of entries) {
    if (!key || key.length > 200 || /[=\0\r\n]/.test(key) || typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new SpiderKitSimProtocolError('INVALID_CONFIG', `Simulation parameter ${key || '<empty>'} is invalid`)
    }
  }
}

function numberOption(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
  integer = false
): void {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new SpiderKitSimProtocolError('INVALID_CONFIG', `${name} must be from ${minimum} to ${maximum}`)
  }
}

function serveArgs(config: SimulationStartConfig): string[] {
  const args = [
    'serve-opmode',
    '--id',
    config.opModeId
  ]
  if (config.pluginId) args.push('--plugin', config.pluginId)
  if (config.scenarioId) args.push('--scenario', config.scenarioId)
  for (const [key, value] of Object.entries(config.parameters ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    args.push('--param', `${key}=${value}`)
  }
  args.push('--gamepad1', sourceArg(config.gamepad1), '--gamepad2', sourceArg(config.gamepad2))
  if (config.rateHz !== undefined) args.push('--rate-hz', String(config.rateHz))
  if (config.staleMs !== undefined) args.push('--stale-ms', String(config.staleMs))
  if (config.rlogPort !== undefined) args.push('--rlog-port', String(config.rlogPort))
  args.push('--init-only')
  return args
}

function validateTargetDuration(
  targetTimeSeconds: number,
  currentTimeSeconds: number,
  dtSeconds: number
): number {
  const durationSeconds = targetTimeSeconds - currentTimeSeconds
  const tolerance = Math.max(1e-12, dtSeconds * 1e-9)
  if (durationSeconds < -tolerance) {
    throw new SpiderKitSimProtocolError(
      'TARGET_TIME_ELAPSED',
      `Target time ${targetTimeSeconds} s is before current simulation time ${currentTimeSeconds} s`
    )
  }
  if (Math.abs(durationSeconds) <= tolerance) return tolerance
  const ticks = Math.round(durationSeconds / dtSeconds)
  if (ticks < 1 || ticks > 10_000) {
    throw new SpiderKitSimProtocolError(
      'INVALID_TARGET_TIME',
      'Target time must be between 1 and 10000 fixed ticks after the current simulation time'
    )
  }
  if (Math.abs(ticks * dtSeconds - durationSeconds) > tolerance) {
    throw new SpiderKitSimProtocolError(
      'INVALID_TARGET_TIME',
      `Target time must align to the fixed timestep ${dtSeconds}`
    )
  }
  return tolerance
}

function sourceArg(source: SimulationStartConfig['gamepad1']): string {
  if (source.kind === 'NONE') return 'NONE'
  if (source.kind === 'LIVE') return 'LIVE'
  return `RLOG:${source.path}`
}

function sanitizeGamepad(value: SimulationGamepadSnapshot): SimulationGamepadSnapshot {
  if (!value || typeof value !== 'object') {
    throw new SpiderKitSimProtocolError('INVALID_GAMEPAD', 'Gamepad snapshot must be an object')
  }
  const axes = value.axes ?? ({} as SimulationGamepadSnapshot['axes'])
  const buttons = value.buttons ?? ({} as SimulationGamepadSnapshot['buttons'])
  const axis = (name: keyof typeof axes, trigger = false): number => {
    const number = axes[name]
    if (!Number.isFinite(number)) return 0
    return trigger ? Math.max(0, Math.min(1, number)) : Math.max(-1, Math.min(1, number))
  }
  const button = (name: keyof typeof buttons): boolean => buttons[name] === true
  return {
    connected: value.connected === true,
    id: typeof value.id === 'string' ? value.id.slice(0, 512) : null,
    mapping: typeof value.mapping === 'string' ? value.mapping.slice(0, 64) : '',
    index: Number.isSafeInteger(value.index) && (value.index as number) >= 0 ? value.index : null,
    timestamp: Number.isFinite(value.timestamp) ? value.timestamp : 0,
    capturedAt: Number.isFinite(value.capturedAt) ? value.capturedAt : 0,
    axes: {
      leftStickX: axis('leftStickX'),
      leftStickY: axis('leftStickY'),
      rightStickX: axis('rightStickX'),
      rightStickY: axis('rightStickY'),
      leftTrigger: axis('leftTrigger', true),
      rightTrigger: axis('rightTrigger', true)
    },
    buttons: {
      a: button('a'),
      b: button('b'),
      x: button('x'),
      y: button('y'),
      dpadUp: button('dpadUp'),
      dpadDown: button('dpadDown'),
      dpadLeft: button('dpadLeft'),
      dpadRight: button('dpadRight'),
      leftBumper: button('leftBumper'),
      rightBumper: button('rightBumper'),
      leftStickButton: button('leftStickButton'),
      rightStickButton: button('rightStickButton'),
      back: button('back'),
      start: button('start'),
      guide: button('guide'),
      touchpad: button('touchpad')
    }
  }
}

function toRunnerGamepad(value: SimulationGamepadSnapshot): Record<string, unknown> {
  return {
    connected: value.connected,
    type: value.mapping || undefined,
    id: value.index ?? undefined,
    timestampNanos: Math.max(0, Math.round(value.timestamp * 1e6)),
    ...value.axes,
    ...value.buttons
  }
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof SpiderKitSimProtocolError) return { code: error.code, message: error.message }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error instanceof Error ? error.message : String(error) }
  }
  return { code: 'SIMULATION_ERROR', message: error instanceof Error ? error.message : String(error) }
}

let singleton: SimulationService | null = null

export function getSimulationService(emit?: SimulationEventSink): SimulationService {
  if (!singleton) singleton = new SimulationService(undefined, emit)
  return singleton
}

export function resetSimulationServiceForTests(): void {
  singleton?.dispose()
  singleton = null
}
