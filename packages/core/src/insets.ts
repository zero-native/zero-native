// insets(): the safe-area insets in dp (ARCHITECTURE §11, docs/styling-and-layout.md §6). Read-only.
//
// Most screens never need it: native keeps each screen clear of the system bars per route (`safeArea`). A
// full-bleed screen (`safeArea: { top: false }`, a coloured header behind the status bar) reads `insets().top` to pad
// its own header. Native sends new values only when they change (start, rotation, cutout), as an app-level event.
// Until the first value arrives they are 0.
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { signal } from "./signals"

export interface Insets {
  top: number
  bottom: number
  start: number
  end: number
}

const same = (a: Insets, b: Insets) => a.top === b.top && a.bottom === b.bottom && a.start === b.start && a.end === b.end
const current = signal<Insets>({ top: 0, bottom: 0, start: 0, end: 0 }, { equals: same })

/** The safe-area insets in dp. Reading it inside JSX makes that value follow changes (rotation). */
export function insets(): Insets {
  return current()
}

/** App-level event id 5 on instance 0 (android/runtime/.../ZnNav.kt). Called by startApp. */
export function installInsets(): void {
  onEvent(0, 5, (payload: NativeValue) => {
    const v = JSON.parse(String(payload)) as Partial<Insets>
    current.set({ top: v.top ?? 0, bottom: v.bottom ?? 0, start: v.start ?? 0, end: v.end ?? 0 })
  })
}
