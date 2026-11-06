// setTimeout / setInterval on top of native timers (ARCHITECTURE §14).
//
// Rules (v0 "zombie timer" lesson):
// - The handle returned to JS never changes for the life of the timer; setInterval keeps one handle.
// - clearTimeout / clearInterval always win, even over a fire that is already queued. Native drops queued fires of
//   cleared timers too (core/src/runtime.cpp); this side also forgets the callback.
// - An error in a callback is logged and never stops other timers.
// - A timer created while an owner is active (a screen, a component, an event handler of one) is cleared when that
//   owner is disposed: closing a screen stops its timers (ARCHITECTURE §14). Timers created outside any owner
//   (module level) live until cleared. A setTimeout made in an event handler belongs to the screen, not to the tapped
//   part; a setInterval made there stays with the part (signals.ts oneShotOwner).
import { reportError } from "./errors"
import "./native"
import { getOwner, onCleanup, oneShotOwner, runWithOwner, type Owner } from "./signals"

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
    reportError("timer callback", e)
  }
}

function forget(handle: number): void {
  callbacks.get(handle)?.owned?.delete(handle)
  callbacks.delete(handle)
}

function register(handle: number, fn: Callback, repeat: boolean): number {
  // A timeout ends by itself: from a tap it belongs to the screen, so it still fires if the tapped part went away (a
  // countdown started by a button that then hid itself). An interval never ends by itself: it stays with the part, so
  // taps on a screen that stays open can't pile intervals up (signals.ts oneShotOwner).
  const owner = repeat ? getOwner() : oneShotOwner()
  let owned: Set<number> | null = null
  if (owner && !owner.disposed) {
    owned = byOwner.get(owner) ?? null
    if (!owned) {
      const set = new Set<number>()
      owned = set
      byOwner.set(owner, set)
      runWithOwner(owner, () =>
        onCleanup(() => {
          byOwner.delete(owner)
          for (const h of [...set]) clearTimeout(h)
        }),
      )
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

/**
 * React Native's requestAnimationFrame, for code that waits "until after this frame". JS doesn't draw here, so it is a
 * timer of about one frame (16 ms), not a real frame callback, and like any timer it stops when its screen closes.
 * The callback gets the time in ms (`__zn_now`), like `performance.now()`. Don't animate with it: use `animate`.
 */
export function requestAnimationFrame(fn: (time: number) => void): number {
  return setTimeout(() => fn(globalThis.__zn_now()), 16)
}

export const cancelAnimationFrame = clearTimeout

/** Number of live timers (for tests and leak checks). */
export function activeTimerCount(): number {
  return callbacks.size
}

/**
 * React Native's setImmediate (RN-compat sweep P1.17): [fn] runs soon, after the current work. A 0 ms timer here, so
 * like other timers it stops with its screen.
 */
export function setImmediate<A extends unknown[]>(fn: (...args: A) => void, ...args: A): number {
  return setTimeout(() => fn(...args), 0)
}

export function clearImmediate(handle: number | undefined | null): void {
  clearTimeout(handle)
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
  g.requestAnimationFrame = requestAnimationFrame
  g.cancelAnimationFrame = cancelAnimationFrame
  g.setImmediate = setImmediate
  g.clearImmediate = clearImmediate
}
