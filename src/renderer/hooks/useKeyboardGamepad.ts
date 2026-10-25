import { useEffect, useRef } from 'react'
import { neutralBrowserGamepad } from './useBrowserGamepads'
import type { SimulationGamepadSnapshot } from '@shared/types/simulation'

export const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'KeyI', 'KeyK', 'KeyX', 'KeyT'])

/** Pinkbacks retains its right-stick translation / left-stick rotation mapping. */
export function keyboardSnapshot(keys: ReadonlySet<string>, active: boolean): SimulationGamepadSnapshot {
  const frame = neutralBrowserGamepad()
  if (!active) return frame
  frame.connected = true
  frame.id = 'Keyboard'
  frame.mapping = 'standard'
  frame.timestamp = Date.now()
  const axis = (positive: string, negative: string): number => Number(keys.has(positive)) - Number(keys.has(negative))
  frame.axes.rightStickY = axis('KeyS', 'KeyW') * 0.65
  frame.axes.rightStickX = axis('KeyD', 'KeyA') * 0.65
  frame.axes.leftStickX = axis('KeyE', 'KeyQ') * 0.65
  frame.axes.leftTrigger = Number(keys.has('KeyI'))
  frame.axes.rightTrigger = Number(keys.has('KeyK'))
  frame.buttons.rightBumper = keys.has('Space')
  frame.buttons.x = keys.has('KeyX')
  frame.buttons.dpadDown = keys.has('KeyT')
  return frame
}

/** Focus, visibility, session end, and window blur all release held keys. */
export function useKeyboardGamepad(active: boolean): {
  read: () => SimulationGamepadSnapshot
  onFocus: () => void
  onBlur: () => void
  press: (code: string) => void
  release: (code: string) => void
} {
  const keys = useRef(new Set<string>())
  const focused = useRef(false)
  useEffect(() => {
    keys.current.clear()
    if (!active) return
    const release = (): void => { keys.current.clear(); focused.current = false }
    const down = (event: KeyboardEvent): void => {
      if (!focused.current || !DRIVE_KEYS.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      keys.current.add(event.code)
    }
    const up = (event: KeyboardEvent): void => { keys.current.delete(event.code) }
    const visibility = (): void => { if (document.hidden) release() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      release()
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [active])
  return {
    read: () => keyboardSnapshot(keys.current, active && focused.current && !document.hidden),
    onFocus: () => { focused.current = true },
    onBlur: () => { focused.current = false; keys.current.clear() },
    press: (code) => { if (active && focused.current && DRIVE_KEYS.has(code)) keys.current.add(code) },
    release: (code) => { keys.current.delete(code) }
  }
}
