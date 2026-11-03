// The pdf plugin's JS side, without the components (PdfView.tsx). Native side: android/.../PdfModule.kt.
// No side effects: nativeModule() only creates a handle.
import { nativeModule, signal, type CallOptions } from "@zero-native/core"

/**
 * Why there is no PDF. network: no answer. http: the server said no (`httpStatus`). too_big: over `maxBytes`. not_pdf: the
 * answer was something else, like an error page. broken: the file can't be read. password: it needs a password (not
 * supported). no_space: the phone is full. not_allowed: not https (debug builds also take http to this computer).
 * not_found: no file for this handle (Android may clear the cache when it is short of space: download again).
 */
export type PdfReason = "network" | "http" | "too_big" | "not_pdf" | "broken" | "password" | "no_space" | "not_allowed" | "not_found" | "failed"

/** A PDF on the phone. `handle` goes to `<PdfView source>`; `uri` (`file://...`) goes in `FormData`. */
export interface PdfFile {
  handle: string
  uri: string
  size: number
  pages: number
  /** The first page's size, in PDF points (1/72 inch). */
  width: number
  height: number
  /** true: it was on the phone already, no network. */
  cached: boolean
}

export type PdfAnswer = ({ status: "ok" } & PdfFile) | { status: "failed"; reason: PdfReason; httpStatus?: number }

export interface PdfDownload {
  /** https only. Debug builds also take `http://localhost` and `http://127.0.0.1`. */
  url: string
  /** Sent with the request, never logged and never saved. */
  headers?: Record<string, string>
  /** Your own name for the file, like a receipt id. The file on disk is named from `url` + `key`. */
  key?: string
  /** Default 20 MB, at most 100 MB. */
  maxBytes?: number
}

export interface PdfNativeModule {
  /** Never rejects for a bad file or network: every failure is an answer with a reason. A second call for the same file joins the first. */
  download(args: PdfDownload, options?: CallOptions): Promise<PdfAnswer>
  /** Checks a `zn://file` handle you already have (from `Media.pickFile`, say) and gives its pages. `cached` is true. */
  open(args: { handle: string }): Promise<PdfAnswer>
  /** Deletes this plugin's files, not other plugins'. Default: older than 7 days. `0`: all, as at logout. `keep`: handles. */
  cleanup(args?: { olderThanMs?: number; keep?: string[] }): Promise<{ deleted: number; bytes: number }>
  /** Debug builds only: zooms a view to [scale] around its middle, for tests (adb can't pinch). */
  debugZoom(args: { view: string; scale: number }): Promise<boolean>
}

export const Pdf = nativeModule<PdfNativeModule>("Pdf", { version: 1 })

/** What a view says went wrong. page: one page failed to draw (the others still show). memory: a page was too big to draw. */
export interface PdfViewError {
  reason: "not_found" | "broken" | "password" | "page" | "memory" | "failed"
  /** For page and memory: which page, from 1. */
  page?: number
}

export interface PdfLoadInfo {
  /** Its id, for `Pdf.debugZoom`. */
  view: string
  pages: number
  /** The first page's size, in PDF points. */
  width: number
  height: number
}

export interface PdfViewProps {
  /** A `zn://file` handle, from `Pdf.download` or `Media.pickFile`. Nothing else: no paths, no URLs. */
  source: string | null | undefined
  /** Default 5, at most 10. 1: no zoom. */
  maxZoom?: number
  /** Space between pages, in dp. Default 16. */
  pageGap?: number
  /** Behind and between the pages. Default "#E5E7EB". */
  background?: string
  /** The page to start on, from 1. Default 1. Only read when a file opens. */
  initialPage?: number
  onLoad?: (info: PdfLoadInfo) => void
  /** The page in the middle of the view, from 1. Also once after `onLoad`. */
  onPageChange?: (page: number, total: number) => void
  /** After a pinch or a double tap settles. 1: not zoomed. */
  onZoom?: (scale: number) => void
  onError?: (error: PdfViewError) => void
}

export interface PdfPreviewProps {
  source: string | null | undefined
  /** From 1. Default 1. */
  page?: number
  /** width (default): as wide as the box, from the top, cut at the box's bottom. contain: the whole page in the box. */
  fit?: "width" | "contain"
  /** Around the page. Default "#FFFFFF". */
  background?: string
  onLoad?: (info: PdfLoadInfo) => void
  onError?: (error: PdfViewError) => void
}

/** What the viewer gets. Handlers stay in JS, so a new handler sends nothing. */
export function viewerProps(p: PdfViewProps): Record<string, unknown> {
  return {
    source: p.source ?? null,
    maxZoom: p.maxZoom ?? 5,
    pageGap: p.pageGap ?? 16,
    background: p.background ?? null,
    initialPage: p.initialPage ?? 1,
  }
}

export function previewProps(p: PdfPreviewProps): Record<string, unknown> {
  return {
    source: p.source ?? null,
    page: p.page ?? 1,
    fit: p.fit ?? "width",
    background: p.background ?? null,
  }
}

/** One event from either view. Kept out of the components so a test can call it. */
export function onPdfEvent(h: PdfViewProps | PdfPreviewProps, e: { name: string; data: any }): void {
  const d = e.data
  switch (e.name) {
    case "load":
      return h.onLoad?.(d)
    case "page":
      return (h as PdfViewProps).onPageChange?.(d.page, d.total)
    case "zoom":
      return (h as PdfViewProps).onZoom?.(d.scale)
    case "error":
      return h.onError?.(d)
  }
}

/** A download as signals, for a screen: `state()` is "loading", "ready" or "failed". */
export interface PdfFileState {
  state: () => "loading" | "ready" | "failed"
  /** The handle for `<PdfView source>`, null until ready. */
  handle: () => string | null
  file: () => PdfFile | null
  reason: () => PdfReason | null
  /** Downloads again. A cached file comes back at once. */
  retry: () => void
}

/**
 * Starts `Pdf.download` now and gives the result as signals. Call it while the screen is built: closing the screen drops a
 * download still running (the file stays, if it finished).
 */
export function pdfFile(args: PdfDownload): PdfFileState {
  const state = signal<"loading" | "ready" | "failed">("loading")
  const file = signal<PdfFile | null>(null)
  const reason = signal<PdfReason | null>(null)
  let run = 0
  const load = () => {
    const mine = ++run
    state.set("loading")
    reason.set(null)
    Pdf.download(args).then(
      (r) => {
        if (mine !== run) return
        if (r.status === "ok") {
          const { status: _, ...f } = r
          file.set(f)
          state.set("ready")
        } else {
          reason.set(r.reason)
          state.set("failed")
        }
      },
      () => {
        if (mine !== run) return
        reason.set("failed")
        state.set("failed")
      },
    )
  }
  load()
  return {
    state: () => state(),
    handle: () => file()?.handle ?? null,
    file: () => file(),
    reason: () => reason(),
    retry: load,
  }
}
