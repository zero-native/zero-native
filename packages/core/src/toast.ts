// Toast API (milestone 3 step 3.7): short transient message shown above the bottom insets.
// Native side: android/runtime/.../ZnToast.kt.
import { callNative } from "./calls"

export interface ToastOptions {
  duration?: "short" | "long"
}

/** Shows a transient toast message above the navigation bar and keyboard. */
export function toast(message: string, options: ToastOptions = {}): void {
  if (typeof message !== "string") throw new TypeError("toast: message must be a string")
  const duration = options.duration ?? "short"
  if (duration !== "short" && duration !== "long") {
    throw new TypeError(`toast: duration must be "short" or "long" (got ${JSON.stringify(duration)})`)
  }
  callNative("Toast", "show", { message, duration, __v: 1 }, { owned: false })
}

/**
 * React Native's `ToastAndroid` (RN basics pack), on top of toast(). The toast is zero-native's own: it sits above the
 * navigation bar and the keyboard and survives navigation. The gravity and offsets of showWithGravity are ignored.
 */
export const ToastAndroid = {
  SHORT: 0,
  LONG: 1,
  TOP: 0,
  BOTTOM: 1,
  CENTER: 2,

  show(message: string, duration: number): void {
    toast(message, { duration: duration === ToastAndroid.LONG ? "long" : "short" })
  },

  showWithGravity(message: string, duration: number, _gravity: number): void {
    ToastAndroid.show(message, duration)
  },

  showWithGravityAndOffset(message: string, duration: number, _gravity: number, _xOffset: number, _yOffset: number): void {
    ToastAndroid.show(message, duration)
  },
}

