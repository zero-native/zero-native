// SecureStore (docs/storage.md): small secrets (auth tokens, refresh tokens, an encryption key) encrypted with a key
// held in the Android Keystore. Native side: android/runtime/.../ZnSecureStore.kt.
//
//   await SecureStore.set("refreshToken", token)
//   const token = await SecureStore.get("refreshToken")   // null if missing or no longer readable
//
// Async (each call goes to the system Keystore service, a few ms), and not tied to the screen: a save started on a
// screen still finishes and answers after the screen closes. A value can become unreadable for good (the Keystore key
// was lost); then get() returns null, so always handle "no token" as "sign in again".
//
// "Can't right now" is different (2026-11-06): a busy or not-ready Keystore (some Android 7-9 phones) rejects with code
// "temporarily_unavailable" after native tried 3 times, and the value is kept. Don't sign the user out on it:
//
//   try { token = await SecureStore.get("refreshToken") }
//   catch (e) { if (SecureStore.isTemporary(e)) return showRetry()  /* + a "Log in again" button */ ; throw e }
import { callNative, NativeError } from "./calls"

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("SecureStore: key must be a non-empty string")
}

const call = <T>(method: string, args: Record<string, unknown>) =>
  callNative<T>("SecureStore", method, { ...args, __v: 1 }, { owned: false })

export const SecureStore = {
  /**
   * The saved string, or null if there is none (or it can never be decrypted again). Rejects with code
   * "temporarily_unavailable" when the Keystore or the file can't be used right now: the value is kept, try again
   * ([isTemporary]).
   */
  async get(key: string): Promise<string | null> {
    checkKey(key)
    return (await call<string | null>("get", { key })) ?? null
  },

  /** Saves `value` (a string, at most 64 KB). Resolves once it is on disk; "temporarily_unavailable" keeps the old value. */
  async set(key: string, value: string): Promise<void> {
    checkKey(key)
    if (typeof value !== "string") throw new TypeError("SecureStore.set: value must be a string (use JSON.stringify)")
    await call("set", { key, value })
  },

  async delete(key: string): Promise<void> {
    checkKey(key)
    await call("delete", { key })
  },

  /**
   * True for "can't right now, the value is kept" from get() or set(): try again later, and never treat it as "no
   * token". An app made before this (or an APK older than 2026-11-06) never gets it.
   */
  isTemporary(error: unknown): boolean {
    return error instanceof NativeError && error.code === "temporarily_unavailable"
  },
}
