// The TSX viewer's open / close (registry 24; ImageViewer module 3). ImageViewer.open keeps the viewer's options here
// in JS, under a key, and pushes the app's route with only that key: no size limit, nothing saved by Android (the
// route has restore: false). The screen (ImageViewerScreen.tsx) reads them with viewerFor and answers with finishViewer.
import { nav, onCleanup } from "@zero-native/core"

/** A box in the window (dp): the thumbnail the photo flies from and back to. */
export interface ViewerRect {
  x: number
  y: number
  width: number
  height: number
}

/** What the screen shows, checked and with defaults (index.ts viewerParts made it). */
export interface ViewerOptions {
  images: { uri: string; alt?: string }[]
  index: number
  swipeToClose: boolean
  doubleTap: boolean
  backgroundColor: string
  closeLabel: string
  errorText: string
  retryLabel: string
  photoLabel: string
  nextLabel: string
  previousLabel: string
  /** The key of the parts held natively (data: links, headers), if any. */
  held?: string
  from?: ViewerRect
}

interface Open {
  options: ViewerOptions
  answer: (r: { index: number } | null) => void
}

const open = new Map<string, Open>()
let made = 0

/** Shows [options] on [route]; gives `{ index }` when the user closes it, null when the app took it away. */
export function openTsx(route: string, options: ViewerOptions): Promise<{ index: number } | null> {
  const key = `v${Date.now().toString(36)}-${++made}`
  let answer: (r: { index: number } | null) => void = () => {}
  const done = new Promise<{ index: number } | null>((resolve) => (answer = resolve))
  open.set(key, { options, answer })
  try {
    // The app's route table types push's names; this package can't see it, so it names the route as text.
    // A missing route throws here, at the caller (not inside the promise), so ImageViewer.open can add the hint.
    ;(nav.push as (name: string, params?: Record<string, unknown>) => void)(route, { v: key })
  } catch (e) {
    open.delete(key)
    throw e
  }
  return done
}

/** The options of viewer [key], for its screen. When the screen goes (the app called nav.back()), it answers null. */
export function viewerFor(key: string | undefined): ViewerOptions | null {
  const o = key === undefined ? undefined : open.get(key)
  if (!o) return null
  onCleanup(() => finishViewer(key, null))
  return o.options
}

/** The user closed viewer [key] (its close animation has played): answer, and leave the screen. null: it is already gone. */
export function finishViewer(key: string | undefined, result: { index: number } | null): void {
  const o = key === undefined ? undefined : open.get(key)
  if (key !== undefined) open.delete(key)
  if (!o) return
  o.answer(result)
  if (result !== null) nav.back()
}

/** @internal Tests only. */
export function resetOpenForTests(): void {
  open.clear()
}
