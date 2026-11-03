// The keyboard (milestone 3 step 3.3; listeners and height: RN basics pack). Built-in native module:
// android/runtime/.../ZnKeyboard.kt. Shown / hidden and the height come as app event KEYBOARD (ZnWindow.kt).
//
//   Keyboard.dismiss()
//   const sub = Keyboard.addListener("keyboardDidShow", (e) => lift.set(e.endCoordinates.height))
//   sub.remove()
//
// As React Native on Android: "keyboardDidShow" and "keyboardDidHide" only (the "Will" events are iOS). Native sends
// one event per show or hide, when it starts. The height is dp from the bottom of the window. Routes with
// `keyboard: "resize"` (the default) already move their content up: listeners are for things drawn over the screen.
import { APP, AppEvent } from "./app-events"
import { nativeModule } from "./calls"
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { getOwner, onCleanup, signal } from "./signals"
import { Dimensions } from "./dimensions"

export interface KeyboardModule {
  /** Closes the keyboard and takes focus away from the focused <TextField> (it gets onBlur). */
  dismiss(): Promise<void>
}

/** The native module, v2: focus / blur / clear of one <TextField> by its ref (text-field.ts). */
interface KeyboardNative extends KeyboardModule {
  focus(args: { inst: number; id: number }): Promise<boolean>
  blur(args: { inst: number; id: number }): Promise<boolean>
  clear(args: { inst: number; id: number }): Promise<boolean>
}

export const keyboardNative = nativeModule<KeyboardNative>("Keyboard", { version: 2 })

export type KeyboardEventName = "keyboardDidShow" | "keyboardDidHide"

export interface KeyboardMetrics {
  screenX: number
  screenY: number
  width: number
  height: number
}

export interface KeyboardEvent {
  /** Where the keyboard ends up (dp). Hidden: height 0. */
  endCoordinates: KeyboardMetrics
  /** Android gives no timing: 0, as in React Native. */
  duration: number
  easing: "keyboard"
  isEventFromThisApp: boolean
}

interface State {
  visible: boolean
  height: number
}

const current = signal<State>({ visible: false, height: 0 }, { equals: (a, b) => a.visible === b.visible && a.height === b.height })
const listeners = new Map<KeyboardEventName, Set<(e: KeyboardEvent) => void>>()

function metricsOf(height: number): KeyboardMetrics {
  const window = Dimensions.get("window")
  return { screenX: 0, screenY: window.height - height, width: window.width, height }
}

export const Keyboard = {
  /** Closes the keyboard and takes focus away from the focused <TextField> (it gets onBlur). */
  dismiss(): Promise<void> {
    return keyboardNative.dismiss()
  },

  /**
   * Calls [listener] when the keyboard is shown or hidden. Returns `{ remove }`, as in React Native. Called while a
   * screen is being built, it stops by itself when the screen closes.
   */
  addListener(event: KeyboardEventName, listener: (e: KeyboardEvent) => void): { remove(): void } {
    if (event !== "keyboardDidShow" && event !== "keyboardDidHide") {
      // keyboardWillShow / WillHide / WillChangeFrame / DidChangeFrame: never sent on Android, as in React Native.
      globalThis.__zn_log(2, `Keyboard.addListener("${event}"): Android sends only keyboardDidShow and keyboardDidHide`)
      return { remove() {} }
    }
    let set = listeners.get(event)
    if (!set) listeners.set(event, (set = new Set()))
    const s = set
    s.add(listener)
    const remove = () => void s.delete(listener)
    if (getOwner()) onCleanup(remove)
    return { remove }
  },

  /** Stops every listener of [event]. */
  removeAllListeners(event: KeyboardEventName): void {
    listeners.get(event)?.clear()
  },

  /** True while the keyboard is shown. Reading it inside JSX makes that value follow changes. */
  isVisible(): boolean {
    return current().visible
  },

  /** Where the keyboard is (dp), or undefined while it is hidden. */
  metrics(): KeyboardMetrics | undefined {
    const s = current()
    return s.visible ? metricsOf(s.height) : undefined
  },
}

/** App-level event KEYBOARD. Called by installRuntime. */
export function installKeyboard(): void {
  onEvent(APP, AppEvent.Keyboard, (payload: NativeValue) => {
    const v = JSON.parse(String(payload)) as Partial<State>
    const next: State = { visible: v.visible === true, height: v.visible === true ? (v.height ?? 0) : 0 }
    const before = current.peek()
    if (before.visible === next.visible && before.height === next.height) return
    current.set(next)
    // A new height while shown (another keyboard, emoji panel) is a new "show", as in React Native.
    const name: KeyboardEventName = next.visible ? "keyboardDidShow" : "keyboardDidHide"
    const event: KeyboardEvent = { endCoordinates: metricsOf(next.height), duration: 0, easing: "keyboard", isEventFromThisApp: true }
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        listener(event)
      } catch (err) {
        reportError(`Keyboard ${name} listener`, err)
      }
    }
  })
}

export function resetKeyboardForTests(): void {
  listeners.clear()
  current.set({ visible: false, height: 0 })
}
