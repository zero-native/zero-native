// Vibration: React Native's Vibration, same arguments and meaning (Android). Native side:
// android/runtime/.../ZnVibration.kt.
//
//   Vibration.vibrate()                       // 400 ms
//   Vibration.vibrate(100)                    // 100 ms
//   Vibration.vibrate([0, 200, 100, 200])     // wait 0, buzz 200, wait 100, buzz 200
//   Vibration.vibrate([0, 500, 500], true)    // again and again, until Vibration.cancel()
//
// As in RN, the app must declare the permission in its AndroidManifest.xml:
//   <uses-permission android:name="android.permission.VIBRATE"/>
// Without it nothing vibrates and a warning is logged once.
import { callNative, NativeError } from "./calls"

let warnedNotDeclared = false

function send(method: string, args: Record<string, unknown>): void {
  callNative("Vibration", method, { ...args, __v: 1 }, { owned: false }).catch((err) => {
    if (err instanceof NativeError && err.code === "not_declared") {
      if (warnedNotDeclared) return
      warnedNotDeclared = true
    }
    globalThis.__zn_log(2, `Vibration.${method}: ${err instanceof Error ? err.message : String(err)}`)
  })
}

function check(ms: unknown): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new TypeError(`Vibration.vibrate: times must be numbers of ms, 0 or more (got ${String(ms)})`)
  }
  return Math.round(ms)
}

export const Vibration = {
  /**
   * A number: one buzz that long (ms; [repeat] is ignored, as in RN). An array: [wait, buzz, wait, buzz, ...] in ms;
   * [repeat] true plays it again from the start until `cancel()`. Returns at once.
   */
  vibrate(pattern: number | number[] = 400, repeat: boolean = false): void {
    let timings: number[]
    if (typeof pattern === "number") {
      timings = [0, check(pattern)]
      repeat = false
    } else if (Array.isArray(pattern)) {
      timings = pattern.map(check)
    } else {
      throw new TypeError("Vibration.vibrate: pattern must be a number or an array of numbers")
    }
    if (!timings.some((ms, i) => i % 2 === 1 && ms > 0)) return // no buzz in it: nothing to do
    send("vibrate", { pattern: timings, repeat: repeat === true })
  },

  /** Stops a vibration, a repeating one included. */
  cancel(): void {
    send("cancel", {})
  },
}

export function resetVibrationForTests(): void {
  warnedNotDeclared = false
}
