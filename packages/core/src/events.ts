// Native → JS events (taps, text changes, ...). Native calls __zn_onEvent(instance, eventId, payload).
// Step 1.1: handlers are registered by hand. From step 1.3 the compiler registers them from the template's event
// table (ARCHITECTURE §6.1).
import { reportError } from "./errors"
import type { NativeValue } from "./native"

type Handler = (payload: NativeValue) => void

const handlers = new Map<string, Handler>()
const key = (instance: number, eventId: number) => `${instance}:${eventId}`

export function onEvent(instance: number, eventId: number, handler: Handler): () => void {
  const k = key(instance, eventId)
  // App events (instance 0) have one owner each (app-events.ts); a second one would silently take its events.
  if (instance === 0 && handlers.has(k) && handlers.get(k) !== handler) {
    globalThis.__zn_log(3, `app event ${eventId} already has a handler; the new one replaces it (two parts of the runtime use one number?)`)
  }
  handlers.set(k, handler)
  return () => {
    if (handlers.get(k) === handler) handlers.delete(k)
  }
}

function dispatch(instance: number, eventId: number, payload: NativeValue): void {
  const handler = handlers.get(key(instance, eventId))
  if (!handler) {
    globalThis.__zn_log(2, `no handler for event ${eventId} on instance ${instance}`)
    return
  }
  try {
    handler(payload)
  } catch (e) {
    reportError("event handler", e)
  }
}

/** Tests only: forget every handler (another test file's startApp left its own). */
export function resetEventsForTests(): void {
  handlers.clear()
}

export function installEvents(): void {
  globalThis.__zn_onEvent = dispatch
}
