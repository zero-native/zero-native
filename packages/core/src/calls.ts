// Calls to native modules (ARCHITECTURE §15.1): the transport only. `callNative("module", "method", args)` returns a
// Promise; native runs the call off the JS and UI threads (android/runtime/.../ZnModules.kt) and answers with app
// event 7 (instance 0) `{ id, ok, value | error }`. Arguments and results are plain JSON. Neither thread ever waits.
// Typed module declarations, codegen, native → JS module events: see docs/native-modules.md (designed, not built).
import { onEvent } from "./events"
import type { NativeValue } from "./native"

const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let nextId = 1

export function callNative<T = unknown>(module: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    try {
      globalThis.__zn_call(module, method, JSON.stringify(args), id)
    } catch (e) {
      pending.delete(id)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

function onResult(payload: NativeValue): void {
  const r = JSON.parse(String(payload)) as { id: number; ok: boolean; value?: unknown; error?: string }
  const p = pending.get(r.id)
  if (!p) return
  pending.delete(r.id)
  if (r.ok) p.resolve(r.value ?? null)
  else p.reject(new Error(r.error ?? "native call failed"))
}

/** Number of calls still waiting for native (for tests and leak checks). */
export function pendingCallCount(): number {
  return pending.size
}

export function installCalls(): void {
  onEvent(0, 7, onResult)
}
