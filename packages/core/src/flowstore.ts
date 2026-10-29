// FlowStore from JS (ARCHITECTURE §13): a crash-safe store for a few records that must never be lost, like a pending
// payment (milestone 2 step 2.7). Use the save-then-verify pattern in docs/guide-notes.md §16. Each key is its own
// file of at least 64 KB, so this is not a settings store. Native side: core/src/flowstore.cpp.
//
// Every call is synchronous on the JS thread (a memory copy into a memory-mapped file: a few microseconds), so code
// can write "I'm about to do X" and be sure it is saved before it does X. Values are JSON.

export type StoreRead<T> = { status: "ok"; value: T } | { status: "missing" } | { status: "broken" }

declare global {
  // eslint-disable-next-line no-var
  var __zn_store_write: (key: string, json: string) => boolean
  var __zn_store_read: (key: string) => string | null | false
  var __zn_store_list: () => string[]
  var __zn_store_remove: (key: string) => boolean
}

export const flowStore = {
  /** Saves [value] (as JSON) under [key]. False if it could not be saved (too big, disk error): then don't act. */
  write(key: string, value: unknown): boolean {
    return globalThis.__zn_store_write(key, JSON.stringify(value))
  },

  /** "missing": never written; "broken": the file is damaged in both copies (quarantine it). */
  read<T = unknown>(key: string): StoreRead<T> {
    const raw = globalThis.__zn_store_read(key)
    if (raw === null) return { status: "missing" }
    if (raw === false) return { status: "broken" }
    try {
      return { status: "ok", value: JSON.parse(raw) as T }
    } catch {
      return { status: "broken" }
    }
  },

  list(): string[] {
    return globalThis.__zn_store_list()
  },

  remove(key: string): boolean {
    return globalThis.__zn_store_remove(key)
  },
}
