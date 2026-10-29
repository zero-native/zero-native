// @zero-native/core: the JS side of the runtime.
import { installConsole } from "./log"
import { installEvents } from "./events"
import { installTimers } from "./timers"

export * from "./native"
export { parseColor } from "./color"
export { batch, computed, createRoot, effect, onCleanup, signal, untrack, type Signal } from "./signals"
export { component, each, on, ready, renderRoot, slot, SlotKind, str, view, when, type Instance, type View } from "./view"
export { onEvent } from "./events"
export { setTimeout, setInterval, clearTimeout, clearInterval, activeTimerCount } from "./timers"

/** Installs console, timers and event dispatch on the global object. Call once, first thing in the bundle. */
export function installRuntime(): void {
  installConsole()
  installTimers()
  installEvents()
}
