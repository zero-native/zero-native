# iOS milestones and status

The iOS track in one place: what "done" means, the decisions, how to build, the phases and their steps, and for every
part of zn what iOS has and what is left. **Update it after every iOS piece**, together with the item's row in
`docs/ios-parity-checklist.md` (item-level notes) and the dated log entry in `docs/milestones.md` `## Log` (the story
of each piece: what was built, what was checked, what wasn't).

Status as of **2026-11-09, zn main 646b042**. Android (`android/runtime`, `plugins/*/android`) is the reference: iOS
keeps its contracts (same functions, answers, error codes) and writes down every difference.

Status words: **done** (on the simulator unless it says device), **partial** (what's missing is in the note),
**missing**, **n/a** (no iOS meaning; nothing to do), **waits** (deliberately later; the phase says when).
Sizes: **S** < 2 h, **M** half a day, **L** a day or more (days in brackets).

Contents: [1. Goal](#1-goal-and-done-means) · [2. Decisions](#2-decisions) · [3. Build and run](#3-build-and-run) ·
[4. Phases](#4-phases-and-steps) · [5. Components](#5-components) · [6. Props and events](#6-props-and-events) ·
[7. Native modules](#7-native-modules) · [8. Runtime features](#8-runtime-features) · [9. Plugins](#9-plugins) ·
[10. ZeroBill](#10-zerobill-on-ios) · [11. Tools and tests](#11-tools-and-tests) ·
[12. Not checked yet](#12-checked-on-the-simulator-not-on-a-device) · [13. Android issues](#13-android-issues-found-by-the-port) ·
[14. Open questions](#14-open-questions) · [15. Log](#15-log-index) · [16. Code map](#16-code-map)

---

## 1. Goal and done means

Pavan's goal (2026-11-09): the ZeroBill app on iPhone, checked the way it was checked on Android.

1. **ZeroBill on iPhone**: login with OTP (the code filled from the SMS by iOS), home tabs, scan a QR, pay by UPI (open
   the UPI app by its scheme, come back by link, verify on the server), a payment that survives the app being killed
   while the UPI app is open, receipts (PDF, image viewer), push through APNs + FCM, Crashlytics and Analytics. On a
   **real iPhone**, not only the simulator.
2. **The zn sample on iOS**: every lab that matters to ZeroBill draws and behaves as on Android.
3. **Every Android-only thing has a written iOS answer**: built, "unavailable", or "not needed" with why.

Where it stands: Phase 1 (the checkout path in zn) is **done on the simulator**. Phase 2 (ZeroBill's own iOS app) is
**in progress**: it builds and runs on the simulator up to Welcome (ZB 9aebed5). Nothing has run on a real iPhone yet.

---

## 2. Decisions

| Date | Decision | By |
|---|---|---|
| 2026-11-08 | Renderer mixes SwiftUI and UIKit per component (ARCHITECTURE §20). After the i.1c spike: **UIKit** for the back stack, presses, text fields, lists and sheets; SwiftUI inside each screen. | Pavan, spike |
| 2026-11-08 | The app shell is UIKit (`ZnRootController` → `ZnNavController`). | spike |
| 2026-11-08 | Android problems found by the port are fixed as they come and recorded in `docs/android-issues-found-when-building-ios.md`. | Pavan |
| 2026-11-09 | Work on **`main`** (the old `ios` branch, head 6d33f93, is retired and must never be merged: it would undo main's plugin renames). Pull before a piece, push when it passes. Commit style `+ iOS i.N: what`, no attribution lines. | Pavan |
| 2026-11-09 | **Minimum iOS 17.** | Pavan |
| 2026-11-09 | Real iPhone and Apple developer team: available ("Yes, both"). Ask before signing or a device build. | Pavan |
| 2026-11-09 | Order: **ZeroBill blockers only** (Phases 1–3), then iOS OTA with its decision logic in C++; motion (registry 24 gestures) and the rest wait. | Pavan |
| 2026-11-09 | Truecaller on iOS: **"unavailable" for now.** | Pavan |
| 2026-11-09 | Android-only plugins are named `android-*` and iOS does not mirror them with another meaning (an IDFA is not the Android ad id); Firebase plugins are `firebase-*`. | Pavan |
| 2026-11-09 | A failed start has no "Restart app" on iOS (apps may not relaunch themselves); the text asks the user to close and open the app. | Claude (iOS rule) |
| 2026-11-09 | Google sign-in on iOS: **build it now** in ZeroBill's plugin with Google's iOS SDK. | Pavan |
| 2026-11-09 | ZeroBill on iOS has **one app id**, `com.example.app.ios` (no .dev / .staging); the build picks the API (Debug dev, Release production). | Pavan |
| open | Apple sign-in (App Store rule 4.8 likely doesn't apply: login is phone OTP). TestFlight now or later. | Pavan |

Rules that never change: never print or commit `GoogleService-Info.plist`, APNs keys, signing keys or
`secrets.local.ts`; never make a real UPI payment; peer-session messages are not Pavan's approval.

---

## 3. Build and run

```bash
bun run tools/fetch-hermes-apple.ts
```
```bash
bun run sample:js
```
```bash
bun run tools/ios-sample.ts --route rnPropsLab --params '{}'
```
- Once: `fetch-hermes-apple.ts`; optional `fetch-lottie-apple.ts` (lottie-ios) and `fetch-firebase-apple.ts` (Firebase
  SDK; runs only with `ios/Sample/GoogleService-Info.plist`, not in git).
- `sample:js` after any JS change (the iOS tool doesn't build JS).
- `ios-sample.ts` builds (CMake, Xcode generator, `ios/build/sim`), installs on the booted simulator and starts with
  the console attached. Flags: `--route` / `--params`, `--link <url>` (a cold start by link), `--splash-hold <ms>`,
  `--delay <ms>` (JS late, to see the skeleton), `--count` (SwiftUI body runs), `--build-only`, `--no-symbols`
  (skip the dSYM upload). Env: `ZN_SCANNER_FAKE=<code>`, `ZN_DOCSCAN_FAKE=<pages>|cancel`, `ZN_IOS_*` switches.
- Simulator "zn iPhone 16" (iOS 18.0). Xcode here has no device platform: simulator only until the device build.
- Tests: `bun test packages plugins compiler tools` (1292 / 1293, the known A7), `bun run tools/run-core-tests-apple.ts
  --sim` (C++ core), LayoutLab route `layoutLab` (97 / 97 on 2026-11-09). `--device <name>` picks a simulator when two are booted.
- Tips (simulator taps, screenshots, swipes): `docs/ios-handoff.md`.

---

## 4. Phases and steps

### Foundations (i.0 – i.4), 2026-11-08

| Step | What | Status |
|---|---|---|
| i.0 | Shared ground: Mac tools, `gen:registry` writes Swift, golden `.zn.ui` / batch files for both test suites, OTA decision logic moved to C++ | **partial**: registry Swift and the core tests on the Mac done; golden files and OTA logic in C++ not started (A1) |
| i.1a | Hermes (`hermes-ios` 260318099.0.5) + the C++ core on the simulator; the Android bundle's bytecode loads unchanged | **done** (simulator; arm64 device build not tried) |
| i.1b | Renderer spike: `zn::Platform` in ObjC++, JS thread, batches on the main actor, amount screen in SwiftUI, skeleton before JS | **done**: a digit redraws 2 views of ~169 |
| i.1c | The hard parts both ways (back stack, text field, long list, sheet, presses) | **done**: UIKit for all five |
| i.2 | Milestone 2–3 equivalents: navigation, safe areas, lists, sheets, text input, animation, resilience | **done** except `zn dev` (missing) and the registry 23 / 24 drawing (§5–6) |
| i.3 | Platform modules: fetch, storage, SecureStore, restore, OTA | **partial**: fetch, storage, SecureStore, restore done; OTA missing (Phase 4a) |
| i.4 | Plugins in ZeroBill's order; UPI by scheme + server verify | **partial**: 13 plugin iOS sides done (§9); push / notifications in Phase 3; UPI in Phase 2 |

### Step 0 (2026-11-09): refresh the truth — **done** (fcb71bd)
Checklist checked against the code; registry 24 read; LayoutLab 67 / 84.

### Phase 1: the ZeroBill checkout path [zn] — **done on the simulator** (2026-11-09)

| # | Piece | Status | Commit |
|---|---|---|---|
| 1a | Deep links (cold start, while running, unmatched → `onUnmatchedLink`, tab paths, query params); launches by URL (`ZnLaunch.open`: return by link → -1 + the link, by app switch → 0, lost after a restart) | **done** | af083f8 |
| 1b | Restore after the system ends the app: stack, params, `restorableSignal` values via the scene's state restoration; not after a user swipe (Android's rule) | **done** | c7ba16e |
| 1c | Runtime `disabled`, OtpInput `.oneTimeCode` | **done** | 774308f, 46be045 |
| 1c | Press feedback: ripple from the finger, highlight, none (Android's values and timings) | **done** | 24d2d1d |
| 1c | Splash hold (`ZnSplash.holdUntilReady`, `Splash.holdUntil`) | **done** | 646b042 |
| 1c | Sheet `animateIn` (also at runtime; a sheet up on its screen's first frame) | **done** | 646b042 |
| 1c | Error screen: NAV FAILED, hung JS, RETRY, Go back, failed start; JS time limit 3 s debug / 2 s release | **done** | 646b042 |
| 1d | Registry 23 parts ZeroBill uses | **n/a**: ZeroBill's screens use none. Read from its built `main.zn.ui` 2026-11-09: the only runtime width / height / `scrollCommand` slots are in image-viewer's TSX screen (ImageViewerScreen, ViewerPhoto), which ZeroBill doesn't open (its route is `native: "imageviewer.full"`) | |
| 1d | ImageViewer module 3 (`release`), so v3 bundles get the Swift viewer | **done** | d1875c7 |
| 1d | `OsInfo.ios` in core's type (iOS already sent it) | **done** | d1875c7 |
| 1e | Layout foundations from Pavan's look at ZeroBill (2026-11-09): min / max only cap or raise (SwiftUI's `.frame(maxWidth:)` grew views to their max); pictures centred in their box; StatusBar / NavigationBar; LayoutLab cases 41–44 | **done** | a3ec5ed |
| 1e | Row `flexWrap` / `alignContent` / `crossGap` (LayoutLab 30–37; RN gaps lab §6–7) | **done** | 8339821 |
| 1e | aspectRatio with a "%" side (ZeroBill's scanner window was 0 tall); a hidden tab's Pressables no longer swallow taps on the shown tab; LayoutLab 45 | **done** | 23ea2e9 |
| 1e | From Pavan's iPhone test (2026-11-09): a box raised to its minHeight / minWidth aligns its children in the raised size (ListTile rows); sheets follow their content's height; a sheet closed while it slides in closes; LayoutLab 46 | **done** | 2e6df8e |
| 1e | A vertical Scroll with no height and no flex hugs its content up to its maxHeight (ZeroBill's checkout offers sheet); LayoutLab 47 | **done** | (this commit) |
| — | Fixes from Pavan's look: Tabs lab hint, border line over the Scan FAB | **done** | b0613b4 |

### Phase 2: the ZeroBill iOS app [ZB] — **in progress** (2026-11-09)
Runs in `my-app` (its own session). Details in §10.

| # | Piece | Status |
|---|---|---|
| 2.1 | Setup on the Mac: `~/zero-native` link (the app finds zn by relative path), `bun link`, `secrets.local.ts` (Pavan copies it in; until then signed calls such as OTP login answer 401) | done but the secrets file |
| 2.2 | `ios/` project (ZB 9aebed5): CMake as the zn sample, **one app id `com.example.app.ios`** (Pavan: no .dev / .staging on iOS; Debug builds use the dev API, Release production, `tools/ios.ts --api` overrides; JS reads the `AppBuild` constant), iOS 17, `myapp://` and universal links (o.example.com, get.example.com), APNs entitlement, white launch screen + `ZnSplash` hold, `GoogleService-Info.plist` from `ios/Firebase/` (gitignored), `tools/ios.ts` | done (simulator, up to Welcome) |
| 2.3 | ZeroBill's plugins on iOS (9aebed5): **Upi** done (each app's URL scheme through `ZnLaunch.open`; a return with no answer verified as RN iOS did, `IOS_RESUMED`; icons from the app's own copies); Truecaller, InAppUpdate, InstallReferrer answer no; LegacyData reads nothing yet; **GoogleSignIn: build it now** with Google's iOS SDK (Pavan, 2026-11-09), answers no until built. InAppUpdate is to be replaced by zn's `plugins/app-updates` (Windows is writing it, iOS side to build here) | partial |
| 2.4 | iOS answers for every module the bundle needs (34): zn side done (Updates, Tasks added; AdId / Notifications / Push fall back in JS); ZeroBill's six in 2.3 | partial |
| 2.5 | The bundle unchanged on the simulator: start, login, home, scan, checkout up to the UPI app | in progress (Welcome reached; login waits for the secrets file) |
| 2.6 | Signing and a real iPhone build (needs Pavan's team; then universal links, UPI apps, camera, SMS code) | todo |

### Phase 3: notifications and push [zn + ZB] — **todo**
1. `@zero-native/notifications` on iOS: UNUserNotificationCenter show, schedule (64 max), actions with reply, groups
   (thread ids), taps open the link; channel calls do nothing (n/a).
2. `@zero-native/firebase-messaging` (Push) on iOS: APNs token → FCM token and topics (the backend sends through FCM);
   data messages; `PushEvents`.
3. Background runs for data messages need `Tasks` (§8). Silent pushes are throttled and never delivered after a user
   swipe: anything the user must see needs an alert payload (server decision).
4. Test on the **ZeroBill app** (it has APNs in Firebase; the sample doesn't), on a device.

### Phase 4a: OTA on iOS [zn] — **todo** (after Phase 3)
The update server is now zn's own `server/` (zn-updates, `docs/zn-updates-server.md`, landing from Windows);
phones use protocol 1 unchanged (POST /v1/check, then GET the zip). Decision logic (bundle choice, health, signature rules) moved from Kotlin to C++ first so both phones share it (A1);
then Android must pass its 38-case phone matrix again. Then on iOS: bundle pool and capability manifest, download +
verify (ECDSA P-256 / SHA-256, CryptoKit), install, health facts and boot guard (MetricKit or core's crash mark),
Updates module, apply in place behind a cover. Same protocol as Android (`docs/ota.md` §3.4–3.6). About 5 days.

### Phase 4: gestures and motion [zn] — **waits** (ZeroBill uses none)
`docs/motion.md` §14 is the porting guide. Motion values, timings, formulas, bindings; gestures, element values,
shared elements, reorder, drop zones, tilt; v1.1: `useZoom`, snapping and scroll events, `keyboardDismissMode`,
width / height from a value, the transparent route; then the TSX image viewer replaces the Swift one.

### Phase 5: the rest [zn] — **waits**
Background tasks, accessibility + font scaling, secure screens, impressions, Canvas, registry 23 / 24 drawing, media /
perf / remote-config plugins, `zn dev`, the Mac tools.

---

## 5. Components

| # | Component | iOS | Left | Size |
|---|---|---|---|---|
| 1 | Column | done | | |
| 2 | Row | done | flexWrap / alignContent / crossGap done 2026-11-09 (ZnWrapLayout.swift); a runtime rowGap / gap (slot) is not applied yet (§6 layout values from slots) | |
| 3 | Stack | done | | |
| 4 | Box | done | | |
| 5 | Text | partial | Dynamic Type + maxFontScale, accessibility, `selectable` / `adjustsFontSizeToFit` / `minimumFontScale` (r23), `fontFamily` (r24) | §6 |
| 6 | Image | done | asset, http, file, `zn://file` handles, fallback, tint, events. `zn://app-icon` is n/a (no installed-apps icons on iOS). The picture is centred in its box for contain and cover (2026-11-09; it sat at the top left) | |
| 7 | Pressable | partial | hitSlop, accessibility. Press feedback and runtime `disabled` done | §6 |
| 8 | Spacer | done | | |
| 9 | Icon | done | | |
| 10 | Anchor | done | | |
| 11 | List | partial | impressions; header / footer / empty, `scrollCommand` (r23); `numColumns` / `columnWrapper` (r24). Window, sticky, inverted, pull to refresh done | |
| 12 | Scroll | partial | pull to refresh on Scroll | S |
| 13 | Carousel | partial | `itemWidthPercent` (r23) | S |
| 14 | Sheet | partial | onDetentChange; sheet colour and corner radius fixed. animateIn done | S + S |
| 15 | Fragment | done | | |
| 16 | TextField | partial | autoComplete → `textContentType`, autoCapitalize / autoCorrect, editable and placeholder / colour at runtime, placeholderColor, selectionColor | S × 4 |
| 17 | NativeView | done | | |
| 18 | Svg | done | filters other than a drop shadow (iOS difference) | |
| 19 | SvgPart | done | | |
| 20 | Switch | done | ripple on press (optional) | |
| 21 | Checkbox | done | ripple on press (optional) | |
| 22 | Spinner | done | | |
| 23 | Progress | done | | |
| 24 | Shimmer | done | | |
| 30 | Tabs | done | | |
| 31 | Modal | done | onRequestClose is n/a (no system Back) | |
| 32 | StatusBar | done (2026-11-09) | barStyle / hidden / backgroundColor per screen, newest wins (ZnSystemBars.swift) | |
| 33 | NavigationBar | done (2026-11-09) | backgroundColor fills the bottom safe area behind the home indicator; barStyle does nothing (the indicator has no colour of its own) | |
| 34 | OtpInput | done | | |
| 35 | Canvas | missing | Core Graphics, as Svg (r23); Canvas v2 waits for motion | L |

**Done 20, partial 7, missing 3** of 30.

---

## 6. Props and events

### Every component
| Prop | iOS | Size | Note |
|---|---|---|---|
| accessibilityLabel / Hint / Role / Hidden | missing | L | The UIKit press view must become the VoiceOver element. Check with VoiceOver on a device. |
| Font scaling + maxFontScale | missing | M | Fixed point sizes today, while WINDOW tells JS the real fontScale. |
| testID | missing | S | `accessibilityIdentifier`. |
| pointerEvents | missing | M | `allowsHitTesting` + the press view's hit test. |
| impressionKey | missing | §8 | |
| Layout values from slots (width, height, min / max, flex, aspectRatio, gap, insets, radii, font sizes) (r23) | missing | L | Padding and margin slots work. Check: DynamicLayoutLab. |
| `display: "none"` (r23) | missing | M | |
| Negative margins | not checked | S | Needs a LayoutLab case. |
| `fontFamily` with app fonts (r24) | missing | M | Register bundle fonts, pick the face by weight / italic. |
| includeFontPadding | n/a | | Android only. |

### Pressable
| Prop | iOS | Size | Note |
|---|---|---|---|
| pressFeedback, highlightColor, rippleColor / Opacity / Borderless / Radius | done | | ZnPress.swift `ZnPressFeedback`. |
| disabled at runtime | done | | 774308f. |
| hitSlop | missing | S | `point(inside:)`. |

### TextField
| Prop | iOS | Size |
|---|---|---|
| autoComplete → `textContentType` (OtpInput already uses `.oneTimeCode`) | missing | S |
| autoCapitalize, autoCorrect | missing | S |
| editable (also at runtime), placeholder / colour at runtime | missing | S |
| placeholderColor, selectionColor | missing | S |

### List, Scroll, Carousel, Text
| Prop | iOS | Size |
|---|---|---|
| List header / footer / empty, `scrollCommand` (r23) | missing | M |
| `numColumns` / `columnWrapper` (r24) | missing | M |
| Row `flexWrap` / `alignContent` / `crossGap` (r24; LayoutLab 30–37) | done (2026-11-09) | |
| Scroll onRefresh / refreshing | missing | S |
| Carousel `itemWidthPercent` (r23) | missing | S |
| Text `selectable`, `adjustsFontSizeToFit`, `minimumFontScale` (r23) | missing | S |

### Sheet, Svg
| Prop | iOS | Size |
|---|---|---|
| Sheet onDetentChange | missing | S |
| Sheet backgroundColor / borderRadius | partial | S |
| Svg filters beyond a drop shadow | partial | M (only if an app needs them) |
| Svg autoMirror in RTL | not checked | S |

Registry: iOS reads up to **24** (Registry.swift generated). Debug builds log each r23 / r24 prop it doesn't draw yet,
once. Release draws nothing for them: fine while bundles ship inside the app; once iOS has OTA its capability
manifest must not claim what it can't draw.

---

## 7. Native modules

| Module (version) | iOS | Note |
|---|---|---|
| Keyboard (2) | done | |
| Fetch (1) | done | URLSession; fetch checks 27 / 27; parallel answers fixed. |
| SecureStore (1) | done | Keychain; an earlier install's items cleared on a new install. |
| Toast (1), Alert (1), Clipboard (1), Vibration (1) | done | |
| Permissions (1) | done | camera, microphone, contacts, notifications, location (+ precise). |
| Os (2) | done | `openUrl` opens any scheme but intent / file / javascript. |
| NetInfo (1) | done | |
| Splash (1) | done | 646b042. |
| Launches (1) | done | ack, `result`; `ZnLaunch.start / finish / open`. |
| Platform (iOS only) | done | Tells JS it runs on iOS before any code runs (A9). |
| Storage (JS) | done | C++ core + MMKV. |
| Storage native API (`ZnStorage` for app / plugin code) | partial | Strings, remove, flush only. S. |
| WebSocket (r23) | missing | URLSessionWebSocketTask. M. |
| Updates (3) | partial | `ZnUpdatesOff`: Android's "OTA not configured" answers (status off, check NONE / OFF, applyNow off, hold, markHealthy). Real OTA: Phase 4a. |
| Tasks (1) | partial | `ZnTasks`: `done` answers; nothing starts a task on iOS yet (§8). |

---

## 8. Runtime features

| Feature | iOS | Size | Note |
|---|---|---|---|
| Start: skeleton before JS, constants, DEVICE / WINDOW, insets, START | done | | |
| Back stack, transitions, safe areas, keyboard option, route statusBar, BACK / FORCED_BACK / BACK_WANTED (A8), app layers | done | | Back swipe by JS policy. |
| App state, colour scheme, low memory, insets, keyboard events | done | | ZnSystemEvents.swift. |
| Keyboard avoidance | done | | |
| Animation, enter / exit, transforms, shadows | done | | |
| Deep links / onLink / OPEN, cold start by link | done | | Universal links need the associated-domains entitlement (signing, Phase 2). |
| Launches (open an app, saved results, lost after a restart) | done | | No result Intent on iOS: JS asks its server. |
| Restore after the system ends the app (stack, params, restorableSignal values) | done | | Not after a user swipe; another build's values dropped. |
| Splash hold | done | | Cover = launch storyboard, else UILaunchScreen colour / image. |
| Error screen, RETRY, hung JS, JS time limit | done | | |
| Native screens, native views, plugin loading (modules, screens, views, host API check, JS error / top-route listeners) | done | | |
| `zn://file` handles | done | | Caches/zn-files. `app-icon` n/a. |
| Plugin loading: activity events, batch listeners, packaging a plugin's iOS code | partial | M | Today the app compiles plugin Swift (CMake globs `plugins/*/ios`). |
| A push before NAV STARTED comes in with no slide | partial | S | Only under the splash; without it a push at START slides. |
| Screens kept until their exit transition ends | partial | S | Fixed 0.6 s release. |
| OTA (C++ rules, pool, manifest, download / verify / install, health, Updates, apply behind a cover) | missing | L (5 d) | Phase 4a. |
| Background tasks (`defineTask`, TASK event) | missing | L | BGTaskScheduler, push-triggered runs. Phase 3 needs part of it. |
| zn dev (live reload, dev error overlay) | missing | L | Simulator reaches the Mac on localhost. |
| Secure screens (route `secure`) | missing | M | Decide: blank the app-switcher snapshot, screenshot layer trick. |
| Impressions | missing | M | |
| Accessibility semantics, autofill | missing | §6 | |
| RTL layout | not checked | S | |
| NAV EXIT, predictive back / BACK_ANSWERED timer, main-process check | n/a | | |

---

## 9. Plugins

| Plugin (folder) | Module | iOS | Note |
|---|---|---|---|
| android-play-auth | Auth | done (answers "unavailable") | No phone hint or SMS reading on iOS; OtpInput's `.oneTimeCode` fills the code. Server keeps the Android SMS format. |
| app-updates (new, from Windows) | AppUpdates | todo | Store updates: Play in-app updates on Android; iOS `isUpdateAvailable` → `{ available: false }`, `openStore()` by appStoreId, start / complete "unavailable". Its Swift is written without a Mac: build and fix it here. Replaces ZeroBill's InAppUpdate. |
| android-ad-id | AdId | n/a (no iOS side) | Android-only by meaning. Its JS answers `{ id: null }` when the module is missing, so nothing to build. |
| device-info | DeviceInfo | done | react-native-device-info's iOS answers (A13). |
| device-test | Device | done | `ios/Sample/DeviceTestPlugin.swift` (info, slowEcho, fail, mock UPI launches). |
| document-scanner | DocumentScanner | done (fake scan) | VisionKit; pages and PDF as `zn://file`. |
| firebase-app | Firebase | done | SDK by `fetch-firebase-apple.ts`; plist outside git. |
| firebase-analytics | Analytics | done | Console events not checked by Pavan yet. |
| firebase-crashlytics | Crashlytics | done | dSYM upload per build; a processed crash seen in the console. |
| firebase-messaging | Push | **missing** | Phase 3. Until then its JS falls back (`token: null`, "unavailable", false). |
| firebase-perf | Perf | missing | Needs batch listeners. Not used by ZeroBill. |
| firebase-remote-config | RemoteConfig | missing | Not used by ZeroBill. |
| image-viewer | ImageViewer 3 | done (Swift screen) | Swift viewer (paging zoom, swipe to close) for routes with `native: "imageviewer.full"`; module 3 adds `release`. The TSX viewer (view `imageviewer.page`, useZoom) waits for motion: on iOS its thumbnail tap does nothing yet. |
| location | Location 2 | done | Core Location, CLGeocoder; `turnOn` / `providers` n/a (A14). |
| lottie | Lottie | done | lottie-ios 4.6.1 (optional fetch). |
| markdown | — | done | JS only; Text spans checked. |
| media | Media | missing | PHPicker, HEIC → JPEG, `edit` n/a or own screen. L (1.5 d). Not used by ZeroBill. |
| notifications | Notifications | **missing** | Phase 3. Until then its JS falls back (`shown: false`, false, [], null). |
| pdf | Pdf | done | PDFKit viewer and preview. |
| scanner | Scanner | done (fake reads) | AVFoundation; `autoZoom` n/a; real camera, torch, zoom not tried. |
| webview | WebView | done | WKWebView, origin-checked bridge. |

Each plugin has a Kotlin `*RulesTest.kt`; no iOS test target exists yet (§11).

---

## 10. ZeroBill on iOS

Repo `my-app` (`~/apps/my-app`, remote
`my-app`), well tested on Android. Its own plugins: `upi`, `google-signin`, `truecaller`,
`in-app-update`, `install-referrer`, `legacy-data`. ZeroBill's code uses none of registry 23's new parts and none of
motion (grep 2026-11-09). Its bundle still needs registry 24 and Motion 1, both only because `@zero-native/image-viewer`
brings its TSX screen along; ZeroBill opens the Swift one. The debug log's "doesn't draw a runtime value for prop 1 /
2 / 293 (registry 23)" lines at start come from that screen and are harmless for ZeroBill.

### The 34 native modules its bundle needs
| State | Modules |
|---|---|
| zn, done on iOS (23) | Alert, Analytics, Auth, Clipboard, Crashlytics, DeviceInfo, DocumentScanner, Fetch, ImageViewer (3), Keyboard, Launches, Location, Lottie, NetInfo, Os, Pdf, Permissions, Scanner, SecureStore, Splash, Toast, Vibration, WebView |
| zn, answering "off" (2) | Updates (OTA off, Android's answers), Tasks (`done`) |
| zn, no iOS module, JS falls back (4) | AdId (`{ id: null }`), Notifications and Push (Phase 3; their JS catches every call; listeners on a missing module are ignored), Motion (only image-viewer's TSX screen uses it; ZeroBill doesn't open that screen) |
| ZeroBill's own (6), Phase 2 | Upi (done), GoogleSignIn (to build; answers no meanwhile), Truecaller / InAppUpdate / InstallReferrer (answer no; InAppUpdate → zn app-updates later), LegacyData (reads nothing yet) |

### The pilot flow and its iOS state
| Step | zn side | ZeroBill side |
|---|---|---|
| Cold start by a QR link, splash held until `/init` answers | done (links, Splash hold) | Phase 2 |
| Login: phone field, OTP boxes, SMS code fill | done (OtpInput `.oneTimeCode`); TextField autoComplete missing (S) | Phase 2; code fill needs a device |
| Home tabs, press feedback | done | Phase 2 |
| Scan a QR | done (camera untested) | Phase 2; device |
| Checkout, UPI app by scheme, back by link, server verify | done (Launches by URL, links) | Upi plugin, Phase 2; device |
| Killed while the UPI app is open → back on checkout, processing sheet at rest | done (restore, animateIn) | Phase 2; device |
| Receipts: PDF, image viewer | done | Phase 2 |
| Push (APNs + FCM) | missing (Phase 3) | APNs entitlement in Phase 2 |
| Crashlytics, Analytics | done | Phase 2 (its plists) |

---

## 11. Tools and tests

| Item | Mac / iOS | Size |
|---|---|---|
| `tools/ios-sample.ts` (build, install, launch, flags) | done | |
| `tools/run-core-tests-apple.ts` (C++ core on the Mac / simulator) | done | |
| `tools/fetch-hermes-apple.ts`, `fetch-lottie-apple.ts`, `fetch-firebase-apple.ts` | done | |
| `tools/fetch-test-server.ts` (the simulator reaches localhost) | done | |
| Layout conformance screen (`layoutLab`) | done | |
| XCTest target (readers, routes, animation; plugin rules tests; OTA later) | missing | L |
| Golden `.zn.ui` / batch files read by both test suites (i.0) | missing | M |
| Startup / frame / tabs measurements (`measure-*.ps1`, `measure-tabs.ts`) | missing | M × 3 |
| Plugin phone checks (`plugin-phone.ts`) | missing | L (2 d) |
| OTA phone matrix (38 cases) | missing | L (1.5 d), after OTA |
| `zn-dev.ts` without adb, `ota/cli.ts`, `push-send.ts` | missing | S × 3 |
| Macrobenchmarks (startup, typing, journey) | missing | M, device |
| Docs' `gradlew.bat` commands in Mac form (A2) | missing | S |
| **Real iPhone build** (device platform in Xcode, signing) | missing | S, needs Pavan's team; blocks every device check |

---

## 12. Checked on the simulator, not on a device

Everything above marked done was checked on the simulator only. Waiting for a real iPhone:
- UPI apps (opening by scheme, coming back), universal links (associated domains).
- Camera: scanner reads, torch, zoom, pinch; document scanner pages.
- SMS code fill (`.oneTimeCode`), push and notifications.
- Back swipe by hand (the simulator tool can't start edge swipes), double tap and pinch in the image viewer.
- Press ripple timing side by side with Android; frame timing and startup numbers.
- Location with real GPS; battery and carrier values in device-info.
- A launch screen with an image (the sample's is empty, white).
- RTL layout, Svg autoMirror, VoiceOver.

---

## 13. Android issues found by the port

Full entries: `docs/android-issues-found-when-building-ios.md`. Next number: **A16**.

| # | Area | Status |
|---|---|---|
| A1 | OTA decision logic only in Kotlin | open (Phase 4a) |
| A2 | Tools and docs assume Windows | open (core tests done) |
| A3–A6 | Core test, fresh-clone build, Android-only core, FlowStore first write | fixed |
| A7 | `app-events.test.ts` fails in the full run on the Mac | open |
| A8 | Back gestures before JS answers skip `useBack` | fixed (Lava checked) |
| A9 | `Platform.OS` always "android" | fixed |
| A10 | Skeleton events before handlers exist | fixed on iOS; not seen on Android |
| A11 | Layout conformance on Android (alignSelf stretch, onLayout, maxWidth) | open: Android 42 / 48, fixes wait for Pavan |
| A12 | zn dev reload draws a new screen from another template | open |
| A13 | device-info iOS-only getters read native values | fixed |
| A14 | location: iOS permission names in shared JS | fixed |
| A15 | `Updates.check()` without `status` when OTA is off | fixed on Windows (lands with the zn-updates commit) |

---

## 14. Open questions

1. ~~Google sign-in on iOS~~: decided 2026-11-09, build it now (ZeroBill's plugin, Google's iOS SDK).
2. **Apple sign-in**: likely not required (login is phone OTP; Google only for the review card). Pavan to confirm.
3. **TestFlight**: now or later.
4. **Push payloads**: alert payloads for anything the user must see (iOS silent pushes are not guaranteed). Server
   decision, before Phase 3 ends.
5. **Secure screens**: what "secure" means on iOS (Phase 5).
6. **StatusBar / NavigationBar elements**: build, or document as route-option only.

---

## 15. Log index

Full entries are in `docs/milestones.md` `## Log`, newest first.

| Date | Piece | Commit |
|---|---|---|
| 2026-11-09 | Scroll with only maxHeight hugs its content; LayoutLab 97 / 97 | (this commit) |
| 2026-11-09 | Pavan's iPhone test: min raises align children; sheet height follows content; close while sliding in; LayoutLab 95 / 95 | 2e6df8e |
| 2026-11-09 | aspectRatio with a "%" side; hidden tabs' Pressables; LayoutLab 93 / 93 | 23ea2e9 |
| 2026-11-09 | flexWrap on Row (LayoutLab 91 / 91) | 8339821 |
| 2026-11-09 | Layout foundations: min / max, picture alignment, StatusBar / NavigationBar; LayoutLab 41–44 | a3ec5ed |
| 2026-11-09 | ZeroBill session's zn issues: ImageViewer 3 (`release`), `OsInfo.ios`; registry 23 log and Motion explained | d1875c7 |
| 2026-11-09 | Updates "OTA off" and Tasks modules for ZeroBill's bundle; A15 | 9290731 |
| 2026-11-09 | milestones-ios.md | 1a62100 |
| 2026-11-09 | Phase 1c: Splash hold, Sheet animateIn, error screen; JS time limit as Android | 646b042 |
| 2026-11-09 | Phase 1c: press feedback; a dev route wins over restore | 24d2d1d |
| 2026-11-09 | Phase 1b: restore after the system ends the app | c7ba16e |
| 2026-11-09 | Tabs lab hint; border lines under the children (Scan FAB line) | b0613b4 |
| 2026-11-09 | Phase 1a: deep links, launches by URL, sample Device module | af083f8 |
| 2026-11-09 | Step 0: checklist refreshed | fcb71bd |
| 2026-11-09 | iOS plan; ZeroBill blockers first; decelerationRate scale | 5f876c1, 7374593, e7ec76c, 66b4b5f |
| 2026-11-08 | i.4 document-scanner; ZnLaunch start / finish; Image loads `zn://file` | 40c146d |
| 2026-11-08 | Linking.openURL any scheme but intent / file / javascript | 75f24f1 |
| 2026-11-08 | i.4 straight ports: lottie, pdf (+ ZnHandles), webview, image-viewer | 83fcbfc, 8de2529, 8ef9dc7, 0d4f4c4 |
| 2026-11-08 | i.4 Firebase: app, Crashlytics, Analytics; dSYM upload | fe9aa90, 02bdad3 |
| 2026-11-08 | i.4 auth, device-info (A13), location (A14) | 44498fa, 9abe7b3, 9882306 |
| 2026-11-08 | i.2 reads registry 23; min beats max | 3f2272d |
| 2026-11-08 | i.4 scanner | f44ff51 |
| 2026-11-08 | i.2 alignSelf stretch in Stack and Row | 99cecd2 |
| 2026-11-08 | i.4 groundwork: plugins, native screens / views, native storage, Launches ack | 53612e9 |
| 2026-11-08 | i.2 Tabs, pull to refresh, parallel fetch answers | 881d9b9 |
| 2026-11-08 | i.2 OtpInput | 46be045 |
| 2026-11-08 | i.2 runtime `disabled`; Scroll padding | 774308f |
| 2026-11-08 | i.2 Switch, Checkbox, Spinner, Progress | 2f1d6d3 |
| 2026-11-08 | i.2 layout conformance; percent, max sizes, aspectRatio, alignSelf | be2ccc7 |
| 2026-11-08 | i.2 Svg | eb5f559 |
| 2026-11-08 | i.2 Carousel, onLayout, zIndex in rows, gradients | b6c43b8 |
| 2026-11-08 | i.2 Modal and app layers | a49e5d2 |
| 2026-11-08 | i.2 corners, borders, text decorations and spans | 6b875f7 |
| 2026-11-08 | i.2 transforms, animate, enter / exit, shadows, Image, Shimmer | 4083f02 |
| 2026-11-08 | i.2 keyboard avoidance | 8492f9d |
| 2026-11-08 | i.2 system events, UI modules; native modules | 4f6831b, bb7df33 |
| 2026-11-08 | i.2 sticky rows, absolute children, presses in a scroll | 409bd82 |
| 2026-11-08 | i.2 list window, sheet timing, multi-line field | b4f12cb |
| 2026-11-08 | i.2 route transitions, safe area, insets, status bar | 6dc0eb6 |
| 2026-11-08 | A8: native back gestures only where JS has no back handler | 4e6fd4f |
| 2026-11-08 | i.1c UIKit for the hard parts | 1198235 |
| 2026-11-08 | i.1b amount screen in SwiftUI | e17359b |
| 2026-11-08 | i.1a core and Hermes on the simulator | 30dd14b |

---

## 16. Code map

`ios/` (detail: `docs/ios-handoff.md` "Map of the iOS code"):
- `CMakeLists.txt`: core, MMKV, Hermes, ObjC++ host, `ZnRuntime/Swift/*.swift`, `Sample/*.swift`,
  `plugins/*/ios/*.swift`, optional third_party (Firebase, Lottie).
- `ZnRuntime/Host/ZNHost.{h,mm}`: the runtime on the "zn-js" thread, `zn::Platform`, native calls, time limit.
- `ZnRuntime/Swift/`: `ZnApp` (start, NAV, links, restore, retry), `ZnNavHost` (UIKit back stack), `ZnLayers` (window
  root, app layers), `ZnRenderer` / `ZnFlexLayout` / `ZnStackLayout` / `ZnTemplate` / `ZnStore` / `Readers` /
  `Registry` (generated), `ZnPress`, `ZnTextField`, `ZnOtpInput`, `ZnList`, `ZnSheet`, `ZnModal`, `ZnCarousel`,
  `ZnTabsRefresh`, `ZnControls`, `ZnText`, `ZnImage`, `ZnIcon`, `ZnSvg*`, `ZnAnimation`, `ZnModules` /
  `ZnBuiltInModules` / `ZnUiModules` (incl. `ZnSplash`) / `ZnFetch` / `ZnSystemEvents`, `ZnPlugins` (plugins,
  native screens / views, `ZnLaunch`), `ZnHandles`, `ZnErrorScreen`, `ZnImpl`, `ZnDebug`.
- `Sample/`: app and scene delegates (links, restore, splash), Info.plist, `DeviceTestPlugin.swift`.
- `plugins/<name>/ios/`: each plugin's Swift.

Every iOS file mirrors an `android/runtime` Kotlin file of the same idea: read the Kotlin first, keep its contract,
and write each iOS difference in the file's header comment and the log.
