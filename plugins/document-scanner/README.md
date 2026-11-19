# @zeronative/document-scanner

Google ML Kit's document scanner: the camera finds the page edges, the user crops, rotates and adds pages, and the app gets
JPEG pages and / or one PDF, as short handles. Bytes never enter JS. Names follow `react-native-document-scanner-plugin`
where they fit (`scanDocument`, `maxNumDocuments`, `scannedImages`, `status: "success" | "cancel"`).

## Add it

```kotlin
// android/settings.gradle.kts:
include(":plugin-document-scanner")
project(":plugin-document-scanner").projectDir = file("<zero-native>/plugins/document-scanner/android")

// The app's build.gradle.kts:
implementation(project(":plugin-document-scanner"))

// Application.onCreate, first thing, with the other plugins:
ZnPlugins.register(this, DocumentScannerPlugin())   // dev.zeronative.plugins.documentscanner.DocumentScannerPlugin
```
```json
"dependencies": { "@zeronative/document-scanner": "workspace:*" }
```

Your Activity needs `ZnActivity.attach(this)` in `onCreate`, as every app with a launch does. No permission: the camera runs in
Google Play services, not in your app.

## Google Play services: the scanner is downloaded, not bundled

**Know:** ML Kit has no bundled document scanner. The scanner (its models and its screens) is a Google Play services module.
Play downloads it the first time an app on the phone needs it, and every app on the phone then shares it. This is the one
exception to our rule "bundle, don't download from Play" (Pavan, 2026-11-05; `docs/second-opinions.md` entry 139). So:

- A phone with no Play services, a too-old one, or one that can't download (no space, no network) can't scan. **Do** always
  give the user another way: type the numbers, or pick a photo with `@zeronative/media`.
- **Do** check `getStatus()` before you show the scan button, and start `download()` early (for example when the screen
  before opens), so the module is there when the user taps.
- Nothing here throws for a Play services problem. Each one is a status with a `reason`.

```ts
const s = await DocumentScanner.getStatus()
// { status: "available" }
// { status: "not_downloaded" }                                          → DocumentScanner.download()
// { status: "downloading", state: "downloading", bytes: 1200000, total: 4800000 }
// { status: "failed", reason: "no_space" }                               → try again later; offer "type by hand"
// { status: "unavailable", reason: "no_play_services" }                  → only "type by hand"

DocumentScanner.onStatus((s) => progress.set(s))          // each step of a download this app started
const end = await DocumentScanner.download()              // "available", or "failed" / "unavailable" with a reason
```

`reason` for `unavailable`: `not_downloaded`, `unknown_module`, `no_play_services`, `play_services_old`, `play_services_disabled`,
`play_services_updating`, `play_services_error`. For `failed`: `no_space`, `network`, `timeout`, `canceled`, `error_<code>`.

**Know:** a scan before the download doesn't fail on a phone that can download. ML Kit opens Play's own screen, "Downloading
updates to Google Play services…" (with a Cancel button), and then the scanner (seen on the Android 13 emulator: about 20 s).
Cancel there gives `cancel`. So `getStatus` and `download` are for showing the state early, and for phones that can't download.

**Know:** "downloading" is known only for a download this app started in this run. After a restart, a download Play still runs
shows as `not_downloaded`; calling `download()` again joins it.

## Scan

```ts
const r = await DocumentScanner.scanDocument({
  maxNumDocuments: 5,          // pages, 1 to 100; no limit if left out
  formats: ["pdf"],            // "jpeg" (default), "pdf", or both
  galleryImport: false,        // default false
  mode: "full",                // "full" (default), "filter", "base"
  tag: orderId,                // your own word for this scan; comes back in the result, also after a kill
})
if (r.status === "success") {
  const form = new FormData()
  form.append("receipt", { uri: r.pdf!.uri, name: "receipt.pdf", type: "application/pdf" })   // streamed from disk
}
```
```tsx
<Image src={r.scannedImages[0]} style={{ width: 90, height: 120 }} />
```

The result: `{ status, scannedImages, pages, pdf, id, tag, reason }`.
- `status`: `success`, `cancel` (the user closed the scanner), `lost` (no answer: the app was swiped away while the scanner was
  open), `unavailable` (see above: offer typing), `failed` (see `reason`).
- `pages`: `{ handle, uri, width, height, size }` per page, with `formats` "jpeg". `scannedImages` is the same pages' handles.
- `pdf`: `{ handle, uri, pageCount, size }`, with `formats` "pdf".
- `reason` with `failed`: `busy`, `unacked`, `no_activity`, `no_storage`, `timeout`, `canceled`, `access_lost` (scan again),
  `no_space`, `read_failed`, `write_failed`, `no_file`, `failed`.

`scanDocument` rejects only with `invalid_args` (a wrong option: a programmer error).

**Not supported** (from the RN plugin): `croppedImageQuality` (ML Kit chooses the quality) and `responseType: "base64"`
(bytes don't enter JS: send `uri` with `FormData`).

## After a kill

Android can kill the app while the scanner is open, on a low-memory phone. Android then starts the app again, ML Kit's answer
comes back, but the promise is gone. ("Don't keep activities" only destroys the screens: the process and JS live on, and the
promise still gets the answer. Both cases were tested on the emulator.) So a screen that cares calls this while it is built:

```ts
DocumentScanner.onResult((r, ack) => {
  if (r.tag === orderId && r.status === "success") upload(r.pdf!.uri)
  ack()                                       // after you acted on it: until then it comes again at every start
})
const open = DocumentScanner.pending()        // { id, tag, status: "waiting" | "result" | "lost" } or null, at once
```

- **Once, never twice:** a result goes to the waiting promise if there is one, else to one `onResult` handler only (the first in
  this run). After `ack` it never comes again. If the handler's screen closes without `ack`, a later handler in this run may
  take it, and it comes again at the next start.
- **Never lost:** the answer is on disk before JS hears it, and stays until `ack`. A kill or a rollback between hearing it and
  `ack` brings it again at the next start, so **do** make your handler safe to run twice (key your upload on `r.id`).
- **Do** check `tag`. A result can belong to another order the user started before the kill.
- If no screen listens, the result is dropped when the next scan starts.

What happens underneath, step by step:

1. **Before the scanner opens**, the job (id, tag) is on disk, and `ZnLaunch` saves its own "waiting" record.
2. **ML Kit answers.** ML Kit's own invisible Activity runs in our process and puts the files in our cache folder. The links go
   in the job, on disk, before JS hears. Nothing is copied on the main thread.
3. **JS calls `collect`** (the plugin does this): each page and the PDF move into `ZnHandles.fileDir` with our own names.
   A move, not a copy, so a full phone doesn't need room for two copies. Calling it again is safe: a whole file already there
   is used as it is.
4. **JS acks**, and the job is removed. The files stay until `cleanup` or the 7-day trim.

**ML Kit has to be started before its Activity is rebuilt.** After a kill, Android starts a new process and first rebuilds ML
Kit's invisible helper Activity (`GmsDocumentScanningDelegateActivity`), whose constructor needs ML Kit started. An app with
`@zeronative/scanner` has ML Kit's start-up provider removed (for a fast app start), so this crashed ("MlKitContext has not
been initialized") and the scan came back `lost` (found on the emulator, 2026-11-05). So the plugin keeps a marker file while the
scanner is open. At app start, in `register`, it only checks whether that file exists, and starts ML Kit right then only if it
does (12 ms in debug, 21 ms in release on the emulator). In a normal run ML Kit is started off the main thread before the
first status check or scan. **Do** register the plugin in `Application.onCreate` as the guide says, or this can't happen in time.

## Limits

- One scan at a time: a second fails with `busy`.
- The files are in Android's cache folder, so Android can clear them when the phone is short of space. Upload them, then forget
  them. **Don't** save a handle across days. After each scan the plugin deletes its files older than 7 days;
  `DocumentScanner.cleanup({ olderThanMs: 0 })` deletes all of them except the open scan's.
- The scanner's look and words are Google's: no colours or brand of your own.
- Android only. iOS (VisionKit) later.

## Size

| What | Version | About |
|---|---|---|
| `com.google.android.gms:play-services-mlkit-document-scanner` | 16.0.0 | the client only; the scanner itself is Play's download |

Measured in the sample's R8 release on 2026-11-05 (apkanalyzer, classes kept by R8): about 135 KB of uncompressed dex. That is
ML Kit's client (`mlkit_vision_document_scanner` 115 KB, `vision.documentscanner` 12 KB) and the plugin (11 KB). The sample
already had ML Kit's common code and Play's ModuleInstall classes (from `@zeronative/scanner`), so an app without the scanner
plugin pays a bit more. The compressed download size isn't measured. No R8 rule is needed: the release build scanned, restored a
scan after a kill, and showed its pages on the emulator.
