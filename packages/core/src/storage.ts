// App storage (ARCHITECTURE §13.1, docs/storage.md): MMKV underneath (core/src/storage.cpp), synchronous on the JS
// thread. A read or write is a memory operation on a mapped file (microseconds), so there are no Promises:
//
//   if (!storage.getBoolean("onboarded")) nav.replace("welcome")
//   storage.set("lastStore", storeId)
//
// - Values keep their type: what you save as a number comes back as a number. Reading it with another typed getter
//   (getString on a number) is a TypeError, never a wrong value.
// - A `set` survives the app being killed as soon as it returns; `flush()` makes it survive a power cut too.
//   Not in backups: a new phone starts empty (docs/storage.md says why).
// - Not for secrets (tokens, PINs): use SecureStore (encrypted with a key in the Android Keystore).
// - Not for payment state that must not be lost: use FlowStore and the save-then-verify pattern (guide-notes §16).
import { getOwner, onCleanup, signal, type Signal } from "./signals"
import { byteRange } from "./text"

declare global {
  // eslint-disable-next-line no-var
  var __zn_kv_set: (id: string, key: string, value: string | number | boolean | ArrayBuffer, offset?: number, length?: number) => boolean
  var __zn_kv_get: (id: string, key: string) => string | number | boolean | ArrayBuffer | undefined
  var __zn_kv_has: (id: string, key: string) => boolean
  var __zn_kv_delete: (id: string, key: string) => boolean
  var __zn_kv_keys: (id: string) => string[]
  var __zn_kv_clear: (id: string) => void
  var __zn_kv_flush: (id: string) => void
}

export type StoredValue = string | number | boolean | Uint8Array

/** `key` is the key that changed, or null when the whole store was cleared. */
export type StorageListener = (key: string | null) => void

export interface Storage {
  /** The store's id (its file name). */
  readonly id: string
  /** Saves `value`. Throws if it could not be saved (disk full): then the old value is still there. */
  set(key: string, value: StoredValue | ArrayBuffer | ArrayBufferView): void
  /** The value with the type it was saved with, or undefined. */
  get(key: string): StoredValue | undefined
  getString(key: string): string | undefined
  getNumber(key: string): number | undefined
  getBoolean(key: string): boolean | undefined
  getBytes(key: string): Uint8Array | undefined
  has(key: string): boolean
  delete(key: string): void
  keys(): string[]
  /** Removes every key of this store. */
  clear(): void
  /**
   * Forces this store to flash. Every `set` already survives the app being killed; `flush()` also makes it survive
   * a power cut or a hard reboot right after. Costs milliseconds: call it after an important write, not after each.
   */
  flush(): void
  /** Called after every set / delete / clear made from JS. Returns the unsubscribe function; also ends with the screen. */
  onChange(listener: StorageListener): () => void
}

const ID = /^[A-Za-z0-9._-]{1,64}$/

function checkKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("storage: a key must be a non-empty string")
  return key
}

class ZnStorage implements Storage {
  private listeners = new Set<StorageListener>()

  constructor(readonly id: string) {}

  set(key: string, value: StoredValue | ArrayBuffer | ArrayBufferView): void {
    checkKey(key)
    let ok: boolean
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      ok = globalThis.__zn_kv_set(this.id, key, value)
    } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const [buffer, offset, length] = byteRange(value)
      ok = globalThis.__zn_kv_set(this.id, key, buffer, offset, length)
    } else {
      throw new TypeError(
        `storage: "${key}" must be a string, number, boolean or bytes, got ${value === null ? "null" : typeof value}. ` +
          "Use delete() to remove a key; use JSON.stringify for objects (or persistedSignal).",
      )
    }
    if (!ok) throw new Error(`storage: could not save "${key}" in "${this.id}" (disk full?)`)
    this.notify(key)
  }

  get(key: string): StoredValue | undefined {
    const v = globalThis.__zn_kv_get(this.id, checkKey(key))
    return v instanceof ArrayBuffer ? new Uint8Array(v) : v
  }

  getString(key: string): string | undefined {
    return this.typed(key, "string")
  }

  getNumber(key: string): number | undefined {
    return this.typed(key, "number")
  }

  getBoolean(key: string): boolean | undefined {
    return this.typed(key, "boolean")
  }

  getBytes(key: string): Uint8Array | undefined {
    const v = this.get(key)
    if (v === undefined || v instanceof Uint8Array) return v
    throw new TypeError(`storage: "${key}" in "${this.id}" holds a ${typeof v}, not bytes`)
  }

  has(key: string): boolean {
    return globalThis.__zn_kv_has(this.id, checkKey(key))
  }

  delete(key: string): void {
    globalThis.__zn_kv_delete(this.id, checkKey(key))
    this.notify(key)
  }

  keys(): string[] {
    return globalThis.__zn_kv_keys(this.id)
  }

  clear(): void {
    globalThis.__zn_kv_clear(this.id)
    this.notify(null)
  }

  flush(): void {
    globalThis.__zn_kv_flush(this.id)
  }

  onChange(listener: StorageListener): () => void {
    this.listeners.add(listener)
    const off = () => {
      this.listeners.delete(listener)
    }
    if (getOwner()) onCleanup(off)
    return off
  }

  private typed<T>(key: string, type: "string" | "number" | "boolean"): T | undefined {
    const v = this.get(key)
    if (v === undefined) return undefined
    if (typeof v !== type) {
      const what = v instanceof Uint8Array ? "bytes" : `a ${typeof v}`
      throw new TypeError(`storage: "${key}" in "${this.id}" holds ${what}, not a ${type}`)
    }
    return v as T
  }

  private notify(key: string | null): void {
    for (const l of [...this.listeners]) l(key)
  }
}

const stores = new Map<string, ZnStorage>()

/**
 * A store with its own file, e.g. one per signed-in user (`createStorage(\`user.${userId}\`)`) so signing out can
 * `clear()` it. `id`: 1–64 characters from A-Z a-z 0-9 . _ -. The same id always gives the same object.
 */
export function createStorage(id: string): Storage {
  if (!ID.test(id)) throw new TypeError(`storage: id "${id}" must be 1-64 characters from A-Z a-z 0-9 . _ -`)
  let s = stores.get(id)
  if (!s) stores.set(id, (s = new ZnStorage(id)))
  return s
}

/** The app's default store. */
export const storage: Storage = createStorage("zn.default")

/**
 * A signal whose value is kept in storage (as JSON): it starts with the saved value (or `initial`), and every
 * `set` saves at once. For preferences and drafts: `const lang = persistedSignal("lang", "en")`.
 * A saved value that isn't valid JSON (changed by other code) is ignored, with a warning.
 */
export function persistedSignal<T>(key: string, initial: T, options: { storage?: Storage } = {}): Signal<T> {
  const store = options.storage ?? storage
  let start = initial
  const saved = store.get(key)
  if (typeof saved === "string") {
    try {
      start = JSON.parse(saved) as T
    } catch {
      globalThis.__zn_log(2, `persistedSignal: "${key}" in "${store.id}" is not JSON; starting from the default`)
    }
  }
  const s = signal<T>(start)
  const setSignal = s.set
  s.set = (next) => {
    setSignal(next)
    const value = s.peek()
    if (value === undefined) store.delete(key)
    else store.set(key, JSON.stringify(value))
  }
  return s
}
