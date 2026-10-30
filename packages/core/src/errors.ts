// Errors that JS catches so one bad handler can't stop the others (event handlers, timers, effects, listeners).
// They go to native: logcat always, and the dev error screen in debug builds (`zn dev`, ARCHITECTURE §17).
// Apps can also hear them with onError (step 3.9), for example to send them to their backend; native apps can hook
// ZnRuntime.onJsError in Kotlin instead (it also gets the running bundle id, for Crashlytics).
import "./native"

/**
 * What was running when the error happened:
 * - "screen": building a screen (the user sees the error screen instead),
 * - "part": building a part of a screen (it stays empty; the rest of the screen works),
 * - "async": a Promise rejected and nothing caught it (an `async` function, a `.then` without `.catch`),
 * - "handler": a tap or other event handler, a timer, an effect, a listener.
 */
export type ErrorKind = "screen" | "part" | "async" | "handler"

export interface ErrorInfo {
  kind: ErrorKind
  /** Where, in words: `screen "amount"`, `event handler`, `timer callback`, ... */
  where: string
  /** The screen it belongs to: the one being built for "screen", else the top screen (null before the first one). */
  screen: string | null
}

type ErrorHandler = (error: unknown, info: ErrorInfo) => void

const handlers = new Set<ErrorHandler>()
let topScreen: () => string | null = () => null

/**
 * Hears every error JS caught and reported (they are logged either way). Returns a function that stops listening.
 * Keep handlers short and safe: an error thrown by a handler is only logged, never reported again.
 *
 *     onError((error, info) => {
 *       if (info.kind !== "handler") sendToBackend({ message: String(error), ...info })
 *     })
 */
export function onError(handler: ErrorHandler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** nav.ts tells which screen is on top (errors.ts can't import nav: nav imports this file). */
export function setTopScreen(fn: () => string | null): void {
  topScreen = fn
}

/** Reports [e], caught while running [what] ("event handler", "timer callback", ...). */
export function reportError(what: string, e: unknown, kind: ErrorKind = "handler", screen?: string): void {
  // Hermes' stack already starts with "Error: <message>"; add the message only when it doesn't.
  const stack = e instanceof Error ? (e.stack ?? "") : ""
  const details = e instanceof Error ? (stack.includes(e.message) ? stack : `${e.message}\n${stack}`) : String(e)
  if (typeof globalThis.__zn_error === "function") globalThis.__zn_error(`${what} threw`, details, kind)
  else console.error(`${what} threw: ${details}`)

  if (handlers.size === 0) return
  const info: ErrorInfo = { kind, where: what, screen: screen ?? topScreen() }
  for (const h of [...handlers]) {
    try {
      h(e, info)
    } catch (err) {
      globalThis.__zn_log(3, `onError handler threw (not reported again): ${String(err)}`)
    }
  }
}

/**
 * Turns on Hermes' tracking of rejected Promises nobody handles (off by default), so an error in `async` code is
 * reported like any other instead of vanishing. Hermes waits a moment before calling it unhandled (a `.catch` may
 * still be added): ~100 ms for TypeError / ReferenceError / RangeError, ~2 s for others.
 */
export function installRejectionTracking(): void {
  const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: (o: object) => void } }).HermesInternal
  if (typeof hermes?.enablePromiseRejectionTracker !== "function") return // not Hermes (tests), or a Hermes without it
  hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: (_id: number, error: unknown) => reportError("an async task (a Promise nobody caught)", error, "async"),
    onHandled: () => {},
  })
}
