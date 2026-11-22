# @zeronative/media

Pick photos and files, take a photo with the camera app, compress and edit, and hand the result to JS as a short handle. Bytes never
enter JS.

## Add it

```kotlin
// android/settings.gradle.kts: include the project, then the app's build.gradle.kts:
implementation(project(":plugin-media"))

// Application.onCreate, first thing:
ZnPlugins.register(this, MediaPlugin())
```

It needs no storage permission. Your Activity needs `ZnActivity.attach(this)` in `onCreate`, as every app with a launch does.

### On iOS

The Swift package's `ZnPluginMedia` product (or `plugins/media/ios` in a CMake build), then in
`application(_:didFinishLaunchingWithOptions:)`:

```swift
ZnPlugins.register(MediaPlugin())
```

Photos and files need no permission (the Photos picker and the Files picker run outside the app and give only what the
user picked). `takePhoto` needs `NSCameraUsageDescription` in Info.plist.

What is different on iOS:
- `pickPhotos` is the Photos picker (`PHPickerViewController`); HEIC photos are read as they are. An iCloud photo is
  downloaded first, so the promise can take a while.
- `pickFile` is the Files picker. `types` are matched to iOS's content types (`image/*` is any picture); a type iOS
  doesn't know matches no file.
- `takePhoto` is the system camera (`UIImagePickerController`). It needs the camera permission: JS asks for it and tries
  again, as on Android. iOS asks only once, so a "no" there comes back as `camera_blocked` (Android says
  `camera_denied` the first time). No camera (the simulator) fails with `no_app`; debug builds can set
  `ZN_MEDIA_FAKE_CAMERA=1` for a drawn photo instead.
- **After a kill** the pick is `lost`: the pickers run inside the app, so their answer dies with it. Everything else in
  that section holds: a half-written file never gets a handle, and `collect` again is safe.
- A picker that goes away with no answer (a swipe down, or a Sheet that closes under it) ends as `cancelled`.
- `fileDir` is in Caches, which iOS can clear when the phone is short of space: as on Android, a handle is for now.

## Use it

```tsx
const { status, files } = await Media.pickPhotos({ maxSize: 1600, quality: 80 })
if (status === "ok") photo.set(files[0].handle)
...
<Image src={photo()} />
```
```ts
const form = new FormData()
form.append("photo", { uri: file.uri, name: file.name, type: file.mime })   // native streams it from disk
await fetch(url, { method: "POST", body: form })
```

Each file is `{ handle, uri, width, height, size, mime, name }`: `handle` (`zn://file/...`) for `<Image src>` and `Media.edit`, `uri`
(`file://...`) for `FormData`.

## API

- `Media.pickPhotos({ max, maxSize, quality })`: Android's photo picker. On a phone without one, the file picker. `max` is 1 to 30.
- `Media.pickFile({ types, maxBytes })`: any file, like `types: ["application/pdf"]`. It comes byte for byte, up to 100 MB.
- `Media.takePhoto({ maxSize, quality })`: the camera app.
- `Media.edit({ handle, rotate, crop, maxSize, quality })`: a new file. `rotate` is a multiple of 90. `crop` is `{ x, y, width, height }`,
  in whole pixels, on the picture after `rotate`. There is no crop screen: your app gets the numbers its own way.
- `Media.cleanup({ olderThanMs, keep })`: deletes this plugin's files. The default is older than a day, `0` is all. `keep`: handles.
- `Media.onResult((result, ack) => ...)`: see below.

Photos and camera shots come out as JPEG, default longest side 2048 and quality 85. The EXIF rotation is built into the pixels. All EXIF
is gone, so the location is too. See-through parts of a PNG become white.

**Know:** `pickFile` keeps a picture's EXIF, location included, as the file is copied byte for byte. To share one, pass it through
`Media.edit` first.

The result has a `status`: `ok`, `cancelled`, `lost` (no answer came, as the app was swiped away), or `failed` with a `reason`:
`no_app`, `no_activity`, `no_storage`, `busy`, `camera_denied`, `camera_blocked`, `access_lost` (pick again), `too_big`, `not_image`,
`no_space`, `read_failed`, `write_failed`, `no_photo`, `no_file`. With `ok`, `skipped` counts picked files that failed. `edit` rejects
with `invalid_crop`, `not_image`, `not_found`, `too_big`.

## After a kill

Android can kill the app while the picker or camera is open. Android then brings the app back and hands over the result, but the
promise is gone. So a screen that cares calls this while it is built:

```ts
Media.onResult((result, ack) => {
  if (result.status === "ok") photo.set(result.files[0].handle)
  ack()                                       // after you acted on it: until then it comes again at every start
})
```

If no screen listens, the result is dropped when the next pick starts.

What happens underneath, step by step:

1. **Before the other app opens**, the job is on disk: sizes, and the file the camera app writes to.
2. **Android answers.** The links go in the job, on disk, before JS hears. Only native keeps the links: JS can't send one back.
3. **JS calls `collect`** (the plugin does this), and each link is copied and compressed off the main thread.

**The right to read a link.** Android gives it to our Activity, not to our process. So it survives a kill while Android keeps the
Activity, which is the normal case: a kill while the picker is open still ends with a readable link. It ends when the Activity is gone
for good, for example when the user swipes the app away. Android's photo picker guide says only that it lasts until the app stops, so
step 2 also asks to keep the right (`takePersistableUriPermission`), and gives it back when the job ends. Most other apps refuse that,
and nothing changes. If the right is gone all the same, that file fails with `access_lost`, and the user picks again. Nothing crashes.

**A half-copied file.** A kill during step 3 leaves a file with a dot name, which no handle can name, so JS never sees it. Files move
to their final name only when whole, and flushed to disk first. `collect` runs again at the next start: whole files are kept and the
rest are done again. What is left is deleted after an hour.

**The camera app** writes straight into our folder through our `FileProvider`, for that one file, so a kill changes nothing there. If
Android kills us first, the write starts our process again, without a screen.

## Limits

- `fileDir` is Android's cache folder: Android can clear it when the phone is short of space. So a handle is for now, not for ever. Upload
  the file, then forget it. Don't save a handle across days.
- The folder can't grow for ever: after each pick the plugin deletes its files older than 7 days, then the oldest until it holds 256 MB.
  A file of the open launch is never deleted. Other plugins' files in the folder are left alone.
- One pick at a time: a second one fails with `busy`.
- HEIC works from Android 9, AVIF from Android 12. On older phones such a photo fails with `not_image`.
- A trap this plugin handles: if the app's manifest lists `CAMERA` (the scanner plugin adds it) and it isn't granted, Android refuses to
  open even the camera app. `takePhoto` asks for the permission first. An app with no `CAMERA` in its manifest never sees that dialog.
- Some camera apps ignore the file we give them. That fails with `no_photo`.

## Size

| What | Version | About |
|---|---|---|
| `androidx.exifinterface:exifinterface` | 1.4.2 | 0 KB: already in every app through Coil |

The photo picker contracts are in `androidx.activity`, which the runtime has. The plugin itself adds a few KB, and one small
`ContentProvider` at app start. Measured in the sample's R8 release, 2026-11-03 (Play download with the brotli method in `docs/startup-and-performance.md` §3): about 38 KB of classes with `exifinterface`, about 20 KB of download.
