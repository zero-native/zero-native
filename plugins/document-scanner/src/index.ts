// The document scanner plugin's JS side: Google ML Kit's document scanner. Native side:
// android/src/main/java/dev/zeronative/plugins/documentscanner/DocScanModule.kt. No side effects: nativeModule() only
// creates a handle. Names follow react-native-document-scanner-plugin where they fit (scanDocument, maxNumDocuments,
// scannedImages, status "success" / "cancel").
//
//   const { status } = await DocumentScanner.getStatus()                 // "available", "not_downloaded", ...
//   const r = await DocumentScanner.scanDocument({ maxNumDocuments: 5, formats: ["pdf"], tag: orderId })
//   if (r.status === "success") upload(r.pdf!.uri)                      // FormData streams the file from disk
//
// The promise dies with the process. If Android kills the app while the scanner is open, the result comes here instead:
//
//   DocumentScanner.onResult((r, ack) => {                               // while the screen is built
//     if (r.tag === orderId && r.status === "success") upload(r.pdf!.uri)
//     ack()                                                              // after you acted on it; until then it comes again
//   })
import { createStorage, launches, nativeModule, type LaunchRecord } from "@zeronative/core"

/** One scanned page, a JPEG of ours. Pixels never enter JS. */
export interface ScannedPage {
  /** `zn://file/...`, for `<Image src>`. */
  handle: string
  /** `file://...`, for `FormData`, which streams it. */
  uri: string
  width: number
  height: number
  /** Bytes. */
  size: number
}

/** All pages in one PDF of ours. */
export interface ScannedPdf {
  handle: string
  uri: string
  pageCount: number
  size: number
}

export interface ScanDocumentResponse {
  /**
   * "success": pages and / or the PDF. "cancel": the user closed the scanner. "lost": no answer came, as the app was swiped
   * away while the scanner was open. "unavailable": the scanner can't open on this phone now (see `reason`: the module isn't
   * downloaded yet, or Play services is missing or old): let the user type or pick a photo instead. "failed": see `reason`.
   */
  status: "success" | "cancel" | "lost" | "unavailable" | "failed"
  /** The pages' handles, for `<Image src>` (react-native-document-scanner-plugin's name). Empty without JPEG. */
  scannedImages: string[]
  /** With `formats` "jpeg" (the default). */
  pages: ScannedPage[]
  /** With `formats` "pdf". */
  pdf: ScannedPdf | null
  /** The launch's id. */
  id?: string
  /** The `tag` the scan was started with. */
  tag?: string
  /**
   * With "unavailable": `not_downloaded`, `unknown_module`, `no_play_services`, `play_services_old`, `play_services_disabled`,
   * `play_services_updating`, `play_services_error`. With "failed": `busy`, `unacked`, `no_activity`, `no_storage`,
   * `timeout`, `canceled`, `no_space`, `network`, `access_lost` (scan again), `read_failed`, `write_failed`, `no_file`, `failed`.
   */
  reason?: string
}

export interface ScanDocumentOptions {
  /** How many pages, 1 to 100. No limit if left out (react-native-document-scanner-plugin's name; ML Kit's page limit). */
  maxNumDocuments?: number
  /** Lets the user import a photo from the gallery. Default false. */
  galleryImport?: boolean
  /** "jpeg" (pages), "pdf" (one file), or both. Default ["jpeg"]. */
  formats?: ("jpeg" | "pdf")[]
  /** ML Kit's scanner mode. "full" (default): filters and ML clean-up; "filter": filters only; "base": crop and rotate only. */
  mode?: "full" | "filter" | "base"
  /** Your own word for this scan (an order id, up to 200 characters), given back in the result, also after a kill. */
  tag?: string
}

export interface ScannerStatus {
  /**
   * "available": ready. "not_downloaded": Play can download it (`download()`). "downloading": see `state`, `bytes`, `total`.
   * "failed": a check or download failed (see `reason`); try again later. "unavailable": not on this phone (see `reason`).
   */
  status: "available" | "not_downloaded" | "downloading" | "failed" | "unavailable"
  reason?: string
  /** With "downloading": "pending", "downloading", "installing" or "paused". */
  state?: "pending" | "downloading" | "installing" | "paused"
  /** With "downloading": bytes so far and in all (0 until Play knows). */
  bytes?: number
  total?: number
}

/** A scan waiting or done, read at once from disk (`DocumentScanner.pending`). */
export interface PendingScan {
  id: string
  tag?: string
  /** "waiting": the scanner is open. "result": an answer waits for `onResult`. "lost": no answer came. */
  status: "waiting" | "result" | "lost"
}

interface Started {
  launched: boolean
  reason?: string
  id?: string
  /** The reason means "not on this phone now". */
  unavailable?: boolean
}

interface DocScanNative {
  getStatus(): Promise<ScannerStatus>
  download(): Promise<ScannerStatus>
  scanDocument(args: ScanDocumentOptions): Promise<Started>
  collect(args: { id: string }): Promise<ScanDocumentResponse>
  forget(args: { id: string }): Promise<boolean>
  cleanup(args: { olderThanMs?: number; keep?: string[] }): Promise<{ deleted: number; bytes: number }>
  events: { status: ScannerStatus }
}

const Native = nativeModule<DocScanNative>("DocumentScanner", { version: 1 })

/** The launch key: one scan at a time (DocScanModule.KEY). */
const KEY = "docscanner"
/** Native's own record of the scan: it holds the tag (DocScanModule.STORE, JOB). */
const jobs = createStorage("zn.docscanner")

/** Launches a promise is waiting for, so `onResult` leaves them alone. */
const waiting = new Set<string>()
/** Results an `onResult` handler has in this run and hasn't acked: one handler each, never two. */
const handed = new Set<string>()

const empty = { scannedImages: [], pages: [], pdf: null }
const answer = (status: ScanDocumentResponse["status"], reason?: string, id?: string): ScanDocumentResponse => ({
  status,
  ...empty,
  ...(id !== undefined ? { id } : {}),
  ...(tagOf(id) !== undefined ? { tag: tagOf(id) } : {}),
  ...(reason !== undefined ? { reason } : {}),
})

function tagOf(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  try {
    const raw = jobs.getString("job")
    const job = raw === undefined ? null : (JSON.parse(raw) as { id?: string; tag?: string | null })
    return job?.id === id && typeof job.tag === "string" ? job.tag : undefined
  } catch {
    return undefined
  }
}

const codeOf = (e: unknown) => (e as { code?: string }).code ?? "failed"

/** The files of a launch. Safe to call again: whole files are kept, so this also finishes a run a kill cut short. */
async function read(record: LaunchRecord): Promise<ScanDocumentResponse> {
  if (record.status !== "result") return answer("lost", undefined, record.id)
  try {
    const r = await Native.collect({ id: record.id })
    return { ...r, scannedImages: r.pages.map((p) => p.handle) }
  } catch (e) {
    return answer("failed", codeOf(e), record.id)
  }
}

async function done(id: string): Promise<void> {
  await launches.ack(KEY, id)
  await Native.forget({ id })
}

async function scanDocument(options: ScanDocumentOptions = {}): Promise<ScanDocumentResponse> {
  // A result nobody took (the app was killed and no screen called onResult) must not block a new scan for ever. One a
  // handler still holds is left alone: the scan then fails with "unacked".
  const old = launches.pending(KEY)
  if (old && old.status !== "waiting" && !waiting.has(old.id) && !handed.has(old.id)) await done(old.id)
  const started = await Native.scanDocument(options)
  const id = started.id
  if (!started.launched || id === undefined) return answer(started.unavailable ? "unavailable" : "failed", started.reason ?? "failed")
  waiting.add(id)
  return new Promise((resolve) => {
    const off = launches.onResult(KEY, (record) => {
      if (record.id !== id) return
      off()
      void read(record).then(async (result) => {
        await done(id)
        waiting.delete(id)
        resolve(result)
      })
    })
  })
}

export const DocumentScanner = {
  /**
   * Opens Google's scanner (camera, edges, crop, filters) and gives the pages and / or a PDF. The camera runs in Google Play
   * services, so the app needs no camera permission. Never rejects for a Play services problem: see `status` and `reason`.
   * Rejects only with `invalid_args` (a wrong option).
   */
  scanDocument,

  /** Is the scanner on this phone? It is a Play services module, downloaded on first use. Never rejects. */
  async getStatus(): Promise<ScannerStatus> {
    try {
      return await Native.getStatus()
    } catch (e) {
      return { status: "unavailable", reason: codeOf(e) }
    }
  },

  /**
   * Asks Play to download the scanner now, and answers when it ends: "available", or "failed" / "unavailable" with a reason.
   * A second call joins the first. Steps and progress come to `onStatus`. Never rejects.
   */
  async download(): Promise<ScannerStatus> {
    try {
      return await Native.download()
    } catch (e) {
      return { status: "failed", reason: codeOf(e) }
    }
  },

  /** Hears each step of a download this app started, and its end. Called while a screen is built, it stops with the screen. */
  onStatus: (listener: (status: ScannerStatus) => void): (() => void) => Native.on("status", listener),

  /**
   * Hears a result no promise is waiting for: after a kill, Android brings the app back and the promise is gone. Call it
   * while a screen is built, and it stops with the screen. It comes at every start until you call `ack`, but only one
   * handler gets each result in a run. Check `tag` before you use it.
   */
  onResult(handler: (result: ScanDocumentResponse, ack: () => void) => void): () => void {
    const mine = new Set<string>()
    const off = launches.onResult(KEY, (record) => {
      if (waiting.has(record.id) || handed.has(record.id)) return
      handed.add(record.id)
      mine.add(record.id)
      void read(record).then((result) =>
        handler(result, () => {
          mine.delete(record.id)
          void done(record.id).then(
            () => handed.delete(record.id),
            () => handed.delete(record.id),
          )
        }),
      )
    })
    return () => {
      off()
      // Not acked by this handler: a handler made later in this run may take it.
      for (const id of mine) handed.delete(id)
      mine.clear()
    }
  },

  /** The scan that is open or has an answer waiting, at once from disk, or null. For a restored screen's first frame. */
  pending(): PendingScan | null {
    const r = launches.pending(KEY)
    if (!r) return null
    const tag = tagOf(r.id)
    return { id: r.id, status: r.status, ...(tag !== undefined ? { tag } : {}) }
  },

  /**
   * Deletes this plugin's files older than `olderThanMs` (default a day; 0 for all), except `keep` (handles) and the open scan.
   * Handles of deleted files stop working. Also runs by itself after each scan, for files over 7 days old.
   */
  cleanup: (options: { olderThanMs?: number; keep?: string[] } = {}) => Native.cleanup(options),
}

export default DocumentScanner
