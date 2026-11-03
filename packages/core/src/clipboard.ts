// Clipboard: the text calls of @react-native-clipboard/clipboard, same names and meaning. Native side:
// android/runtime/.../ZnClipboard.kt.
//
//   Clipboard.setString(upiId)
//   const text = await Clipboard.getString()
//
// Android 10+ lets an app read the clipboard only while it is on screen with focus; at other times getString gives ""
// and hasString false.
import { callNative } from "./calls"

export const Clipboard = {
  /** Copies [text]. Returns at once; a failure is only logged. */
  setString(text: string): void {
    if (typeof text !== "string") throw new TypeError("Clipboard.setString: text must be a string")
    callNative("Clipboard", "setString", { text, __v: 1 }, { owned: false }).catch((err) =>
      globalThis.__zn_log(2, `Clipboard.setString failed: ${err instanceof Error ? err.message : String(err)}`),
    )
  },

  /** The copied text, or "" when there is none (or Android won't let the app read it now). */
  getString: () => callNative<string>("Clipboard", "getString", { __v: 1 }, { owned: false }),

  /** True when something is copied and it is text. */
  hasString: () => callNative<boolean>("Clipboard", "hasString", { __v: 1 }, { owned: false }),
}
