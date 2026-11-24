# iOS milestones and status

The iOS track in one place: what "done" means, the decisions, how to build, the phases and their steps, and for every
part of zn what iOS has and what is left. **Update it after every iOS piece**, together with the item's row in
`docs/ios-parity-checklist.md` (item-level notes) and the dated log entry in `docs/milestones.md` `## Log` (the story
of each piece: what was built, what was checked, what wasn't).

Status as of **2026-11-24** (zn main 30d895c, after the iOS gap rounds 1–4 of 2026-11-21 to 11-24; the phase notes in
§4 are dated where they say). Android (`android/runtime`, `plugins/*/android`) is the reference: iOS
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
**in progress**: it builds and runs on the simulator up to Welcome (ZB 9aebed5). On Pavan's iPhone so far: a layout look
(2026-11-09) and real FCM pushes (i.18); every other device check is in §12. The gap list of
`docs/guides/platform-differences.md` §3 was closed on the simulator in rounds 1–4 (2026-11-21 to 11-24): §5–9 say
what each piece does and what is left.

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
- Simulator "zn iPhone 16" (iOS 18.0); the gap rounds used their own simulators. Device builds exist (Pavan's iPhone 11:
  FCM pushes 2026-11-11, cold start and App Store size 2026-11-19, `docs/milestones.md`); ask Pavan before any
  device build or signing.
- Tests: `bun run test` (1666 pass on 2026-11-24; the `draw` Mac suite hit its 180 s timeout once under load and passes alone, 319 / 319), `bun run tools/ios-unit-test.ts` (the Mac unit suites,
  `ios/tests/README.md`), `bun run ios:ui-test` (XCUITest on a simulator), `bun run tools/run-core-tests-apple.ts
  --sim` (C++ core), LayoutLab route `layoutLab` (97 / 97 on 2026-11-09). `--device <name>` picks a simulator when two are booted.
- Tips (simulator taps, screenshots, swipes): `docs/ios-handoff.md`.
- The iOS 26.3 simulator runtime (23D8133) draws every emoji as a boxed "?": the system font asks for
  `Fonts/Core/AppleColorEmoji.ttc`, which that runtime doesn't have (only `CoreAddition/AppleColorEmoji-160px.ttc`), and
  the log says "Requested font not available … fallback to LastResort" (2026-11-24). Not zn: the same build draws
  them on the iOS 18.0 simulator (MotionCardsLab's 🍛).

---

## 4. Phases and steps

### Foundations (i.0 – i.4), 2026-11-08

| Step | What | Status |
|---|---|---|
| i.0 | Shared ground: Mac tools, `gen:registry` writes Swift, golden `.zn.ui` / batch files for both test suites, OTA decision logic moved to C++ | **partial**: registry Swift and the core tests on the Mac done; golden files and OTA logic in C++ not started (A1) |
| i.1a | Hermes (`hermes-ios` 260318099.0.5) + the C++ core on the simulator; the Android bundle's bytecode loads unchanged | **done** (simulator; arm64 device builds on Pavan's iPhone 11 since 2026-11-11) |
| i.1b | Renderer spike: `zn::Platform` in ObjC++, JS thread, batches on the main actor, amount screen in SwiftUI, skeleton before JS | **done**: a digit redraws 2 views of ~169 |
| i.1c | The hard parts both ways (back stack, text field, long list, sheet, presses) | **done**: UIKit for all five |
| i.2 | Milestone 2–3 equivalents: navigation, safe areas, lists, sheets, text input, animation, resilience | **done**; `zn dev` (simulator 2026-11-22, an iPhone over the LAN 2026-11-24, §8) and the registry 23 / 24 drawing (2026-11-21 to 11-23, §5–6) since |
| i.3 | Platform modules: fetch, storage, SecureStore, restore, OTA | **done** on the simulator: fetch, storage, SecureStore, restore; OTA (Phase 4a, 2026-11-10; patches 2026-11-22); OTA's phone part left |
| i.4 | Plugins in ZeroBill's order; UPI by scheme + server verify | **partial**: 20 plugin iOS sides done (§9, push and notifications included; android-ad-id has none by design); ZeroBill's Upi done, GoogleSignIn left (§10, 2.3) |

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
| 1e | A vertical Scroll with no height and no flex hugs its content up to its maxHeight (ZeroBill's checkout offers sheet); LayoutLab 47 | **done** | 9afd9ff |
| — | Fixes from Pavan's look: Tabs lab hint, border line over the Scan FAB | **done** | b0613b4 |

### Phase 2: the ZeroBill iOS app [ZB] — **in progress** (2026-11-09)
Runs in `my-app` (its own session). Details in §10.

| # | Piece | Status |
|---|---|---|
| 2.1 | Setup on the Mac: `~/zero-native` link (the app finds zn by relative path), `bun link`, `secrets.local.ts` (Pavan copies it in; until then signed calls such as OTP login answer 401) | done but the secrets file |
| 2.2 | `ios/` project (ZB 9aebed5): CMake as the zn sample, **one app id `com.example.app.ios`** (Pavan: no .dev / .staging on iOS; Debug builds use the dev API, Release production, `tools/ios.ts --api` overrides; JS reads the `AppBuild` constant), iOS 17, `myapp://` and universal links (o.example.com, get.example.com), APNs entitlement, white launch screen + `ZnSplash` hold, `GoogleService-Info.plist` from `ios/Firebase/` (gitignored), `tools/ios.ts` | done (simulator, up to Welcome) |
| 2.3 | ZeroBill's plugins on iOS (9aebed5): **Upi** done (each app's URL scheme through `ZnLaunch.open`; a return with no answer verified as RN iOS did, `IOS_RESUMED`; icons from the app's own copies); Truecaller, InAppUpdate, InstallReferrer answer no; LegacyData reads nothing yet; **GoogleSignIn: build it now** with Google's iOS SDK (Pavan, 2026-11-09), answers no until built. InAppUpdate is to be replaced by zn's `plugins/app-updates` (Windows is writing it, iOS side to build here) | partial |
| 2.4 | iOS answers for every module the bundle needs (35, §10): zn side done (Updates, Tasks, Notifications, Push on iOS; AdId answers in JS by design; Motion the stub in Release); ZeroBill's six in 2.3 | partial |
| 2.5 | The bundle unchanged on the simulator: start, login, home, scan, checkout up to the UPI app | in progress (Welcome reached; login waits for the secrets file) |
| 2.6 | Signing and a real iPhone build (needs Pavan's team; then universal links, UPI apps, camera, SMS code) | todo |

### Phase 3: notifications and push [zn + ZB] — **zn done** (i.16–i.19, 2026-11-10); ZeroBill's wiring in its session
zn: notifications (show, schedule, actions, threads, summaries, taps, swipes), FCM (token, topics, messages, taps), the
service extension, and every event for pushes iOS shows itself (i.19). Checked on the simulator and on Pavan's iPhone
(real FCM pushes, i.18). Left: ZeroBill's Flutter-style categories and event counting (its session), the server's apns
block (docs/ios-push-server-change.md in ZeroBill; Pavan and the Windows session), buttons and App Group on a device.
Original plan:
1. `@zero-native/notifications` on iOS: UNUserNotificationCenter show, schedule (64 max), actions with reply, groups
   (thread ids), taps open the link; channel calls do nothing (n/a).
2. `@zero-native/firebase-messaging` (Push) on iOS: APNs token → FCM token and topics (the backend sends through FCM);
   data messages; `PushEvents`.
3. Background runs for data messages need `Tasks` (§8). Silent pushes are throttled and never delivered after a user
   swipe: anything the user must see needs an alert payload (server decision).
4. Test on the **ZeroBill app** (it has APNs in Firebase; the sample doesn't), on a device.

### Phase 4a: OTA on iOS [zn] — **in progress** (steps 1–5 and the simulator matrix done, 2026-11-10)
Plan: docs/ios-ota-plan-2026-11-10.md (Swift copy of the Kotlin rules, no patches yet). Done: rules, check, download,
install, crash mark, rollback (ZnOta.swift, ZnOtaRules.swift, ZnOtaInstall.swift; `bun run ios:ota-test`). Apply in place
and rollback in place done (5a), the launch gate (5b), the simulator matrix (7, 18 of 18, docs/ota-test-matrix.md).
Patches (znbsdiff1) since 2026-11-22: ZnBsPatch.swift, `docs/ota-patches.md` §6.
Next: ZeroBill (6, its session), then the phone part of 7 on Pavan's iPhone. Earlier text:
The update server is now zn's own `server/` (zn-updates, `docs/zn-updates-server.md`, landing from Windows);
phones use protocol 1 unchanged (POST /v1/check, then GET the zip). Decision logic (bundle choice, health, signature rules) moved from Kotlin to C++ first so both phones share it (A1);
then Android must pass its 38-case phone matrix again. Then on iOS: bundle pool and capability manifest, download +
verify (ECDSA P-256 / SHA-256, CryptoKit), install, health facts and boot guard (MetricKit or core's crash mark),
Updates module, apply in place behind a cover. Same protocol as Android (`docs/ota.md` §3.4–3.6). About 5 days.

### Phase 4: gestures and motion [zn] — **done on the simulator; the engine is on in every build since the motion gate** (2026-11-21 to 11-24; ZeroBill uses none)
Built in the gap rounds: the engine, bindings, gestures, element values, useZoom, tilt, animateLayout, shared elements,
reorder, the plugin API (§6, §8). Since the motion gate (2026-11-24, host API 10) every build registers the real engine;
`ZN_MOTION_ENGINE=0` (Debug only) brings back the old stub for comparison (`docs/motion.md`, `docs/ota.md` §3.2). The plan as it was:
`docs/motion.md` §14 is the porting guide. Motion values, timings, formulas, bindings; gestures, element values,
shared elements, reorder, drop zones, tilt; v1.1: `useZoom`, snapping and scroll events, `keyboardDismissMode`,
width / height from a value, the transparent route; then the TSX image viewer replaces the Swift one.
The compiler half of the OTA gate is done (2026-11-21): an app file that imports `useElementMotion`, `useFrame`,
`useTilt`, `nativeMotion`, `interpolateColor`, `self` or `parent` now needs Motion 1 too (`GATED_CORE_MODULES`, a test
fails when core exports a new motion name nobody classed). The compiler also warns when a row of `<List reorderable>`
has `onLongPress`, in its JSX or a component of the same file it uses (the long press starts the drag, so iOS drops
the row's long press, Pavan's decision 7; Android may still run it, reported as an Android issue).
The gate itself closed on 2026-11-24 (W5-A, motion-ota-gate): the engine is `Motion` v1 in every build (ZnMotionNone
is gone; `ZN_MOTION_ENGINE=0` in a Debug build swaps in ZnMotionOff, the old stub), the host API is 10 (a
native-only step, bundles still need 9), and the update server sends an iOS app below 10 no bundle that requires
Motion (`tools/ota/decide.ts`, docs/ota.md §3.2). `tools/test/motion-coverage.test.ts` fails when Android's Motion
module (gestures and plugins' drivers included) or core's motion.ts has a method iOS lacks. Cost with the engine on
in a Release build: see the motion-ota-gate row in "Gestures and motion".

### Phase 5: the rest [zn] — **done on the simulator** (2026-11-21 to 11-24)
Background tasks, accessibility + font scaling, secure screens, impressions, Canvas, registry 23 / 24 drawing, media /
perf / remote-config plugins, `zn dev`, the Mac unit suites and the UI tests (§5–9, §11). Left: the phone checks (§12)
and the measurement tools (§11).

---

## 5. Components

| # | Component | iOS | Left | Size |
|---|---|---|---|---|
| 1 | Column | done | | |
| 2 | Row | done | flexWrap / alignContent / crossGap done 2026-11-09 (ZnWrapLayout.swift); gap / rowGap from a slot done 2026-11-21 | |
| 3 | Stack | done | | |
| 4 | Box | done | | |
| 5 | Text | done | `selectable` / `adjustsFontSizeToFit` / `minimumFontScale` (r23) done 2026-11-21 (7e787b2, ZnUIRules.swift). Top-level onPress / onLongPress and fontSize / lineHeight / letterSpacing from slots done 2026-11-21; Dynamic Type + maxFontScale, accessibility, `fontFamily` (r24) and motion values as text (`v.format`) done 2026-11-21 (W2-B) | §6 |
| 6 | Image | done | asset, http, file, `zn://file` handles, fallback, tint, events. `zn://app-icon` is n/a (no installed-apps icons on iOS). The picture is centred in its box for contain and cover (2026-11-09; it sat at the top left). Remote pictures' bytes on disk (Caches/zn-images, 200 MB, LRU), and two askers for one URL share one download (2026-11-23, W4-C) | |
| 7 | Pressable | done | Press feedback, runtime `disabled` and hitSlop (2026-11-12); accessibility (2026-11-21, §6) | §6 |
| 8 | Spacer | done | | |
| 9 | Icon | done | | |
| 10 | Anchor | done | | |
| 11 | List | done | Impressions (2026-11-22, §8). Window, sticky, inverted, pull to refresh (with refreshBackground), header / footer / empty, ref scroll commands (r23), `numColumns` / `columnWrapper` (r24), horizontal and the cells' environment (entry, hidden tab, touch off) done (2026-11-21; GridLab, ChatListLab, RnPropsLab). Item animation (fade / move, moves found by key), drag to reorder (UIKit drag and drop; a row's onLongPress is off, decision 7), image preload into a disk cache, scroll extras (events, paging, snap, decelerationRate, keyboardDismissMode) and an inverted list following its newest row done 2026-11-23 (W4-C; ListsTwoLab /dev/lists2, ScrollLab b, /dev/image-list; ios/tests/list). The SwiftUI variant (ZN_IOS_LIST=swiftui) does the same, scrollToOffset / viewOffset and the image preload included; review fixes 2026-11-23 (JS rows wait for a drag to end, header / footer / empty keep onLongPress, flipped fling direction, a lost SwiftUI drag goes back) | |
| 12 | Scroll | done | Pull to refresh, refreshBackground; scroll events, snapping, decelerationRate, scrollTo / scrollToEnd and keyboardDismissMode (r24) done 2026-11-21 (ZnScroll.swift, ZnScrollSnap.swift; ios/tests/scroll; ScrollLab, InputScreen) | |
| 13 | Carousel | done | `itemWidthPercent` (r23) done 2026-11-21 (7e787b2). autoAdvance pauses after a touch on plain pages too (2026-11-21; DynamicLayoutLab section 8) | S |
| 14 | Sheet | done | onDetentChange, backgroundColor and borderRadius done 2026-11-21 (235deb6; the default corner is 10 pt, Android's 24); `motion` progress 2026-11-23 (W4-A). animateIn done | |
| 15 | Fragment | done | | |
| 16 | TextField | done | autoComplete → `textContentType` (2026-11-11); editable, placeholder / colour at runtime (2026-11-21); autoCapitalize / autoCorrect, placeholderColor (#9CA3AF when not set, decision 2), selectionColor (2026-11-21, 7e787b2) | |
| 17 | NativeView | done | | |
| 18 | Svg | done | (the whole filter graph runs, as Android 12+: done 2026-11-22, ZnSvgFilters.swift, SvgLab Filters, ios/tests/svg) | |
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
| 35 | Canvas | done (simulator) | Core Graphics in a plain UIView, as Svg (ZnCanvas.swift, ZnCanvasParse.swift, ZnCanvasDraw.swift, ZnPathData.swift; 2026-11-21): every command, paint, clip, blend layer, shadow, blur on solid colours, text, paragraph and image; Android's parse rules and warning texts; Mac suite ios/tests/draw. Motion values in commands and blur on gradient / sweep paints since 2026-11-22 (b9e80d7; CanvasLab 9–11, 18, 19) | |

**Done 30** of 30 (2026-11-24; on the simulator).

---

## 6. Props and events

### Every component
| Prop | iOS | Size | Note |
|---|---|---|---|
| accessibilityLabel / Hint / Role / Hidden | done (simulator, 2026-11-21) | L | ZnAccessibility.swift: a Pressable is one element (ZnPressA11y: a button unless its role says otherwise, the label also from a slot, the hint, a disabled one dimmed, VoiceOver's activate sends onPress, a "Long press" action while JS has a handler; with a control inside, the controls stay separate and the Pressable is still its own element, read first, from its label or its plain texts). Other nodes (ZnA11y): hidden hides the subtree, a label makes one element (a role alone only adds its trait), a label slot with no string reads as unset, a labelled Image / Svg / Canvas is an image (Icon / Shimmer: read by the label) and an unlabelled one is skipped, also with a testID. Switch, Checkbox, TextField, OtpInput apply theirs on their own element. Checked with an XCUITest tree dump of /dev/a11y (A11yLab.tsx), ComponentsScreen section 8 and RnPropsLab, and with an in-app walk of the elements VoiceOver stops on (2026-11-22), which also ran each element's activate and Long press action. Still to hear on a phone with VoiceOver: the spoken words and the reading order. |
| Font scaling + maxFontScale | done (2026-11-21) | M | ZnTextStyle.swift: Text (spans too), TextField and OtpInput follow Dynamic Type through znContentSizeScale (the number JS gets), capped by maxFontScale; a Settings change redraws at once. Mac test: ios/tests/text. Check: `xcrun simctl ui <sim> content_size accessibility-extra-large` on /dev/rn-gaps and /dev/components section 8. |
| testID | done (2026-11-21) | S | accessibilityIdentifier on the element (a plain container becomes one that holds its children); fields and NativeView on their UIView. XCUITest finds fill-stack, rn-status, row-pressable-wrap, a11y-*. |
| pointerEvents | done (2026-11-21) | M | none / box-none / box-only / auto, written or from a slot, and the absolute-layer default (ZnRenderer.swift ZnPointerEventsNone / ZnPointerEventsKids / znStopsTaps, ZnPress.swift znTouchOff). A background no longer stops taps by itself, as on Android. Check: RnPropsLab pe1–pe4, PressScreen. |
| impressionKey | done (simulator, 2026-11-22) | §8 | See "Impressions" (§8). |
| Layout values from slots (width, height, min / max, flex, aspectRatio, gap, insets, radii, font sizes) (r23) | done (2026-11-21) | L | ZnTemplate.swift "now" readers, ZnDynamicValues.swift (Mac test: ios/tests/layout, `bun run tools/ios-unit-test.ts layout`). A size is read in its own ZnSizeFrame, an absolute child's insets in its own ZnChildTraits, so an animated value lays out that node alone. aspectRatio keeps both sides inside their min / max, the given side first, as Android's dynamicSize (2026-11-21 review). While section 2's width animates, only the label's Text body runs, once per change (ZnDebug counts). Check: DynamicLayoutLab sections 1–5 and 7. |
| `display: "none"` (r23) | done (2026-11-21) | M | Written or from a slot; Column / Row / Stack / wrap leave it out (no gap), other parents draw nothing. |
| Style that follows a motion value: opacity, transforms, rotateX / rotateY / cameraDistance, blurRadius, backgroundColor (a motion colour), border radii, width / height (r24) | done (engine on by default 2026-11-24; 2026-11-21) | L | ZnMotionBindings.swift, ZnMotionBindRules.swift (Mac test: ios/tests/motion). Read in leaf modifiers: a moving value runs only its node's ZnLayer (or ZnBackground, ZnPaintLayers for corners, ZnSizeFrame for a size) body, never the node, its children or JS. A node without `animate` moves its transforms with SwiftUI's own effects and no animation scopes (HWUI's order; a custom GeometryEffect left a UITextField's touch area behind). `self` / `parent` sizes through ZnSite and ZnInstance.sizeBox (gestures can reuse them); a fragment root's children read the node they are laid out in, a vertical Scroll's children its scrolled content. Cost on the simulator (60 Hz, a busy Mac, -O): 3–5 ms of main-thread time per frame for 30 bound boxes (translate, rotate, opacity), 4.5–5.5 ms with blur, rotateY and corners too, 2–2.7 ms for one; check on a 120 Hz iPhone (13 Pro or later). A transformed Pressable takes taps where it is drawn (since W3-B: its touch view sits inside the layer, ZnElementMotion.swift ZnPressInLayer). Check: MotionBindingsLab (`--route motionBindingsLab`; `--params '{"n":30}'`, `{"n":30,"mixed":true}` or `{"n":30,"playing":true}` with ZN_MOTION_PERF=1). |
| Motion `env`: window width / height, insets, keyboard height every frame, keyboard target (ids 1-8) | done (engine on by default 2026-11-24; 2026-11-22, W2-C) | M | ZnMotionEnv.swift, written by the window's root (ZnRootController): size and safe area on each layout (rotation included), the keyboard from a probe pinned to the keyboard layout guide (its presentation frame each frame while it moves; `ZN_KEYBOARD_FRAMES=1` logs them), the target when the keyboard starts to move. Lab /dev/lifecycle; MotionSheetsLab's chat bar uses it. Sheets and Modals read the same values (one root). |
| `gesture` (r24): usePan, usePinch, useRotate, useTap, useLongPress, useFling, Gesture.simultaneous / exclusive / race, requireToFail, simultaneousWith, manualActivation, snapTo, haptics | done (engine on by default 2026-11-24; 2026-11-23, W3-A) | L | Native, no JS per frame: ZnGesture.swift (model, anchors, magnets, drop zones, settle, resting on a moving anchor), ZnGestureRecognizers.swift (Android's recognizers, arbiter and touch loop), ZnGestureMath.swift, ZnVelocityTracker.swift (Compose's impulse tracker; the lift is a sample, as UIKit sends no moves for a still finger), ZnHaptics.swift. ZnGestureHub.swift: a probe inside the node's layer (taps follow a 3D-turned or dragged node), one hub per screen / Sheet / Modal (a feed recognizer and a claim recognizer); scrolls, the sheet's card pan and lists wait for a consuming gesture under the finger (the child decides first), withParent "after-edge" (shares each move with the list once the list's drag started, Compose's nested scroll, in one drag) / "simultaneous" / "block", and the back swipe leaves a horizontal pan alone (Android's exclusion band: the whole node if at most 200 pt tall, else its centre 200 pt, where it shows). As Compose's hit test, a touch goes to the frontmost gesture node under it and the nodes around it, not to a sibling it covers or a node a Pressable covers (an end mark over the node's content tells a Pressable inside it from one over it). A grab during a settle holds the card (the settle rests on its anchor only when it got there). Differences: a pan, pinch and rotation measure the fingers in the window (Android: in the node, so a node that scales or turns with its own gesture lags there, reported); links across screens / windows don't exist on either. Drop zones need element boxes (W3-B). useZoom (2026-11-23, W4-A): ZnZoom.swift, Android's ZnZoomMath and ZoomRec (pinch around the fingers, drag inside the edges, fling to the edges, rubber bands, double tap through useZoom's tap, zoomTo / reset; one finger leaves the touch to a Carousel when not zoomed or at the edge it drags toward; a finger during a zoom tween decides by where the tween goes and drags from there, so a drag right after a double tap moves the photo, not the page). VoiceOver (W4-A, ZnGestureA11yActions in ZnAccessibility.swift): a tap with a11yLabel is a button (double tap sends onEnd with accessibility: true), useZoom has zoom in / zoom out, each anchor an action that settles there (all with accessibility: true); iOS only: a one-axis pan with no anchors and both bounds is adjustable (value read only while VoiceOver or Switch Control runs). The node's own element takes them (a Pressable's, or a labelled node's: one stop); else an element behind the node inside its layer, read as the a11yLabel (GestureLab case i). Mac test: ios/tests/gestures (226 checks, ZnZoomTest's numbers, Sheet progress maths). ZN_A11Y_DUMP=<s> / ZN_A11Y_DO print and drive the accessibility tree (Debug). Check with ZN_GESTURE_LOG=1: GestureLab (`--route gestureLab`, case h: overlapping boxes), MotionPayLab, MotionVideoLab, MotionCardsLab, MotionFeedLab, MotionSheetsLab (Drawer, pushed by `zn://sample/dev/motion/sheets`), MotionMediaLab (chart), MotionExtensionLab (manual start). |
| Element values: `useElementMotion()` with `motion={m}` (box x / y / width / height, `pressed`, Scroll scrollX / scrollY, List index / offset / scroll, Carousel page, pull, `m.follow(v)`) (r24) | done (engine on by default 2026-11-24; 2026-11-23, W3-B; Sheet progress W4-A) | L | ZnElementMotion.swift (ZnElementProbe inside the node's layer: the box is where the node is drawn, written on placement, on any move of it or of a layer around it (bound transforms, SwiftUI animations, a sheet's card; during a UIKit transition it reads where the screen ends up), on a scroll around it and before measure(); `pressed` springs 0 → 1 as Android's ZnPressMotion), ZnScroll.swift / ZnList.swift (both variants) / ZnCarousel.swift / ZnTabsRefresh.swift give the readers and follow m.follow(v); a Sheet's progress (UIKit variant) comes from ZnSheetLayer each frame of its drag, slides and close (a display link reads the card's presentation layer while UIKit animates; MotionSheetsLab "Sheet", ZN_GESTURE_LOG prints each tenth); ZnElementRules.swift (Mac suite `element`). Lab elementValuesLab (`--params '{"mode":"box|scroll|list|carousel"}'`, `"followAt": n` for a follow set at mount; box: slide, drop, open as modal; carousel: hold at 1 then swipe). |
| `animateLayout` (r24) | done (simulator, 2026-11-22, W3-C) | M | ZnLayoutMotion.swift: the size as animateContentSize (ZnAnimateLayout after ZnSizeFrame: a Layout reports the animated size, places the content at its own size and clips it, so the background, border and siblings follow each frame) and the place as Android's offset (ZnAnimatePlace, outermost in styled: a new place is drawn from the old one in the same layout pass and glides, FLIP). Stepped on ZnFrameClock with the engine's curves (ZnLayoutAnim in ZnMotionMath.swift, Mac test ios/tests/motion), so a new target keeps the speed; Reduce Motion jumps. A place is the one a Column / Row / wrap / Stack gives the node in its box (LayoutSubview.znPlace, as positionInParent), so a moving or gliding ancestor starts no glide (nested animateLayout chips go with their card); the size layout measures its content only when its parent measures it, not when the placed size is passed down. `ZN_LAYOUT_MOTION_LOG=1` (debug) logs measures, placements and glides. Differences: a size from style (`height: open ? 110 : 50`) animates on iOS (Android's outer size modifier fixes it, so it may jump there: an Android issue from W3-C, not yet numbered); a node placed by another container (a Scroll's content root, a List row) uses its place in that container's coordinate space. Check: MotionCoreLab §7 (`--route motionCoreLab --params '{"run":true,"only":"layout"}'`). |
| Motion engine on by default; the OTA gate (motion-ota-gate) | done (simulator, 2026-11-24, W5-A) | S | ZnMotionModule in every build (ZnMotionNone gone; `ZN_MOTION_ENGINE=0` in a Debug build swaps in ZnMotionOff, the old stub: every call "unavailable"; Release ignores it). Host API 10 (native only), server rule (an iOS app is known by `capabilities.os` or `store.os`) and docs: docs/ota.md §3.2 "Motion on older iOS apps". `tools/test/motion-coverage.test.ts`: Android's 20 Motion functions, core's 20 methods and the device-test driver all exist on iOS, and a Release build registers ZnMotionModule as `Motion`. Checked on the simulator (iPhone, 60 Hz): MotionEngineLab 10 / 10 in Debug and in the Release package sample (also with ZN_MOTION_ENGINE=0, which Release ignores); in Debug with it, 1 / 10, every command ends at once and the log says once "Motion.animate: … done at once, nothing moves"; the TSX image viewer still opens and closes there. MotionCoreLab `run` in Release: commands, orbit / wobble drivers, derive, follow, measure all answer. Release CMake sample: GestureLab rotate, fling and a button on a draggable card; the TSX image viewer's pinch, double tap back, page drag (2 → 3 of 4) and close. Cost (rough: the simulator, not a phone), the CMake sample built Debug and Release, one meter (the main thread's CPU time from `ps -M` over 10 s, load about 3; ZN_MOTION_PERF agrees within 0.2 ms and shows 59-60 frames/s): 30 bound boxes (translate / rotate / opacity) Release 4.8 ms a frame, Debug 5.2; with blur / rotateY / corners 5.2 and 5.9; with a self-playing scale too 5.3 (Release); one box 2.2 and 2.6. About 2 ms of that is a fixed cost per frame (a `sample` of one box: SwiftUI's graph update for the hosting view), then about 0.1 ms a box. Per frame only the bound leaves run (30 Layer, plus 30 Background and 30 Paint when mixed; 0 node bodies), and ZN_COUNT_BODIES shows one batch (the mount) in 8 s of motion. Still boxes, home: 0 ms/s. On a real iPhone, still to measure (Instruments, Release): Animation Hitches and Time Profiler on MotionBindingsLab `{"n":30}` and `{"n":30,"mixed":true}` at 120 Hz (13 Pro or later): main thread under 4 ms a frame, hitch ratio under 5 ms/s; the same on a 60 Hz phone (iPhone 11 / SE); the TSX image viewer's pinch and page drag; a cold start with the engine registered against main's. |
| Negative margins | not checked | S | Needs a LayoutLab case. |
| `fontFamily` with app fonts (r24) | done (2026-11-21) | M | ZnFonts.swift / ZnFontRules.swift: the manifest's font table, the face by weight and style (CSS), a synthesized italic, the phone's fonts by Android's names, per span, TextField and OtpInput; files from the running OTA bundle, else the app's, never registered system-wide. The sample builds copy fonts/ (CMake glob, package sample script). Mac test: ios/tests/text. Check: /dev/rn-gaps sections 1–5. |
| includeFontPadding | n/a | | Android only. |

### Pressable
| Prop | iOS | Size | Note |
|---|---|---|---|
| pressFeedback, highlightColor, rippleColor / Opacity / Borderless / Radius | done | | ZnPress.swift `ZnPressFeedback`. |
| disabled at runtime | done | | 774308f. |
| hitSlop | done (2026-11-12) | S | The touch area grows by negative padding; in the slop, another Pressable under the finger wins (Android's rule). |
| Minimum touch area (44 pt) | done (simulator, 2026-11-24) | S | Decided 2026-11-24: Apple's 44 pt, centred (Android: Compose's 48 dp). ZnTouchRules.reach (hitSlop only adds; nothing for a Pressable not laid out; Mac suite uirules), ZnTouchControl.hitTest: a Pressable under the finger wins in the extra area unless it holds this one (znPressAncestors: a card around a small button), the nearer of two overlapping areas wins, and a scroll view, Sheet or screen edge clips it. UI test LabTests.testMinTouchArea (RnPropsLab). |
| A Pressable moved by `transform` takes taps where it is drawn | done (2026-11-23, W3-B) | M | The press feedback, the press look (pressScale / pressOpacity) and the touch view sit inside the node's layer (ZnPressInLayer, ZnElementMotion.swift), as Compose's pointer input inside graphicsLayer; the ripple turns and scales with it and keeps its corners. A Switch / Checkbox inside a Pressable is unchanged (A53, open). Lab elementValuesLab box. |
| Who takes the tap where Pressables overlap (Compose's hit test) | done (simulator, 2026-11-24) | M | ZnTouchControl.hitTest leaves a tap only to a Pressable inside this one (znPressAncestors, also through a List's cells and for a tappable Text) that shows under the finger (znReaches: not clipped by a Scroll or List, not in a hidden or reused cell). It was "any smaller one": a fixed Pay button over a Scroll's clipped chips did nothing, and a tap-outside backdrop over small buttons pressed the button. Lab touchLab 1-2, UI tests TouchLabTests. TextField / link-Text / Switch boxes still go by size (ZnFieldFocus.boxes, owned by the text work). |
| A Scroll, Carousel, List or plugin view inside a Pressable | done (simulator, 2026-11-24) | M | ZnPressInner.swift: one that can scroll takes the swipe (the card isn't pressed); a tap on it still presses the card through ZnPressForward (a watching recognizer: pressed after UIKit's 150 ms content delay or at a quick lift, cancelled when a scroll around the finger starts: onPressOut(true), no onPress). A plugin view that takes touches (a control, a scroll view or a recognizer under the finger) keeps them. Lab touchLab 3, UI tests TouchLabTests. Differs from Android: a swipe that starts within 150 ms sends no onPressIn / onPressOut (Android sends both, cancelled), as for a Pressable inside a scroll. |
| Quick tap inside a Scroll / List / Carousel shows the feedback | done (simulator, 2026-11-24) | S | ZnPressState.minShown: the press look shows at least 0.1 s (UIKit hands a quick tap's start and end over at the lift, so it showed nothing). Video of touchLab's quick card: ~230 ms of ripple and pressScale. The 150 ms content delay on a hold stays (a scroll that starts on a Pressable doesn't flash it, as UIKit's buttons). |
| rippleColor with its own alpha | done (2026-11-24) | S | znRippleColor: the colour's alpha is left out and the ripple's (24 %, or rippleOpacity) used, as Android's ripple (rgba(61,38,237,0.1) was 2.4 %). |

### TextField
| Prop | iOS | Size |
|---|---|---|
| autoComplete → `textContentType` (OtpInput already uses `.oneTimeCode`) | done 2026-11-11 (ZnTextField.swift) | S |
| autoCapitalize, autoCorrect | done (2026-11-21, 7e787b2; ZnUIRules.swift, Mac suite uirules) | S |
| editable (also at runtime), placeholder / colour at runtime | done (2026-11-21; a read-only one-line field takes no focus on iOS) | S |
| placeholderColor, selectionColor | done (2026-11-21, 7e787b2; #9CA3AF when not set, decision 2) | S |

### List, Scroll, Carousel, Text
| Prop | iOS | Size |
|---|---|---|
| List header / footer / empty, `scrollCommand` (r23) | done (2026-11-21; ZnList.swift, ios/tests/list) | M |
| `numColumns` / `columnWrapper` (r24) | done (2026-11-21; ZnListGrid.swift, GridLab) | M |
| Row `flexWrap` / `alignContent` / `crossGap` (r24; LayoutLab 30–37) | done (2026-11-09) | |
| Scroll onRefresh / refreshing | done (ZnScroll.swift's probe, ZnTabsRefresh.swift; the control is a subview, since SwiftUI's ScrollView owns `refreshControl` and cleared ours at its first render; a pull while the Scroll itself updates was checked 2026-11-22) | S |
| Scroll onScroll (throttled), onScrollBeginDrag / EndDrag, onMomentumScrollBegin / End (r24) | done (2026-11-21; ZnScrollDriver: contentOffset KVO, a pan target, momentum begins at the release when UIKit coasts, and a snap scroll always sends begin and end as Android's fling; onScroll at most once a frame; checked with drags and flings on the simulator, ScrollLab) | M |
| Scroll pagingEnabled, snapToInterval / Alignment, snapToOffsets, snapToStart / End, disableIntervalMomentum, decelerationRate (r24) | done (2026-11-21; Android's ZnSnap.pick through scrollTargetBehavior, a let-go with no speed snaps too, also while refreshing; the rate is UIKit's own, set again at each drag) | M |
| Scroll ref scrollTo / scrollToEnd (r24) | done (2026-11-21; once per seq on the instance, waits for the scroll view and its first layout) | S |
| Scroll keyboardDismissMode (r24) | done (2026-11-21; SwiftUI's scrollDismissesKeyboard, interactive only vertical as Android, none never closes it) | S |
| Carousel `itemWidthPercent` (r23) | done (2026-11-21, 7e787b2; the last page shown at the scroll's end) | S |
| Text `selectable`, `adjustsFontSizeToFit`, `minimumFontScale` (r23) | done (2026-11-21, 7e787b2) | S |

### Sheet, Svg
| Prop | iOS | Size |
|---|---|---|
| Sheet onDetentChange | done (2026-11-21, 235deb6; sent when a drag rests on another detent) | S |
| Sheet backgroundColor / borderRadius | done (2026-11-21, 235deb6; the whole card; default corner 10 pt, Android's 24) | S |
| Svg filters beyond a drop shadow | done (2026-11-22: every primitive the compiler keeps; a region over 4M px at a lower resolution) | |
| Svg autoMirror in RTL | not checked | S |

Registry: iOS reads up to **24** (Registry.swift generated) and draws every r23 / r24 prop and slot (2026-11-24); the
debug notice for props it didn't draw yet is gone (ZnTemplate.swift). The props with nothing to map to on iOS
(includeFontPadding, NavigationBar barStyle) are n/a above.

---

## 7. Native modules

| Module (version) | iOS | Note |
|---|---|---|
| Keyboard (2) | done | |
| Fetch (1) | done | URLSession; fetch checks 41 / 41 (iOS simulator, 2026-11-21); parallel answers fixed; upload / download progress, `FormData` files streamed from disk (200 MB checked), network-change session flush (docs/fetch.md §9). |
| SecureStore (1) | done | Keychain; an earlier install's items cleared on a new install. |
| Toast (1), Alert (1), Clipboard (1), Vibration (1) | done | |
| Permissions (1) | done | camera, microphone, contacts, notifications, location (+ precise). |
| Os (2) | done | `openUrl` opens any scheme but intent / file / javascript. |
| NetInfo (1) | done | |
| Splash (1) | done | 646b042. |
| Launches (1) | done | ack, `result`; `ZnLaunch.start / finish / open`. |
| Platform (iOS only) | done | Tells JS it runs on iOS before any code runs (A9). |
| Storage (JS) | done | C++ core + MMKV. |
| Storage native API (`ZnStorage` for app / plugin code) | done | `ZNStorage` (ZNHost.mm): string, number, boolean, bytes, `storedType`, has, remove, keys, clear, flush, in JS's format; Swift `ZnStorage.store(id)` (ZnStorage.swift). Mac test `zn_znstorage_tests` (run-core-tests-apple). /dev/storage 9 / 9 on the iOS simulator (2026-11-22: the test plugin's storageEcho / storageHammer). |
| WebSocket (1) | done | `ZnWebSocket.swift` on URLSessionWebSocketTask; lab `/dev/websocket` 28 / 28 (iOS simulator; not run on Android yet); differences in docs/fetch.md §8. |
| Updates (3) | done | Real OTA (ZnOta.swift, Phase 4a); `ZnUpdatesOff` answers only while OTA isn't configured. znbsdiff1 patches since 2026-11-22 (ZnBsPatch.swift, `docs/ota-patches.md` §6). |
| Tasks (1) | done | `ZnTasks` (2026-11-22, W2-C): JS starts with no window (`ZnApp.prepare` at launch, or `ZnTasks.run` starts it), so a plugin's task runs in a background launch; UIApplication background time is held while a task waits or runs. BGTask bridge: `ZnBackgroundTasks` (2026-11-23, W3-E). |

---

## 8. Runtime features

| Feature | iOS | Size | Note |
|---|---|---|---|
| Start: skeleton before JS, constants, DEVICE / WINDOW, insets, START | done | | 2026-11-22 (W2-C): JS may start first with no window (`ZnApp.prepare`, in the sample and the app template); START waits for the window's safe area. A second window keeps the open screens; a downloaded bundle that fails before any window rolls back in place when the window opens (checked on the simulator with a scratch OTA store and `ZN_SCENE_DELAY_MS`). WINDOW is measured by the root controller and sent again on rotation, split view and text size changes (sample and template stay portrait only: decision 5; `ZN_ROTATE=1` turns the sample). Lab /dev/lifecycle, Mac suite `lifecycle`. |
| Back stack, transitions, safe areas, keyboard option, route statusBar, BACK / FORCED_BACK / BACK_WANTED (A8), app layers | done | | Back swipe by JS policy. |
| App state, colour scheme, low memory, insets, keyboard events | done | | ZnSystemEvents.swift. |
| Keyboard avoidance | done | | |
| Animation, enter / exit, transforms, shadows | done | | |
| Deep links / onLink / OPEN, cold start by link | done | | Universal links need the associated-domains entitlement (signing, Phase 2). |
| Launches (open an app, saved results, lost after a restart) | done | | No result Intent on iOS: JS asks its server. |
| Restore after the system ends the app (stack, params, restorableSignal values) | done | | Not after a user swipe; another build's values dropped. |
| Motion plugin API: ZnMotionApi (value handles, onDispose, onFrame, registerDriver, reader) and ZnViewScope.motion / onMotion | done (engine on by default 2026-11-24; 2026-11-22, W3-C) | M | ZnMotionApi.swift mirrors ZnMotionApi.kt's three parts and names (Handle.value / onDispose, onFrame returns a FrameToken kept until it ends, registerDriver with the public ZnMotionDriver: durationNanos, value, velocity). UIKit views are not redrawn by SwiftUI, so a view also gets `scope.onMotion(name) { v in }`, called on frames where the value changed (ZnMotionEngine.onDirty; no polling per view). Lottie follows a motion `progress`; the test plugin has orbit, device.wobble and the fake view's level bar. Mac test: ios/tests/motion. Check: MotionCoreLab §6. |
| useTilt (CoreMotion gravity) | done; the signs checked on the Mac only (2026-11-22, W3-C) | S | ZnTilt.swift: deviceMotion (the accelerometer if there is none) at 50 Hz as SENSOR_DELAY_GAME, turned with the scene's interface orientation, the same 0.2 low-pass (ZnTiltFilter, ios/tests/motion), stops when the app resigns active and starts again when active with users. No permission. CoreMotion linked in CMake, SwiftPM and the CMake app template. The filter resets when the last user goes. The simulator has no motion: x / y stay 0; needs an iPhone side by side with Android, both landscapes included: the Mac suite checks iOS against one reference per rotation (Android's AccelerometerPlay turn), and Android's ZnTilt gives the opposite signs in landscape today (an Android issue from W3-C; the suite reads Android's lines, so a change there shows). |
| Splash hold | done | | Cover = launch storyboard, else UILaunchScreen colour / image. |
| Error screen, RETRY, hung JS, JS time limit | done | | |
| Native screens, native views, plugin loading (modules, screens, views, host API check, JS error / top-route listeners) | done | | |
| `zn://file` handles | done | | Caches/zn-files. `app-icon` n/a. |
| Plugin loading: activity events, batch listeners, packaging a plugin's iOS code | partial | M | Packaging done: the CMake builds compile `plugins/*/ios`, the Swift package has one `ZnPlugin<Name>` product per plugin (Package.swift, `ios/packages/firebase`, `ios/packages/lottie`). Activity events and batch listeners: iOS plugins listen to UIKit's own app and scene notifications; not compared with Android's `activityEvents` / `addBatchListener` yet. |
| A push before NAV STARTED comes in with no slide | done (simulator, 2026-11-23, W4-B) | S | As Android's openedAtStart: ZnApp marks an entry pushed before NAV STARTED (or under the splash hold); ZnNavController shows it with no slide when it is the new top; its back still slides. Lab: `--route navStartLab --params '{"then":"sharedLab"}'` logs `setViewControllers (2 screens, animated false, opened at start)`. ZN_IOS_NAV=swiftui pushes with no slide anyway (its NavigationStack follows the stack with no animation). |
| Screens kept until their exit transition ends | done (simulator, 2026-11-23, W4-B) | S | As Android's ZnNav.shown / hidden: every screen's view carries a ZnDrawnMarker (ZnSecure.swift), and a screen off the stack keeps its instances until its view has left the window (a JS pop, a finished or slow swipe, a modal spring, a see-through screen's close), then they go one main-queue turn later; one never drawn or covered goes at once. A screen still drawn 2 s after it left the stack is logged (a host bug), not freed. ZN_IOS_NAV=swiftui counts onAppear / onDisappear. Logs `nav: released <entry>` right after didShow. |
| Shared elements (`sharedTag`) between screens | done (simulator, 2026-11-23, W4-B) | L | ZnShared.swift: a tagged node has an anchor view and hides while it flies; ZnNavController gives push, pop, modal, fade and the edge swipe a ZnSharedFlight (UIKit's own push is replaced by ZnSlideAnimator only when the covered screen has tags). An Image flies as its ZnImageCache picture (contentScale, the destination's corners), anything else moves its bounds and cross-fades two snapshots scaled to the box. The edge swipe scrubs it and a cancel puts it back (`ZN_SHARED_LOG=1` logs its frames). Not for "none", a push at start, Reduce Motion, a see-through screen's own tags (as Android), Sheets / Modals, or ZN_IOS_NAV=swiftui. Works over and from see-through routes (the opaque screen under one flies) and secure routes (the flight is inside the secure container: the capture probe reads blank mid-flight). A push waits one main-queue turn for the new screen's layout (60–120 ms on the simulator). Labs: `--route sharedLab`, `motionScreensLab`. |
| OTA (rules, pool, manifest, download / verify / install, health, Updates, apply behind a cover, patches) | partial | L (5 d) | Phase 4a: steps 1–5 and the fault matrix done on the simulator (2026-11-10); patches 2026-11-22; ZeroBill (6) and the phone check left. |
| Background tasks (`defineTask`, TASK event) | partial | L | 2026-11-22 (W2-C): runs with no window (ZnApp.prepare; checked on the simulator with `ZN_SCENE_DELAY_MS` + `ZN_BOOT_TASK`), background time held while a task waits or runs (a 12 s task ends in the background; without it iOS suspends it; at about 30 s iOS ends the time and the task is aborted; notifyutil `dev.zeronative.sample.task` / `.task.nohold`). A real background launch (silent push, background fetch) is not run on a simulator. 2026-11-23 (W3-E): `ZnBackgroundTasks` runs a JS task from a BGTaskScheduler task (register before launch ends, Info.plist checked, schedule / refresh, the BGTask is the background time, iOS ending it aborts the JS task and ends as failed); the simulator refuses every request, so the debugger's `_simulateLaunch` finds nothing: `ZnBackgroundTasks.simulateLaunch` with a stand-in (notifyutil `dev.zeronative.sample.bgtask`, state = ms until iOS ends it) checked done, expired (JS signal aborted) and before any window; iOS ending it aborts only its own run (`ZnTasks.expire(handle)`: a no-hold `lab.wait` beside it still ends done) and ends the BGTask in the same main-thread turn. Not run with a real BGTask (needs a phone). |
| zn dev (live reload, dev error overlay) | done on the simulator (2026-11-22); a real iPhone over the LAN built and checked on the simulator by the LAN address and Bonjour (2026-11-24), not yet on a phone | L | ZnDev.swift (Debug builds only: no ZnDev symbol in a Release build), ZnDevWire.swift (Mac test: ios/tests/dev), tools/zn-dev.ts (test: tools/test/zn-dev.test.ts). The simulator reaches `bun run dev` on 127.0.0.1:8082 with no adb step; one build serves Android and the simulator at once. A build runs through ZnApp.restart (keepAll: every open screen opens again by route and params, a lone ZN_ROUTE screen too, over the start screen as Android); templates and JS come from one folder (Caches/zn-dev/<hash>), so A12 can't happen; a restart on the app's bundle later in the process runs the dev build (Android's devBytecode). The first build waits until the first screens have been up 0.5 s. Error screen (Dismiss / Reload) for JS errors (TSX-mapped by the server), build failures (file:line) and missing native modules, only once this run has talked to a dev server. Reload 0.4–1.6 s (0.6–0.8 s on a quiet Mac) (a whole runtime replacement; Android reloads in place). `ZN_DEV=0` turns it off. A real iPhone (2026-11-24): `zn dev --lan` listens on every network (IPv4 and IPv6) and advertises `_zn-dev._tcp` with dns-sd (stopped with the server however it ends); the app looks at ZN_DEV_HOST (environment), then ZNDevHost (Info.plist, the ZN_DEV_HOST build setting), then 127.0.0.1 on the simulator and Bonjour on an iPhone (a server that doesn't answer in 5 s is skipped for the next one), and logs how to turn Local Network access on when it is off (again every minute while it stays off). Bonjour never takes a server for another app (TXT app= against the build's zn-bundle.json; `zn dev --name`) and prefers the Mac the build was made on (TXT mac= against ZNDevMac); a ZNDevHost that stops answering gives way to Bonjour after 3 tries; a build without NSBonjourServices says so once and doesn't browse. NSLocalNetworkUsageDescription and NSBonjourServices are in Debug builds only (ios/cmake/ZnDev.cmake: a Debug Info.plist for CMake hosts, filled in as Release's, keeping an app's own Local Network text and Bonjour types; the packages template's build phase "zn dev keys (Debug)", and the same phase in the package sample ios/SamplePackage since 2026-11-24, tools/test/ios-builds.test.ts keeps the two scripts equal), so App Store builds never ask (checked: the packages template's and the package sample's Release builds have none). No ATS key: plain TCP. Check on a phone (not done): a Debug build on the iPhone (same Wi-Fi as the Mac), `bun run dev --lan`, allow Local Network: the Mac logs `phone connected: <name> (ios, <phone IP>)` and a save to examples/sample/src/offers.ts reloads it; "Don't Allow" on the first prompt, then Settings > Privacy & Security > Local Network on: the console says how, and it connects; ZN_DEV_HOST=<Mac IP> in the scheme connects with no Bonjour; a Debug build with NSBonjourServices removed from its Info.plist says so once; a Release archive has no NSBonjourServices, NSLocalNetworkUsageDescription, ZNDevHost or ZNDevMac. Check: `bun run dev`, then the sample on a simulator; edit examples/sample/src/offers.ts. |
| Secure screens (route `secure`) | done (simulator) | M | ZnSecure.swift (2026-11-21): while a secure screen is drawn (exit and cover animations included) the window root's content sits in a password field's canvas, so screenshots, recordings and mirroring show it blank; Sheets, Modals, layers and toasts too, not Alerts. App switcher: a plain cover in the screen's background from willResignActive (the switcher shows an inactive app live, seen without the cover), so it also shows behind Face ID, permission prompts, Control Center and Notification Center, where Android shows the screen. iOS can't refuse a screenshot as FLAG_SECURE does. The text field is not in the accessibility tree (XCUITest dump: the screens' texts and fields, no TextField around them). Checked on the iOS 26.3 and 18.0 simulators with the render server's capture (`ZN_IOS_SECURE_PROBE=1` logs blank / shows content); no iOS 17 simulator here. Still to check on a phone: side-button screenshot, Control Center recording, AirPlay / QuickTime, VoiceOver, password AutoFill on a secure screen's fields, scroll speed of a long list on a secure screen. |
| See-through screens (route `transparent`) | done (simulator) | M | ZnSeeThrough.swift (2026-11-22): the UINavigationController holds one box per opaque screen with the see-through screens over it (Android's ZnSeeThroughStrategy scene), so the screens below stay drawn and updating, a push over a see-through screen slides over both and Back brings both back. A see-through screen opens and closes alone by its route transition (the screen below stays still; android-issues A28); with "push" the edge swipe moves it alone (FORCED_BACK as after a pop). Touches: it takes them on UIKit touch views (Pressables, Scrolls, fields, plugin views, plain UIViews with gesture recognizers), field boxes, tappable Text and enabled Switch / Checkbox; elsewhere they reach the screen below (Compose's rule); SwiftUI-only taps (a plugin's SwiftUI Button, ZN_IOS_PRESS=swiftui) pass through. Showing the error screen (time limit), it takes every touch. Secure screens under it stay protected; the app switcher cover takes the colour of the screen below. ZN_IOS_NAV=swiftui draws it opaque (logged). Lab: Dev > Core lab > "Open see-through screen" / "Open sliding see-through". Not checked: rotation (the sample is portrait), restore after the system ends the app. |
| Impressions | done (simulator, 2026-11-22) | M | ZnImpressionsCore.swift (Android's ZnImpressions.kt rules: threshold 0.35 clamped 0.01–1, minMs, top screen and in front only, once per visit, 500 ms batches, flush on resign and release, reset on a restart; Mac test: ios/tests/impressions), ZnImpressions.swift (a UIKit view behind each keyed node on a tracking screen: its box in the window cut by the window, every scroll view and clipping UIKit view, and the overflow-hidden nodes around it; measured one main-queue turn after a layout or scroll, so a List row placed by its estimated size doesn't count; stops once counted; the node's structure stays the same when tracking or its key turns on or off, so what is inside keeps its state). Difference: only clipping views cut the box, not every layout around it as Android's boundsInWindow. List cells get the entry through ZnHostedEnv. Keys inside a Sheet or Modal count under the screen (2026-11-23, W4-A: their hosting controllers get the screen's entry, hidden tab and touchOff through ZnHostedEnv; lab buttons Sheet / Modal). Check: `--route offers` (OffersScreen) and `--route impressionsLab` (/dev/impressions). |
| Accessibility semantics, autofill | done (accessibility 2026-11-21; autofill hints earlier) | §6 | |
| RTL layout | not checked | S | |
| NAV EXIT, predictive back / BACK_ANSWERED timer, main-process check | n/a | | |

---

## 9. Plugins

| Plugin (folder) | Module | iOS | Note |
|---|---|---|---|
| android-play-auth | Auth | done (answers "unavailable") | No phone hint or SMS reading on iOS; OtpInput's `.oneTimeCode` fills the code. Server keeps the Android SMS format. |
| app-updates (new, from Windows) | AppUpdates | done (W2-K, 2026-11-22; the sheet itself needs an iPhone) | Store updates: Play in-app updates on Android; iOS `isUpdateAvailable` asks the App Store lookup (`storeVersion`, `appStoreId`, kept an hour), `start` shows the App Store sheet in the app (`state` declined / canceled on close; a forced one opens again on return), `setBusy` kept on disk (start isn't refused while busy, as Android), the account's storefront then the phone's region, `complete` "unavailable", `openStore()` by appStoreId. JS `confirm: appStoreUpdates`. Mac suite `plugins/app-updates`. Replaces ZeroBill's InAppUpdate. |
| android-ad-id | AdId | n/a (no iOS side, by design) | Android-only by meaning. Its JS answers `{ id: null }` when the module is missing, so nothing to build. No IDFA plugin for 0.1.0 (Pavan, 2026-11-24): an app that needs iOS ad attribution would use AdAttributionKit / SKAdNetwork, or a separate opt-in tracking plugin (plugins/android-ad-id/README.md "iOS"). |
| device-info | DeviceInfo | done | react-native-device-info's iOS answers (A13). |
| device-test | Device | done | `ios/Sample/DeviceTestPlugin.swift` (info, slowEcho, fail, mock UPI launches; orbit, the device.wobble curve and the fake view's motion `level`, W3-C). |
| document-scanner | DocumentScanner | done (fake scan; Photos import on the simulator, W2-K) | VisionKit; pages and PDF as `zn://file`. `download` sends one `status` event; `galleryImport` asks Camera / Photos (Photos: Vision finds the paper, Core Image straightens it, `mode` filter / base); a sheet, picker or camera closed with no answer ends the scan as a cancel. Mac suite `plugins/document-scanner`. |
| firebase-app | Firebase | done | SDK by `fetch-firebase-apple.ts`; plist outside git. |
| firebase-analytics | Analytics | done | Console events not checked by Pavan yet. `zn_bundle` is the running bundle's label (ZnBundles.watchRunning, also after an update applied in place), 2026-11-21. |
| firebase-crashlytics | Crashlytics | done | dSYM upload per build; a processed crash seen in the console. Bundle keys from the running bundle, OTA outcomes as log lines and serious ones as non-fatals (ZnOta.addReportListener), JS error reasons `[label] kind in where` (2026-11-21; on the simulator the log showed the downloaded bundle's label at a cold start and a serious OTA outcome recorded; an in-place apply and the console not checked yet). |
| firebase-messaging | Push | done | Phase 3 (i.18, i.19): token, topics, messages, taps, swipes, buttons, the service extension. Data-only pushes (2026-11-21): iOS's fetchCompletionHandler answered once within 25 s (ZnTasks `answerByMs` + ZnOnce), the message kept for the next start when JS isn't up; checked on the simulator with the sample's debug hook only, in a running app (simctl push's background pushes don't reach the app delegate on the iOS 26 simulator); a real background wake of a suspended app and a background launch are not checked yet (a real iPhone, `push-send.ts --token … --background`). JS starts for a background launch since 2026-11-22 (ZnApp.prepare); taps wait for the screens (`ZnApp.isUIStarted`, getInitialNotification waits as Android's does); not run in a real background launch yet. |
| firebase-perf | FirebasePerf | done | 2026-11-23 (W3-E): registered in both samples (first, before the other Firebase plugins); network traces from core's fetch (`ZnFetch.addObserver`, as Android's interceptor): an HTTPMetric per fetch with `zn_bundle`, code, payload sizes, content type, `url` picks or leaves out the URL (checked on the simulator: the fetch lab's calls traced with `zn_bundle`, 41 / 41 still pass). 2026-11-22: `plugins/firebase-perf/ios` (custom traces, `screen_<route>` traces with frames / slow / frozen from a display link, `zn_bundle`), product `ZnPluginFirebasePerf`, SDK in the CMake fetch. Firebase's automatic ones are behind `PerfPlugin(automatic: true)`, default off, and the sample's Info.plist turns them off before registration (Pavan's decision open). `frames` counts display refreshes. Checked on the simulator with a local registration: custom trace, `screen_perfLab` with 425 frames, the lab's fetch traced as `https://www.gstatic.com/generate_204`, and with `automatic: false` no network traces. Mac test: ios/tests/perf. Not used by ZeroBill. |
| firebase-remote-config | FirebaseRemoteConfig | done | 2026-11-23 (W3-E): registered in both samples, on its own line as Android's SampleApp.kt. 2026-11-22: `plugins/firebase-remote-config/ios`, product `ZnPluginFirebaseRemoteConfig`, SDK in the CMake fetch. Checked on the simulator with a local registration: defaults, fetch and activate (`changed=true`, then `false` as Android), `zn_lab_greeting` from the console with source `remote`. `reset()` answers false (no reset in iOS's Firebase). A live `updated` event not seen (nobody published). Mac test: ios/tests/remote-config. Not used by ZeroBill. |
| image-viewer | ImageViewer 3 | done (Swift screen, simulator; 2026-11-10 as Android: no page skip, no paging while zoomed, Android's bar) | Swift viewer (paging zoom, swipe to close) for routes with `native: "imageviewer.full"`; module 3 adds `release`. The view `imageviewer.page` (2026-11-23, W4-D, simulator + Mac suite `plugins/image-viewer`): loads web / headers / asset / zn://file / file:// / held `data:` at the size on screen, emits `loaded` / `error`, retry, moves by `scale` / `x` / `y` each frame, cuts sharp parts of the original once the zoom rests (EXIF turns; none for mirror images). The TSX viewer (2026-11-24, W5-B, simulator + UI test ImageViewerTests): flies from the thumbnail, pages with the counter following, pinch and double tap zoom, a zoomed photo pans and hands the swipe to paging at its edge, a drag down closes with the backdrop fading (flight back on the start photo, fade on another), the close button, `{ index }` answered, VoiceOver labels ("Photo n of count", the close label, the alt), errors with retry, web / headers / asset / file / `data:`; the photo is centred (a List has no safe area inside, ZnList.swift); turning the screen while open (ZN_ROTATE=1) keeps the photo in place, full screen (safeArea none frees the sides, ZnNavHost.swift; a sideways List keeps its first item when its width changes, ZnList.swift), the bar clear of the side insets. While it opens (see-through) its layers take touches, as on Android (an absolute layer stops taps on a see-through screen, ZnSeeThrough.swift; lab case "Invisible layer"). Checked on iOS 26 and iOS 18.0. Needs the motion engine; no Back button on iOS. |
| location | Location 2 | done | Core Location, CLGeocoder; `turnOn` / `providers` n/a (A14). |
| lottie | Lottie | done | lottie-ios 4.6.1 (optional fetch). |
| markdown | — | done | JS only; Text spans checked. |
| media | Media | done | 2026-11-23 (W3-E): `plugins/media/ios` as MediaModule.kt (PHPicker with no permission, the Files picker, the camera, copies made in the picker's answer, `collect` writes JPEGs with the EXIF turn in the pixels and no EXIF, `edit`, cleanup and the 7-day / 256 MB trim), product `ZnPluginMedia`, registered in both samples. A kill while a picker is up: `lost` (the pickers run in our process). No camera (simulator): `no_app`; `ZN_MEDIA_FAKE_CAMERA=1` in debug. Checked on the simulator: pick 1 / 3 photos, cancel, a PDF, take (fake), rotate, compress, upload. Review fixes: a package from Files fails `read_failed` (checked: an .rtfd), an unknown type family matches no file, a pick right after a picker vanished is `busy`, a photo not read in 60 s fails. Mac suite `plugins/media` (115 checks). Not used by ZeroBill. |
| notifications | Notifications | done | Phase 3 (i.17): show, schedule, actions, threads, summaries, badge, categories. |
| pdf | Pdf | done | PDFKit viewer and preview. |
| scanner | Scanner | done (fake reads) | AVFoundation; `autoZoom` n/a; real camera, torch, zoom not tried. |
| webview | WebView | done | WKWebView, origin-checked bridge. W2-K: paused under a presented controller too (media suspended), `onUpload` with the count from an isolated script world (open shadow roots and showPicker() too; refused natively on iOS 18.4+), a swipe back waits for its end, reload of inline html. Mac suite `plugins/webview` (the upload script under JavaScriptCore). |

Each plugin has a Kotlin `*RulesTest.kt`. On iOS the plugins' plain rules run as Mac suites (`ios/tests/README.md`):
`plugins/app-updates`, `plugins/document-scanner`, `plugins/image-viewer`, `plugins/media`, `plugins/webview`, and
`perf`, `remote-config`, `push` (Crashlytics' rules).

---

## 10. ZeroBill on iOS

Repo `my-app` (`~/apps/my-app`, remote
`my-app`), well tested on Android. Its own plugins: `upi`, `google-signin`, `truecaller`,
`in-app-update`, `install-referrer`, `legacy-data`. ZeroBill's code uses none of registry 23's new parts and none of
motion (grep 2026-11-09). Its bundle still needs registry 24 and Motion 1, both only because `@zero-native/image-viewer`
brings its TSX screen along; ZeroBill opens the Swift one. (A debug notice listed the props iOS didn't draw yet; the list was
empty from 2026-11-22 (the last was prop 293, scrollCommand) and the notice was removed on 2026-11-24.)

### The 35 native modules its bundle needs
| State | Modules |
|---|---|
| zn, done on iOS (27) | Alert, Analytics, Auth, Clipboard, Crashlytics, DeviceInfo, DocumentScanner, Fetch, ImageViewer (3), Keyboard, Launches, Location, Lottie, NetInfo, Notifications, Os, Pdf, Permissions, Push, Scanner, SecureStore, Splash, Tasks, Toast, Updates (real OTA once the app configures it; Android's "off" answers until then), Vibration, WebView |
| zn, Motion (1) | The real engine in every build since the motion gate (2026-11-24, host API 10; §4 Phase 4). Only image-viewer's TSX screen uses it; ZeroBill doesn't open that screen |
| zn, no iOS module by design (1) | AdId (JS answers `{ id: null }`) |
| ZeroBill's own (6), Phase 2 | Upi (done), GoogleSignIn (to build; answers no meanwhile), Truecaller / InAppUpdate / InstallReferrer (answer no; InAppUpdate → zn app-updates later), LegacyData (reads nothing yet) |

### The pilot flow and its iOS state
| Step | zn side | ZeroBill side |
|---|---|---|
| Cold start by a QR link, splash held until `/init` answers | done (links, Splash hold) | Phase 2 |
| Login: phone field, OTP boxes, SMS code fill | done (OtpInput `.oneTimeCode`; TextField autoComplete → textContentType, 2026-11-11, iPhone check waits) | Phase 2; code fill needs a device |
| Home tabs, press feedback | done | Phase 2 |
| Scan a QR | done (camera untested) | Phase 2; device |
| Checkout, UPI app by scheme, back by link, server verify | done (Launches by URL, links) | Upi plugin, Phase 2; device |
| Killed while the UPI app is open → back on checkout, processing sheet at rest | done (restore, animateIn) | Phase 2; device |
| Receipts: PDF, image viewer | done | Phase 2 |
| Push (APNs + FCM) | done (Phase 3, i.16–i.19; data-only background wakes 2026-11-21 / 22, not yet on a phone) | APNs entitlement in Phase 2 |
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
| UI tests (XCUITest, `ios/SamplePackage/ZnSampleUITests`, `bun run ios:ui-test [--device <sim>] [--only Class/test] [--dump <route>]`) | done (simulator, 2026-11-24): 25 tests by testID on ComponentsScreen, the Dev hub, A11yLab, RnPropsLab, InputScreen and Dynamic Type: switches, checkboxes, progress buttons, toasts, a sheet (open, grow, toast inside, drag closed), roles, labels, disabled, long press, hitSlop, typing in fields. 5.5 min cold (build, boot, run) on the iOS 26.3 simulator, two green cold runs in a row. They found and fixed: a toast out of the accessibility tree, a tappable Text read as two elements. A Switch inside a Pressable still gives the tap to the row (A53, open; the test checks today's behaviour). Known: a burst of keys into a field that JS reformats can lose one (InputTests/testBurst, an expected failure). Not in CI yet. | M |
| Unit tests (readers, routes, animation, OTA, plugin rules) | done as Mac suites instead of an XCTest target (2026-11-21 to 11-24): `bun run tools/ios-unit-test.ts`, 25 suites, run by `bun run test` and CI (`ios/tests/README.md`) | L |
| Golden `.zn.ui` / batch files read by both test suites (i.0) | missing | M |
| Startup / frame / tabs measurements (`measure-*.ps1`, `measure-tabs.ts`) | partial: cold start on an iPhone 11 measured by hand (2026-11-19, `docs/milestones.md`); no Mac script yet | M × 3 |
| Plugin phone checks (`plugin-phone.ts`) | missing | L (2 d) |
| OTA phone matrix (38 cases) | partial: 18 iOS fault cases on the simulator (2026-11-10, docs/ota-test-matrix.md); phone part left | L (1.5 d), after OTA |
| `zn-dev.ts` without adb, `ota/cli.ts`, `push-send.ts` | done: `zn dev` reaches the simulator with no adb (2026-11-22) and an iPhone with `--lan` (2026-11-24); `push-send.ts --background` sends iOS's apns block (2026-11-21); `ota/cli.ts` runs on the Mac (its USB hint is Android's) | S × 3 |
| Macrobenchmarks (startup, typing, journey) | missing | M, device |
| Docs' `gradlew.bat` commands in Mac form (A2) | missing | S |
| **Real iPhone build** (device platform in Xcode, signing) | done for Pavan's iPhone 11 (signed Debug 2026-11-11, Release 2026-11-19); the device checks in §12 are still open | S, needs Pavan's team |

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

Full entries: `docs/android-issues-found-when-building-ios.md` (A1–A95 on 2026-11-24, most from A26 on still open; the
table below keeps only the first ones). Next number: **A96**.

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
| A22 | Android doesn't report shown / swipe / buttons for pushes FCM shows itself (iOS now does) | open, a gap |

---

## 14. Open questions

1. ~~Google sign-in on iOS~~: decided 2026-11-09, build it now (ZeroBill's plugin, Google's iOS SDK).
2. **Apple sign-in**: likely not required (login is phone OTP; Google only for the review card). Pavan to confirm.
3. **TestFlight**: now or later.
4. **Push payloads**: alert payloads for anything the user must see (iOS silent pushes are not guaranteed). Server
   decision, before Phase 3 ends.
5. ~~Secure screens~~: built 2026-11-21 (ZnSecure.swift): captures show the screen blank, the app switcher a plain cover; a phone check is still open.
6. **StatusBar / NavigationBar elements**: build, or document as route-option only.

---

## 15. Log index

Full entries are in `docs/milestones.md` `## Log`, newest first.

| Date | Piece | Commit |
|---|---|---|
| 2026-11-24 | Motion gate: the engine on by default, host API 10 (native only), no motion bundle for iOS apps below 10, method coverage test | W5-A |
| 2026-11-24 | TSX image viewer on iOS end to end (paging, zoom, close, labels); List rows laid out under the bars; UI test ImageViewerTests | W5-B |
| 2026-11-24 | See-through screens: absolute layers stop taps (even at opacity 0); a sideways List keeps its first item across a width change | W5-B review |
| 2026-11-23 | Image viewer page view `imageviewer.page` (TSX viewer's photos): loading, events, zoom values, sharp parts; ImageViewerPageLab, Mac suite | W4-D |
| 2026-11-21 | Scroll extras: events, snapping, decelerationRate, ref commands, keyboardDismissMode; pull to refresh kept through SwiftUI's updates | 6efa539 |
| 2026-11-10 | OTA step 7: the fault matrix on the simulator, 18 of 18 | i.10 |
| 2026-11-10 | AdId and Motion stubs; Updates status only to JS listeners | i.9 |
| 2026-11-10 | OTA step 5b: the launch gate and update screen (simulator) | c07563b |
| 2026-11-10 | OTA step 5a: apply in place, rollback in place (simulator) | 9aae06f |
| 2026-11-10 | OTA steps 1–4: rules, check, download, install, crash mark, rollback (simulator) | 5049461 |
| 2026-11-10 | Image viewer as Android's: one page per swipe, no paging while zoomed, Android's bar; checked in ZeroBill's Offer Details | 53bc864 |
| 2026-11-09 | Scroll with only maxHeight hugs its content; LayoutLab 97 / 97 | 9afd9ff |
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
