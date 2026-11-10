# @zero-native/image-viewer

A full-screen photo viewer, opened with one call. For store photos, offer pictures and receipt photos.

- One picture or many. Opens on the picture you choose.
- Pinch to zoom (1x to 5x; a pinch can shrink it to 0.8x and it springs back to fit when you let go, as in React
  Native), move a zoomed picture with one finger, double tap to zoom in (2.5x at the finger) and out.
- Swipe left or right between pictures (also from a zoomed picture, once it is at its edge). Drag up or down to
  close: the background fades as you drag. Back closes.
- Registry 24: opened with `from` (the thumbnail you tapped), the picture flies out of the thumbnail and back into it
  on close (drag, Back, the close button).
- Black background, a white back arrow at the top left over a dark fade (the same as ZeroBill's React Native viewer:
  Material "arrow back" rounded, 48 dp touch area, round white ripple), "2 / 5" when there is more than one picture.
- A spinner while loading. A message and "Try again" when a picture fails.
- Big pictures stay sharp when zoomed, without running out of memory (see "Memory").

Since registry 24 (ImageViewer module 3) the screen is TSX (`ImageViewerScreen`), built on zero-native's own
`useZoom` and a paging `List`, on a see-through route. Each picture is drawn by the plugin's native view
`imageviewer.page` (loading, EXIF, the sharp part when zoomed). An app whose route still says
`native: "imageviewer.full"` gets the older Compose screen until that screen is removed. Android only for now.

## Add it

1. `package.json`: add `"@zero-native/image-viewer": "workspace:*"`.
2. `android/settings.gradle.kts`: include `:plugin-image-viewer` and set its `projectDir` to `../plugins/image-viewer/android`
   (`docs/guide-notes.md` §30).
3. The app's `build.gradle.kts`: `implementation(project(":plugin-image-viewer"))`.
4. `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, ImageViewerPlugin())`.
5. `routes.ts`: one route for the screen. `open` uses the name `imageViewer` unless you give another.

```ts
import { ImageViewerScreen } from "@zero-native/image-viewer/screen"

imageViewer: { path: "/image-viewer", screen: ImageViewerScreen, transparent: true, safeArea: "none", statusBar: "light", restore: false, transition: "none" },
```

`transparent: true` (registry 24): the screen below stays drawn while the picture flies and the background fades.
`safeArea: "none"`: the pictures go under the status bar; the close button keeps clear of it by itself.
`restore: false`: the viewer's pictures live in JS memory, so after a kill it does not come back.

Before registry 24 (or to keep the old Compose screen for now):
`imageViewer: { path: "/image-viewer", native: "imageviewer.full", safeArea: "none", transition: "fade" }`.

## Use it

```tsx
import { Image, Pressable, Row } from "@zero-native/ui"
import { ImageViewer } from "@zero-native/image-viewer"

function Thumb(p: { photos: string[]; i: number }) {
  const box = useElementMotion() // its place on screen: the picture flies from here and back
  return (
    <Pressable motion={box} onPress={() => ImageViewer.open({ images: p.photos, imageIndex: p.i, from: box })}>
      <Image src={p.photos[p.i]!} style={{ width: 72, height: 72, borderRadius: 10 }} />
    </Pressable>
  )
}

export function StorePhotos(p: { photos: string[] }) {
  return <Row gap={8}>{p.photos.map((url, i) => <Thumb key={url} photos={p.photos} i={i} />)}</Row>
}
```

(`useElementMotion` comes from `@zero-native/core`.)

`open` gives `{ index }` (the picture on screen) when the user closes the viewer, and null when the app closed it
(`nav.back()`, `nav.reset()`). Most apps ignore the answer.

## API

**`ImageViewer.open(options)`** → `Promise<{ index: number } | null>`

| Option | Default | What |
|---|---|---|
| `images` | (needed) | A list of `"https://..."`, `{ uri, alt?, headers? }` or `{ url, alt?, headers? }`. `alt` is what TalkBack reads. `headers` go with that picture's request (see "Links that load") |
| `imageIndex` (or `index`) | 0 | The picture to start on. Kept inside the list |
| `from` | none | Registry 24, TSX screen: the thumbnail tapped, as a `useElementMotion()` bound on it or a box `{ x, y, width, height }` in the window (dp). The picture flies from it and back into it when closed on the same picture; on another picture, or without `from`, the viewer fades |
| `swipeToCloseEnabled` | true | Swipe up or down to close |
| `doubleTapToZoomEnabled` | true | Double tap zooms |
| `backgroundColor` | `"#000000"` | `"#RRGGBB"` or `"#AARRGGBB"` |
| `closeLabel` | "Close" | TalkBack's name for the close button |
| `errorText`, `retryLabel` | "Couldn't load this photo", "Try again" | Under a picture that failed |
| `photoLabel` | "Photo {n} of {count}" | TalkBack's name for a picture with no `alt`, and for the count |
| `nextLabel`, `previousLabel` | "Next photo", "Previous photo" | TalkBack actions that move between pictures |
| `route` | `"imageViewer"` | Your route for the screen, if you named it differently |

The names come from React Native's `react-native-image-viewing` (`images: [{ uri }]`, `imageIndex`,
`swipeToCloseEnabled`, `doubleTapToZoomEnabled`, `backgroundColor`). `index` and `{ url }` are
`react-native-image-zoom-viewer`'s. RN's `visible` / `onRequestClose` become the promise: no state to keep.
Not here: `HeaderComponent`, `FooterComponent`, `onLongPress`, save to gallery, live `onImageIndexChange` (you get the
last index when it closes).

`open` rejects (never throws) for an empty list, a picture with no link, or a route that isn't `imageviewer.full`; the
message says the route line to add. A second `open` while the viewer is still on screen gives the same promise, so a
double tap on a thumbnail opens one screen.

**Links that load:**

| Link | Notes |
|---|---|
| `https://...` | And `http://` where the app allows cleartext. Can have `headers` |
| `asset:<path>` | A picture in the bundle, the same as `<Image>` |
| `zn://file/<name>` | A file a plugin made, like a photo from `@zero-native/media` |
| `content://...` | From a picker or another app. Read through Android's `ContentResolver`, so Android's own rules decide: a link the app has no right to read shows the error |
| `file://...` | **Only inside the app's own folders**: `cacheDir`, `filesDir`, and the app's external files and cache folders. The path is resolved first (`../` and links followed), then checked. Any other path shows the error |
| `data:image/...;base64,...` | Up to **5 MB** once decoded, and 20 MB of `data:` pictures in all. A bad or bigger one shows the error |

**Why `file://` only inside the app's folders:** this is the safe form of the `file://` ask. A bundle comes over the
air, so it must not be able to read any path it likes (`/sdcard/...`, another app's shared files): the same rule as
`zn://file` (`docs/guide-notes.md` §35). A file the app itself wrote (its cache, a download, a media plugin photo) is
fine. **Why the 5 MB cap on `data:`:** the whole string is in memory, then the decoded bytes; a huge one must not run the
app out of memory. Use a file or an https link for big pictures. (`docs/second-opinions.md` 143.)

**`headers`** (a login token, for example `{ uri, headers: { Authorization: "Bearer ..." } }`): sent with that
picture's request. The sharp zoom reads Coil's disk copy of that same answer, so it needs no second request. Header
values are never logged. Only text values are kept; a name that isn't a plain header name, or a value with a line break,
is dropped (its name is logged).

**`data:` links and headers stay in memory, not in the params.** The params are saved with the back stack (Android's
saved state, with a size limit, kept outside the app), so a token or a big string must not go there. `open` hands them
to native first, then opens the screen. So:

- Use `ImageViewer.open` for them, not `nav.push("imageViewer", ...)` (a `data:` link there shows the error; headers
  are not read).
- After Android kills the app, the viewer comes back, but those pictures show the error ("Try again" can't help).
  Other pictures are fine.
- A picture fetched with headers is in Coil's caches like any other (by its link), so the same link opened later without
  headers shows the cached copy. Use a link per user if that matters.

## After a kill

The TSX screen (`restore: false`) does not come back after a kill: the app reopens on the screen below it.

The old native screen: if Android kills the app while the viewer is open, the viewer comes back on the same picture, but the promise is gone
(like any `nav.pushForResult`). The viewer only shows pictures, so nothing is lost. If you need the index after a
kill, add `onNavResult("imageViewer", (r, ack) => { ...; ack() })` in `main.ts`.

## Memory

Pictures load with the app's own Coil, the same as `<Image>`: one memory and disk cache, so a photo already shown in a
list opens at once. Coil decodes each picture at the screen's size, never at its full size, so a 6000 x 4000 photo
takes about 3.5 MB, not 96 MB. When you zoom in and stop, the viewer reads only the part on screen from the original
(Android's `BitmapRegionDecoder`, from Coil's disk copy) at the screen's pixels: sharp at 5x, about one screen of memory
(at most 2.5 screens). It drops that part when Android is short of memory. The pdf viewer does the same.

No sharp part (only Coil's copy, a little soft at 5x) when: the server says `no-store` (no disk copy), the picture is a
mirror image in its EXIF (rare), or the format has no region decoder (GIF; Coil also shows only its first frame).
Turned EXIF photos (90, 180, 270 degrees) are fine.

## Size

Kotlin only, no new library: Coil, Compose, `exifinterface` and `activity-compose` are already in every zero-native app
(same versions). In the sample's R8 release (2026-11-05), the plugin's package is **25.5 KB of dex** (`apkanalyzer dex
packages` with the mapping). By the pdf plugin's ratio (43 KB of classes → 15 KB download) that is about 9 KB of Play
download; not measured with bundletool.

## Test

`bun test plugins/image-viewer` (params, `open`, both routes, double open, `data:` and headers held natively first,
`from`, the TSX screen compiles),
`gradlew :plugin-image-viewer:testDebugUnitTest` (zoom, pan limits, double tap, swipe to close, the visible part, EXIF
turns, links, `file://` folders, `data:` cap, header checks, params). On a phone: the sample's Dev
screen → "Image viewer plugin" (`zn://sample/dev/image-viewer`); its log lines start with `image-viewer-lab`. Its
first button switches between the TSX screen (route `photoViewer`) and the old one (route `imageViewer`). The
"Header" button needs `bun run tools/fetch-test-server.ts` and `adb reverse tcp:8788 tcp:8788`.

Two fingers from adb, debug builds only (phones refuse `sendevent` without root), old screen only. It sends real touch
events through the Activity, so the viewer's own gesture code runs. Not in release builds (`src/release` has an empty one):

```bash
adb shell am broadcast -a dev.zeronative.imageviewer.DEBUG_GESTURE --es kind pinch --ei x 360 --ei y 800 --ei from 150 --ei to 450 --ei ms 400
```

`from` / `to` are the gap between the fingers in screen pixels; `dx` / `dy` move both fingers together. For a double tap, tap twice by hand.

## Not built

iOS (the TSX screen needs only the `imageviewer.page` view there: `docs/motion.md` §14). Video. Share or save. Zoom
kept across a turn of the screen (it goes back to fit; the picture stays). The TSX screen's overlay is fixed today
(close and count); an app can copy `ImageViewerScreen.tsx` to change it.
