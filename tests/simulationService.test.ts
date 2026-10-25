import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { SimulationService } from '../src/main/services/simulation/service'
import { listSimulationCatalog } from '../src/main/services/simulation/project'
import type { SimulationGamepadSnapshot } from '../src/shared/types/simulation'

const temporaryDirectories: string[] = []
type RunnerState = 'INITIALIZED' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'FAILED'

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class FakeReadable extends EventEmitter {
  setEncoding(): void {}
}

class ReplyingStdin extends EventEmitter {
  destroyed = false
  readonly requests: Record<string, any>[] = []
  private timeSeconds = 0
  private tick = 0

  constructor(
    private readonly stdout: FakeReadable,
    private replyState: RunnerState,
    private readonly onEnd: () => void
  ) {
    super()
  }

  write(value: string, _encoding: string, callback: (error?: Error | null) => void): boolean {
    const request = JSON.parse(value) as Record<string, any>
    this.requests.push(request)
    callback(null)
    queueMicrotask(() => {
      if (request.command === 'start' && this.replyState === 'INITIALIZED') this.replyState = 'RUNNING'
      if (request.command === 'pause' && this.replyState === 'RUNNING') this.replyState = 'PAUSED'
      if (request.command === 'resume' && this.replyState === 'PAUSED') this.replyState = 'RUNNING'
      if (request.command === 'advance' && ['INITIALIZED', 'PAUSED'].includes(this.replyState)) {
        this.replyState = 'PAUSED'
        const durationSeconds = Number(request.durationSeconds)
        this.timeSeconds += durationSeconds
        this.tick += Math.round(durationSeconds / 0.02)
      }
      if (request.command === 'stop') this.replyState = 'STOPPED'
      const state = this.replyState
      this.stdout.emit(
        'data',
        `${JSON.stringify({
          protocol: 'spiderkit-sim-opmode',
          protocolVersion: 1,
          id: request.id,
          command: request.command,
          ok: true,
          status: {
            state,
            id: 'test.opmode',
            tick: this.tick,
            timeSeconds: this.timeSeconds,
            dtSeconds: 0.02,
            rateHz: 50,
            ...(state === 'FAILED' ? { failureMessage: 'Robot model exploded' } : {})
          }
        })}\n`
      )
    })
    return true
  }

  end(): void {
    if (this.destroyed) return
    this.destroyed = true
    queueMicrotask(this.onEnd)
  }
}

function fakeChild(
  replyState: RunnerState = 'INITIALIZED',
  closeOnInputEnd = true
) {
  const stdout = new FakeReadable()
  const emitter = new EventEmitter()
  const close = () => emitter.emit('close', 0, null)
  const stdin = new ReplyingStdin(stdout, replyState, () => {
    if (closeOnInputEnd) close()
  })
  const process = Object.assign(emitter, {
    pid: 123,
    stdout,
    stderr: new FakeReadable(),
    stdin,
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  })
  return {
    child: process as unknown as ChildProcessWithoutNullStreams,
    stdin,
    close
  }
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'logvue-sim-service-'))
  temporaryDirectories.push(root)
  writeFileSync(
    join(root, 'spiderkit-sim.json'),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      name: 'Test robot',
      launchCommand: {
        linux: ['dist/bin/robot-sim'],
        windows: ['dist/bin/robot-sim.bat']
      }
    })
  )
  return root
}

function gamepad(timestamp: number): SimulationGamepadSnapshot {
  return {
    connected: true,
    id: 'Browser controller',
    mapping: 'standard',
    index: 2,
    timestamp,
    capturedAt: 100,
    axes: {
      leftStickX: 0.5,
      leftStickY: 0,
      rightStickX: 0,
      rightStickY: 0,
      leftTrigger: 0,
      rightTrigger: 0
    },
    buttons: {
      a: true,
      b: false,
      x: false,
      y: false,
      dpadUp: false,
      dpadDown: false,
      dpadLeft: false,
      dpadRight: false,
      leftBumper: false,
      rightBumper: false,
      leftStickButton: false,
      rightStickButton: false,
      back: false,
      start: false,
      guide: false,
      touchpad: false
    }
  }
}

describe('SimulationService', () => {
  it('launches platform argv and publishes canonical LIVE snapshots on Linux', async () => {
    const process = fakeChild()
    let launched: string[] = []
    const service = new SimulationService(
      (_projectDirectory, command) => {
        launched = command
        return process.child
      },
      () => undefined,
      'linux'
    )

    await service.initialize({
      projectDirectory: project(),
      opModeId: 'test.opmode',
      pluginId: 'test.plugin',
      scenarioId: 'loaded',
      parameters: { mass: '4.2' },
      gamepad1: { kind: 'LIVE' },
      gamepad2: { kind: 'NONE' }
    })

    expect(launched).toEqual([
      'dist/bin/robot-sim',
      'serve-opmode',
      '--id',
      'test.opmode',
      '--plugin',
      'test.plugin',
      '--scenario',
      'loaded',
      '--param',
      'mass=4.2',
      '--gamepad1',
      'LIVE',
      '--gamepad2',
      'NONE',
      '--init-only'
    ])

    await expect(service.start()).resolves.toMatchObject({ phase: 'running' })
    service.publishGamepads({ gamepad1: gamepad(12.5) })
    await new Promise((resolve) => setImmediate(resolve))
    const update = process.stdin.requests.find(({ command }) => command === 'gamepadUpdate')
    expect(update.gamepad1).toMatchObject({
      connected: true,
      id: 2,
      type: 'standard',
      timestampNanos: 12_500_000,
      leftStickX: 0.5,
      a: true
    })
    service.releaseLiveInputs()
    await new Promise((resolve) => setImmediate(resolve))
    const released = process.stdin.requests.filter(({ command }) => command === 'gamepadUpdate').at(-1)
    expect(released.gamepad1).toMatchObject({ connected: false, leftStickX: 0, a: false })
    expect(released.gamepad2).toBeUndefined()
    await service.pause()
    await service.advance(1.5)
    expect(process.stdin.requests).toContainEqual(
      expect.objectContaining({ command: 'advance', durationSeconds: 1.5 })
    )

    service.dispose()
  })

  it('remains stopping with a live PID until the simulator process exits', async () => {
    const process = fakeChild('INITIALIZED', false)
    const service = new SimulationService(() => process.child, () => undefined, 'linux')

    await service.initialize({
      projectDirectory: project(),
      opModeId: 'test.opmode',
      gamepad1: { kind: 'NONE' },
      gamepad2: { kind: 'NONE' }
    })

    const stopPromise = service.stop()
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.getStatus()).toMatchObject({ phase: 'stopping', pid: 123 })

    process.close()
    await expect(stopPromise).resolves.toMatchObject({ phase: 'stopped', pid: null })
  })

  it('initializes and executes to an absolute simulation time in one service call', async () => {
    const process = fakeChild()
    const service = new SimulationService(() => process.child, () => undefined, 'linux')

    const status = await service.runUntil({
      projectDirectory: project(),
      opModeId: 'test.opmode',
      gamepad1: { kind: 'NONE' },
      gamepad2: { kind: 'NONE' },
      rateHz: 50
    }, 2.0)

    expect(status).toMatchObject({
      phase: 'paused',
      runner: { state: 'PAUSED', tick: 100, timeSeconds: 2.0 }
    })
    expect(process.stdin.requests).toContainEqual(
      expect.objectContaining({ command: 'advance', durationSeconds: 2.0 })
    )
    expect(process.stdin.requests.some(({ command }) => command === 'start')).toBe(false)
    expect(process.stdin.requests.some(({ command }) => command === 'pause')).toBe(false)
    service.dispose()
  })

  it('fail-closes a runner-reported FAILED session and permits a clean restart', async () => {
    const failed = fakeChild('FAILED')
    const restarted = fakeChild('INITIALIZED')
    let spawnCount = 0
    const service = new SimulationService(
      () => (spawnCount++ === 0 ? failed.child : restarted.child),
      () => undefined,
      'linux'
    )
    const config = {
      projectDirectory: project(),
      opModeId: 'test.opmode',
      gamepad1: { kind: 'NONE' as const },
      gamepad2: { kind: 'NONE' as const }
    }

    const failedStatus = await service.initialize(config)
    expect(failedStatus.phase).toBe('error')
    expect(failedStatus.lastError).toEqual({
      code: 'SPIDERKIT_SIM_FAILED',
      message: 'Robot model exploded'
    })
    expect(failed.stdin.destroyed).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.getStatus().pid).toBeNull()

    await expect(service.initialize(config)).resolves.toMatchObject({ phase: 'initialized', pid: 123 })
    expect(spawnCount).toBe(2)
    service.dispose()
  })
})

it.skipIf(!process.env.LOGVUE_SPIDERKIT_PROJECT)(
  'executes an exact bounded interval without wall-clock pacing',
  async () => {
    const projectDirectory = process.env.LOGVUE_SPIDERKIT_PROJECT!
    const catalog = await listSimulationCatalog(projectDirectory, 'linux')
    const opMode = catalog.opModes[0]
    const service = new SimulationService(undefined, () => undefined, 'linux')

    try {
      const before = performance.now()
      const advanced = await service.runUntil(
        {
          projectDirectory,
          opModeId: opMode.id,
          pluginId: opMode.pluginId,
          gamepad1: { kind: 'NONE' },
          gamepad2: { kind: 'NONE' },
          rlogPort: 0
        },
        1.0
      )
      expect(advanced).toMatchObject({
        phase: 'paused',
        runner: { tick: 50 }
      })
      expect(advanced.runner!.timeSeconds).toBeCloseTo(1.0, 12)
      expect(performance.now() - before).toBeLessThan(1_000)
      await expect(service.stop()).resolves.toMatchObject({ phase: 'stopped' })
    } finally {
      service.dispose()
    }
  }
)
