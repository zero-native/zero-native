# @zero-native/pdf

Show a PDF: download it once, keep it on the phone, show one page on a card, or every page with scroll and zoom.

Drawing is Android's own `PdfRenderer`. No PDF library, no new Maven dependency.

## Add it

1. `package.json`: add `"@zero-native/pdf": "workspace:*"`.
2. `android/settings.gradle.kts`: include `:plugin-pdf` and set its `projectDir` to `../plugins/pdf/android` (`docs/guide-notes.md` §30).
3. The app's `build.gradle.kts`: `implementation(project(":plugin-pdf"))`.
4. `Application.onCreate`, first thing: `ZnPlugins.register(this, PdfPlugin())`.

The host needs the `INTERNET` permission for downloads. Nothing else: no storage permission, no manifest entries.

## Use it

```tsx
import { Box, Column, Pressable, Text } from "@zero-native/ui"
import { PdfPreview, PdfView, pdfFile } from "@zero-native/pdf"

// A card: one page, as wide as the box, from the top, cut at the box's bottom. No touch: the tap goes to the Pressable.
export function ReceiptCard(p: { url: string; token: string; receiptId: string; onOpen: () => void }) {
  const pdf = pdfFile({ url: p.url, headers: { _zcc: p.token }, key: p.receiptId })
  return (
    <Pressable onPress={p.onOpen}>
      <Box style={{ height: 220, overflow: "hidden" }}>
        <PdfPreview source={pdf.handle()} />
      </Box>
    </Pressable>
  )
}

// The full receipt: every page, scroll, pinch, double tap.
export function ReceiptScreen(p: { url: string; token: string; receiptId: string }) {
  const pdf = pdfFile({ url: p.url, headers: { _zcc: p.token }, key: p.receiptId })
  return (
    <Column style={{ flex: 1 }}>
      {pdf.state() === "failed" && (
        <Pressable onPress={pdf.retry}>
          <Text>Couldn't load the receipt. Tap to try again</Text>
        </Pressable>
      )}
      <Column style={{ flex: 1 }}>
        <PdfView source={pdf.handle()} background="#FFFFFF" onError={(e) => console.warn(`receipt: ${e.reason}`)} />
      </Column>
    </Column>
  )
}
```

Both views fill the Box or Column around them, so give that a size. Don't put `PdfView` in a `Scroll`: it scrolls by itself.

The card and the screen ask for the same file. The second call joins the first download, or gets the file from disk at once.

## API

**`Pdf.download({ url, headers, key, maxBytes })`** gives `{ status: "ok", handle, uri, size, pages, width, height, cached }` or `{ status: "failed", reason, httpStatus? }`. It never rejects for a bad file or the network.
- `handle` (`zn://file/pdf-...`) goes to the views.
- `uri` (`file://...`) goes in `FormData`.
- `width` and `height` are the first page's size in PDF points.
- `key` is your own name for the file, like a receipt id.
- `maxBytes`: default 20 MB, at most 100 MB.

**`Pdf.open({ handle })`**: the same answer for a handle you already have, such as a PDF from `Media.pickFile`.

**`Pdf.cleanup({ olderThanMs, keep })`** deletes this plugin's files and no one else's. The default deletes files older than 7 days, counted from their last use. `0` deletes all. `keep` takes handles.

**`pdfFile(args)`**: `Pdf.download` as signals, for a screen: `state()` ("loading", "ready", "failed"), `handle()`, `file()`, `reason()`, `retry()`.

**`<PdfView>`**
- Props: `source`, `maxZoom` (5; 1 is no zoom; at most 10), `pageGap` (16 dp), `background` ("#E5E7EB"), `initialPage` (1).
- Events: `onLoad({ view, pages, width, height })`, `onPageChange(page, total)` (the page in the middle, from 1), `onZoom(scale)` (once the fingers rest), `onError({ reason, page? })`.

**`<PdfPreview>`**
- Props: `source`, `page` (1), `fit` ("width" or "contain"), `background` ("#FFFFFF").
- Events: `onLoad`, `onError`.

**Reasons.**
- `Pdf.download`:
  - `network`: no answer.
  - `http`: the server said no (`httpStatus`).
  - `too_big`: over `maxBytes`.
  - `not_pdf`: an error page sent as 200, say.
  - `broken`: the file can't be read.
  - `password`: the file needs a password.
  - `no_space`: the phone is full.
  - `not_allowed`: not https.
  - `failed`: something else.
- The views: `not_found` (no file for this handle), `broken`, `password`, `page` (one page failed to draw; the others still show), `memory`, `failed`.

## Downloads

| Rule | Why |
|---|---|
| https only. A debug build also takes `http://localhost` and `http://127.0.0.1` | The phone test's server, through `adb reverse` |
| Uses the app's own OkHttp from `ZnFetch.client`, so `ZnFetch.configure` (pinning, interceptors) applies | One network setup for the app. 0 bytes added: the runtime ships the same OkHttp |
| Redirects are followed here, up to 5, each to an allowed URL. **The app's headers only go to the first host.** A redirect to another host gets none | A token in a header must not reach a CDN or another server |
| No https → http redirect | Same as `fetch` |
| 30 s with no data, or 5 minutes in all, ends a download with `network` | ZnFetch's own client has no read limit, and a stalled download must end |
| The body is checked for `%PDF-` in its first 1024 bytes, then opened with PdfRenderer, before it gets a handle | An HTML error page with a 200 is common, and a handle must only point at a PDF that opens |
| Written to a dot name (`.pdf-<hash>.pdf.part`), renamed when whole and checked | A kill in the middle leaves no half file with a handle. A dot name can never be a handle |
| Logs show the host only, never headers, the path or the query | A link can carry a token |
| Content-Length over `maxBytes` stops before the body; a body that grows past it stops at that byte | A broken server must not fill the phone |

**The file's name comes from `url` + `key`, not the headers.** Two users who get the same URL with different headers share one file. **Do** call `Pdf.cleanup({ olderThanMs: 0 })` at logout if your URLs are not per user.

Android may clear the cache folder when the phone is short of space. The view then says `not_found`. Call `download` again: it fetches the file again.

## How it draws

- **One thread for every PDF in the app.** PdfRenderer is not thread-safe, and the pdfium code under it keeps state for the whole process. So a card and the full view take turns.
- **Lazy.** The page sizes are read once, at open; no page is drawn then. Only pages on screen and one on each side get a bitmap. Pages far away are dropped first.
- **A memory cap per view (the budget):** 1/8 of the app's heap limit, between 16 and 48 MB. Low-RAM phones get 16 MB.
  - Pages get 2/3 of it. A page bitmap is as wide as the view, but smaller if it would take over 1/3 of that share, or have a side over 2048 px.
  - On top of the pages, a **sharp layer**: when the fingers rest and the pages are scaled, one bitmap the size of the view, at the real zoom, of only what is on screen. It gets the other 1/3.
  - So text is sharp at 5×, a long receipt page is sharp too, and memory doesn't grow with zoom.
- **Bitmaps are dropped, never `recycle()`d.** A recycled bitmap that Compose still draws crashes the app. Android 8+ frees bitmaps with GC.
- **Out of memory on a page:** drop the other bitmaps, try once at half the width, else leave the page white and send `onError({ reason: "memory" })`. When Android asks for memory back, every view drops its bitmaps and draws them again when needed.
- **The preview** draws only what the box shows, in one bitmap the size of the box (at most 1/3 of the budget). A 220 dp card costs the same for a long receipt as for one line.

## Zoom

- Two fingers zoom around the fingers and pan. One finger scrolls, and pans sideways when zoomed. A fling goes on after the fingers leave, and stops at the edges.
- Double tap: 1× to 2.5× around the tap, and back.
- While the fingers move, the page bitmaps are scaled: quick, a bit soft. 150 ms after they rest, the sharp layer is drawn.

## After a kill

The screen comes back (it's a route), and the file is still in `cacheDir/zn-files`. So the view opens it again from its `source`, at page 1 and 1×. Keep `source` in a `restorableSignal`, or call `pdfFile` again: a cached file comes back at once.

A download that was running dies with the process, and so does its promise. Its part file stays until the next download of the same file writes over it. Nothing waits on another app, so no result event is needed after a kill, unlike `Media`.

## Limits

- **A PDF that crashes pdfium itself kills the app.** Kotlin can't catch a crash in native code. PdfRenderer runs in our process, so the risk is any PDF from outside: only show PDFs from servers you trust. `docs/second-opinions.md` entry 82.
- No password entry: a locked PDF is `password`. Android takes a password only from Android 15.
- No text selection, search, links inside the PDF, forms or annotations.
- No share or save (ZeroBill's RN app has `shareFile` but never calls it). Later, with a FileProvider like media's.
- No base64 source: the bytes would pass through JS.
- Scroll position and zoom aren't kept after a kill. `onPageChange` + `initialPage` can do it.
- A view keeps its file open while it shows. Up to 3 views at once is fine; a list of 20 previews isn't, as each has its own budget.
- Android only.

## Size

Kotlin only. Measured in the sample's R8 release, 2026-11-03, with the brotli method in `docs/startup-and-performance.md` §3: **about 15 KB of Play download** (43 KB of classes).

## Test

`bun test plugins/pdf`, `gradlew :plugin-pdf:testDebugUnitTest`, and on a phone or the emulator `bun run tools/plugin-phone.ts pdf` (`tools/plugin-phone/pdf-server.ts` serves the test PDFs: a password one, a broken one, an error page, 50 pages, a long receipt, redirects, a slow one).
