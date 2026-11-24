// The image viewer's JS side. Since registry 24 (module 3) the screen is TSX (ImageViewerScreen.tsx) on a `transparent`
// route, with zero-native's gestures; each photo is the native view "imageviewer.page" (ViewerPage.kt). An app whose
// route still says `native: "imageviewer.full"` gets the old Compose screen until it is removed. No side effects at
// import: nativeModule() only creates a handle.
import { nativeModule, nav, type ElementMotion } from "@zeronative/core"
import { openTsx, type ViewerOptions, type ViewerRect } from "./open"

export type { ViewerRect } from "./open"

/** One picture's parts that must not go in the route's params: a `data:` link (big) or request headers (a token). */
export interface HeldItem {
  /** The picture's place in `images`. */
  i: number
  data?: string
  headers?: Record<string, string>
}

export interface ImageViewerModule {
  /** Keeps [items] in native memory under [key], for the screen. Not in the params: Android saves those, with a size limit. */
  hold(args: { key: string; items: HeldItem[] }): Promise<boolean>
  /** Version 3: frees what [key] holds (the TSX screen calls it when it closes; the old screen frees its own). */
  release(args: { key: string }): Promise<boolean>
}

/**
 * The native module. It also makes a bundle that opens the viewer need this plugin: an app without it never runs the
 * bundle (docs/plugins.md D3). The screen belongs to it. Version 2: `hold`, for `data:` links and headers. Version 3
 * (registry 24): the view "imageviewer.page" the TSX screen draws each photo with.
 */
export const ImageViewerNative = nativeModule<ImageViewerModule>("ImageViewer", { version: 3 })

/** In the params, in place of a `data:` link given natively. ViewerRules.HELD_DATA says the same. */
export const HELD_DATA = "held:data"

/** The screen's name. The app's route uses it: `native: "imageviewer.full"`. */
export const IMAGE_VIEWER_SCREEN = "imageviewer.full"

/** The route `open` uses when you don't name one. */
export const DEFAULT_ROUTE = "imageViewer"

/**
 * One picture. Links that load: https, `asset:<path>` (a picture in the bundle), `zn://file/<name>` (a file a plugin
 * made), `content://` (Android only: from a picker or another app; iOS refuses it, use a `zn://file` handle or `file://`), `file://` inside the app's own folders only, and
 * `data:image/...;base64,` up to 5 MB. `uri` is react-native-image-viewing's name, `url` is
 * react-native-image-zoom-viewer's. `alt` is what TalkBack reads. `headers` go with an https request (a login token);
 * they stay in memory, never in the saved params, and are never logged.
 */
export type ImageSource =
  | string
  | { uri: string; alt?: string; headers?: Record<string, string> }
  | { url: string; alt?: string; headers?: Record<string, string> }

export interface ImageViewerOptions {
  images: ImageSource[]
  /** The picture to start on, from 0. react-native-image-viewing's name. Default 0. */
  imageIndex?: number
  /** The same as `imageIndex` (react-native-image-zoom-viewer's name). `imageIndex` wins if both are given. */
  index?: number
  /** Swipe up or down to close. Default true. */
  swipeToCloseEnabled?: boolean
  /** Double tap zooms in, and out again. Default true. */
  doubleTapToZoomEnabled?: boolean
  /** As "#RRGGBB". Default black. */
  backgroundColor?: string
  /** TalkBack's name for the close button. Default "Close". */
  closeLabel?: string
  /** Under a picture that didn't load. Default "Couldn't load this photo". */
  errorText?: string
  /** The button under it. Default "Try again". */
  retryLabel?: string
  /** TalkBack's name for a picture with no `alt`. `{n}` and `{count}` are filled in. Default "Photo {n} of {count}". */
  photoLabel?: string
  /** TalkBack actions that move between pictures. Defaults "Next photo" and "Previous photo". */
  nextLabel?: string
  previousLabel?: string
  /** The app's route for the viewer. Default "imageViewer". */
  route?: string
  /**
   * The thumbnail that was tapped (registry 24): `useElementMotion()` bound on it with `motion={m}`, or its box in the
   * window (dp). The photo flies from it on open and back into it on close (drag down, Back, the close button), while
   * the backdrop fades. Without it, the viewer fades in and out.
   */
  from?: ElementMotion | ViewerRect
}

/** What `open` gives when the user closes the viewer: the picture that was on screen. */
export interface ImageViewerResult {
  index: number
}

const TEXTS = ["closeLabel", "errorText", "retryLabel", "photoLabel", "nextLabel", "previousLabel", "backgroundColor"] as const

/**
 * The screen's params and the parts to hold natively, from [options], checked. Throws for a list with no pictures or a
 * picture with no link: those are bugs in the app, not something to show. The start index is kept inside the list.
 * A `data:` link and headers go to `held`; the params only say `"held:data"` in the link's place.
 */
export function viewerParts(options: Omit<ImageViewerOptions, "route">): { params: Record<string, unknown>; held: HeldItem[] } {
  if (!Array.isArray(options?.images) || options.images.length === 0) throw new Error("ImageViewer: images must be a list with at least one picture")
  const held: HeldItem[] = []
  const images = options.images.map((source, i) => {
    const uri = typeof source === "string" ? source : (source as { uri?: unknown })?.uri ?? (source as { url?: unknown })?.url
    if (typeof uri !== "string" || uri.length === 0) throw new Error(`ImageViewer: images[${i}] has no uri`)
    const alt = typeof source === "object" && typeof source.alt === "string" ? source.alt : undefined
    const headers = typeof source === "object" ? textHeaders((source as { headers?: unknown }).headers) : undefined
    const data = /^data:/i.test(uri)
    if (data || headers) held.push({ i, ...(data ? { data: uri } : {}), ...(headers ? { headers } : {}) })
    const shown = data ? HELD_DATA : uri
    return alt === undefined ? { uri: shown } : { uri: shown, alt }
  })
  const wanted = Number(options.imageIndex ?? options.index ?? 0)
  const index = Number.isFinite(wanted) ? Math.min(images.length - 1, Math.max(0, Math.trunc(wanted))) : 0
  const params: Record<string, unknown> = { images, index }
  if (options.swipeToCloseEnabled === false) params.swipeToClose = false
  if (options.doubleTapToZoomEnabled === false) params.doubleTap = false
  for (const key of TEXTS) if (typeof options[key] === "string") params[key] = options[key]
  return { params, held }
}

/** The screen's params only (see [viewerParts]). */
export function viewerParams(options: Omit<ImageViewerOptions, "route">): Record<string, unknown> {
  return viewerParts(options).params
}

/** Only text values; undefined when none. Native checks names and values again (no line breaks). */
function textHeaders(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object") return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string") out[k] = v
  return Object.keys(out).length > 0 ? out : undefined
}

let holds = 0

/** The viewer opened by `open` that is still on screen: a second tap on a thumbnail gets the same one. */
let showing: Promise<ImageViewerResult | null> | null = null

export const ImageViewer = {
  /**
   * Opens the viewer on top of the current screen. Gives `{ index }` when the user closes it (the close button, a swipe,
   * Back), and null if the app closed it (`nav.back()`, `nav.reset()`). If the app is killed while it is open, this
   * promise is gone, like any `nav.pushForResult`: the viewer only shows pictures, so nothing is lost.
   */
  open(options: ImageViewerOptions): Promise<ImageViewerResult | null> {
    if (showing) return showing
    const route = options?.route ?? DEFAULT_ROUTE
    let answer: Promise<unknown>
    try {
      const { params, held } = viewerParts(options)
      const key = held.length === 0 ? undefined : `iv-${Date.now().toString(36)}-${++holds}`
      // data: links and headers go native first, by key; then the screen opens and the pages find them there.
      const hold = key === undefined ? null : ImageViewerNative.hold({ key, items: held })
      const withKey = key === undefined ? params : { ...params, held: key }
      const from = options.from
      const measured = from !== undefined && from !== null && "measure" in from && typeof from.measure === "function"
      if (hold === null && !measured) {
        answer = show(route, withKey, key, (from ?? undefined) as ViewerRect | undefined) // at once, in the same tick as the tap
      } else {
        const box = measured ? (from as ElementMotion).measure().catch(() => undefined) : Promise.resolve(from as ViewerRect | undefined)
        answer = Promise.all([hold, box]).then(([, rect]) => show(route, withKey, key, rect))
      }
    } catch (e) {
      return Promise.reject(e)
    }
    const done = answer.then(
      (r) => {
        showing = null
        return toResult(r)
      },
      (e) => {
        showing = null
        throw e
      },
    )
    showing = done
    return done
  },
}

/** The TSX screen's options, with defaults, from viewerParts' params. */
function tsxOptions(params: Record<string, unknown>, held: string | undefined, from: ViewerRect | undefined): ViewerOptions {
  const text = (k: string, d: string) => (typeof params[k] === "string" ? (params[k] as string) : d)
  return {
    images: params.images as { uri: string; alt?: string }[],
    index: params.index as number,
    swipeToClose: params.swipeToClose !== false,
    doubleTap: params.doubleTap !== false,
    backgroundColor: text("backgroundColor", "#000000"),
    closeLabel: text("closeLabel", "Close"),
    errorText: text("errorText", "Couldn't load this photo"),
    retryLabel: text("retryLabel", "Try again"),
    photoLabel: text("photoLabel", "Photo {n} of {count}"),
    nextLabel: text("nextLabel", "Next photo"),
    previousLabel: text("previousLabel", "Previous photo"),
    ...(held !== undefined ? { held } : {}),
    ...(from !== undefined && [from.x, from.y, from.width, from.height].every(Number.isFinite) && from.width > 0 && from.height > 0 ? { from } : {}),
  }
}

/**
 * Opens the screen: the old native one if the route says `native` (an app not moved yet), else the TSX one. A route
 * that isn't in routes.ts throws, with the line to add.
 */
function show(route: string, params: Record<string, unknown>, held: string | undefined, from: ViewerRect | undefined): Promise<unknown> {
  try {
    try {
      // The app's route table types pushForResult's name; this package can't see it, so it names the route as text.
      return (nav.pushForResult as (name: string, params?: Record<string, unknown>) => Promise<unknown>)(route, params)
    } catch (e) {
      // Not native (or not there at all): the TSX screen. nav.push says if the route is missing.
      if (!(e instanceof Error && e.message.includes("not a native screen"))) throw e
      const shown = openTsx(route, tsxOptions(params, held, from))
      // However it ends (closed, nav.back(), the screen gone), free the data: bytes and the headers (login tokens).
      if (held !== undefined) {
        const free = () => void ImageViewerNative.release({ key: held }).catch(() => {})
        shown.then(free, free)
      }
      return shown
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    const hint = why.includes("unknown route")
      ? `. Add to routes.ts: ${route}: { path: "/image-viewer", screen: ImageViewerScreen, transparent: true, accessibilityHidesBelow: true, safeArea: "none", statusBar: "light", restore: false } (ImageViewerScreen from "@zeronative/image-viewer/screen")`
      : ""
    throw new Error(`ImageViewer.open: ${why}${hint}`)
  }
}

function toResult(value: unknown): ImageViewerResult | null {
  if (value === null || typeof value !== "object") return null
  const index = Number((value as { index?: unknown }).index)
  return { index: Number.isFinite(index) ? index : 0 }
}

/** @internal Tests only. */
export function resetImageViewerForTests(): void {
  showing = null
}
