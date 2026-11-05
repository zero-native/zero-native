// An <OtpInput>'s handle, as react-native-otp-entry's ref: focus(), blur(), clear(), setValue(code) (registry 18,
// docs/guide-notes.md §62).
//
//   const otp = createRef<OtpInputHandle>()
//   <OtpInput ref={otp} numberOfDigits={4} onFilled={verify} />
//   const r = await Auth.listenForOtp(); if (r.code) otp.current?.setValue(r.code)
//
// focus / blur / clear go to the hidden field through the Keyboard module, as a TextField's ref does. setValue goes
// through a value slot as "n\u0001code": native fills the boxes and sends onChangeText and onFilled, as RN's setValue
// does. The number makes the same code sent twice count twice.
import { keyboardNative } from "./keyboard"
import { onCleanup, signal } from "./signals"
import type { Ref } from "./text-field"
import type { Instance } from "./view"
import { slot } from "./view"

export interface OtpInputHandle {
  /** Focuses the hidden field and opens the keyboard. */
  focus(): void
  /** Takes focus away (closes the keyboard if no other field takes it). */
  blur(): void
  /** Empties the boxes. onTextChange("") follows. */
  clear(): void
  /** Fills the boxes (the SMS auto-read): cut to numberOfDigits; then onTextChange, and onFilled when every box is full. */
  setValue(code: string): void
}

/** Compiler output for `<OtpInput ref={r}>`: [id] is its ref event, [valueSlot] carries setValue to native. */
export function otpRef(inst: Instance, id: number, valueSlot: number, ref: Ref<OtpInputHandle> | null | undefined): void {
  const pending = signal("")
  slot(inst, valueSlot, () => pending())
  if (ref == null) return
  if (typeof ref !== "object" || !("current" in ref)) {
    throw new TypeError("ref: pass an object made by createRef(), e.g. const r = createRef<OtpInputHandle>()")
  }
  let n = 0
  const args = { inst: inst.id, id }
  // RN's methods return nothing: a failure (the boxes are gone) is only logged.
  const send = (p: Promise<unknown>, what: string) =>
    void p.catch((err) => globalThis.__zn_log(2, `OtpInput ${what}: ${String((err as Error)?.message ?? err)}`))
  const handle: OtpInputHandle = {
    focus: () => send(keyboardNative.focus(args), "focus()"),
    blur: () => send(keyboardNative.blur(args), "blur()"),
    clear: () => send(keyboardNative.clear(args), "clear()"),
    setValue: (code: string) => pending.set(`${++n}\u0001${String(code ?? "")}`),
  }
  ref.current = handle
  onCleanup(() => {
    if (ref.current === handle) ref.current = null
  })
}
