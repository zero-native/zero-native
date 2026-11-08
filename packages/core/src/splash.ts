// Splash: keep Android's launch screen up a little longer at start, while the app gets its first screen ready.
// Native side: android/runtime/.../ZnSplash.kt (the app must call ZnSplash.holdUntilReady in its Activity).
//
//   // In a first screen's build, at a QR-link start:
//   Splash.holdUntil(init(), { maxMs: 400 })
//
// The splash then stays until `init()` settles, or `maxMs` after the first screens are up, whichever comes first.
// The Activity's hold limit (holdUntilReady's capMs) still wins. Too late (the splash already went, or the app doesn't
// hold it): nothing happens. A push or replace made while it is held comes in with no slide, so the first thing the
// user sees is the final screen.
import { callNative } from "./calls"

let next = 0

// "unavailable": an app built before Splash (2026-11-07). The splash just isn't held, so say nothing. Splash is a soft
// core module: bundles don't require it, so an older app runs new bundles (compiler/src/modules.ts, B4).
const failed = (what: string) => (err: unknown) => {
  if ((err as { code?: unknown } | null)?.code === "unavailable") return
  globalThis.__zn_log(2, `Splash.${what} failed: ${err instanceof Error ? err.message : String(err)}`)
}

export const Splash = {
  /** Holds the splash until [work] settles (resolved or rejected), at most [maxMs] after the first screens are up. */
  holdUntil(work: Promise<unknown>, options: { maxMs: number }): void {
    const maxMs = options?.maxMs
    if (typeof maxMs !== "number" || !Number.isFinite(maxMs) || maxMs < 0) {
      throw new TypeError("Splash.holdUntil: maxMs must be a number of ms, 0 or more")
    }
    const id = ++next
    callNative("Splash", "hold", { id, maxMs: Math.round(maxMs), __v: 1 }, { owned: false }).catch(failed("holdUntil"))
    const release = () => {
      callNative("Splash", "release", { id, __v: 1 }, { owned: false }).catch(failed("release"))
    }
    // One JS turn later: a nav.replace / push made when the work settled goes to native at the end of this turn, and it
    // must be on the stack before the splash lifts, or Home shows for a frame and the new screen slides in.
    const later = () => void setTimeout(release, 0)
    Promise.resolve(work).then(later, later)
  },
}
