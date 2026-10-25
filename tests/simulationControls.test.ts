import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({ releaseLiveInputs: vi.fn(), failClose: vi.fn() }))
vi.mock('../src/main/services/simulation/service', () => ({ getSimulationService: () => service }))
vi.mock('../src/main/ipc/events', () => ({ emitIpcEvent: vi.fn() }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    static instances: BrowserWindow[] = []
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      id: BrowserWindow.instances.length + 1,
      setWindowOpenHandler: vi.fn()
    })
    restore = vi.fn()
    minimize = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    setAlwaysOnTop = vi.fn()
    constructor(public options = {}) { super(); BrowserWindow.instances.push(this) }
    isDestroyed() { return this.destroyed }
    async loadFile() { this.emit('ready-to-show') }
    async loadURL() { this.emit('ready-to-show') }
    close() { this.destroyed = true; this.emit('closed') }
  }
  return { BrowserWindow }
})

import { BrowserWindow } from 'electron'
import { closeSimulationControls, openSimulationControls, ownsSimulationInputs,
  pinSimulationControls, registerSimulationMainWindow, simulationControlsDetached } from '../src/main/simulationControls'

const instances = (): BrowserWindow[] => (BrowserWindow as unknown as { instances: BrowserWindow[] }).instances

describe('detached driving controls', () => {
  let main: BrowserWindow
  beforeEach(() => {
    closeSimulationControls()
    vi.clearAllMocks()
    main = new BrowserWindow()
    registerSimulationMainWindow(main)
  })

  it('transfers exclusive input ownership and returns it without stopping the session', async () => {
    expect(ownsSimulationInputs(main.webContents.id)).toBe(true)
    await openSimulationControls()
    const panel = instances().at(-1)!
    expect(simulationControlsDetached()).toBe(true)
    expect(ownsSimulationInputs(main.webContents.id)).toBe(false)
    expect(ownsSimulationInputs(panel.webContents.id)).toBe(true)
    expect(main.minimize).toHaveBeenCalled()
    expect(service.releaseLiveInputs).toHaveBeenCalledTimes(1)
    closeSimulationControls()
    expect(simulationControlsDetached()).toBe(false)
    expect(ownsSimulationInputs(main.webContents.id)).toBe(true)
    expect(service.releaseLiveInputs).toHaveBeenCalledTimes(2)
    expect(main.restore).toHaveBeenCalled()
    expect(service.failClose).not.toHaveBeenCalled()
  })

  it('reuses the panel and releases inputs on focus loss; renderer failure stops the session', async () => {
    await openSimulationControls()
    const panel = instances().at(-1)!, count = instances().length
    await openSimulationControls()
    expect(instances()).toHaveLength(count)
    pinSimulationControls(false)
    expect(panel.setAlwaysOnTop).toHaveBeenCalledWith(false)
    panel.emit('blur')
    expect(service.releaseLiveInputs).toHaveBeenCalledTimes(2)
    panel.webContents.emit('render-process-gone')
    expect(service.failClose).toHaveBeenCalledWith('driving controls renderer exited')
    expect(simulationControlsDetached()).toBe(false)
  })
})
