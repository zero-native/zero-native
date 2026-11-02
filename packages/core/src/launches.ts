// The result of another app a plugin opened (a payment app, the phone number hint). Native side:
// android/runtime/.../ZnLaunch.kt. Guide: docs/guide-notes.md §31.
//
//   const saved = launches.pending("upi")               // while a screen is built, even right after a kill
//   launches.onResult("upi", async (r) => {
//     await verifyWithServer(r)
//     await launches.ack("upi", r.id)                   // only now: until then it comes again at every start
//   })
//
// The record is on disk until ack, so a kill or a rollback at any point loses nothing. Expect repeats. The data comes
// from another app: it is outside input, and it never proves that money moved. Only your server does.
import { nativeModule } from "./calls"
import { reportError } from "./errors"
import { createStorage } from "./storage"

export interface LaunchRecord {
  key: string
  /** The id the launch was given, so a repeat can be told from a new one. */
  id: string
  /** "waiting": the other app is open. "lost": no result came (the app was swiped, say): ask your server. */
  status: "waiting" | "result" | "lost"
  /** With a result: Android's result code (-1 OK, 0 cancelled), the link it sent back, and its simple extras. */
  resultCode?: number
  data?: string | null
  extras?: Record<string, string | number | boolean>
}

interface LaunchesModule {
  ack(args: { key: string; id: string }): Promise<boolean>
  events: { result: LaunchRecord }
}

const Native = nativeModule<LaunchesModule>("Launches", { version: 1 })
const store = createStorage("zn.launch")

function pending(key: string): LaunchRecord | null {
  const raw = store.getString(`launch.record.${key}`)
  return raw === undefined ? null : (JSON.parse(raw) as LaunchRecord)
}

export const launches = {
  /** The record of [key], or null. A sync read that clears nothing, right from the first screen of a restored app. */
  pending,

  /**
   * Calls [handler] with a result or "lost", also for one already saved when this is called, and again after each start
   * until it is acked. Each record comes once per listener. Called while a screen is built, it stops with the screen.
   */
  onResult(key: string, handler: (record: LaunchRecord) => void): () => void {
    const seen = new Set<string>()
    const deliver = (r: LaunchRecord) => {
      const mark = `${r.id}\u0000${r.status}`
      if (r.key !== key || r.status === "waiting" || seen.has(mark)) return
      seen.add(mark)
      try {
        handler(r)
      } catch (err) {
        reportError("launches.onResult handler", err)
      }
    }
    const off = Native.on("result", deliver)
    const saved = pending(key)
    if (saved) void Promise.resolve().then(() => deliver(saved))
    return off
  },

  /** Clears the record after you acted on it. False if [id] isn't the record's: an old screen can't clear a new launch. */
  ack: (key: string, id: string): Promise<boolean> => Native.ack({ key, id }),
}
