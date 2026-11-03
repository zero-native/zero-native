// The media plugin's JS side. Native side: android/.../MediaModule.kt. No side effects: nativeModule() only creates a handle.
//
//   const { status, files } = await Media.pickPhotos({ maxSize: 1600, quality: 80 })
//   if (status === "ok") photo.set(files[0].handle)                     // <Image src={photo()} />
//
//   const form = new FormData()
//   form.append("photo", { uri: files[0].uri, name: files[0].name, type: files[0].mime })   // streamed by native
//
// The promise dies with the process. If Android kills the app while the other app is open, the result comes here instead:
//
//   Media.onResult((result, ack) => {                                   // while a screen is built
//     if (result.status === "ok") photo.set(result.files[0].handle)
//     ack()                                                             // after you acted on it; until then it comes again
//   })
import { launches, nativeModule, Permissions, type LaunchRecord } from "@zero-native/core"

/** A file of ours. Pixels and bytes never enter JS. */
export interface MediaFile {
  /** `zn://file/...`, for `<Image src>`, and to give back to `Media.edit`. */
  handle: string
  /** `file://...`, for `FormData`, which streams it. */
  uri: string
  /** 0 for a file that isn't a picture. */
  width: number
  height: number
  /** Bytes. */
  size: number
  mime: string
  /** The name it had in the other app, for showing or uploading. Never a path. */
  name: string
}

export interface MediaResult {
  /**
   * "ok": at least one file. "cancelled": the user came back with nothing. "lost": no answer came, as the app was swiped away
   * while the other app was open. "failed": see `reason`.
   */
  status: "ok" | "cancelled" | "lost" | "failed"
  files: MediaFile[]
  /**
   * With "failed". From the launch: `no_app`, `no_activity`, `no_storage`, `busy`, `camera_denied`, `camera_blocked`. From the
   * file: `access_lost` (pick again), `too_big`, `not_image`, `no_space`, `read_failed`, `write_failed`, `no_photo`, `no_file`.
   */
  reason?: string
  /** Picked files that couldn't be used, with status "ok". */
  skipped?: number
}

/** Longest side in pixels (default 2048) and JPEG quality 1 to 100 (default 85). */
export interface PhotoOptions {
  maxSize?: number
  quality?: number
}

export interface EditOptions extends PhotoOptions {
  handle: string
  /** A multiple of 90, clockwise. */
  rotate?: number
  /** Whole pixels, on the picture after `rotate`. A crop outside the picture fails with `invalid_crop`. */
  crop?: { x: number; y: number; width: number; height: number }
}

interface Started {
  launched: boolean
  reason?: string
  id?: string
}

interface MediaNative {
  pickPhotos(args: PhotoOptions & { max?: number }): Promise<Started>
  pickFile(args: { types?: string[]; maxBytes?: number }): Promise<Started>
  takePhoto(args: PhotoOptions): Promise<Started>
  collect(args: { id: string }): Promise<MediaResult>
  forget(args: { id: string }): Promise<boolean>
  edit(args: EditOptions): Promise<MediaFile>
  cleanup(args: { olderThanMs?: number; keep?: string[] }): Promise<{ deleted: number; bytes: number }>
  /** Debug builds only. A photo stored sideways, with a location in it. */
  debugPhoto(): Promise<MediaFile>
  /** Debug builds only. What is left in a file's EXIF. */
  debugExif(args: { handle: string }): Promise<{ orientation: number; location: boolean }>
}

const Native = nativeModule<MediaNative>("Media", { version: 1 })

/** The launch key: one pick at a time (MediaModule.KEY). */
const KEY = "media"

/** Launches a promise is waiting for, so `onResult` leaves them alone. */
const waiting = new Set<string>()

const failed = (reason: string): MediaResult => ({ status: "failed", reason, files: [] })

/** The files of a launch. Safe to call again: whole files are kept, so this also finishes a run a kill cut short. */
async function read(record: LaunchRecord): Promise<MediaResult> {
  if (record.status !== "result") return { status: "lost", files: [] }
  try {
    return await Native.collect({ id: record.id })
  } catch (e) {
    return failed((e as { code?: string }).code ?? "failed")
  }
}

async function done(id: string): Promise<void> {
  await launches.ack(KEY, id)
  await Native.forget({ id })
}

async function start(open: () => Promise<Started>): Promise<MediaResult> {
  // A result nobody took (the app was killed and no screen called onResult) must not block a new pick for ever.
  const old = launches.pending(KEY)
  if (old && old.status !== "waiting" && !waiting.has(old.id)) await done(old.id)
  const started = await open()
  const id = started.id
  if (!started.launched || id === undefined) return failed(started.reason ?? "failed")
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

async function takePhoto(options: PhotoOptions = {}): Promise<MediaResult> {
  const first = await start(() => Native.takePhoto(options))
  if (first.reason !== "camera_permission") return first
  // Only an app whose manifest lists CAMERA gets here, like one that also has the scanner plugin.
  const { camera } = await Permissions.request(["camera"])
  if (camera !== "granted") return failed(camera === "blocked" ? "camera_blocked" : "camera_denied")
  return start(() => Native.takePhoto(options))
}

export const Media = {
  /**
   * Android's photo picker, with no permission, or the file picker on a phone without one. Each photo comes as a JPEG with
   * its rotation built in and no EXIF, so no location. `max`: how many, 1 to 30 (default 1).
   */
  pickPhotos: (options: PhotoOptions & { max?: number } = {}): Promise<MediaResult> => start(() => Native.pickPhotos(options)),

  /**
   * Any file, like a PDF. `types`: mime types, like ["application/pdf", "image/*"]. It comes byte for byte, so a picture keeps
   * its EXIF: use `Media.edit` before you share one. Over `maxBytes` (default and limit 100 MB) it fails with `too_big`.
   */
  pickFile: (options: { types?: string[]; maxBytes?: number } = {}): Promise<MediaResult> => start(() => Native.pickFile(options)),

  /** The camera app. The result is treated like a picked photo. */
  takePhoto,

  /** Rotates, crops, resizes and compresses, off the main thread, into a new file. The old one stays. */
  edit: (options: EditOptions): Promise<MediaFile> => Native.edit(options),

  /**
   * Deletes this plugin's files older than `olderThanMs` (default a day; 0 for all), except `keep` (handles) and the launch in
   * progress. Handles of deleted files stop working. Also runs by itself after each pick: over 7 days, or over 256 MB in all.
   */
  cleanup: (options: { olderThanMs?: number; keep?: string[] } = {}) => Native.cleanup(options),

  /**
   * Hears a result no promise is waiting for: after a kill, Android brings the app back and the promise is gone. Call it while
   * a screen is built, and it stops with the screen. The result comes at every start until you call `ack`.
   */
  onResult(handler: (result: MediaResult, ack: () => void) => void): () => void {
    return launches.onResult(KEY, (record) => {
      if (waiting.has(record.id)) return
      void read(record).then((result) => handler(result, () => void done(record.id)))
    })
  },

  /** Debug builds only, for the plugin's phone test. */
  debugPhoto: () => Native.debugPhoto(),
  debugExif: (handle: string) => Native.debugExif({ handle }),
}
