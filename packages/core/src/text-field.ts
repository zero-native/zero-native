// A <TextField>'s handle: focus(), blur(), clear(), isFocused() (RN basics pack; docs/guide-notes.md §39).
//
//   const code = createRef<TextFieldHandle>()
//   <TextField ref={code} keyboardType="number-pad" maxLength={4} ... />
//   <Pressable onPress={() => code.current?.focus()}>...</Pressable>
//
// React Native's `useRef<TextInput>(null)` becomes `createRef<TextFieldHandle>()`: a screen body runs once, so a plain
// object does what useRef does. The compiler turns `ref={r}` into fieldRef(...) below: native gave the field an event
// id, and focus changes come back on it. `r.current` is null until the field is built and again after it is gone.
import { keyboardNative } from "./keyboard"
import type { NativeValue } from "./native"
import { onCleanup } from "./signals"
import type { Instance } from "./view"
import { on } from "./view"

export interface Ref<T> {
  current: T | null
}

/** A ref for `ref={...}`. Make it in a screen body or a component, once per field (an array of them for a list). */
export function createRef<T>(): Ref<T> {
  return { current: null }
}

export interface TextFieldHandle {
  /** Focuses the field and opens the keyboard. */
  focus(): void
  /** Takes focus away (closes the keyboard if no other field takes it). */
  blur(): void
  /** Empties the field. onChangeText("") follows, as if the user deleted the text. */
  clear(): void
  /** True while the field has focus. */
  isFocused(): boolean
}

/** Compiler output for `<TextField ref={r}>`: [id] is the field's ref event. */
export function fieldRef(inst: Instance, id: number, ref: Ref<TextFieldHandle> | null | undefined): void {
  if (ref == null) return
  if (typeof ref !== "object" || !("current" in ref)) {
    throw new TypeError("ref: pass an object made by createRef(), e.g. const r = createRef<TextFieldHandle>()")
  }
  let focused = false
  const args = { inst: inst.id, id }
  // RN's methods return nothing: a failure (the field is gone) is only logged.
  const send = (p: Promise<unknown>, what: string) =>
    void p.catch((err) => globalThis.__zn_log(2, `TextField ${what}: ${String((err as Error)?.message ?? err)}`))
  const handle: TextFieldHandle = {
    focus: () => send(keyboardNative.focus(args), "focus()"),
    blur: () => send(keyboardNative.blur(args), "blur()"),
    clear: () => send(keyboardNative.clear(args), "clear()"),
    isFocused: () => focused,
  }
  on(inst, id, (payload: NativeValue) => {
    focused = payload === true
  })
  ref.current = handle
  onCleanup(() => {
    if (ref.current === handle) ref.current = null
  })
}
