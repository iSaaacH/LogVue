import { describe, expect, it } from 'vitest'
import { keyboardSnapshot } from '../src/renderer/hooks/useKeyboardGamepad'
describe('Pinkbacks keyboard gamepad', () => {
  it('maps movement and mechanism keys onto the shared controller mapping', () => {
    const frame = keyboardSnapshot(new Set(['KeyW', 'KeyA', 'KeyQ', 'Space', 'KeyI', 'KeyK', 'KeyT', 'KeyX']), true)
    expect(frame.connected).toBe(true)
    expect(frame.axes.rightStickY).toBeLessThan(0)
    expect(frame.axes.rightStickX).toBeLessThan(0)
    expect(frame.axes.leftStickX).toBeLessThan(0)
    expect(frame.buttons.rightBumper).toBe(true)
    expect(frame.buttons.dpadDown).toBe(true)
    expect(frame.axes.leftTrigger).toBe(1)
    expect(frame.axes.rightTrigger).toBe(1)
    expect(frame.buttons.x).toBe(true)
  })
  it('opposing movement keys cancel', () => {
    const frame = keyboardSnapshot(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE']), true)
    expect(frame.axes.rightStickY).toBe(0)
    expect(frame.axes.rightStickX).toBe(0)
    expect(frame.axes.leftStickX).toBe(0)
  })
  it('inactive focus always publishes a neutral frame even with held keys', () => {
    const frame = keyboardSnapshot(new Set(['KeyW', 'KeyK', 'Space']), false)
    expect(frame.connected).toBe(false)
    expect(Object.values(frame.axes).every(value => value === 0)).toBe(true)
    expect(Object.values(frame.buttons).every(value => value === false)).toBe(true)
  })
})
