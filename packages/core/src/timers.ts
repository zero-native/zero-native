// setTimeout / setInterval on top of native timers (ARCHITECTURE §14).
//
// Rules (v0 "zombie timer" lesson):
// - The handle returned to JS never changes for the life of the timer; setInterval keeps one handle.
// - clearTimeout / clearInterval always win, even over a fire that is already queued. Native drops queued fires of
//   cleared timers too (core/src/runtime.cpp); this side also forgets the callback.
// - An error in a callback is logged and never stops other timers.
import "./native"

type Callback = () => void

const callbacks = new Map<number, { fn: Callback; repeat: boolean }>()

function onTimer(handle: number): void {
  const entry = callbacks.get(handle)
  if (!entry) return
  if (!entry.repeat) callbacks.delete(handle)
  try {
    entry.fn()
  } catch (e) {
    globalThis.__zn_log(3, `timer callback threw: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
  }
}

export function setTimeout(fn: Callback, delayMs = 0): number {
  const handle = globalThis.__zn_setTimer(Math.max(0, delayMs || 0), false)
  callbacks.set(handle, { fn, repeat: false })
  return handle
}

export function setInterval(fn: Callback, intervalMs = 0): number {
  const handle = globalThis.__zn_setTimer(Math.max(1, intervalMs || 0), true)
  callbacks.set(handle, { fn, repeat: true })
  return handle
}

export function clearTimeout(handle: number | undefined | null): void {
  if (handle == null) return
  callbacks.delete(handle)
  globalThis.__zn_clearTimer(handle)
}

export const clearInterval = clearTimeout

/** Number of live timers (for tests and leak checks). */
export function activeTimerCount(): number {
  return callbacks.size
}

/** `replaceGlobals: false` only wires native fires (used by tests running under Bun's own timers). */
export function installTimers(options: { replaceGlobals?: boolean } = {}): void {
  globalThis.__zn_onTimer = onTimer
  if (options.replaceGlobals === false) return
  const g = globalThis as any
  g.setTimeout = setTimeout
  g.setInterval = setInterval
  g.clearTimeout = clearTimeout
  g.clearInterval = clearInterval
}
