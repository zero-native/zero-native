# OTA bundle needs per OS (2026-11-11)

Decided by Pavan on 2026-11-11 (docs/ios-plan-2026-11-09.md §6). Built on the Mac. This doc is the plan and the record,
so the Windows machine can follow it, check it on the Lava, and make the Play build after it.

## 1. The problem

One OTA bundle (the same bytes, one serial) goes to every phone on a channel, Android and iOS. Its `zn-bundle.json`
lists what it needs (`requires`): the registry, the bytecode format, the host API, and **every native module any of
its files calls**, with versions (docs/ota.md §3.2). A phone runs a bundle only if it has all of them.

ZeroBill's bundle lists 34 modules. Four are not on iOS: **AdId** (the `android-ad-id` plugin: Android only by nature),
**Notifications** and **Push** (not built on iOS yet, Phase 3), and **Motion** (only image-viewer's TSX screen uses it;
ZeroBill opens the native viewer). So iOS refuses every ZeroBill OTA bundle as INCOMPATIBLE, though the same JS runs
fine as the built-in bundle (its calls to a missing module fail softly, and ZeroBill catches them).

Rejected (Pavan): "a module that was also missing when the store build was made doesn't count". Patchy: it guesses
from history instead of saying what the bundle needs where.

## 2. The rule

A bundle's modules have three parts: **both** OSes, **Android only**, **iOS only**. A phone needs "both" plus its own
OS's part. Still one bundle and one release for both OSes; only the needs list says more.

Nobody writes the three lists by hand. The build works them out from the package each call is in:

| Where the `nativeModule("X")` / `callNative("X", …)` call is | X counts for |
|---|---|
| `@zero-native/core`, or the app's own sources | both |
| a plugin package (`zeroNative` in its package.json) | the plugin's platforms (below) |

A plugin's platforms: `zeroNative.platforms` in its package.json when written (`["android"]`, `["ios"]` or
`["android", "ios"]`); otherwise the folders it has: `android/` (or a `zeroNative.android` entry) means Android,
`ios/` means iOS. A module called from several packages counts for every platform any of them has (versions: the
highest).

Write `platforms` when the folders don't tell the truth:
- **A plugin meant for both, not built on one OS yet**: `notifications` and `firebase-messaging` say
  `["android", "ios"]`, so iOS keeps refusing ZeroBill's bundles until Phase 3 builds them. That is right: ZeroBill
  should get push on iOS before it gets OTA there (Pavan: Notifications and Push are a must).
- **An Android-only plugin**: `android-ad-id` says `["android"]` (its folder already says so; written to be clear).

## 3. The format

`zn-bundle.json`:

```json
"requires": {
  "registry": 23, "bytecode": 99, "hostApi": 6,
  "modules": { "Alert": 1, "Fetch": 1, "Notifications": 1, "Push": 1 },
  "os": { "android": { "AdId": 1 } }
}
```

- `modules`: both OSes (as before).
- `os`: only when some module is for one OS; only the OSes that have one (`android`, `ios`). A module is in exactly one
  place.

**The signed line** (signing.ts `requiresLine`, ZnOtaSignature.kt, ZnOtaRules.swift) gets the OS parts at the end,
Android then iOS, each only when it isn't empty:

```
registry=23;bytecode=99;hostApi=6;modules=Alert:1,Fetch:1,Notifications:1,Push:1;android=AdId:1
```

A bundle with no OS parts has exactly the line it had before: its signature, its serial and the server's serial
de-duplication don't change. A bundle with OS parts can't be verified by an app built before this change (its line has
no OS parts, so the signature fails): such an app keeps its bundle and gets no OTA until it is updated. No zn app is
in a store yet, so: **make ZeroBill's Play build (store-build) after this lands** (Pavan, 2026-11-11).

## 4. The check

The phone says which OS it is: `capabilities.os` = `"android"` / `"ios"` in every check, and its own check uses it.
`missing(caps, req)` (decide.ts, ZnCapabilities.kt, ZnOtaRules.swift) checks `modules` plus `os[caps.os]`, with the
same messages as today. The server treats a check without `os` as Android (every app built before this change is
Android).

## 5. Motion: image-viewer's TSX screen as its own import

Motion counts only for files that import its API (compiler modules.ts `GATED_CORE_MODULES`). ZeroBill imports
`ImageViewer` from `@zero-native/image-viewer`, whose index also exports `ImageViewerScreen` (TSX, `useZoom`), so the
screen's file is loaded and the bundle needs Motion 1 and registry 24.

Now: `@zero-native/image-viewer` exports the API only; the screen is `@zero-native/image-viewer/screen`. Apps with the
TSX viewer route (the sample) import it from there; ZeroBill (native viewer route `imageviewer.full`) drops Motion and
registry 24 from its needs. No Motion work on iOS for ZeroBill (it is Phase 4, a big one).

## 6. What changes where

| Part | Change |
|---|---|
| compiler (`plugin.ts`, `modules.ts`) | modules per platform from the calling file's package; `requires.os` |
| `tools/bundle-info.ts`, `tools/ota/signing.ts` | the type; the line's OS parts |
| `tools/ota/decide.ts`, `tools/ota/server.ts` | `capabilities.os` (default android); `missing` with the OS part |
| `server/` (zn-updates) | the same rule through decide.ts; the dashboard shows the OS parts |
| Android runtime | `ZnBundles.Requires.os`, the line, `ZnCapabilities.missing`, `os: "android"` in the check |
| iOS runtime | the same in ZnOtaRules.swift / ZnOta.swift, `os: "ios"` |
| signature fixture | a case with OS parts, checked by the TS, Kotlin and Swift tests |
| plugins | `platforms` for notifications, firebase-messaging, android-ad-id; image-viewer `./screen` |
| sample | routes import the screen from `@zero-native/image-viewer/screen` |

## 7. After this

1. Windows: pull, run the Android unit tests and the OTA phone matrix on the Lava, then make ZeroBill's Play build.
2. Phase 3 on iOS: Notifications and Push. Then ZeroBill's bundles fit iOS, and the first real OTA on an iPhone can run.
3. Later (Pavan): publishing a release to one OS only (as Expo EAS), optional; the default stays both.
