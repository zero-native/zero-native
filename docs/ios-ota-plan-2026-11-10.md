# iOS OTA plan (2026-11-10) — Pavan: "Go as recommended" (2026-11-10)

Pavan: "OTA at launch". The order: the full Phase 4a (download, verify, bundle choice, health, rollback, Updates, the
`requires` check, the store answer) and ZeroBill's forced store screen with `openStore({ appStoreId })`. If OTA slips,
the store-answer check ships on its own. OTA touches what runs on every phone, so this is the plan first; nothing is
built until Pavan says go.

## Where things are today
- **iOS:** the app runs only the bundle inside it. `Updates` answers "updates are off" (ZnBuiltInModules.swift).
  `ZnApp.start(bundle:)` already runs a bundle from any folder, so a downloaded bundle can run with no other change.
  The JS engine can't be restarted in place yet (ZNHost has no restart).
- **Android:** all OTA logic is Kotlin (about 3,400 lines in 9 files: ZnOta, ZnBundles, ZnOtaHealth, ZnOtaInstall,
  ZnOtaGate, ZnOtaSignature, ZnCapabilities, ZnBsPatch, ZnOtaStore). It passed its 38-case phone matrix.
  The plan to move the decisions to shared C++ first (A1) is not started.
- **ZeroBill:** its store-update code only knows Play (`hasStoreChannel` accepts Android ids only; the iOS
  InAppUpdate stub always says "no update"). No iOS forced-update screen yet.

## Decision 1: Swift copy now, or shared C++ first?
| | Swift copy of the Kotlin (recommended) | Shared C++ first (A1) |
|---|---|---|
| Android risk | none: Android's OTA is not touched | Android's OTA is rewritten and must pass its 38 cases again |
| Time to iOS OTA | about 6 days | about 9–10 days |
| Later cost | two copies of the rules to keep the same | one copy |

Recommended: **copy to Swift now**, with the same rules and the same test cases as Kotlin's unit tests (ZnOtaHealthTest,
ZnBundlesTest, ZnOtaSignatureTest), so the two can't drift without a failing test. A1 stays open for after launch.

## Decision 2: what ships at launch
Recommended for launch:
- Check, download (resumed), verify, install, bundle choice, `requires` check, health and rollback, the launch gate,
  `Updates` (status, check, markHealthy, applyNow, hold, the status event), apply in place behind a cover, the store
  answer.
- **Patches later.** The phone tells the server which patch formats it reads; iOS sends none, so the server sends
  full zips. Nothing breaks and nothing is lost but download size. Patches can come in a later app version.
- **The push-triggered check comes with Phase 3** (push on iOS isn't built). Until then iOS checks at launch and on
  every return to the app (ZeroBill already asks for that: `checkIntervalMs = 0`).

## The steps (each ends with a commit and a check)
1. **Config and disk** — **done 2026-11-10** (0.5 d). `ZnOta.configure` in Swift with the same fields as Android's `Config` (server,
   channel, public keys). Files under Application Support/zn-ota, kept out of iCloud backup, same layout as Android
   (`bundles/<id>/`, `tmp/`, `current`, `state.json`, `health.json`). App id from the built-in `zn-bundle.json`.
   The sample gets a local test server config.
2. **Rules** — **done 2026-11-10** (1.5 d). Bundle choice, the `requires` check (registry, bytecode, host API, module versions), the health
   rules (1 sure crash, 2 unsure, 3 for last good; healthy after 4 s in front), signatures (CryptoKit P-256, the same
   `zn-ota-v1` texts). The Kotlin tests copied as Swift tests and passing.
3. **Check, download, install** — **done 2026-11-10** (1.5 d). `POST /v1/check` with the same fields as Android, plus
   `store: { os: "ios", version: "<CFBundleShortVersionString>" }`. Resumed download, space check, unzip only the
   listed files, check each SHA, atomic rename, `current` written last. Unzip uses zlib (ships with iOS).
4. **Start and rollback** — **done 2026-11-10** (1 d). At start: choose the bundle, run it, mark the launch; a crash before "healthy" is
   counted by a crash mark (iOS has no exit-reason API like Android's), and the next start rolls back to the last good
   bundle, else the built-in one. A new App Store version clears downloaded bundles older than the built-in one.
5. **Apply in place and the launch gate** — **done 2026-11-10** (1 d). A restart of the JS engine: Android deletes the engine and makes a new
   one (`ZnNative.destroyRuntime`); iOS's ZNHost is one shared engine today, so it gets a restart method. Covered by a screen so nothing flickers; screens reopen by route as on Android. The launch gate
   waits up to Android's limits for a critical update.
6. **ZeroBill** (in the ZeroBill session, 0.5 d). Configure OTA in MyApp.swift (Debug: staging, Release:
   production; the same two public keys as Android). `hasStoreChannel` accepts `com.example.app.ios`. A forced-update
   screen and an optional sheet for iOS that open the App Store with `AppUpdates.openStore({ appStoreId })`
   (`appStoreId` comes in the server's answer). Build zn's app-updates plugin on the Mac (written on Windows, never
   compiled).
7. **Tests** (1 d). An iOS version of the phone matrix on the simulator (simctl instead of adb): update, bad
   signature, wrong SHA, `requires` refused, crash → rollback, no space, cut download resumed, store forced / optional
   / none. Then on Pavan's iPhone: one real OTA and one forced store screen from staging.

About **7 days** in all; the store answer (part of step 3 + step 6) can ship first if OTA slips.

## What I need from Pavan
- **Go / no-go on this plan**, and on Decision 1 (Swift copy) and Decision 2 (no patches, no push check at launch).
- **The App Store id** (the number in the app's App Store link) set on the update server for `com.example.app.ios`,
  and an iOS store rule on appupdates.example.com (staging and production). If the server needs an `ios` channel
  added, that is a server change from Windows.
- Nothing secret: the public keys are already in MyApp.kt; no private key is needed on the Mac.

## Apple's rules
App Store guideline 3.3.2 allows downloaded code that runs in the app's own engine (as React Native's CodePush does),
as long as an update doesn't change what the app is for or add store-review-bypassing features. Bundle updates for
fixes and screens are fine; a new feature that needs review still goes through the store.
