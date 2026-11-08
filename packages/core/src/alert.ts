// Alert: React Native's Alert.alert, same arguments and meaning (Android). Native side: android/runtime/.../ZnAlert.kt.
//
//   Alert.alert("Cancel payment?", "The amount is not taken yet.", [
//     { text: "Keep", style: "cancel" },
//     { text: "Cancel payment", style: "destructive", onPress: cancelPayment },
//   ])
//
// Android shows up to 3 buttons, left to right in the order given. The alert stays open when the screen turns.
// `Alert.prompt` is iOS-only in React Native, so it is not here.
import { callNative } from "./calls"
import { reportError } from "./errors"

export interface AlertButton {
  text?: string
  /** `value` is for iOS prompts; Android never passes it. */
  onPress?: (value?: string) => void
  /** iOS only (Android draws every button the same); kept so RN code compiles as is. */
  style?: "default" | "cancel" | "destructive"
  /** iOS only. */
  isPreferred?: boolean
}

export interface AlertOptions {
  /** Back or a tap outside closes the alert (then `onDismiss` runs). Default false, as in RN on Android. */
  cancelable?: boolean
  onDismiss?: () => void
  /** iOS only. */
  userInterfaceStyle?: "unspecified" | "light" | "dark"
}

/** Android has places for 3 buttons (neutral, negative, positive). */
const MAX_BUTTONS = 3

export const Alert = {
  /**
   * Shows an alert and returns at once. The tapped button's `onPress` runs later. No buttons: one "OK" button. More
   * than 3: only the first 3 show (a warning is logged).
   */
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions): void {
    let list: AlertButton[] = buttons && buttons.length > 0 ? buttons : [{ text: "OK" }]
    if (list.length > MAX_BUTTONS) {
      globalThis.__zn_log(2, `Alert.alert: Android shows up to ${MAX_BUTTONS} buttons; the other ${list.length - MAX_BUTTONS} are left out`)
      list = list.slice(0, MAX_BUTTONS)
    }
    // As in RN: the last button (positive) is "OK" when it has no text; the others are empty.
    const texts = list.map((b, i) => (b.text ? String(b.text) : i === list.length - 1 ? "OK" : ""))
    const args = {
      title: title == null ? "" : String(title),
      message: message == null ? null : String(message),
      buttons: texts,
      // iOS draws cancel and destructive buttons its own way (Android draws them all the same and ignores this).
      styles: list.map((b) => b.style ?? "default"),
      cancelable: options?.cancelable === true,
    }
    callNative<{ index: number }>("Alert", "show", { ...args, __v: 1 }, { owned: false }).then(
      (answer) => {
        const button = answer && answer.index >= 0 ? list[answer.index] : undefined
        try {
          if (button) button.onPress?.()
          else options?.onDismiss?.()
        } catch (err) {
          reportError(button ? "Alert button onPress" : "Alert onDismiss", err)
        }
      },
      (err) => globalThis.__zn_log(2, `Alert.alert: not shown: ${err instanceof Error ? err.message : String(err)}`),
    )
  },
}
