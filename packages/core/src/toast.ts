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

