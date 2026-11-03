# @zero-native/scanner

Scan QR codes and barcodes with the camera: a full screen (`scanner.full`) and a view inside your own screen (`scanner.qr`).
Reads codes on the phone, with no network and no Play services download.

## Add it

```kotlin
// android/settings.gradle.kts: include the project, then the app's build.gradle.kts:
implementation(project(":plugin-scanner"))

// Application.onCreate, first thing:
ZnPlugins.register(this, ScannerPlugin())
```

The plugin's manifest adds the `CAMERA` permission. You don't ask for it: the scanner does, when it opens.

## The full screen

```ts
// routes.ts: your app names its own route
scan: { path: "/scan", native: "scanner.full", safeArea: "none" },
```
```ts
const code = await nav.pushForResult<ScanResult>("scan", { title: "Scan the code", hint: "Point the camera at the code" })
if (code) use(code.value, code.format)                 // null: the user went back
```

The answer is `{ value, format }`. If Android kills the app while the scanner is open, the scanner comes back but the promise is
gone, so also listen with `onNavResult("scan", (code, ack) => { ...; ack() })` if the answer matters then.

Params, all optional (`ScannerParams`):
- Words: `title`, `hint`, `linkLabel` + `linkUrl`, `closeLabel`, `torchOnLabel`, `torchOffLabel`, `permissionTitle`, `permissionBody`,
  `blockedBody`, `allowLabel`, `settingsLabel`, `failedTitle`, `failedBody`, `retryLabel`.
- Colours, as `#RRGGBB`: `accentColor` (frame and line), `buttonColor`, `buttonTextColor`. The defaults are white on black.
- `formats`: `qr`, `aztec`, `datamatrix`, `pdf417`, `ean13`, `ean8`, `upca`, `upce`, `code128`, `code39`, `code93`, `codabar`, `itf`.
  The default is `qr` only: fewer false reads, and each frame is read faster.

`linkUrl` opens only `http` and `https`: an OTA bundle sets it, and it must not be able to open a payment link.

## The view

```tsx
import { QrScanner } from "@zero-native/scanner"

const torch = signal(false)
const again = signal(0)

<Box style={{ height: 320 }}>
  <QrScanner
    torch={torch()}
    scanKey={again()}
    onScan={(code) => check(code.value)}
    onTorchOff={() => torch.set(false)}
  />
</Box>
```

- It fills its parent, so give the parent a size.
- After the first code the camera stops and waits, as it does while your app starts a session. A new `scanKey` scans again. Use the
  view when a wrong code needs a sheet with "Scan again" over the camera: the full screen closes when it answers.
- `onPermission(state)`: `granted`, `denied` or `blocked`. `onError({ code, message })`: `camera_failed`. `active={false}` stops the camera.
- The view also takes the message words and button colours above.

`<NativeView name="scanner.qr" props={...} onEvent={...} />` works too. Events: `scanned`, `permission`, `error`, `torch`.

## What it does for you

- **Old frames.** After the camera opens, the phone can hand over an old picture, like the last counter's QR. Frames are ignored for
  500 ms, counted from the first real frame, at every open and every return.
- **Double scan.** The first code locks at once, before anything else happens. Going to the background and back doesn't unlock it.
- **Torch.** Off when the app leaves or the screen is covered, and it never comes back by itself. A view's torch stays off until you
  set the prop to false and then to true.
- **Camera.** It follows the screen it is on: off when covered, back on return, and given back when the view goes away.
- **Permission.** Asked on open, read again at every return. Refused: a message and a button. "Don't ask again": a button to settings.
  It never shows a black screen, and Close always works.

## Limits

- Android only, like the rest of zero-native today.
- One camera at a time: don't put two `QrScanner` on one screen.
- `Permissions.status(["camera"])` says `denied`, not `blocked`, if only the scanner asked: the scanner has its own dialog, as a native
  screen can't call JS. The scanner itself is always right.
- ML Kit normally starts itself when the app starts. This plugin turns that off to keep app start fast, and starts ML Kit on the first
  frame. If your app also uses another ML Kit feature, call `MlKit.initialize(context)` before you use it.
- The native code has 32-bit and x86 copies. Use `abiFilters` in your app: arm64 alone keeps the size below.

## Size

| What | Version | About |
|---|---|---|
| `com.google.mlkit:barcode-scanning` (bundled) | 17.3.0 | arm64: 4.9 MB library, 0.9 MB models, some Java |
| `androidx.camera` camera2, lifecycle, view | 1.4.2 | 34 KB of libraries, some Java |

Together about 2.3 MB of Play download and about 6.6 MB once installed, for arm64 (`experiments/exp-notes/1-result-exp1-size.md`).
Measured in the sample's R8 release, 2026-11-03 (Play download with the brotli method in `docs/startup-and-performance.md` §3): about **2.5 MB** of download (library 1.56, models 0.57, Java ≈ 0.37) and **6.6 MB** of the APK file.

This is the real bundled library: `com.google.mlkit:barcode-scanning`, with `libbarhopper_v3.so` and the models inside the AAR. It is not
`play-services-mlkit-barcode-scanning`, which downloads the model through Play services and fails on full phones.
