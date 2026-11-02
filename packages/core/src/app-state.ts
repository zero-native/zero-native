// appState() and onAppState(): is the user in this app right now? (docs/guide-notes.md §29)
//
//   onAppState((state) => {
//     if (state === "active") checkPaymentStatus() // back from a UPI app, even if it sent no result
//   })
//
// "active": the user can touch the app. "background": they can't: another app or a see-through window is on top, or the
// phone is locked. Native sends it when the Activity resumes and pauses, so a see-through payment window counts too,
// though Android doesn't stop the app for one. JS doesn't run less in the background: this is only information.
import { APP, AppEvent } from "./app-events"
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { getOwner, onCleanup, signal } from "./signals"

export type AppState = "active" | "background"

// A start with no screens (a push, a background job) stays "background" until the user opens the app.
const current = signal<AppState>("background")
const listeners = new Set<(state: AppState) => void>()

/** The state now. Reading it inside JSX makes that value follow changes. */
export function appState(): AppState {
  return current()
}

/**
 * Calls [listener] each time the state changes, not for the state at the start. Returns a function that stops it. Called
 * while a screen is being built, it stops by itself when the screen closes.
 */
export function onAppState(listener: (state: AppState) => void): () => void {
  listeners.add(listener)
  const off = () => void listeners.delete(listener)
  if (getOwner()) onCleanup(off)
  return off
}

/** App-level event 11 on instance 0 (android/runtime/.../ZnAppState.kt). Called by startApp. */
export function installAppState(): void {
  onEvent(APP, AppEvent.AppState, (payload: NativeValue) => {
    const next: AppState = String(payload) === "active" ? "active" : "background"
    if (next === current.peek()) return
    current.set(next)
    for (const listener of [...listeners]) {
      try {
        listener(next)
      } catch (err) {
        reportError("onAppState handler", err)
      }
    }
  })
}

/** Native's START: screens open only for an Activity coming to the front, so this is no change to report. */
export function appStarting(): void {
  current.set("active")
}

export function resetAppStateForTests(): void {
  listeners.clear()
  current.set("background")
}
