// AbortController / AbortSignal (the web standard shape) for Hermes, which doesn't have them. Used to cancel native
// calls (calls.ts) and, later, fetch. Installed only when the engine has none (Bun tests use their own).
import { reportError } from "./errors"


type AbortListener = (event: { type: "abort" }) => void

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
    this.onabort?.(event)
    for (const l of [...this.listeners]) {
      try {
        l(event)
      } catch (e) {
        reportError("abort listener", e)
      }
    }
    this.listeners.clear()
  }
}

class ZnAbortController {
  readonly signal = new ZnAbortSignal()
  abort(reason: unknown = new Error("aborted")): void {
    this.signal._abort(reason)
  }
}

export function installAbort(): void {
  const g = globalThis as any
  if (typeof g.AbortController === "undefined") {
    g.AbortController = ZnAbortController
    g.AbortSignal = ZnAbortSignal
  }
}
