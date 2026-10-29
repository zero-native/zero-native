// setTimeout / setInterval on top of native timers (ARCHITECTURE §14).
//
// Rules (v0 "zombie timer" lesson):
// - The handle returned to JS never changes for the life of the timer; setInterval keeps one handle.
// - clearTimeout / clearInterval always win, even over a fire that is already queued. Native drops queued fires of
//   cleared timers too (core/src/runtime.cpp); this side also forgets the callback.
// - An error in a callback is logged and never stops other timers.
// - A timer created while an owner is active (a screen, a component, an event handler of one) is cleared when that
//   owner is disposed: closing a screen stops its timers (ARCHITECTURE §14). Timers created outside any owner
//   (module level) live until cleared.
import "./native"
import { getOwner, onCleanup, type Owner } from "./signals"

type Callback = () => void

const callbacks = new Map<number, { fn: Callback; repeat: boolean; owned: Set<number> | null }>()
/** Live timer handles per owner; one cleanup per owner clears them all. */
const byOwner = new WeakMap<Owner, Set<number>>()

function onTimer(handle: number): void {
  const entry = callbacks.get(handle)
  if (!entry) return
  if (!entry.repeat) forget(handle)
  try {
    entry.fn()
  } catch (e) {
    globalThis.__zn_log(3, `timer callback threw: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
  }
}

function forget(handle: number): void {
  callbacks.get(handle)?.owned?.delete(handle)
  callbacks.delete(handle)
}

function register(handle: number, fn: Callback, repeat: boolean): number {
  const owner = getOwner()
  let owned: Set<number> | null = null
  if (owner && !owner.disposed) {
    owned = byOwner.get(owner) ?? null
    if (!owned) {
      const set = new Set<number>()
      owned = set
      byOwner.set(owner, set)
      onCleanup(() => {
        byOwner.delete(owner)
        for (const h of [...set]) clearTimeout(h)
      })
    }
    owned.add(handle)
  }
  callbacks.set(handle, { fn, repeat, owned })
  return handle
}

export function setTimeout(fn: Callback, delayMs = 0): number {
  return register(globalThis.__zn_setTimer(Math.max(0, delayMs || 0), false), fn, false)
}

export function setInterval(fn: Callback, intervalMs = 0): number {
  return register(globalThis.__zn_setTimer(Math.max(1, intervalMs || 0), true), fn, true)
}

export function clearTimeout(handle: number | undefined | null): void {
  if (handle == null) return
  forget(handle)
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
