// The image viewer's JS side: a full-screen native screen ("imageviewer.full") that shows one or more pictures with
// pinch zoom, pan, double tap and swipes. Native side: android/.../ImageViewerScreen.kt. No side effects at import:
// nativeModule() only creates a handle.
import { nativeModule, nav } from "@zero-native/core"

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
}

/**
 * The native module. It also makes a bundle that opens the viewer need this plugin: an app without it never runs the
 * bundle (docs/plugins.md D3). The screen belongs to it. Version 2: `hold`, for `data:` links and headers.
 */
export const ImageViewerNative = nativeModule<ImageViewerModule>("ImageViewer", { version: 2 })

/** In the params, in place of a `data:` link given natively. ViewerRules.HELD_DATA says the same. */
export const HELD_DATA = "held:data"

/** The screen's name. The app's route uses it: `native: "imageviewer.full"`. */
export const IMAGE_VIEWER_SCREEN = "imageviewer.full"

/** The route `open` uses when you don't name one. */
export const DEFAULT_ROUTE = "imageViewer"

/**
 * One picture. Links that load: https, `asset:<path>` (a picture in the bundle), `zn://file/<name>` (a file a plugin
 * made), `content://` (from a picker or another app), `file://` inside the app's own folders only, and
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
      if (held.length === 0) {
        answer = push(route, params) // at once, in the same tick as the tap
      } else {
        // data: links and headers go native first, by key; then the screen opens and finds them there.
        const key = `iv-${Date.now().toString(36)}-${++holds}`
        answer = ImageViewerNative.hold({ key, items: held }).then(() => push(route, { ...params, held: key }))
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

/** Opens the screen. A route that isn't the viewer throws, with the line to add to routes.ts. */
function push(route: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    // The app's route table types pushForResult's name; this package can't see it, so it names the route as text.
    return (nav.pushForResult as (name: string, params?: Record<string, unknown>) => Promise<unknown>)(route, params)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    const hint = why.includes("not a native screen") || why.includes("unknown route")
      ? `. Add to routes.ts: ${route}: { path: "/image-viewer", native: "${IMAGE_VIEWER_SCREEN}", safeArea: "none", transition: "fade" }`
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
