# Android issues found while building iOS

Problems in the Android side or the shared code that the iOS port turned up. iOS work happens on the `ios` branch; Pavan
forwards these entries to sessions on his other machine (Windows, the Lava phone), which check and land them on
Android. **Add an entry whenever the iOS work finds one**, newest last, and keep each entry readable on its own: a
session reading it has no other context.

Each entry says:
- **Status:** `open` (not fixed anywhere), `fixed on ios` (fixed on the `ios` branch, waiting for an Android check),
  `checked on Android` (the phone or the Android build confirmed it; say who and when), or `won't fix` (with why).
- **Problem**, **why it matters**, **fix** (what changed, files, commit once there is one), and **check on Android**:
  what the other machine must run to confirm, because this Mac has no Android SDK.

## Summary
| # | Found | Area | Problem | Status |
|---|---|---|---|---|
| A1 | 2026-11-07 | OTA | Bundle choice, health and signature rules exist only in Kotlin | open (iOS step i.0) |
| A2 | 2026-11-07 | Tools | Tools and docs assume Windows | open (core tests done, A2 below) |
| A3 | 2026-11-08 | Core tests | The "unknown NAV kind" test used kind 11, which is now `LAYER` | fixed on ios (736b8eb) |
| A4 | 2026-11-08 | Sample | The sample doesn't build from a fresh clone (`offers-data.json` not in git) | fixed on ios (736b8eb) |
| A5 | 2026-11-08 | Core build | Shared core assumed Android: `posix_fallocate`, MMKV headers, `liblog` | fixed on ios (736b8eb) |
| A6 | 2026-11-08 | FlowStore | Without space reservation, the first write of a key rewrote the whole file and could fail on a full disk | fixed on ios (736b8eb) |
| A7 | 2026-11-08 | JS tests | `app-events.test.ts` (and since 2026-11-09 four in `calls.test.ts`) pass alone but fail in the full `bun test` run on the Mac | fixed 2026-11-19 (4f4d6a1: tests-only resets in `calls.ts` and `events.ts`; 1582 pass, 0 fail) |
| A8 | 2026-11-08 | Navigation | A back gesture that animates before JS answers (Android 13+ predictive back) cannot respect `useBack` | fixed; Android checked on the Lava 2026-11-08 (in main; predictive back on, second-opinions 184) |
| A9 | 2026-11-08 | JS (shared) | `Platform.OS` was hard-coded "android"; `Platform.select` never looked at `ios` | fixed on ios (no Android change expected) |
| A10 | 2026-11-08 | Events | An event from the first screen's skeleton (drawn before JS) can reach JS before the screen's handlers exist | not seen on Android (fixed on ios) |
| A11 | 2026-11-08 | Layout | New layout conformance screen to run on the Lava; `alignSelf: "stretch"` doesn't stretch on Android when `alignItems` doesn't; onLayout x / y inside padding; maxWidth on a stretched child | open: Android 42 / 48, fixes wait for Pavan |
| A12 | 2026-11-08 | zn dev | A reload that adds a screen draws it from another screen's template | open (found on Android; iOS has no `zn dev` yet) |
| A13 | 2026-11-08 | device-info (shared JS) | `hasDynamicIsland`, `isDisplayZoomed`, `getBrightness` now read native values (iOS); Android answers stay false / -1 | fixed on ios (check the tests) |
| A14 | 2026-11-08 | location (shared JS) | On iOS the plugin asks core's Permissions for "location" (iOS's name), not Android's two names | fixed on ios (no Android change expected) |
| A15 | 2026-11-09 | OTA (Updates) | With OTA off, `Updates.check()` answers without `status`, which its JS type promises; the sample's Updates screen throws on "Check now" | fixed 2026-11-09 (`ZnOta.kt` Module `check` adds `status` when OTA is off); not phone-checked: the sample has OTA on |
| A16 | 2026-11-10 | Build (app:js, shared) | A plain `.ts` file that imports a `.tsx` file with components fails the build: "Cannot find package 'react'" (found by the ZeroBill session; worked around in ZeroBill) | fixed 2026-11-10 (`compiler/src/plugin.ts`: such a `.ts` file is no longer loaded at build time); test in `compiler/test/build-app.test.ts`; same build for Android and iOS, nothing to check on a phone |
| A17 | 2026-11-11 | updates CLI (shared) | `updates login` writes ~/.zero-native/updates.json with `mode: 0o600`, but Node applies the mode only when it creates the file: a file made earlier (another server's login) keeps its open mode (found as rw-rw-r-- on the Mac, holding the production admin token; set to 600 by hand). Fix: `chmodSync(loginFile, 0o600)` after the write | open |
| A18 | 2026-11-11 | OTA needs (shared + Android runtime) | Every module a bundle calls counted for both OSes, so iOS refused every ZeroBill OTA bundle (AdId is Android-only). Per-OS needs written on the Mac, Kotlin included but not compiled there (Gradle couldn't download): docs/ota-requires-per-os.md | checked on Android 2026-11-10: 530 Android unit tests, OTA phone matrix 40 of 40 and updates:phone 7 of 7 on the Lava |
| A19 | 2026-11-11 | Repo (Android) | `android/gradlew` is mode 100644 in git: on the Mac `./gradlew` says "permission denied" (`bash ./gradlew` works). Fix: `git update-index --chmod=+x android/gradlew` | fixed 2026-11-19 (8e35cdd; `git ls-files -s android/gradlew` shows 100755) |
| A20 | 2026-11-11 | Plugins (shared + Android) | Native module names didn't say their plugin (`Push` in firebase-messaging, `Auth` in android-play-auth): Pavan found the dashboard's needs list confusing. Renamed to `FirebaseMessaging`, `FirebaseAnalytics`, `FirebaseCrashlytics`, `FirebasePerf`, `FirebaseRemoteConfig`, `FirebaseApp`, `FirebaseInstallations`, `AndroidAdId`, `AndroidPlayAuth` (docs/plugins.md, "Module names"); Kotlin `ZnModuleBase(...)` names changed on the Mac, not compiled there | checked on Android 2026-11-10: unit tests, ZeroBill staging on the Lava, and three production AABs (168–170) built for Pavan's Play test |
| A21 | 2026-11-11 | ZeroBill JS (shared) | ZeroBill now listens to `Push.onNotificationOpenedApp` and `Push.getInitialNotification` (for pushes iOS shows itself). They run on Android too: a tap on a notification FCM showed itself (a message with a `notification` block) now opens the push's `action`. Today's server sends `notification: {}`, so Android shows ZeroBill's own and this path isn't hit. Also: the server change for iOS (an `apns` block) is written for Pavan; Android ignores `apns` | checked on the Lava 2026-11-10 (ZeroBill dev build at 8a6156e, pushes sent with tools/push-send.ts): a data-only push (ZeroBill shows it) and a push with a `notification` block (FCM shows it), each tapped with the app behind and after the app died: one notification, one `[Push] tap`, one open in all 4 |
| A22 | 2026-11-10 | Push (Android) | Pushes the phone showed itself: iOS reports shown, swipe and buttons; Android doesn't | open, a gap |
| A23 | 2026-11-16 | Scanner (shared) | The scanner's default button said "Allow camera" (App Review 5.1.1(iv)) | changed on both |
| A24 | 2026-11-18 | Sheet / Modal (Android) | A leaving screen's Sheet / Modal stays for the exit transition on Android | open, a difference |
| A25 | 2026-11-19 | Updates (Android) | The update screen's icon check used an Android 8 class on Android 7 | fixed on the Mac, not run on a phone |
| A26 | 2026-11-21 | Layout (Android) | A child's flex from a signal is read from the parent's instance | open, not run on Android |
| A27 | 2026-11-21 | Layout (Android) | A "%" width from a signal inside a Row is a fraction of the room left, not of the Row | open, not run on Android |
| A28 | 2026-11-21 | Navigation (Android) | A transparent route with a transition other than "none" may animate the screen below it too | open, likely (code read again 2026-11-22), not run |
| A29 | 2026-11-21 | Sheet (Android) | A Sheet's backgroundColor may be painted twice (the card and the sheet's own content box) | open, possible, minor |
| A30 | 2026-11-21 | Compiler (shared) | The Motion OTA gate's name list misses some motion APIs, so a bundle using only them doesn't declare Motion | fixed in the compiler (0c522b5 on the Mac), not run on Android |
| A31 | 2026-11-21 | Lists (Android) | A reorderable List row's `onLongPress` probably fires as the drag starts (Pavan: the long press only drags) | open, not run on Android |
| A32 | 2026-11-21 | TextField (Android) | An explicit `autoCapitalize="sentences"` gives no capitals on a field with a keyboardType or a secure field | open, not run on Android |
| A33 | 2026-11-21 | Motion (Android) | After a dev reload or in-place OTA, window values (env.width …) stay 0 in JS: `reset()` keeps the old watch jobs | open, not run on Android |
| A34 | 2026-11-21 | Motion (Android) | `v.sequence([], { repeat: "forever" })` spins on the main thread (ANR) | open, not run on Android |
| A35 | 2026-11-21 | Motion (shared JS) | A motion value read in JS on a screen with no gesture never got native's values (fixed in core motion.ts) | fixed in shared JS on the Mac, not run on Android |
| A36 | 2026-11-21 | fetch (Android) | A missing / unreadable FormData file part fails as `connection_lost` mid-upload, not `invalid_request` before sending | open, not run on Android |
| A37 | 2026-11-21 | Background tasks (Android) | A kept task JS is still running may be aborted by a limit counted from `run()`, dropping its saved copy | open, possible |
| A38 | 2026-11-21 | Svg (Android) | Check the stacked drop-shadow fixture (shadow-skew.svg), especially the fallback path | open, check only |
| A39 | 2026-11-22 | Lists (Android) | An animated `scrollToOffset` to anything but 0 goes to an estimated place, off with rows of different heights | open, not run on Android |
| A40 | 2026-11-22 | Lists (Android) | An inverted List with a ListHeaderComponent: "follow the newest" may test the header, not the newest row | open, possible, not run |
| A41 | 2026-11-22 | Canvas (Android) | Canvas image loads restart on every new command list, so a slow picture never shows under a ticking chart | open, a difference (Pavan to decide) |
| A42 | 2026-11-22 | Canvas (Android) | Bad path data warns with Compose's own text, or none, and doesn't name `"d"` | open, minor |
| A43 | 2026-11-22 | Canvas (Android) | A boolean `fontWeight` in a text command is dropped with no warning | open, minor |
| A44 | 2026-11-22 | Motion (Android) | A corner slot from a null value reads 0 instead of falling back to the written corner, then borderRadius | open, not run on Android |
| A45 | 2026-11-22 | Motion (Android) | `siteUsed` misses `cameraDistanceSlot`, so a cameraDistance from `self` / `parent` alone never changes | open, not run on Android |
| A46 | 2026-11-22 | Motion (Android) | A motion value put in a `<Text>` without `format` prints raw control characters | open, minor |
| A47 | 2026-11-22 | Motion (Android) | backgroundColor, width / height and corner formulas are read with no site, so `parent.*` / `self.*` read 0 there | open, a gap (iOS matches) |
| A48 | 2026-11-22 | Motion (Android + iOS) | An `animate` `from` play towards a moving motion value restarts every frame and stays at `from` | open, a design question (Pavan to decide) |
| A49 | 2026-11-22 | Text (Android) | `maxFontScale={0}` draws the text at size 0 (a negative value, a negative scale) | open, not run on Android |
| A50 | 2026-11-22 | Accessibility (Android) | Pressable roles "link" / "text" and a tappable Text always read as a button | open, a difference (Pavan to decide) |
| A51 | 2026-11-22 | Accessibility (Android) | A labelled Box with a Switch inside: check TalkBack reads the label, then the Switch | check only |
| A52 | 2026-11-22 | Navigation (Android) | Predictive back on a see-through "push" route probably drags the screen below too | open, possible, not run |
| A53 | 2026-11-22 | Touch (Android) | A Switch or Checkbox inside a Pressable fires both onValueChange and onPress | open, a design question (Pavan to decide) |
| A54 | 2026-11-22 | Navigation (Android) | See-through lab: taps on the backdrop reach the screen below; a disabled Switch in a row only presses the row | check only |
| A55 | 2026-11-22 | Compiler (shared) | A white luminance mask whose shape has a `filter` is compiled into a clip, so the filter is lost (both platforms) | open, a one-line fix (Pavan to decide) |
| A56 | 2026-11-22 | Compiler (shared) | A filter, mask or clip in object units on text alone gets an empty box, so the text vanishes (both platforms) | open (Pavan to decide: estimate a text box or document userSpaceOnUse) |
| A57 | 2026-11-22 | Svg (Android) | A blur with one side 0 still blurs that side about half a pixel (iOS copies it) | open, minor, parity note |
| A58 | 2026-11-22 | firebase-perf (Android) | The first `screen_<route>` trace may have no `zn_bundle` | open, not run on Android |
| A59 | 2026-11-22 | firebase-perf (Android) | Smaller: a frozen frame isn't also counted slow; the 64-trace check and a reused id aren't safe | open, minor |
| A60 | 2026-11-22 | webview (Android) | Media may keep playing while the page is paused | open, not run on Android |
| A61 | 2026-11-22 | webview (Android) | Uploads: a cancelled picker on Android 14+, showPicker() and shadow-root inputs | check only |
| A62 | 2026-11-22 | webview (Android) | Reload of an inline (loadDataWithBaseURL) page may fetch the base URL instead | open, possible, not run |
| A63 | 2026-11-23 | Gestures (Android) | Pinch and rotation are measured in the node's own transformed space, so a node scaled or turned by its own gesture lags | open, Pavan to decide (rec: fix Android) |
| A64 | 2026-11-23 | Gestures (Android) | useLongPress sends `begin` twice per touch | open, Pavan to decide (rec: fix) |
| A65 | 2026-11-23 | Gestures (Android + iOS) | After snapTo, a gesture doesn't rest on the anchor and follow it when the anchor moves | open, Pavan to decide (rec: fix both) |
| A66 | 2026-11-23 | Gestures (Android) | A settle re-attaches to its old anchor even when its runs were cancelled (snapTo or a grab during a settle) | open, fixed on iOS |
| A67 | 2026-11-23 | Gestures (Android) | A pan's velocity tracker never gets the up: hold still, then lift, keeps the last move's speed | open, low |
| A68 | 2026-11-23 | Gestures (Android) | An after-edge panel being dragged through a list can be pulled back by a moving anchor | open |
| A69 | 2026-11-23 | OTA (Android) | A patch zip's listed sizes are trusted until the end: a hostile patch can make Android allocate ~1.5 GB | open (rec: check early, as iOS) |
| A70 | 2026-11-23 | Impressions (Android) | A numeric impressionKey from a slot can reach JS as "7.0" (iOS sends "7") | open |
| A71 | 2026-11-23 | Impressions (Android) | A keyed node composed before its screen's NAV IMPRESSIONS may never measure | open, possible |
| A72 | 2026-11-23 | Impressions (Android) | A second configure of the same screen drops counted-but-unsent keys | open |
| A73 | 2026-11-23 | firebase-perf (Android) | A network trace stops at the headers: no body time, and no size for chunked or gzip answers | open (Pavan: rec make Android measure the body, as iOS) |
| A74 | 2026-11-23 | firebase-perf (Android) | Only an IOException stops a network trace; another exception leaves it started | open |
| A75 | 2026-11-23 | Canvas (Android) | Canvas blur (BlurMaskFilter) and shadows (setShadowLayer) may not draw on hardware canvases before Android 9 | check (likely) |
| A76 | 2026-11-23 | Motion (Android) | animateLayout: a style size change (`height: open ? 110 : 50`) jumps instead of animating | open, Pavan to decide (rec: animate, as iOS) |
| A77 | 2026-11-23 | Motion (Android) | useTilt: x and y have the wrong sign in landscape | open, Pavan to decide (rec: fix Android) |
| A78 | 2026-11-23 | Motion (Android) | useTilt keeps its old lean for a new user or after a reload; its lifecycle observer stays | open |
| A79 | 2026-11-23 | Motion (Android) | A plugin Handle's second onDispose replaces the first | open |
| A80 | 2026-11-23 | Motion (both) | 3D turns: check the camera distance matches (iOS may turn harder than Android) | check, from iOS |
| A81 | 2026-11-24 | List (Android) | A List's scroll offset is estimated from the visible rows, so onScroll, paging and snapToInterval drift with mixed heights | open |
| A82 | 2026-11-24 | List (Android) | A reorderable List row's onLongPress still runs when the drag starts | open |
| A83 | 2026-11-24 | List (Android) | A picture on screen whose preload is still running downloads twice | check (likely) |
| A84 | 2026-11-24 | List (Android) | With itemAnimation, a List's header, footer and empty item jump; iOS fades them | open, Pavan to decide (rec: animate on Android) |
| A85 | 2026-11-24 | List (Android) | Check: rows JS adds while a reorder drag is held | check |
| A86 | 2026-11-24 | Sample (both) | Check: MotionScreensDetail's "Scan & Pay" bar | check, from iOS |
| A87 | 2026-11-24 | Gestures (Android) | useZoom: a drag right after a double tap turns the page instead of moving the photo | open |
| A88 | 2026-11-24 | Gestures (Android) | TalkBack can't move a plain bounded slider (no tap, zoom or anchors) | open, Pavan to decide (rec: add on Android) |
| A89 | 2026-11-24 | Gestures (Android) | useZoom's TalkBack zoom in / out end without `accessibility: true` | open |
| A90 | 2026-11-24 | Gestures (Android) | Check: the order TalkBack lists gesture actions | check |
| A91 | 2026-11-24 | Motion (shared) | Check: a motion value read outside derive() in a handler (env.width() gave 0 on iOS) | check (likely shared) |
| A92 | 2026-11-24 | image-viewer (Android) | Check: the image viewer page emits `error` before JS sends its props | check |
| A93 | 2026-11-24 | TextField (both) | Check: typing fast into a field that onChangeText reformats loses a key on iOS | check |
| A94 | 2026-11-24 | zn dev (Android) | zn dev on Android can only use adb reverse | open (feature gap) |
| A95 | 2026-11-24 | zn dev (Android) | zn dev's HELLO from Android has no `os`, `bytecode` or `app` | open |
| A96 | 2026-11-24 | Plugins (Android) | ZnPlugins.HOST_API's comment says it equals kHostApiVersion; they now differ on purpose | open (comment only) |
| A97 | 2026-11-24 | OTA (Android) | Android store builds made after the motion gate report hostApi 10 | check (information) |
| A98 | 2026-11-24 | image-viewer (shared) | Check: the TSX image viewer on Android after the iOS fixes (window width, side insets) | check |
| A99 | 2026-11-24 | image-viewer (both) | The image viewer's next / previous labels are never used: TalkBack has no next / previous actions | open |
| A100 | 2026-11-24 | Routes (both) | Screens under a see-through screen stay in the TalkBack tree | open, Pavan to decide |
| A101 | 2026-11-24 | image-viewer (Android) | The image viewer's invisible ✕ takes taps while the viewer opens | check |
| A102 | 2026-11-24 | Layout (Android) | Check: a Column raised by minWidth stretches its children to that width (layout case 48) | check |
| A103 | 2026-11-24 | Touch (Android) | hitSlop shrinks a small Pressable's touch area below Compose's 48 dp minimum | open |
| A104 | 2026-11-24 | Layout (Android) | A rounded Pressable clips all its children, which React Native doesn't (iOS now matches Android) | open, Pavan to decide (keep as a zn rule or drop on both) |
| A105 | 2026-11-24 | Text (Android) | numberOfLines={0} probably throws (BasicText maxLines must be at least 1) | open |
| A106 | 2026-11-24 | TextField (Android) | returnKeyType: Done keeps focus; Next may land on a read-only field or wrap | check |
| A107 | 2026-11-24 | Theme (Android) | colorScheme() reports the phone's night mode while the Light theme keeps windows and dialogs light | open, Pavan to decide |
| A108 | 2026-11-24 | Navigation and touch (Android) | Check: the iOS polish round's labs (nav race, edge swipe over a rail, touch) | check |
| A109 | 2026-11-24 | Lists (Android) | A reorderable inverted (or RTL horizontal) List likely picks and moves the wrong row | check (likely) |
| A110 | 2026-11-24 | TextField (Android) | Check: returnKeyType next in an inverted List (iOS goes down the screen; Android likely by row order) | check |
| A111 | 2026-11-24 | Layout and text (Android) | Check: round 6's lab cases (layout 50a-j and 51, text spacing, touch fixes, fade list) | check |
| A112 | 2026-11-24 | Shared (compiler) | <NativeView> allows testID and pointerEvents in its type, but the compiler rejects them | open, Pavan to decide (rec: pass them through) |
| A113 | 2026-11-25 | NativeView (Android) | <NativeView pointerEvents="none"> probably still takes touches on Android | check (likely) |
| A114 | 2026-11-25 | Layout and touch (Android) | Check: round 7's cases (layout 52, modal drag-down is iOS only, checks lab f/g, 3D turned field) | check |

---

## A1. OTA decision logic exists only in Kotlin
- **Status:** open. Planned as iOS step i.0 (`milestones.md`).
- **Problem:** which bundle runs, the launch watchdog and blocking rules, and signature checks live in
  `ZnBundles.kt`, `ZnOtaHealth.kt`, `ZnOtaSignature.kt` and `ZnOta.kt` (about 2.1k lines). iOS needs the same rules.
- **Why it matters:** two copies of safety-net rules drift apart. A phone on one platform could keep running a bundle
  the other would block. These are the rules that stop a bad OTA from bricking the app.
- **Fix (proposed):** move the decisions into the C++ core; each platform only reports facts (Android:
  `ApplicationExitInfo` reasons; iOS: MetricKit reports on the next launch). Not started.
- **Check on Android:** the whole OTA phone matrix (`bun run ota:phone`, 38 cases) after the move.

## A2. Tools and docs assume Windows
- **Status:** open. Core tests are done.
- **Problem:** `tools/*.ps1` (`run-core-tests.ps1`, `measure-startup.ps1`, `measure-frames.ps1`) and the docs'
  `.\gradlew.bat` commands only work on Windows.
- **Why it matters:** iOS work happens on a Mac, and contributors on Mac or Linux can't run the checks.
- **Fix so far:** `tools/run-core-tests-apple.ts` builds and runs the core tests on a Mac and the iOS simulator
  (no phone). Still open: Mac versions of the measuring scripts and the docs' build commands.
- **Check on Android:** nothing yet.

## A3. Stale core test for unknown NAV kinds
- **Status:** fixed on ios (commit `736b8eb`).
- **Problem:** `core/tests/core_tests.cpp` ("nav ops") sent NAV kind 11 and expected the runtime to drop it as
  unknown. Kind 11 became `LAYER` with the app layers (commit 96418b4), so the test has failed (2 checks) on the phone
  since then. Core tests only run by hand on the phone, so nobody saw it.
- **Why it matters:** a red core test nobody notices hides real failures. It's an argument for CI
  (`production-readiness.md` A3).
- **Fix:** the test sends kind 12 and expects "unknown kind 12".
- **Check on Android:** `.\tools\run-core-tests.ps1` on the phone: 166 checks, 0 failed.

## A4. The sample doesn't build from a fresh clone
- **Status:** fixed on ios (commit `736b8eb`).
- **Problem:** `examples/sample/src/offers.ts` imports `test-kit/offers-data.json`, which is in `.gitignore` (real
  offers). On a fresh clone `bun run sample:js` fails with "Cannot find module '../../../test-kit/offers-data.json'".
- **Why it matters:** anyone new (or a new machine) can't build the sample. It's a community project.
- **Fix:** `test-kit/offers-data.example.json` (made-up offers in the same shape) is committed;
  `examples/sample/build.ts` copies it to `offers-data.json` when that file is missing. A machine that has the real
  file keeps using it.
- **Check on Android:** none needed on a machine that has the real file. On a fresh clone: `bun run sample:js` works.

## A5. The shared core assumed Android
- **Status:** fixed on ios (commit `736b8eb`).
- **Problem:** three things in `core/` only built on Android:
  1. `flowstore.cpp` called `posix_fallocate`, which Apple platforms don't have.
  2. `storage.cpp` uses MMKV's C++ API. On Apple, MMKV's headers switch to their Objective-C API (`NSString` logs, a
     namespace) unless `FORCE_POSIX` is defined. MMKV's own CMake sets it, but only for MMKV's files, not ours.
  3. `core/CMakeLists.txt` linked `log` (Android's `liblog`) on every platform.
- **Fix:** `core/CMakeLists.txt` links `log` only `if(ANDROID)` and defines `FORCE_POSIX` for `zn_core_base`
  `if(APPLE)`. `flowstore.cpp` calls `posix_fallocate` only when not `__APPLE__` (Apple uses the fallback path, A6).
  The tests take their folder from `ZN_TEST_DIR` (default stays `/data/local/tmp`) and use `std::filesystem`
  instead of `std::system`, which iOS doesn't have.
- **Check on Android:** `.\gradlew.bat :sample:assembleDebug` (the CMake change), then `.\tools\run-core-tests.ps1`.

## A6. FlowStore: the first write of a key could fail on a full disk
- **Status:** fixed on ios (commit `736b8eb`).
- **Problem:** `reserve()` in `core/src/flowstore.cpp` makes sure every byte of a FlowStore file has a disk block, so a
  write into the memory map can't crash (SIGBUS) on a full disk. A file opened in a new process isn't marked reserved,
  so its first write calls `reserve()` again. Where `posix_fallocate` isn't supported, the fallback rewrites the whole
  file block by block, and on a full disk that rewrite fails, **although the write itself would fit**. This is the
  write made at payment time, right before opening the UPI app.
- **Where it happens:** on Android only on file systems where `posix_fallocate` returns `EOPNOTSUPP` / `ENOSYS` /
  `EINVAL` (not seen on the Lava). On Apple it is the only path.
- **How it was found:** the core test "a write that fits still works on the full disk" failed on the Mac.
- **Fix:** before the fallback rewrite, `reserve()` checks `fstat`: if the file is already big enough and
  `st_blocks * 512` covers it, there is nothing to fill. Side finding: APFS backs small files fully (a 16 KB file made
  with `ftruncate` has no hole; a 100 MB one does), so on Apple the test's "file with a hole" setup can't make a hole
  and prints a note instead. On Android the test still requires the hole.
- **Check on Android:** `.\tools\run-core-tests.ps1` ("flowstore: files have no holes ..." passes, no note printed).

## A7. A JS test depends on test file order
- **Status:** fixed 2026-11-19 (4f4d6a1, "core: tests pass whatever order the files run in"). `bun test` runs every
  file in one process: motion.test.ts left Motion calls nobody answered (calls.test.ts counts pending calls), and
  earlier files' startApp left app-event handlers. Tests-only resets in `calls.ts` and `events.ts`, as
  resetNativeConstantsForTests. `bun run test`: 1582 pass, 0 fail then. Nothing to check on Android beyond `bun test`
  on Windows.
- **Problem:** on the Mac, `bun test packages plugins compiler tools` gives 1164 pass, 1 fail:
  `packages/core/test/app-events.test.ts` "native calls still settle after startApp". It passes when run alone
  (`bun test packages/core/test/app-events.test.ts`). In the full run its host logs about 50 lines like "app event 12
  already has a handler; the new one replaces it": an earlier test file leaves app-event handlers installed.
  Same result without the 2026-11-08 changes.
- **2026-11-09:** now 5 fail in the full run (1387 pass): in `packages/core/test/calls.test.ts` "a typed module call
  resolves …", "errors carry a code …", "abort rejects at once …", "a screen's calls are dropped quietly …", and the
  one above. `calls.test.ts` alone: 5 pass. Same with or without that day's iOS changes.
- **Why it matters:** a test that passes or fails depending on the order hides real breakage. The order likely differs
  between Windows and the Mac.
- **Fix (proposed):** find which file installs the handlers without resetting them (run `bun test packages` and
  bisect the file list), and reset app-event handlers in `installEvents()` or in that file's teardown.
- **Check on Android:** `bun test` on Windows, and the full run on the Mac.

## A8. Back gestures that animate before JS answers skip `useBack`
- **Status:** fixed on ios, **not committed, Android side not compiled** (2026-11-08). Not seen on Android before the
  fix: the Lava uses 3-button navigation, and predictive back was never tested.
  **Update (2026-11-08 night, Windows session):** in main, compiled and checked on the Lava with gesture navigation
  (sample and ZeroBill `.dev`). Predictive back was off on Android 13-15 (no `enableOnBackInvokedCallback`; only
  Android 16 turns it on for target 36), so the runtime's manifest now turns it on, and screens without a handler are
  popped natively when the gesture ends (`ZnNav.navDisplayBack`, second-opinions 184).
- **Fix as built:** `packages/core/src/nav.ts` sends NAV BACK_WANTED (existing kind 10, no host API change) for any
  screen while it has an app handler (`useBack`, `BackHandler`) or its tabs want Back (tabs' own handler doesn't
  count: `useBackUncounted`); once per change, after a screen build ends, never for a closed screen. JS tests: 1166
  pass (only A7 fails). Android `ZnNavHost.kt`: one `BackHandler`, now registered **after** NavDisplay (keyed by the top
  entry), enabled while the top screen wants Back; it replaces the old last-screen-only one. Sheets and modals are
  Dialogs, so they still get Back first. iOS: `ZnNavController` (window root) has its own edge pan that reads it
  (UIKit's built-in pop gesture often never began over our Pressables). Checked on the iOS simulator: no handler →
  interactive pop + FORCED_BACK; handler that lets go → popped by JS; handler that keeps → stays, "Discard ₹6?".
- **Behaviour change to check:** a root screen with `useBack` is now asked on Back (before: the app went to the
  background), and loses Android 14's predictive "back to home" while it has the handler.
- **Problem:** every back press goes to JS first (`ZnNav.systemBack` → BACK → `useBack` handlers may keep the screen).
  But `ZnNavHost` gives Navigation 3 a `predictivePopTransitionSpec`, so with gesture navigation on Android 14+ the pop
  preview (the previous screen sliding in) plays during the gesture, and JS is asked only when it commits. A screen
  whose `useBack` keeps it (the sample's amount screen with an amount typed: "Discard ₹6?") would show the preview,
  then stay. On iOS the same thing is worse: the swipe-back is interactive and cannot wait for JS at all.
- **Why it matters:** the amount screen's guard is a payment-flow guard. A preview that shows "leaving", then doesn't
  leave, looks broken; on iOS the swipe would skip the guard (or has to be turned off everywhere).
- **Fix (proposed, shared):** JS tells native which entries have back handlers right now (the `useBack` count per
  entry, like NAV BACK_WANTED but for any entry; a host API change). Entries without handlers get the native
  interactive back (Android predictive pop, iOS swipe); entries with handlers get no preview, and the gesture goes to
  JS as a plain BACK. iOS needs this before the swipe can be turned on (i.2).
- **Check on Android:** build (`.\gradlew.bat :sample:installDebug` after `bun run sample:js`). On a phone with gesture
  navigation (Android 14+): Dev → Amount keypad, type a digit, swipe back slowly: no preview of Dev, "Discard ₹…?"
  shows. Dev screens (no handler): the predictive preview plays as before. 3-button phone: Back on the amount screen
  still asks. A sheet open on the amount screen: Back closes the sheet first. Tabs lab: Back on a later tab goes to the
  first tab; on the first tab it leaves the app.

## A9. `Platform.OS` was always "android"
- **Status:** fixed on ios (2026-11-08, the native modules commit). Shared JS only; nothing changes on Android.
- **Problem:** `packages/core/src/platform.ts` had `OS: "android"` as a constant and `select` returned `android`,
  then `native`, then `default`, never `ios`.
- **Why it matters:** shared app code (and plugins) branch on `Platform.OS`; on iOS every branch would take the
  Android path.
- **Fix:** `OS` is a getter: "ios" when native gave `nativeConstants("Platform").os === "ios"` (iOS sets it before
  the main script, so top-level reads work), else "android" (Android sends no such constants, so nothing changes
  there). `select` picks the entry for the current OS. On iOS `Version` is the major iOS version as a number. New
  test in `packages/core/test/rn-basics.test.ts`; the Android test is unchanged and passes.
- **Also changed, shared sample:** `examples/sample/src/FetchScreen.tsx` "gzip offered" accepted only exactly
  `gzip` (OkHttp's header); it now accepts any Accept-Encoding list that has gzip (URLSession sends "gzip, deflate").
- **Check on Android:** `bun test packages/core/test/rn-basics.test.ts`; on the phone, RN basics lab → Platform
  shows `platform android <sdk> …`; Dev → fetch checks still 27 / 27 (or as many as before).

## A10. Events from the pre-JS skeleton can be dropped
- **Status:** not seen on Android (2026-11-08, Android session on the Lava: three cold starts into the RN props lab,
  every event arrived, no `no handler for event` lines); fixed on ios (the props lab commit). Keep the Android code
  as it is unless it shows up.
- **Shared difference from RN, seen on both runtimes:** onLayout can fire twice with the same frame for one node
  (RN sends it once per change). Harmless for the lab; an app that counts onLayout calls would see it.
- **Problem:** the first screen is drawn from its template before JS runs (ARCHITECTURE §8.1). If a node in that
  skeleton sends an event before JS has applied its first batch, JS has no handler yet: it logs
  `no handler for event N on instance <entry>` and the event is lost. On iOS a local `<Image src="asset:...">`
  loaded at once and its `onLoad` / `onError` / `onLoadEnd` were dropped this way (RN props lab, images row).
- **Why it matters:** an app that reacts to `onLoad` / `onError` / `onLayout` on its first screen (hide a
  placeholder, report a broken picture) would miss it, only at cold start, only when the picture is fast.
- **Fix on iOS:** `ZnApp.afterJSDrew { … }` holds such events until the first batch is applied
  (`ios/ZnRuntime/Swift/ZnApp.swift`, used by `ZnImage.swift`).
- **Check on Android:** likely rare: Coil loads asynchronously and its memory cache is empty at cold start. But
  `onLayout` and an Image with a disk-cached picture on the first screen could race the same way. Look for
  `no handler for event` in logcat right after a cold start of a screen with such nodes (RN props lab as the first
  screen: "Open this lab at next start"); if seen, hold skeleton events in `ZnRuntime` until START's first batch.

## A11. Layout conformance: run it on Android; alignSelf stretch
- **Status:** open. The screen is new (shared sample); iOS passes 46 / 46. Not run on Android (no SDK on this Mac).
- **What it is:** `examples/sample/src/LayoutLab.tsx`, route `layoutLab` (deep link `zn://sample/dev/layout`). 26
  small layouts with fixed sizes, one or more per zn flex rule (docs/styling-and-layout.md §5): each measured node
  reports its frame through onLayout and JS compares it with the frame the rules give (1 dp tolerance). It logs
  `layout-conformance FAIL <id> expected x,y,w,h got x,y,w,h` per miss, then `layout-conformance <n>/<total> pass`,
  and shows the same on screen. No text in the cases, so both platforms must match exactly.
- **Likely failures on Android** (read from the Kotlin, not run):
  1. **c19b, alignSelf stretch:** `ZnColumn` stretches a child only when the Column's `alignItems` is unset or
     `stretch` (`stretch && … && (alignSelf == -1 || alignSelf == STRETCH)`), so in an `alignItems: "flex-start"`
     Column a child with `alignSelf: "stretch"` and no width gets width 0. RN stretches it. Fix in
     `android/runtime/.../ZnRenderer.kt` ZnColumn: `stretched = definiteWidth && child.width == null && child.type
     != SPACER && (child.alignSelf == STRETCH || (child.alignSelf == -1 && (s.alignItems == -1 || s.alignItems ==
     STRETCH)))`. iOS has this fix (ZnRenderer.swift childLayout).
  2. **c10a, x / y in a padded parent:** RN's onLayout x / y are from the parent's top-left, its padding included
     (10, 10 here). `znOnLayout` uses `positionInParent()`, which may be measured from the parent's content box
     (inside its padding) and give 0, 0. If so, add the parent's padding (and border) or measure from the parent's
     outer box.
- **Also noted:** case 26 (a Row with a height and `alignItems` unset doesn't stretch) follows android/runtime; RN
  would stretch. Written into docs/platform-differences.md next to the Row stretch line.
- **Android session's reading (2026-11-08, Windows, read only):** (1) confirmed in the Kotlin, and the same gap is in
  the Stack and the vertical Scroll; a Row has a similar one (`alignSelf: "stretch"` without `alignItems: "stretch"`
  doesn't fill its height). (2) likely real: `positionInParent()` is measured from inside the parent's padding.
  A10: probably fine, as `ZnNav.startWith` posts START to the JS thread before Compose draws, so skeleton events queue
  behind it; to be checked in logcat. None of these is used by ZeroBill, so none blocks its release.
- **Added cases (iOS fixed, 48 / 48):** c27 (Stack with `alignItems: "center"`, a child with `alignSelf: "stretch"`
  and no width: expected 0,0,200,10) and c28 (Row with height 40 and `alignItems: "flex-start"`, a 50-wide child with
  `alignSelf: "stretch"`: expected 0,0,50,40). Expected on Android after the fixes: `48/48 pass`.
- **Check on Android:** `bun run sample:js`, install the sample, open `zn://sample/dev/layout`, read the
  `layout-conformance` lines in logcat (`adb logcat -s zn-js`). Expected after the fixes: `48/48 pass` (46 before c27 and c28 were added). Any other
  miss is either an Android layout difference or a wrong expectation in LayoutLab.tsx: say which in this entry.
- **Run on Android (2026-11-08, Android session, Lava, branch `opus/parity-fixes`, before any fix): 42 / 48.**
  - c10a expected 10,10,90,10 got 0,0,90,10 and c12a expected 4,4,10,10 got 0,0,10,10: item 2 above confirmed,
    x / y are measured inside the parent's padding and border.
  - c19b (Column) expected 0,10,200,10 got 0,10,0,10; c27a (Stack) expected 0,0,200,10 got 100,0,0,10; c28a (Row
    height) expected 0,0,50,40 got 0,0,50,0: item 1 above, in all three containers.
  - **New, A11-3:** c13a expected 0,0,80,10 got 0,0,200,10. On a stretched child `fillMaxWidth` is applied outside
    its `widthIn(max = …)`, so `maxWidth` is ignored. On `main` too (not from that branch's changes). iOS passes it.
    Fix: apply the max inside, i.e. the size limits before the fill (or clamp the stretched width to maxWidth).
  - None of these is used by ZeroBill (no alignSelf, onLayout or maxWidth there), so none blocks its release. The
    fixes are Pavan's call, in their own commit, re-run until 48 / 48.
- **Case 29 added (2026-11-08, after the merge of main into `ios`):** min beats max. c29a: a 50-wide child with
  `minWidth: 80, maxWidth: 60, alignSelf: "flex-start"` → 0,0,80,10. c29b: a stretched child with `minWidth: 120,
  maxWidth: 100` → 0,10,120,10. iOS 50 / 50. Expected on Android: `50/50 pass` (the A11-3 fix makes min beat max).

## A12. zn dev: a reload that adds a screen draws it from another screen's template
- **Status:** open. Found by the Android session (2026-11-08, Lava) and not looked into; not tried on iOS.
- **Problem:** with `zn dev` running, adding a new screen and reloading drew that screen as a blank page showing
  another lab's text ("status: ready"). It looks like the template table kept the old component numbers, so the new
  screen's number points at an old template.
- **Why it matters:** dev only (a fresh install is fine), but it makes a new screen look broken and wastes time.
- **Likely place:** how the dev reload replaces the template table (compiler output → runtime): template ids are
  numbered in compile order, so adding a component shifts them; the runtime must drop the whole old table on reload,
  not merge by id. Check the dev server's reload path in `tools/` and both runtimes' template load.
- **Check:** start `zn dev` on the sample, add a screen with a route and a visible text, save, open it: it must show
  its own text. iOS has no `zn dev` yet (i.2), so it can't hit this today; whatever the fix, iOS's reload must
  follow it when it gets one.

## A13. device-info: three iOS-only getters read native values
- **Status:** changed on `ios` (2026-11-08, the device-info iOS commit). No Android behaviour change expected.
- **What changed (shared JS, `plugins/device-info/src/index.ts`):** `hasDynamicIsland()` and `isDisplayZoomed()` read
  the constants `hasDynamicIsland` / `isDisplayZoomed` (iOS gives them; Android doesn't, so they stay false), and
  `getBrightness()` calls a native `brightness` (iOS has it; Android has none, the call is refused "unavailable", so
  it stays -1). The test that pinned `getBrightness` to -1 now refuses the call; a new test covers iOS values.
  The sample's DeviceInfoLab prints `getSystemName()` instead of the word "Android" (same text on Android) and adds
  "island <bool>" to the type line.
- **Check on Android:** `bun test plugins/device-info` (9 pass); the Device info lab on the phone: the type line now
  ends "island false, emulator false"; Read changing values unchanged.

## A14. location: iOS's permission names in the shared JS
- **Status:** changed on `ios` (2026-11-08, the location iOS commit). No Android behaviour change expected.
- **What changed (`plugins/location/src/index.ts`):** when `Platform.OS === "ios"`, `status`, `requestPermission` and
  the denied → blocked check ask core's Permissions for `"location"` (and read `"location.precise"`), because
  Android's `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` mean nothing on iOS (always "denied" there). On Android
  the same two names as before, in the same order. `requestPermission({ precise: false })` changes nothing on iOS (the
  precise switch is in iOS's own dialog). New test: "iOS: one location permission …"; the Android tests are unchanged.
- **Check on Android:** `bun test plugins/location` (26 pass); the Location lab on the phone: Ask permission / Ask
  rough only behave as before.

## A15. Updates.check() leaves out `status` when OTA is off
- **Found:** 2026-11-09, on iOS, writing the "OTA off" Updates module (iOS has no OTA yet) to answer as Android does.
- **Problem:** `ZnOta.kt` Module `check`: `if (config == null) return@function call.resolve(JSONObject().put("action",
  "NONE").put("reason", "OFF"))` has no `status`, but `UpdateCheckResult.status` is not optional in
  `packages/core/src/updates.ts`. The sample's `UpdatesScreen.tsx` calls `show(r.status)` and throws ("Check now" on an
  app that didn't call `ZnOta.configure`: the error goes to `onError` as async). ZeroBill configures OTA, so it doesn't
  hit it.
- **Fix:** add `.put("status", status())` in that branch (status() is `{ enabled: false, phase: "off" }` then). iOS's
  `ZnUpdatesOff` already answers with it.
- **Check on Android:** the sample without OTA configured, route `updates`, Check now: "Check: NONE OFF", no error.

## A16. A `.ts` file that imports a `.tsx` file fails the build
- **Status:** fixed 2026-11-10 (Windows session). Shared build code, so Android and iOS both have the fix.
- **Found:** 2026-11-10 by the ZeroBill session. ZeroBill worked around it by keeping the state of its iOS store update
  screens in a plain `.ts` file (`app/src/system/storePrompt.ts`) apart from the views (`StoreUpdateViews.tsx`).
- **Problem:** the build error was "Cannot find package 'react' imported from <file>.tsx". It is not the bundler: Bun's
  bundler sends every `.tsx` file through the zero-native compiler, whoever imports it. The cause was the build-time
  load of design tokens: when a `.tsx` file imports names from a relative `.ts` file, `loadStaticImports` in
  `compiler/src/plugin.ts` runs that `.ts` file with `import()` to fold its values into the templates. If that `.ts`
  file imports a `.tsx` file (an `index.ts` that re-exports components, a service that imports views), Bun's runtime
  reads the `.tsx` file as React JSX and asks for `react/jsx-dev-runtime`.
- **Fix:** before that load, `reachesTsx` follows the `.ts` file's relative imports and re-exports (type-only ones
  don't count). If one reaches a `.tsx` / `.jsx` file, the `.ts` file is not loaded: its values are read at runtime,
  like any value not known at build time (a `gap={GAP}` becomes a slot). A tokens file with no `.tsx` import is folded
  as before. The sample's bundle and ZeroBill's build give the same bytes with and without the fix.
- **Test:** `compiler/test/build-app.test.ts` "a .ts file that imports a .tsx file (issue A16)", fixture
  `compiler/test/fixtures/ts-imports-tsx/` (fails with the old code with ZeroBill's error).

## A18. Every module a bundle calls counted for both OSes
- **Status:** written on the Mac 2026-11-11 (Pavan asked; plan and record: docs/ota-requires-per-os.md). Android
  side not compiled there: this Mac's Gradle couldn't download its distribution, and Pavan said to leave it to Windows.
- **Problem:** a bundle's `requires.modules` listed every native module any of its files calls, and a phone ran the
  bundle only if it had all of them. ZeroBill's bundle calls AdId (the `android-ad-id` plugin, Android only), so iOS
  refused every ZeroBill OTA bundle, though the same JS runs as the built-in bundle.
- **Fix:** `requires.os` holds modules from one-OS plugins (from the calling file's package); the signed line appends
  them; each phone checks both OSes' modules plus its own OS's. Android: `ZnBundles.Requires.os` and `from()`,
  `ZnOtaSignature.requiresLine`, `ZnCapabilities.os` / `missing`, `capabilities.os` in the check.
- **Check on Android (Windows):** `:runtime:testDebugUnitTest` (ZnBundlesTest `onlyThisOsPartCounts`,
  ZnOtaSignatureTest `perOsNeedsMatchTheCli`, ZnOtaInstall*); the OTA phone matrix on the Lava; ZeroBill's rebuilt
  bundle shows `"os":{"android":{"AdId":1}}`. Deploy the zn-updates server before the first bundle with OS parts; then
  ZeroBill's Play build and a new staging APK (an APK built before can't verify bundles with OS parts).

## A20. Native module names didn't say their plugin
- **Status:** written on the Mac 2026-11-11 (Pavan asked). Kotlin not compiled there (no Gradle).
- **Problem:** a bundle's needs list (and the dashboard) names native modules, and several had short names that hid
  their plugin and could clash with another plugin: `Push` (firebase-messaging), `Analytics`, `Crashlytics`, `Perf`,
  `RemoteConfig`, `Firebase` and `Installations` (firebase-app), `AdId` (android-ad-id), `Auth` (android-play-auth).
- **Fix:** each name starts with its package's first word: `FirebaseMessaging`, `FirebaseAnalytics`,
  `FirebaseCrashlytics`, `FirebasePerf`, `FirebaseRemoteConfig`, `FirebaseApp`, `FirebaseInstallations`, `AndroidAdId`,
  `AndroidPlayAuth`. Only the registered name changed (`ZnModuleBase("...")` in Kotlin, `super.init("...")` in Swift,
  `nativeModule("...")` in TS); classes and the JS objects (`Push`, `Analytics`, `AdId`...) keep their names.
  `plugins/module-names.test.ts` checks the rule and that TS, Kotlin and Swift agree. The bundle also gets
  `moduleFrom` (not signed) so the dashboard groups needs: framework, core, zero-native plugins, the app's own.
- **Check on Android (Windows):** the plugins' unit tests; ZeroBill's bundle needs the new names
  (`"os":{"android":{"AndroidAdId":1}}`, `FirebaseMessaging`...); ZeroBill starts on the Lava with its new built-in
  bundle (an app that registers old names refuses it). An APK built before this can't run bundles built after it
  (missing modules), and the reverse: make ZeroBill's Play build and a new staging APK after this lands, and redeploy
  zn-updates for the grouped needs.

## A21. ZeroBill reads taps on pushes the phone showed itself (from iOS work)
- **Status:** written on the Mac 2026-11-11 (Phase 3). JS only; Android not run.
- **Change:** `app/src/system/pushService.ts` listens to `Push.onNotificationOpenedApp` and, at start,
  `Push.getInitialNotification()`, mapping the message's data with `tapFromPush` (src/system/push.ts) to the same
  action as ZeroBill's own notifications. Needed for iOS, where iOS shows the push itself while the app is behind.
- **Android:** these fire only for a notification FCM showed itself (a message with a non-empty `notification` block).
  The worker sends `notification: {}` today, so ZeroBill shows its own and taps go through `Notifications.onPress` as
  before. If the server ever sends a real `notification` block, its taps now open the action instead of just the app.
- **Check on Android (Windows):** a staging push on the Lava shows once and its tap opens once (no double open).

## A22. Pushes the phone showed itself: iOS now reports shown, swipe and buttons; Android doesn't (from iOS work)
- **Status:** open, a gap, nothing broken. Found on the Mac 2026-11-10 (Phase 3).
- **iOS (i.19):** for a push iOS showed while the app was behind or closed, JS now gets `push.message` with
  `shown: true` / `shownAt` at the next start or return to the front, `onDismiss` for a swipe and `onAction` for a
  button (both with `provider: "fcm"`). The new fields are optional in `PushMessage` and the event types.
- **Android:** a message with a non-empty `notification` block is shown by FCM's SDK while the app is behind; JS hears
  only its tap. No shown, no swipe, no buttons. Apps that send `notification: {}` (ZeroBill) show their own and get
  every event already, so nothing changes for them.
- **If wanted later:** the Android plugin could report FCM-shown pushes from `getActiveNotifications()` at the return
  to the front, as iOS's fallback does. Not planned.

## A23. The scanner's default button said "Allow camera" (from iOS work)
- **Status:** changed on both, 2026-11-16. App Review rejected ZeroBill 1.6.2 again under 5.1.1(iv): a button before
  the system camera prompt said "Allow camera". ZeroBill passes `allowLabel="Continue"`, but the plugin's own
  defaults said "Allow camera" and "Allow the camera to scan codes.".
- **Change (shared, ScannerTexts on both):** the defaults are now "Continue" and "The camera is used to scan codes.".
  An app that passes its own words sees no change.
- **iOS only:** the permission message is made again when the view's words change, and after "Don't Allow" it offers
  Settings (it kept a "Continue" that did nothing).
- **Check on Android (Windows):** the sample scanner lab with no words passed shows "Continue".

## A24. A leaving screen's Sheet / Modal stays for the exit transition on Android (from iOS work, finding 20)
- **Status:** open, a difference, maybe nothing to change. Found on the Mac 2026-11-18.
- **iOS now:** a popped, replaced or reset screen's Sheets and Modals close at the nav step, with no slide, before the
  next screen's own can open (ZnPopups, second-opinions 231). Each layer closes alone (what is over it stays).
- **Android:** the leaving screen's Dialog stays (and may take touches) for its 300 ms exit transition. Check with the
  sample lab `zn://sample/dev/sheet-leave`: "Replace with a screen that opens a sheet", "Reset to a screen that opens
  a sheet", "Back: the screen below opens a sheet" (push another lab screen first), and "Close the payment sheet under
  this one" (from the sheet or the Modal over it). The new sheet must stay; the upper one must stay.
- **Measured on the Lava (Windows, 2026-11-20, debug sample, screen recording at 20 frames a second, 2 rounds each):**
  the new screen's sheet starts sliding in while the old one is still fully drawn. The old sheet then fades out and is
  gone about 250 ms (replace), 270 ms (reset) and 200 ms (back) after the new sheet first shows; from the tap that is
  about 450, 520 and 200 ms. So it is the 300 ms Dialog exit, as expected. To the eye it reads as a short cross-fade,
  not a stuck sheet. In all six rounds the new sheet stayed open. Not checked: whether the fading old sheet takes a tap.

## A25. The update screen's icon check used an Android 8 class on Android 7 (found by CI lint)
- **Status:** fixed on the Mac 2026-11-19, not run on a phone. CI's first lint run (GitHub Actions) failed with
  NewApi: `ZnOtaGate.kt` checked `icon is AdaptiveIconDrawable` (API 26) with minSdk 24.
- **Risk:** on Android 7 (API 24–25) that check can throw (the class isn't there) when the OTA update screen draws at
  launch.
- **Fix:** `Build.VERSION.SDK_INT >= 26 && icon is AdaptiveIconDrawable`; Android 7 uses the plain icon box (it has no
  adaptive icons). CI builds and lints it.
- **Check on Android (Windows):** an Android 7 emulator (API 24) with a high-priority update waiting: the update screen
  shows its icon, no crash.

## A26. A child's flex from a signal is read from the parent's instance (from iOS work, layout values from slots)
- **Status:** open. Found on the Mac 2026-11-21 in a review of the iOS layout-from-slots work; not run on Android.
- **Problem:** `ZnRenderer.kt` reads a child's flex slot with the parent's `inst`: Row (`ZnRow`, the `childFlex` line,
  about line 230), Column (`ZnColumn`, about line 577) and the wrap row (about line 1674) all do
  `inst.finiteNum(child.flexSlot)`. When the child is a mounted component (its root node lives in another instance,
  `ref.instance`), that reads the slot with the same number in the parent's instance: the wrong value, or nothing.
- **Why it matters:** `<Row><MyCard style={{ flex: grow() ? 3 : 1 }} /></Row>` where the flex is decided inside the
  component gets a wrong or fixed weight on Android. iOS reads it from the child's own instance (`znSlotFlexes`, `r.inst`),
  so the two platforms differ.
- **Fix:** read `ref.instance.finiteNum(child.flexSlot)` in the three places (and anywhere else a child's slot is read
  with the parent's `inst`).
- **Check on Android (Windows):** a component whose root has `flex` from a signal, inside a Row and a Column, toggled
  at runtime: the weights change as on iOS (DynamicLayoutLab section 7's flex row is a plain Box, so it doesn't cover
  this; add a component case).

## A27. A "%" width from a signal inside a Row is a fraction of the room left, not of the Row (from iOS work)
- **Status:** open, a difference. Found on the Mac 2026-11-21 in the same review; not run on Android.
- **Problem:** a static `width: "50%"` in a Row uses the Row's own width (`znPercentOfRow`, the 2026-11-09 fix), but a
  "%" that comes from a slot goes through `dynamicSize` → `resolveSizePx(value, constraints.maxWidth, …)`. In a Compose
  Row `constraints.maxWidth` is what is left after the children before it, so the same "50%" gives a smaller box when it
  changes at runtime. iOS (`ZnPercentKey`) and RN use the Row's full width in both cases.
- **Fix:** give the slot path the Row's width too (the saved `rowWidth`, as `znPercentOfRow` does) when the child sits
  in a Row; a Column's offered width is already the full width.
- **Check on Android (Windows):** DynamicLayoutLab section 3 ("Cycle Width %") with a fixed-width sibling before the
  bar in the same Row: 33 % and 50 % of the Row's width, as on iOS.

## A28. A transparent route with a transition other than "none" may animate the screen below it too (from iOS work)
- **Status:** open, possible, not run on Android. Seen in the code on the Mac 2026-11-21 while mapping iOS's
  `transparent: true`.
- **Problem:** `ZnSeeThroughStrategy` (`ZnNavHost.kt` ~371) puts the screen below a transparent one in the same scene.
  When the transparent route has a transition other than `"none"`, the screen below appears in both the old and the new
  scene, so it may slide or fade along with the transparent screen instead of staying still. The code's own comment
  (`ZnNavHost.kt` ~333) expects transparent routes to use `"none"` and animate their own content.
- **Why it matters:** an app that gives a transparent route a `fade` or `slide` gets a moving background on Android.
  iOS will keep the screen below still.
- **Fix:** either keep the screen below out of the animation, or document that transparent routes should use
  `transition: "none"` (and maybe warn in the compiler).
- **Check on Android (Windows):** add `transition: "fade"` to the sample's `photoViewer` route (or any transparent
  route) and open it: does the screen below move or fade?
- **Update 2026-11-22:** iOS now has transparent routes (round 2b): only the see-through screen animates. Read again
  in `ZnNavHost.kt` ~289 and ~371-391, the Android problem looks real. Easier check: Dev > Core lab > "Open sliding
  see-through" (route `seeThroughSlide`, transition "push"): does the core lab move? Pavan to decide (the iOS job
  recommends fixing Android so only the see-through screen animates, and keeping the "use none" advice in the docs).

## A29. A Sheet's backgroundColor may be painted twice (from iOS work)
- **Status:** open, possible, minor (overdraw only). Seen in the code on the Mac 2026-11-21.
- **Problem:** `ZnSheet.kt` paints `s.background` on the card (~377), and the sheet node's own style (which carries the
  same `backgroundColor`) is applied again to the inner content box. Nothing looks wrong; it is one extra full-size
  paint while the sheet is open or dragged.
- **Fix:** don't apply `backgroundColor` to the inner box when the card already paints it.
- **Check on Android (Windows):** Layout Inspector or "Debug GPU overdraw" on a Sheet with a backgroundColor.

## A30. The Motion OTA gate's name list misses some motion APIs (from iOS work, shared compiler)
- **Status:** fixed in the compiler on the Mac (iOS round 1: `GATED_CORE_MODULES` plus compiler/test/modules.test.ts,
  with a test that every motion export of core is gated or named as plain JS); not run on Android. Two sample files now
  newly need Motion: `examples/sample/src/ImageViewerLab.tsx` and `plugins/device-test/src/index.ts`. On iOS this
  changes nothing yet: the iOS stub registers Motion version 1 until the real engine's gate step.
- **Problem:** `compiler/src/modules.ts` `GATED_CORE_MODULES` lists the motion names that make a bundle declare the
  `Motion` module, but leaves out `useElementMotion`, `useTilt`, `useFrame`, `nativeMotion`, `interpolateColor`,
  `self` and `parent`. A bundle that uses only those doesn't declare Motion, so a phone without Motion would accept it
  as an OTA update and then fail at runtime.
- **Why it matters:** on Android every host has Motion, so nothing breaks there today; it matters for iOS builds with
  the Motion stub, and for any future host that lacks a module.
- **Fix:** add the names (with compiler tests). Android sees bundles that now also declare Motion, which every Android
  host has.
- **Check on Android (Windows):** after it lands, build the sample and ZeroBill bundles and run the OTA upload check
  (`bun run updates` dry run): the Motion requirement should be the same version as before.

## A31. A reorderable List row's `onLongPress` probably fires as the drag starts (from iOS work)
- **Status:** open, not run on Android. Found on the Mac 2026-11-21 (iOS round 1, reading the code).
- **Problem:** `ZnPress.kt` (~98-102) starts its own `delay(longPressTimeoutMillis)` and then sends `onLongPress`.
  `ZnReorder.kt` `modifier()` (~200-218) watches the touch at the Initial pass and takes nothing until the same
  timeout. So both happen: the row lifts for the drag and the row's `onLongPress` (a menu, say) fires too.
- **Pavan's decision (2026-11-21):** in a `<List reorderable>` the long press only drags; a row's `onLongPress` is
  ignored. The compiler now prints a build warning for this case (compiler/test/build-warnings.test.ts).
- **Fix:** in a reorderable list, `ZnPress` doesn't send `onLongPress` for a press inside a row (e.g. the list provides
  "reorder on" through a CompositionLocal and `longPressOn()` answers false); drop the row's accessibility long-click
  action too. Update docs/motion.md §11 ("compete" → "the long press only drags").
- **Check on Android (Windows):** a `<List reorderable>` whose row has `<Pressable onLongPress={() => log("long")}>`;
  long-press a row. Today: does "long" print as the row lifts? After the fix: the row lifts and nothing prints; with
  `reorderable={false}`, "long" prints.

## A32. An explicit `autoCapitalize="sentences"` gives no capitals with a keyboardType or a secure field (from iOS work)
- **Status:** open, not run on Android. Found on the Mac 2026-11-21 (iOS round 1).
- **Problem:** `ZnTextField.kt` ~147-152 maps `autoCapitalize`; an explicit `"sentences"` falls into the `else` branch
  and gives `None` on a field that has a `keyboardType` or is secure. iOS (and RN) capitalise sentences there.
- **Fix:** map `"sentences"` to `KeyboardCapitalization.Sentences` whatever the keyboard type; keep the default
  (not written) as today.
- **Check on Android (Windows):** `<TextField autoCapitalize="sentences" keyboardType="email-address">`: the keyboard
  should start in capitals.

## A33. Window values stay 0 in JS after a dev reload or an in-place OTA (from iOS work, Motion)
- **Status:** open, not run on Android. Found on the Mac 2026-11-21 (iOS round 1, motion engine review).
- **Problem:** `ZnMotion.kt` `reset()` (~547) disposes only ids above `ENV_LAST`, so the `watching` jobs for the window
  ids 1-15 survive a reload. Then `watch()` (~748-755) returns early on `watching.containsKey(id)` and never sends the
  current value. The new JS starts its env entries at 0 (core motion.ts `envSource`), so `env.width` and the other
  window values read 0 in JS until the window changes.
- **Fix:** in `reset()`, cancel and clear every `watching` job; and a `watch(on)` for an id already watched sends its
  value now. iOS does both.
- **Check on Android (Windows):** a screen that reads `env.width` in JS (`v()` or `derive`), then a dev reload: it reads 0
  until a resize or rotation.

## A34. `v.sequence([], { repeat: "forever" })` spins on the main thread (from iOS work, Motion)
- **Status:** open, not run on Android. Found on the Mac 2026-11-21.
- **Problem:** `ZnMotion.kt` ~680: `while (plays < 0 || play < plays)` with no steps; `runSteps` returns true without
  suspending, so the coroutine never yields and the main thread freezes.
- **Fix:** an empty sequence finishes at once with `finished: true` (iOS does this).
- **Check on Android (Windows):** call `v.sequence([], { repeat: "forever" })` from any screen: today the app hangs (ANR).

## A35. A motion value read in JS on a screen with no gesture never got native's values (from iOS work, shared JS)
- **Status:** fixed in shared JS on the Mac 2026-11-21 (`packages/core/src/motion.ts` `listen`: a source's first read
  calls `listen()`); not run on Android.
- **Problem:** before the fix, a value read in JS (`v()`, `derive`, `map`, `follow`) on a screen with no gesture never
  subscribed to native, so its JS copy stayed at its first value. Android has the same bug on builds before the fix.
- **Check on Android (Windows):** cold-start `zn://sample/dev/motion/engine` with `{"run":true}` before opening any
  gesture screen: on a build with the fix the "derive" and "map" checks pass (before it they stay at 0).

## A36. A missing FormData file part fails mid-upload as `connection_lost` (from iOS work, fetch)
- **Status:** open, not run on Android. Found on the Mac 2026-11-21 (iOS round 1).
- **Problem:** `ZnFetch.kt` `multipart` (~583-595) and `UriBody` (~637-650): a missing or unreadable `file://` /
  `content://` part isn't refused before sending. `contentLength()` swallows the error (-1, so the body goes chunked),
  then `writeTo` throws `FileNotFoundException` during the call, which `errorCode`'s else branch reports as
  `connection_lost` (or `offline`). iOS rejects `invalid_request` with the path before sending. Also, `UriBody` reads
  the length once and opens the stream again in `writeTo`: if the file changes in between, the declared length and the
  bytes differ (low priority).
- **Fix:** in `multipart()`, open each URI once (`openAssetFileDescriptor`, or `openInputStream` and close it) and
  reject `invalid_request` with the URI when that fails.
- **Check on Android (Windows):** `/dev/fetch` with `{"only":"missing file"}` (plus the lab's `port`/`dir` params): see
  which code "FormData missing file" prints. After the fix, make that lab case expect `invalid_request` on both.

## A37. A kept background task JS is still running may be aborted by its answer-by limit (from iOS work)
- **Status:** open, possible, not run on Android. Found on the Mac 2026-11-21 (iOS round 1, push and background review).
- **Problem:** on iOS a kept task that JS was already running got aborted at the caller's answer-by limit, which deleted
  its saved copy (fixed on iOS: the caller is answered in time, JS goes on to the task's own limit). On Android, check
  `ZnBackground.kt`'s time-limit path: can a task kept across process death be aborted by a limit counted from `run()`
  while JS is still running it? If so, its saved copy is lost the same way.
- **Check on Android (Windows):** a kept task that reaches JS late, with a handler longer than the time left: is the
  saved copy dropped before JS finishes?

## A38. Stacked SVG drop shadows: check the fixture on Android (from iOS work)
- **Status:** check only. Added 2026-11-21 with iOS's drop-shadow fallback.
- **Check on Android (Windows):** svgLab's `shadow-skew.svg` should show the dot's green shadow on its left and both
  stacked shadows to the right and below. Android 12+ runs the real filter (RenderEffect); also look at the fallback
  path (a pattern tile, or Android before 12).

## A39. An animated `scrollToOffset` to anything but 0 lands at an estimated place (from iOS work, Lists)
- **Status:** open, not run on Android. Found on the Mac 2026-11-22 (iOS round 2, List extras).
- **Problem:** `ZnRenderer.kt` ~820-828, ZnLazyList's scroll-command "offset" / "to" branch: an animated scrollToOffset
  uses `animateScrollBy` from `estimatedScrollPx`, the average size of the visible rows. With rows of different heights
  it lands off. iOS lands exactly, with a short correction while row sizes settle.
- **Check on Android (Windows):** in rnPropsLab's extras list, from the top, call `scrollToOffset({ offset: 600,
  animated: true })`, then the same with `animated: false`, and compare where each lands.

## A40. An inverted List with a ListHeaderComponent may not follow the newest row (from iOS work, Lists)
- **Status:** open, possible, not run on Android. Found on the Mac 2026-11-22.
- **Problem:** `ZnRenderer.kt` ~1112, ZnLazyList's follow-newest effect (`LaunchedEffect(firstKey) { if (follow ...)
  state.scrollToItem(0) }`). The header is lazy item 0, so a "follow" test based on `firstVisibleItemIndex == 0` may
  be about the header, not the newest row.
- **Check on Android (Windows):** chatLab, stay at the bottom and tap "Add message" a few times: each new message should
  stay in view above "Ravi is typing…".

## A41. Canvas image loads restart on every command list (from iOS work, Canvas)
- **Status:** open, a difference. Pavan to decide (the iOS job recommends making Android match iOS).
- **Problem:** `ZnCanvas.kt` ~1048-1051 with `ZnCanvasImage.kt` ~40-88 (`startCanvasImages` in
  `DisposableEffect(commands)`): each new list cancels the loads that haven't finished. A picture slower than the list's
  refresh never shows, and a failed picture is requested and warned about again on every list. iOS keeps a running
  load for the next list, doesn't retry a failed picture while the lists keep it, and retries after the Canvas leaves
  and comes back.
- **Check on Android (Windows):** CanvasLab tile 1 now has a picsum photo in its 500 ms list. Throttle the network to
  2G: the photo never appears while the ticks run, and a proxy shows a new request every 500 ms.

## A42. Bad Canvas path data doesn't name the field (from iOS work, Canvas)
- **Status:** open, minor. Found on the Mac 2026-11-22.
- **Problem:** `ZnCanvas.kt` ~459 and ~478 (`pathParser.pathStringToNodes`): a bad `d` gives Compose's exception text,
  or none, and the warning doesn't say `"d"`. iOS says `"d" is not valid path data; skipped`.
- **Check on Android (Windows):** `draw.path("M 0 0 X 5 5", …)`, then read logcat.

## A43. A boolean Canvas `fontWeight` is dropped silently (from iOS work, Canvas)
- **Status:** open, minor.
- **Problem:** `ZnCanvas.kt` ~508: a `fontWeight` given as a JSON boolean falls to `else -> null`, with no warning.
- **Check on Android (Windows):** `{"type":"text","text":"a","x":0,"y":10,"options":{"fontWeight":true}}` gives no
  logcat warning.

## A44. A motion corner from a null value reads 0 (from iOS work, Motion)
- **Status:** open, not run on Android. Found on the Mac 2026-11-22 (iOS round 2, motion bindings).
- **Problem:** `ZnMotionUi.kt` ~129-137: a corner slot whose value is null reads 0 instead of falling back to the
  written corner, then `borderRadius`. iOS falls back.
- **Check on Android (Windows):** `borderRadius: v.map(...)` plus `borderTopLeftRadius` from a signal that is null: the
  top-left corner comes out square.

## A45. `siteUsed` misses `cameraDistanceSlot` (from iOS work, Motion)
- **Status:** open, not run on Android.
- **Problem:** `ZnRenderer.kt` ~1241-1242 (`siteUsed`) lists the layer slots that read `self` / `parent` but not
  `cameraDistanceSlot`, so a node whose only site formula is its cameraDistance never gets its size.
- **Check on Android (Windows):** `cameraDistance: derive(() => self.width / 20)` alone on a turned box never changes.

## A46. A raw motion value in a `<Text>` prints control characters (from iOS work, Motion)
- **Status:** open, minor.
- **Problem:** `ZnRenderer.kt` ~1322 (`display`): a "\u0000m<id>" string (a motion value put in a Text without
  `format`) is drawn as is. iOS shows "".
- **Fix:** show "" for such a string (and maybe a debug warning to use `v.format()`).
- **Check on Android (Windows):** `<Text>{v}</Text>` with a motion value `v`.

## A47. Some motion formulas are read with no site (from iOS work, Motion)
- **Status:** open, a gap. iOS matches Android today.
- **Problem:** `parent.*` / `self.*` read 0 in these, because they are read with no site:
  - backgroundColor colour formulas: `ZnAnimation.kt` ~372-376 (`znBackground`);
  - `width` / `height`: `ZnRenderer.kt` `resolveSizePx`, `read(null)`;
  - motion corners: `ZnMotionUi.kt` ~135, `read(null)`.
- **Check on Android (Windows):** a box with `width: derive(() => p * parent.width)` stays 0 wide.
- **Fix (both platforms, later):** read them with the node's site, as opacity and transforms do.

## A48. An `animate` `from` play towards a moving motion value sits at `from` (from iOS work, Motion, both platforms)
- **Status:** open, a design question for Pavan (the iOS job recommends fixing both, Android first).
- **Problem:** `ZnAnimation.kt` ~508 (`znMotion` restart flow): a `from` play restarts on every change of `rest()`.
  With a rest that follows a playing motion value it restarts each frame and stays at `from`. iOS now does the same.
- **Check on Android (Windows):** `animate={{opacity:{from:0}}}` with `opacity: t.map(...)` while `t` plays.

## A49. `maxFontScale={0}` draws text at size 0 (from iOS work, Text)
- **Status:** open, not run on Android. Found on the Mac 2026-11-22 (iOS round 2, text and accessibility).
- **Problem:** `ZnTemplate.kt` ~441-444 (`fontScaleCap`): a cap of 0 gives a scale of 0, and a negative cap a negative
  scale. iOS, like React Native's `maxFontSizeMultiplier=0`, treats a cap of 0 or less as no cap.
- **Check on Android (Windows):** `<Text maxFontScale={0}>` with the phone's font size above 1.0: the text disappears.

## A50. Pressable roles "link" and "text" read as a button (from iOS work, accessibility)
- **Status:** open, a difference. Pavan to decide (iOS reads them as a link and as text, as React Native on iOS).
- **Problem:** `ZnPress.kt` ~75-76: roles "link", "text" and any role not listed fall to `else -> Role.Button`, so
  TalkBack says "button". A tappable Text (the TEXT clickable in `ZnRenderer.kt`) is always `Role.Button`.
- **Check on Android (Windows):** /dev/a11y with TalkBack on. In section 5 "Terms" and "Read only", and in section 11
  "Privacy policy" and "Skip", all read as buttons today.

## A51. A labelled Box with a Switch inside: check TalkBack (from iOS work, accessibility)
- **Status:** check only.
- **Check on Android (Windows):** /dev/a11y section 6, "Card settings", with TalkBack: it should read "Card settings",
  then the Switch "Card on" on its own. iOS does this now.

## A52. Predictive back on a see-through "push" route probably drags the screen below too (from iOS work, navigation)
- **Status:** open, possible, not run on Android. Found on the Mac 2026-11-22 (iOS round 2b, transparent routes).
- **Problem:** `ZnNavHost.kt` ~289 and ~371: the see-through scene holds the screen below, so a predictive back gesture
  on a transparent route with transition "push" probably drags the whole scene. iOS drags only the see-through screen.
- **Check on Android (Windows):** Dev > Core lab > "Open sliding see-through" (route `seeThroughSlide`), then a slow
  predictive back: does the core lab move with it?

## A53. A Switch or Checkbox inside a Pressable fires both (from iOS work, touch)
- **Status:** open, a design question for Pavan (the iOS job recommends "the innermost wins" on both platforms; until he
  decides, iOS keeps its old behaviour).
- **Problem:** `ZnSwitch.kt` ~91-103 and `ZnCheckbox.kt` ~94-105 with `ZnPress.kt` ~91 and ~116: the toggle's
  pointerInput never consumes the down or the up, so the parent Pressable's `awaitFirstDown()` /
  `waitForUpOrCancellation()` sees an unconsumed up, and both onValueChange and onPress fire.
- **Check on Android (Windows):** `<Pressable onPress={log}><Switch value onValueChange={log2} /></Pressable>`: tap the
  Switch and look for both log lines.

## A54. See-through lab: what taps should do (from iOS work, check only)
- **Check on Android (Windows):** Dev > Core lab > "Open see-through screen": a tap on the dim backdrop over "Run task"
  should reach the core lab ("core-lab task lab.echo"), as on iOS. In "Row with a disabled switch", a tap on the
  disabled Switch should log "see-through-lab row press" only.

## A55. A white mask whose shape has a `filter` becomes a clip (from iOS work, shared compiler)
- **Status:** open. Both platforms draw it wrong. Pavan to decide (the iOS job recommends the one-line fix).
- **Problem:** `compiler/src/svg.ts` ~1602 (`whiteMask`, used at ~1580) rejects shapes with clip-path or mask, but not
  ones with `filter` (and probably `mix-blend-mode`), although its comment says "no effects". So a luminance mask of
  opaque white shapes, one blurred, is compiled into a clip and the blur is lost: a hard edge where browsers show a
  soft one.
- **Fix:** also reject a shape with `filter` (and `mix-blend-mode`) in `whiteMask`.
- **Check (any machine):** in `examples/sample/src/svg/r13/filter-in-pattern.svg`, change the `#dotMask` circle's fill
  from `#FFFFFE` to `#FFFFFF`: the compiled data loses its second `FL` filter and the mask becomes a clip of the
  circle path. On Android, use that blurred mask outside a pattern to see its edge go sharp.

## A56. A filter, mask or clip in object units on text alone hides the text (from iOS work, shared compiler)
- **Status:** open, both platforms. Pavan to decide: estimate a text box in the compiler (the iOS job's recommendation)
  or document "use userSpaceOnUse".
- **Problem:** `compiler/src/svg.ts` contentBox (~1620, called from userBox and filterOf ~1272) ignores `<text>`, so a
  `<g filter>` holding only text, with the default objectBoundingBox units, gets an empty box and is hidden.
- **Check:** in `examples/sample/src/svg/r13/filter-blend.svg`, remove `filterUnits="userSpaceOnUse"` and the
  x/y/width/height from `#glow`: the "zn" text vanishes.

## A57. A blur with one side 0 still blurs that side slightly (from iOS work, Svg)
- **Status:** open, minor. iOS copies it for parity.
- **Problem:** `ZnSvgEffects.kt` ~209-212: a zero side passes radius 0.01, about a 0.5 px blur, so `stdDeviation="4 0"`
  is a little soft vertically. (`ZnSvgEffects.kt` ~224-228, plus as BlendMode.PLUS, is correct: don't change it.)
- **Check on Android (Windows):** zoom into svgLab's "across only" bar and look at its top and bottom edges.

## A58. The first `screen_<route>` trace may have no `zn_bundle` (from iOS work, firebase-perf)
- **Status:** open, not run on Android. It happened on iOS and was fixed there (an open trace gets the label when it
  arrives).
- **Problem:** `plugins/firebase-perf/android/.../PerfPlugin.kt` ~58 and ~138-141 set `zn_bundle` only when a screen
  trace starts. If the first route comes before `ZnBundles.watchRunning` delivers the label, that trace has none.
- **Check on Android (Windows):** start with `-e ZN_ROUTE perfLab` and `firebase_performance_logcat_enabled`, and read
  the first `screen_` trace's attributes.

## A59. firebase-perf: smaller issues (from iOS work)
- **Status:** open, minor; read the code.
- `PerfPlugin.kt` ~221-225 (`PerfRules.frameKind`): a frozen frame isn't also counted as slow (Firebase's own
  `_fr_slo` counts both). The shared README now says `frames_slow` leaves out frozen frames, so either keep that or
  change both.
- `PerfPlugin.kt` ~166-176: the 64-trace check and the insert aren't atomic, and a reused `id` replaces a running trace
  without stopping it.

## A60. webview: media may keep playing while the page is paused (from iOS work)
- **Status:** open, not run on Android. iOS suspends media while paused.
- **Problem:** `WebViewPage.kt` ~280-290 (`resume()` / `pause()`).
- **Check on Android (Windows):** WebViewLab > Inline upload > "Play tone" > "Open fake screen": the page should report
  "media paused".

## A61. webview uploads: checks on Android (from iOS work)
- **Status:** check only.
- **Check on Android (Windows):**
  - Android 14+: WebViewLab > Inline upload > "Pick files", then back out of the picker: the lab should log "upload
    answered: 0" (`WebViewPage.kt` ~373-431, pickFiles).
  - Uploads off: the new showPicker, open shadow and closed shadow buttons should each log "upload answered: 0" with
    no chooser (`WebViewPage.kt` ~383-389, onShowFileChooser). With uploads on they should be counted.

## A62. webview: reload of an inline page (from iOS work)
- **Status:** open, possible, not run on Android.
- **Problem:** after `loadDataWithBaseURL`, does reload reload the html or fetch the base URL? iOS had this bug and now
  tracks the inline navigation.
- **Check on Android (Windows):** WebViewLab > Inline upload, then "#frag" or "pushState", then Reload: the page should
  still show "Pick files", with no load error. "Upload, bare base", then Reload, should behave the same.

## A63. Pinch and rotation are measured in the node's own transformed space, so a node scaled or turned by its own gesture lags (from iOS work, round 3)
- **Status:** open, Pavan to decide (rec: fix Android). Found on the Mac 2026-11-23.
- **Problem:** `ZnGesture.kt` ~870-874 (`PinchRec.spread`) and ~931-934 (`RotateRec.angleOf`) measure the fingers in the
  node's transformed space. When the node's scale or rotation follows the same gesture, the pinch converges to about the
  square root of the finger spread and the rotation lags. iOS measures in the window.
- **Check on Android (Windows):** GestureLab (`/dev/motion/gestures`) c: turn two fingers 60°; onEnd's angle isn't 60.
  MotionVideoLab: the card grows slower than the fingers.

## A64. useLongPress sends `begin` twice per touch (from iOS work, round 3)
- **Status:** open, Pavan to decide (rec: fix). Found on the Mac 2026-11-23.
- **Problem:** `ZnGesture.kt` ~1077 (`LongPressRec` sends "begin") and ~1434 (`leaves.forEach { it.send("begin") }`) both
  fire, so onBegin runs twice. The iOS job says iOS does the same today (copied); fix both together.
- **Check:** `useLongPress({ onBegin: () => console.log("b") })` logs twice per long press.

## A65. After snapTo, a gesture doesn't rest on the anchor and follow it when the anchor moves (from iOS work, round 3)
- **Status:** open, Pavan to decide (rec: fix both). Found on the Mac 2026-11-23.
- **Problem:** `ZnGesture.kt` ~480-501 (`snapTo`) never calls `attach()`, so a gesture placed by snapTo doesn't follow a
  moving anchor (keyboard, resize).
- **Check:** MotionVideoLab without dragging the card first: tap the field; the card at br stays under the keyboard.

## A66. A settle re-attaches to its old anchor even when its runs were cancelled (snapTo or a grab during a settle) (from iOS work, round 3)
- **Status:** open, fixed on iOS. Found on the Mac 2026-11-23.
- **Problem:** `ZnGesture.kt` ~474 (`settle`) calls `attach(t.id)` after the joins even when the runs were cancelled, so
  snapTo during a settle ends at, or follows, the old anchor; a grab during a settle can re-attach too.
- **Fix (as iOS):** attach only when every run finished.
- **Check:** release slide-to-pay so it springs back, call snapTo("paid") within 100 ms, then open the keyboard: it should
  stay at "paid".

## A67. A pan's velocity tracker never gets the up: hold still, then lift, keeps the last move's speed (from iOS work, round 3)
- **Status:** open, low. Found on the Mac 2026-11-23.
- **Problem:** `ZnGesture.kt` ~776 (`PanRec`): the tracker gets only moves, not the up.
- **Check:** slide-to-pay, drag halfway, hold 300 ms, lift: end's vx should be 0.

## A68. An after-edge panel being dragged through a list can be pulled back by a moving anchor (from iOS work, round 3)
- **Status:** open. Found on the Mac 2026-11-23.
- **Problem:** `ZnGesture.kt` ~1558-1571 (`ZnNestedPan.nested`) interrupts y but never calls `g.detach()`.
- **Check:** a panel whose anchors depend on keyboardHeight: open the keyboard, then drag the list.

## A69. A patch zip's listed sizes are trusted until the end: a hostile patch can make Android allocate ~1.5 GB (from iOS work, round 3)
- **Status:** open (rec: check early, as iOS). Found on the Mac 2026-11-23.
- **Problem:** `ZnOtaInstall.kt` ~241-285 with `ZnBsPatch.kt` ~50: buildFromPatch trusts the sizes in the patch zip's
  `zn-bundle.json` until `finish`, so `ByteArray(newSize.toInt())` can try ~1.5 GB, ends in an OutOfMemoryError ("out of
  memory") and installs the full zip. No wrong bundle, but a huge allocation.
- **Fix (as iOS):** check the listed sizes and SHAs against `m.bundleSha256` right after `readInfo`.
- **Check:** a JVM test in ZnOtaInstallPatchTest with main.hbc's listed size and the patch header's newSize at 1.5e9.

## A70. A numeric impressionKey from a slot can reach JS as "7.0" (iOS sends "7") (from iOS work, round 3)
- **Status:** open. Found on the Mac 2026-11-23.
- **Problem:** `ZnRenderer.kt` ~617: `.toString()` on whatever number type the slot holds.
- **Check:** `impressionKey={someNumberSignal()}` on a screen with useImpressions; read the keys the handler gets.

## A71. A keyed node composed before its screen's NAV IMPRESSIONS may never measure (from iOS work, round 3)
- **Status:** open, possible. Found on the Mac 2026-11-23.
- **Problem:** `ZnImpressions.kt` ~56 and `ZnRenderer.kt` ~618: `tracking(entry)` reads a plain HashMap, not Compose
  state, so such a node gets an empty Modifier until something recomposes it.
- **Check:** a screen whose useImpressions runs after its first draw, with static cards that never recompose: do they
  ever count?

## A72. A second configure of the same screen drops counted-but-unsent keys (from iOS work, round 3)
- **Status:** open. Found on the Mac 2026-11-23.
- **Problem:** `ZnImpressions.kt` ~53: `tracks[entry] = Track(...)` drops keys not yet sent (a `flush()` first would keep
  them), and nodes that had counted stop at the `done` early return until their next onGloballyPositioned.
- **Check:** count some keys, rebuild the screen within 500 ms, keep still: does the first batch reach JS, and do visible
  keys count again?

## A73. A network trace stops at the headers: no body time, and no size for chunked or gzip answers (from iOS work, round 3)
- **Status:** open (Pavan: rec make Android measure the body, as iOS). Found on the Mac 2026-11-23.
- **Problem:** `plugins/firebase-perf/android/.../PerfPlugin.kt` ~92-96 stops the HTTPMetric when the headers arrive.
- **Check:** with Perf on, fetch `/big` and `/gzip` from tools/fetch-test-server.ts: the payload size is missing and the
  time is about the time to first byte.

## A74. Only an IOException stops a network trace; another exception leaves it started (from iOS work, round 3)
- **Status:** open. Found on the Mac 2026-11-23.
- **Problem:** `PerfPlugin.kt` ~88: a RuntimeException from another interceptor leaves an HTTPMetric never stopped. A
  `finally` fixes it. (Also a difference, not a bug: `ZnFetch.kt` ~106 `addInterceptor` refuses after the first fetch,
  so a late PerfPlugin gets no traces; iOS's observer hears calls from when it is added.)
- **Check:** add an interceptor that throws IllegalStateException: no trace is logged for that call.

## A75. Canvas blur (BlurMaskFilter) and shadows (setShadowLayer) may not draw on hardware canvases before Android 9 (from iOS work, round 3)
- **Status:** check (likely). Found on the Mac 2026-11-23.
- **Problem:** `ZnCanvas.kt` ~178-179 on a hardware-accelerated canvas, minSdk 24. docs/svg.md already says "Android 9+"
  for the SVG equivalents; the Canvas docs don't.
- **Check:** CanvasLab tile 18 and the blur and shadow tiles on an API 24-27 emulator: is the bottom row soft, and do the
  shadows show?

## A76. animateLayout: a style size change (`height: open ? 110 : 50`) jumps instead of animating (from iOS work, round 3)
- **Status:** open, Pavan to decide (rec: animate, as iOS). Found on the Mac 2026-11-23.
- **Problem:** `ZnTemplate.kt` ~815 (with `ZnRenderer.kt` ~1270 and `ZnMotionUi.kt` ~167): `animateContentSize` comes
  after the fixed `.width` / `.height` modifiers (~754-760).
- **Check:** `/dev/motion/core` §7: tap the "50 tall" box; if it snaps to 110, it's real.

## A77. useTilt: x and y have the wrong sign in landscape (from iOS work, round 3)
- **Status:** open, Pavan to decide (rec: fix Android). Found on the Mac 2026-11-23.
- **Problem:** `ZnMotionApi.kt` ~174-177 (`ZnTilt.onSensorChanged`): ROTATION_90 gives (ax, ay) = (-ay, ax), but the
  reference (AccelerometerPlay) is ax = ay, ay = -ax; ROTATION_270 the reverse. The iOS Mac suite (ios/tests/motion)
  reads these three lines and fails if they change: update that check with the fix.
- **Check:** landscape with the phone's top on the left, lower the screen's right edge: x should go positive.

## A78. useTilt keeps its old lean for a new user or after a reload; its lifecycle observer stays (from iOS work, round 3)
- **Status:** open. Found on the Mac 2026-11-23.
- **Problem:** `ZnMotionApi.kt` ~149-152 (`ZnTilt.remove`) and `reset()` never reset sx / sy; the observer stays on the
  activity after the last user (a leak per activity).
- **Check:** tilt, close and reopen a useTilt screen while the phone lies flat: does x start from the old value?

## A79. A plugin Handle's second onDispose replaces the first (from iOS work, round 3)
- **Status:** open. Found on the Mac 2026-11-23.
- **Problem:** `ZnMotionApi.kt` ~48-50 (`Handle.onDispose`): `DeviceModule.orbit` called twice for one id leaves the first
  frame job running after JS drops the value. iOS chains them.
- **Check:** call `orbit` twice with one id, close the screen: does a frame job keep running (a log in its block)?

## A80. 3D turns: check the camera distance matches (iOS may turn harder than Android) (from iOS work, round 3)
- **Status:** check, from iOS. Found on the Mac 2026-11-23.
- **Why:** `ios/ZnRuntime/Swift/ZnDepth.swift` puts the camera at cameraDistance × 72 device pixels (576 px for the
  default 8). If Compose's layer scales cameraDistance by the screen density before HWUI uses it, Android's camera is
  that many times further away and its turns look milder. On the iOS simulator GestureLab a)'s card (rotateY 40, default
  camera) is drawn far past its box, over its title.
- **Check on Android (Windows):** a screenshot of GestureLab (`/dev/motion/gestures`) a) and MotionBindingsLab b), to put
  side by side with iOS's. If Android's card stays inside its box, the iOS camera is too close.

## A81. A List's scroll offset is estimated from the visible rows, so onScroll, paging and snapToInterval drift with mixed heights (from iOS work, round 4)
- **Status:** open. Found on the Mac 2026-11-24.
- **Problem:** `ZnScrollExtras.kt` ~58-75 (`ZnLazyPos`) works out a List's offset and max from the average size of the
  visible items. With rows of different heights the onScroll y, paging and snapToInterval targets drift. iOS reads the
  exact offset.
- **Check:** ScrollLab b) or ListsTwoLab (`/dev/lists2`) Scroll tab with rows of mixed heights and snapToInterval: fling,
  then compare the momentum-end y with the row starts.

## A82. A reorderable List row's onLongPress still runs when the drag starts (from iOS work, round 4)
- **Status:** open (decision 7 says it is ignored; the compiler warns). Found on the Mac 2026-11-24.
- **Problem:** `ZnPress.kt` with `ZnReorder.kt` ~208-231: the row's long press fires as the reorder drag starts.
- **Check:** ListsTwoLab Reorder tab: drag a row; the "onLongPress ran N times" counter should stay at 0.

## A83. A picture on screen whose preload is still running downloads twice (from iOS work, round 4)
- **Status:** check (likely). Found on the Mac 2026-11-24.
- **Problem:** `ZnImagePreload.kt` ~31-33: Coil doesn't join a running preload, so the on-screen request downloads again.
  iOS joins it.
- **Check:** `/dev/image-list` with `tools/repro/http-stall.ts list`: does the server log show a URL fetched twice?

## A84. With itemAnimation, a List's header, footer and empty item jump; iOS fades them (from iOS work, round 4)
- **Status:** open, Pavan to decide (rec: add animateItem to the extras on Android). Found on the Mac 2026-11-24.
- **Problem:** `ZnRenderer.kt` ~897-899 and ~943 give the header, footer and empty item no `znItemAnimation`.
- **Check:** ListsTwoLab Animate tab with a ListHeaderComponent: empty the data and fill it again.

## A85. Check: rows JS adds while a reorder drag is held (from iOS work, round 4)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** iOS holds rows that come during a drag and puts them in after the drop. Android's reorderable LazyColumn may
  jump or drop the drag.
- **Check:** ListsTwoLab Reorder tab: tap "Add 3 in 2 s", then hold a dragged row for more than 2 s, and drop it.

## A86. Check: MotionScreensDetail's "Scan & Pay" bar (from iOS work, round 4)
- **Status:** check, from iOS. Found on the Mac 2026-11-24.
- **Why:** iOS draws a dark strip under the bar on `motionScreensDetail`. It is likely an iOS issue; a screenshot of the
  Android screen tells which side is right.
- **Check (Windows):** a screenshot of `motionScreensDetail` on Android.

## A87. useZoom: a drag right after a double tap turns the page instead of moving the photo (from iOS work, round 4)
- **Status:** open. Found on the Mac 2026-11-24.
- **Problem:** `ZnGesture.kt` ~1196-1199 (ZoomRec's slop check) reads `g.scale.value` while the 280 ms double-tap tween is
  still near 1x and fails, so the pager takes the drag. iOS decides by where the tween is going and jumps to it.
- **Check:** MotionMediaLab: double tap the photo, then drag sideways within about 100 ms. The page turns.

## A88. TalkBack can't move a plain bounded slider (no tap, zoom or anchors) (from iOS work, round 4)
- **Status:** open, Pavan to decide (rec: add an adjustable action on Android, still not for pans with anchors). Found on
  the Mac 2026-11-24.
- **Problem:** `ZnGesture.kt` ~1502-1543 (semantics): a gesture with an a11yLabel but no tap, zoom or anchors
  (MotionPayLab "Loan amount", the price thumbs) gets no TalkBack action. iOS makes a one-axis pan with both bounds and no
  anchors adjustable (swipe up / down moves a tenth). Pans with anchors stay rotor actions on both, so one swipe can't
  complete a slide to pay.
- **Check:** TalkBack on, MotionPayLab b) and c): nothing moves the knobs.

## A89. useZoom's TalkBack zoom in / out end without `accessibility: true` (from iOS work, round 4)
- **Status:** open. Found on the Mac 2026-11-24.
- **Problem:** `ZnGesture.kt` ~1513-1527: tap and anchor actions send onEnd with `accessibility: true`, the zoom actions
  don't. iOS sends it.
- **Check:** run "Photo: zoom in" with onEnd logging `e.accessibility`.

## A90. Check: the order TalkBack lists gesture actions (from iOS work, round 4)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** iOS hands its actions over reversed so VoiceOver lists them in Android's order (`ZnGesture.kt` ~1504-1538).
- **Check:** TalkBack on, MotionPayLab a): "start" should come before "paid".

## A91. Check: a motion value read outside derive() in a handler (env.width() gave 0 on iOS) (from iOS work, round 4)
- **Status:** check (likely shared, packages/core). Found on the Mac 2026-11-24.
- **Why:** with the engine on, `env.width()` in an event handler returned 0 on iOS. It looks like the open "`peek()` of an
  unwatched value" issue in packages/core.
- **Check:** `console.info(env.width())` in a Pressable's onPress should print the window width, not 0.

## A92. Check: the image viewer page emits `error` before JS sends its props (from iOS work, round 4)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** `ViewerPage.kt` ~57 reads `props.optString("uri", "")`, so a page composed before its props arrive may make Coil
  fail with no data and emit `error`. iOS reports an empty link only when JS sent it.
- **Check:** log `error` events while the TSX viewer opens: none should come before `loaded`.

## A93. Check: typing fast into a field that onChangeText reformats loses a key on iOS (from iOS work, round 4)
- **Status:** check (shared code if Android loses keys too). Found on the Mac 2026-11-24.
- **Why:** XCUITest's typeText of "1234567" into the sample's amount field (`examples/sample/src/InputScreen.tsx` ~110)
  showed "1,23,456" in about half the runs. The cause isn't found yet.
- **Check:** emulator, `/input`, focus the "₹0" field, `adb shell input text 1234567`: it should show "12,34,567".

## A94. zn dev on Android can only use adb reverse (from iOS work, round 4)
- **Status:** open (a feature gap). Found on the Mac 2026-11-24.
- **Problem:** `ZnDev.kt` ~104 connects to a fixed `InetSocketAddress("127.0.0.1", PORT)`. iOS now finds `zn dev --lan`
  over Bonjour (`_zn-dev._tcp`, TXT `app=` and `mac=`) or a `ZN_DEV_HOST`.
- **Fix idea:** a debug-only host override, and NSD for `_zn-dev._tcp` that reads `app=` from the TXT, as iOS does.
- **Check:** `bun run dev --lan` with no adb reverse and the phone on the same Wi-Fi: the phone never connects.

## A95. zn dev's HELLO from Android has no `os`, `bytecode` or `app` (from iOS work, round 4)
- **Status:** open. Found on the Mac 2026-11-24.
- **Problem:** `ZnDev.kt` HELLO sends only `device` and `hash`, so the server can't warn about a Hermes bytecode mismatch
  or a phone running another app. iOS sends `"os":"ios"`, `bytecode` and `app` (zn-bundle.json's app).
- **Fix:** add `"os":"android"`, `"bytecode"` and `"app"` to HELLO.

## A96. ZnPlugins.HOST_API's comment says it equals kHostApiVersion; they now differ on purpose (from iOS work, round 5)
- **Status:** open (comment only). Found on the Mac 2026-11-24.
- **Problem:** `ZnPlugins.kt` ~73-76 says HOST_API is "the same as kHostApiVersion in core/include/zn/engine.h". Since the
  motion gate kHostApiVersion is 10, a native-only step (`NATIVE_ONLY_HOST_API` in packages/core/src/host-api.ts), while
  HOST_API rightly stays 9: it is the JS contract number (packages/core/test/host-api.test.ts checks it).
- **Fix:** reword the comment: "the JS host API (HOST_API_VERSION), kHostApiVersion less its native-only steps".

## A97. Android store builds made after the motion gate report hostApi 10 (from iOS work, round 5)
- **Status:** check (information, no code change). Found on the Mac 2026-11-24.
- **Why:** `jni_bridge.cpp` ~155 reads the shared `kHostApiVersion`, so a rebuilt Android app says 10 in its OTA check,
  and the server's familyOf puts new Android store builds in a new family. Bundles still need 9, so older apps keep
  getting them.
- **Check:** an Android build's OTA check against server/src/local.ts: `capabilities.hostApi` is 10, and a bundle built
  for 9 is still offered to it.

## A98. Check: the TSX image viewer on Android after the iOS fixes (window width, side insets) (from iOS work, round 5)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** `plugins/image-viewer/src/ImageViewerScreen.tsx` now follows the window width (the pages read it once before)
  and pads the bar by `env.insets.start` / `end`. Shared JS, only run on iOS.
- **Check:** open the viewer on photo 2, turn the phone, page, and check the ✕ clears the side insets in landscape.

## A99. The image viewer's next / previous labels are never used: TalkBack has no next / previous actions (from iOS work, round 5)
- **Status:** open (both platforms; Pavan's call: an `accessibilityActions` core API after release). Found on the Mac
  2026-11-24.
- **Problem:** `ImageViewerScreen.tsx` accepts `nextLabel` / `previousLabel` but nothing reads them.
- **Check:** TalkBack on the viewer: the actions menu has no next / previous.

## A100. Screens under a see-through screen stay in the TalkBack tree (from iOS work, round 5)
- **Status:** open, Pavan to decide (rec: a route option, on by default for the viewer). Found on the Mac 2026-11-24.
- **Problem:** `ZnNavHost.kt` ~382-391 (ZnSeeThroughScene) leaves the screens below reachable. iOS has the same gap.
- **Check:** TalkBack, open the TSX viewer and swipe through: the lab's buttons are reached.

## A101. The image viewer's invisible ✕ takes taps while the viewer opens (from iOS work, round 5)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** on Android an absolute layer takes taps at any alpha, so a tap in the first 0.4 s can close a viewer the user
  can't see yet. iOS answers only once it shows (UIKit skips alpha below 0.01). A fix for both may be `pointerEvents`
  "none" on the bar until it shows.
- **Check:** tap the top-left corner right after tapping a thumbnail.

## A102. Check: a Column raised by minWidth stretches its children to that width (layout case 48) (from iOS work, 2026-11-24)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** iOS now stretches a stretching child (no width, alignItems unset or stretch) of a Column whose width comes
  only from `minWidth` to the raised width, as Yoga does (docs/styling-and-layout.md §5 rule 4). Before, iOS left it at
  its content width: ZeroBill's notification badge pill (flexGrow in an absolute ring with minWidth 18) was narrow. By
  reading `ZnRenderer.kt` ZnColumn (~566-590), Android follows the old rule too (no `fillMaxWidth` without a definite
  width); Compose may still give a `weight()` child the Column's min width.
- **Check:** `/dev/layout`: case 48 (c48a-c). If c48b or c48c fail, Android needs the same rule: a stretching child of a
  Column with only minWidth gets `widthIn(min = the Column's inner minWidth)`.

## A103. hitSlop shrinks a small Pressable's touch area below Compose's 48 dp minimum (from iOS work, 2026-11-24)
- **Status:** open. Found on the Mac 2026-11-24 (reading the code).
- **Problem:** `ZnTouch.kt` ~59-71 (`WithHitSlop`) sets `minimumTouchTargetSize` to the size plus twice the slop,
  replacing the 48 dp minimum instead of raising it. A 24 dp icon with `hitSlop={4}` gets 32 dp, smaller than the 48 dp
  it has with no hitSlop.
- **Fix:** `max(48 dp, size + 2 × slop)` per axis (the base configuration's minimum, not a fixed 48).
- **Check:** a 24 dp Pressable with `hitSlop={4}`: tap 10 dp outside its edge; it should still fire (it does without
  the prop).

## A104. A rounded Pressable clips all its children, which React Native doesn't (iOS now matches Android) (from iOS work, polish round)
- **Status:** open, Pavan to decide (keep as a zn rule, or drop it on both). Found on the Mac 2026-11-24.
- **Why:** `ZnTemplate.kt` ~869-876 (`clipsByDefault`) clips a rounded Pressable's children to its corners. React
  Native doesn't. iOS now does the same as Android (polish round), so the two platforms agree; it is an RN difference.
- **Check:** `/dev/paint` §1: the first card's picture has round corners. Also `/dev/paint` §3 on a phone: the stripe
  shows through the translucent and the empty bordered cards, the shadow only outside them; and `/dev/layout` case 49
  (look for "c49" FAIL lines, especially c49h, ZnWrap.kt).

## A105. numberOfLines={0} probably throws (BasicText maxLines must be at least 1) (from iOS work, polish round)
- **Status:** open (likely a crash). Found on the Mac 2026-11-24.
- **Problem:** `ZnTemplate.kt` ~233 keeps 0, and `ZnRenderer.kt` ~410/416/421/427 pass `maxLines = 0` to BasicText,
  which throws IllegalArgumentException below 1. React Native's 0 means no limit; iOS now does that.
- **Fix:** treat `<= 0` as `Int.MAX_VALUE`.
- **Check:** open `zn://sample/dev/text-polish/lines`.

## A106. returnKeyType: Done keeps focus; Next may land on a read-only field or wrap (from iOS work, polish round)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** `ZnTextField.kt` ~165 and ~172-176: Done only hides the keyboard (the field keeps focus, no onBlur); Next uses
  ImeAction.Next, and a readOnly BasicTextField can take focus, so Next may stop on it. iOS: Done blurs, Next skips
  read-only fields and fields under pointerEvents "none", reads in reading order with a List's own rows first, and
  closes the keyboard on the last field.
- **Check:** `/dev/text-polish` §2 (Done on D: onBlur?; Next on B: "focus RO"?), §8 (Next goes r1 → r8, then to a §10
  note), and Next on the last field.

## A107. colorScheme() reports the phone's night mode while the Light theme keeps windows and dialogs light (from iOS work, polish round)
- **Status:** open, Pavan to decide (rec: keep and document; iOS's Light template says "light", as React Native iOS).
  Found on the Mac 2026-11-24.
- **Problem:** `ZnActivity.kt` ~83-84 reports the phone's night mode, while the template's
  Theme.Material.Light.NoActionBar keeps the window and AlertDialogs light, so an app that themes by colorScheme() draws
  dark screens with light dialogs. New iOS apps now set UIUserInterfaceStyle Light.
- **Check:** phone in dark mode: the CoreLab "scheme:" line, then Alert.alert in the RN basics lab.

## A108. Check: the iOS polish round's labs (nav race, edge swipe over a rail, touch) (from iOS work, polish round)
- **Status:** check. Found on the Mac 2026-11-24.
- **Check (navigation):** `zn://sample/dev/nav/race`, "Run race": expect "result: 44/44"; with `{"stepwise":true}` each
  case's wait text is on the screen shown. "Push wants Back", then a system back gesture from the edge over the rail:
  "back asked 1", the rail doesn't move. "Push in 2 s", hold a predictive-back gesture past 2 s and release: Back from
  "Race target 9" shows the lab.
- **Check (touch):** `/dev/touch`, and with `--params '{"mode":"more"}'`: the box-only and "none" rails don't scroll and
  their cards press; the WebView card doesn't press; the long-press card held on its rail long-presses at about 0.5 s.

## A109. A reorderable inverted (or RTL horizontal) List likely picks and moves the wrong row (from iOS work, round 6)
- **Status:** check (likely). Found on the Mac 2026-11-24.
- **Problem:** `ZnReorder.kt` ~102-115 (pick) and ~136-138 (swap) compare the finger's position from the top / left
  with `LazyListItemInfo.offset`, which counts from the bottom under `reverseLayout = s.inverted` (`ZnRenderer.kt` ~914);
  `ZnRenderer.kt` ~841-842 passes only `horizontal`. A horizontal list in RTL has the same risk.
- **Check:** `/dev/checks` d): long press Row 1 (at the bottom) and drag it up two rows: onReorder 0 → 2.

## A110. Check: returnKeyType next in an inverted List (iOS goes down the screen; Android likely by row order) (from iOS work, round 6)
- **Status:** check. Found on the Mac 2026-11-24.
- **Why:** iOS's ZnFieldFocus.focusNext goes in screen order, so in an inverted List n3 → n2 and from n1 it leaves the
  List. Compose's focus search likely goes by row order. Pavan to pick one (rec: row order, as Android).
- **Check:** `/dev/checks` g): focus n1 and press Next: Android should go to n2 (above).

## A111. Check: round 6's lab cases (layout 50a-j and 51, text spacing, touch fixes, fade list) (from iOS work, round 6)
- **Status:** check. Found on the Mac 2026-11-24.
- **Check:** `/dev/layout` should give 118/118 and "layout-overflow 3/3 pass" (50i: a Stack with justifyContent
  flex-end, child at y 50 in a 60 tall share). `zn://sample/dev/text-polish/spacing` with `adb logcat | grep
  text-polish`: "width pill" = "width pill-plain" + 30, "lineHeight tight ok", "lineHeight loose ok" (assumes Compose's
  LineHeightStyle Trim.Both). `/dev/paint/fade-list` scrolls smoothly. `--route touchFixLab` §1/§2: fx-log reads only
  "switch on" / "rail switch on" (A53). `/ws`: the "80 sockets" case now opens to 127.0.0.1, plus a timed "20 sockets
  to localhost". Dev hub → More labs → "Push at start", then Back: lands on "Start screen" with no doubled or missing
  screen (a push during a slide-in).

## A112. <NativeView> allows testID and pointerEvents in its type, but the compiler rejects them (from iOS work, round 6)
- **Status:** open, Pavan to decide (rec: pass them through). Found on the Mac 2026-11-24.
- **Problem:** `compiler/src/compile.ts` ~2278 with `packages/ui/src/index.ts` ~468: the type allows them, the build
  fails. The iOS runtime already handles both. Both platforms.
- **Check:** add `testID="x"` to a NativeView and run `bun run sample:js`.

## A113. <NativeView pointerEvents="none"> probably still takes touches on Android (from iOS work, round 7)
- **Status:** check (likely). Found on the Mac 2026-11-25.
- **Problem:** `ZnNativeViews.kt` ~49-62 with `ZnRenderer.kt` ~155-176: pointerEvents "none" only sets LocalTouchOff and
  skips znBlockTouches; the plugin's AndroidView is a real View that never reads LocalTouchOff. iOS turns
  isUserInteractionEnabled off. The compiler now passes testID and pointerEvents on NativeView (A112, fixed in the
  compiler 2026-11-25); testID on Android sits on the Box around the plugin view (`ZnTemplate.kt` ~774).
- **Check:** `zn://sample/dev/checks` c), last row: tap the middle of the NativeView over the green "under-direct"
  Pressable: "under direct 1", not "direct view none got an event". With uiautomator, "native-direct-id" is found.

## A114. Check: round 7's cases (layout 52, modal drag-down is iOS only, checks lab f/g, 3D turned field) (from iOS work, round 7)
- **Status:** check. Found on the Mac 2026-11-25.
- **Check:** `/dev/layout`: 124/124 (case 52: a wrap Row of fixed height 20 gives center at -10 and flex-end at -20 in a
  60 share). `/dev/checks` g): Next from n1 goes n2, n3, n4, then s1 to s4. f): type 0 into a maxLength 4 field: it shows
  123456 while focused; type 1234567 fast into the multiline field: 12,34,567. In checksLab, a tap just right of the
  turned card's drawn edge presses nothing and doesn't focus "turned-field" (iOS's ChecksLabTests.testTapsOn3DTurnedViews
  is flaky there). The modal drag-down is iOS only by design (Android has system back).
