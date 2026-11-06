// AbortController / AbortSignal (the web standard shape) for Hermes, which doesn't have them. Used to cancel native
// calls (calls.ts) and fetch (fetch.ts). Installed only when the engine has none (Bun tests use their own).
// Also: a small DOMException (Hermes has none) so abort reasons have the web names "AbortError" / "TimeoutError",
// which libraries check, and useAbortSignal() for requests that should stop when the screen closes.
import { reportError } from "./errors"
import { onCleanup, oneShotOwner, runWithOwner } from "./signals"

type AbortListener = (event: { type: "abort" }) => void

/** The web's DOMException, as far as apps use it: an Error with a `name` ("AbortError", "TimeoutError", ...). */
class ZnDOMException extends Error {
  constructor(message = "", name = "Error") {
    super(message)
    this.name = name
  }
}

function domException(message: string, name: string): Error {
  const D = (globalThis as any).DOMException ?? ZnDOMException
  return new D(message, name)
}

class ZnAbortSignal {
  aborted = false
  reason: unknown = undefined
  onabort: AbortListener | null = null
  private listeners = new Set<AbortListener>()

  addEventListener(type: string, listener: AbortListener): void {
    if (type === "abort") this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: AbortListener): void {
    if (type === "abort") this.listeners.delete(listener)
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason
  }

  /** Internal: called by the controller. */
  _abort(reason: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    const event = { type: "abort" as const }
    try {
      this.onabort?.(event)
    } catch (e) {
      reportError("abort listener", e)
    }
    for (const l of [...this.listeners]) {
      try {
        l(event)
      } catch (e) {
        reportError("abort listener", e)
      }
    }
    this.listeners.clear()
  }

  /** A signal that is already aborted. */
  static abort(reason: unknown = domException("This operation was aborted", "AbortError")): ZnAbortSignal {
    const s = new ZnAbortSignal()
    s._abort(reason)
    return s
  }

  /** A signal that aborts after `ms` with a "TimeoutError" reason. */
  static timeout(ms: number): ZnAbortSignal {
    const s = new ZnAbortSignal()
    setTimeout(() => s._abort(domException("The operation timed out", "TimeoutError")), ms)
    return s
  }

  /** A signal that aborts as soon as any of `signals` does, with that signal's reason. */
  static any(signals: Iterable<AbortSignal>): ZnAbortSignal {
    const s = new ZnAbortSignal()
    const list = [...signals]
    const done = list.find((x) => x.aborted)
    if (done) {
      s._abort(done.reason)
      return s
    }
    const onAbort = (from: AbortSignal) => () => {
      s._abort(from.reason)
      for (const x of list) x.removeEventListener("abort", stops.get(x)!)
    }
    const stops = new Map<AbortSignal, () => void>()
    for (const x of list) {
      const stop = onAbort(x)
      stops.set(x, stop)
      x.addEventListener("abort", stop)
    }
    return s
  }
}

class ZnAbortController {
  readonly signal = new ZnAbortSignal()
  abort(reason: unknown = domException("This operation was aborted", "AbortError")): void {
    this.signal._abort(reason)
  }
}

/**
 * An AbortSignal that aborts when the current screen (or component) closes. Call it while the screen is being set up:
 *
 *   const signal = useAbortSignal()
 *   effect(() => { fetch(`/offers?page=${page()}`, { signal }).then(...) })
 *
 * Use it for requests whose answer only this screen needs. Don't use it for payments or saves: those must finish.
 */
export function useAbortSignal(): AbortSignal {
  const controller = new AbortController()
  // In a tap handler: the screen's, not the tapped part's (signals.ts oneShotOwner), as the request it aborts
  const owner = oneShotOwner()
  if (owner) runWithOwner(owner, () => onCleanup(() => controller.abort(domException("The screen closed", "AbortError"))))
  return controller.signal
}

export function installAbort(): void {
  const g = globalThis as any
  if (typeof g.DOMException === "undefined") g.DOMException = ZnDOMException
  if (typeof g.AbortController === "undefined") {
    g.AbortController = ZnAbortController
    g.AbortSignal = ZnAbortSignal
  }
}
