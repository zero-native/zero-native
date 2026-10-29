// Errors that JS catches so one bad handler can't stop the others (event handlers, timers, effects, listeners).
// They go to native: logcat always, and the dev error screen in debug builds (`zn dev`, ARCHITECTURE §17).
import "./native"

/** Reports [e], caught while running [what] ("event handler", "timer callback", ...). */
export function reportError(what: string, e: unknown): void {
  // Hermes' stack already starts with "Error: <message>"; add the message only when it doesn't.
  const stack = e instanceof Error ? (e.stack ?? "") : ""
  const details = e instanceof Error ? (stack.includes(e.message) ? stack : `${e.message}\n${stack}`) : String(e)
  if (typeof globalThis.__zn_error === "function") globalThis.__zn_error(`${what} threw`, details)
  else console.error(`${what} threw: ${details}`)
}
