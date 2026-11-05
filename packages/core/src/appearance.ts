// colorScheme(), scheme() and onLowMemory(): how the phone is set, and when it is short of memory. Guide: docs/guide-notes.md §37
//
//   <Box style={{ backgroundColor: scheme("#FFFFFF", "#121212") }} />      // follows the phone's dark mode
//   onLowMemory(() => cache.clear())
//
// Native sends the scheme right after the main script runs, before any screen is built, and on each change.
import { APP, AppEvent } from "./app-events"
import { reportError } from "./errors"
import { onEvent } from "./events"
import { getOwner, onCleanup, signal } from "./signals"

export type ColorScheme = "light" | "dark"

const current = signal<ColorScheme>("light")
const memoryListeners = new Set<() => void>()
const schemeListeners = new Set<(scheme: ColorScheme) => void>()

/** The phone's setting now. Reading it inside JSX makes that value follow changes. */
export function colorScheme(): ColorScheme {
  return current()
}

/** [light] or [dark], by the phone's setting. Only props that can change at runtime can use it (docs/guide-notes.md §37). */
export function scheme<T>(light: T, dark: T): T {
  return current() === "dark" ? dark : light
}

/**
 * Calls [listener] when Android asks the app to free memory. Drop what can be made again. Returns a function that stops
 * listening; while a screen is being built, it stops by itself when the screen closes.
 */
export function onLowMemory(listener: () => void): () => void {
  memoryListeners.add(listener)
  const off = () => void memoryListeners.delete(listener)
  if (getOwner()) onCleanup(off)
  return off
}

/**
 * Calls [listener] when the phone's setting changes (React Native's Appearance.addChangeListener, rn.ts). Returns a
 * function that stops listening; while a screen is being built, it stops by itself when the screen closes.
 */
export function onColorSchemeChange(listener: (scheme: ColorScheme) => void): () => void {
  schemeListeners.add(listener)
  const off = () => void schemeListeners.delete(listener)
  if (getOwner()) onCleanup(off)
  return off
}

/** Called by startApp. */
export function installAppearance(): void {
  onEvent(APP, AppEvent.ColorScheme, (payload) => {
    const next: ColorScheme = payload === "dark" ? "dark" : "light"
    if (next === current.peek()) return
    current.set(next)
    for (const listener of [...schemeListeners]) {
      try {
        listener(next)
      } catch (err) {
        reportError("Appearance listener", err)
      }
    }
  })
  onEvent(APP, AppEvent.LowMemory, () => {
    for (const listener of [...memoryListeners]) {
      try {
        listener()
      } catch (err) {
        reportError("onLowMemory handler", err)
      }
    }
  })
}
