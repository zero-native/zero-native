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

/** The most JSON one key can hold, in UTF-8 bytes: 256 KB less a 16-byte header (core/include/zn/flowstore.h). */
const MAX_BYTES = 256 * 1024 - 16
/** Above this a write still works, but it is half way to the limit: say so once per key, before it fails. */
const WARN_BYTES = 128 * 1024
const warned = new Set<string>()

/** UTF-8 length of [s] without making the bytes. */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

export const flowStore = {
  /** The most one key can hold: 262,128 bytes of JSON (UTF-8). A bigger write returns false and keeps the old value. */
  MAX_BYTES,

  /**
   * Saves [value] (as JSON) under [key]. False if it could not be saved (too big, disk error): then don't act.
   * Over 128 KB it logs a warning once per key: keep flow state small, and put big data in Storage by id.
   */
  write(key: string, value: unknown): boolean {
    const json = JSON.stringify(value)
    // Each UTF-16 unit is at most 3 bytes, so short JSON needs no count.
    if (json.length * 3 > WARN_BYTES && !warned.has(key)) {
      const bytes = utf8Length(json)
      if (bytes > WARN_BYTES) {
        warned.add(key)
        globalThis.__zn_log(
          2,
          `flowStore "${key}": ${bytes} bytes, over half the ${MAX_BYTES}-byte limit. Keep flow state small (big data in storage, by id)`,
        )
      }
    }
    return globalThis.__zn_store_write(key, json)
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
