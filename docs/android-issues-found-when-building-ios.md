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
| A7 | 2026-11-08 | JS tests | `app-events.test.ts` passes alone but fails in the full `bun test` run on the Mac | open |
| A8 | 2026-11-08 | Navigation | A back gesture that animates before JS answers (Android 13+ predictive back) cannot respect `useBack` | fixed; Android checked on the Lava 2026-11-08 (in main; predictive back on, second-opinions 184) |
| A9 | 2026-11-08 | JS (shared) | `Platform.OS` was hard-coded "android"; `Platform.select` never looked at `ios` | fixed on ios (no Android change expected) |
| A10 | 2026-11-08 | Events | An event from the first screen's skeleton (drawn before JS) can reach JS before the screen's handlers exist | not seen on Android (fixed on ios) |
| A11 | 2026-11-08 | Layout | New layout conformance screen to run on the Lava; `alignSelf: "stretch"` doesn't stretch on Android when `alignItems` doesn't; onLayout x / y inside padding; maxWidth on a stretched child | open: Android 42 / 48, fixes wait for Pavan |
| A12 | 2026-11-08 | zn dev | A reload that adds a screen draws it from another screen's template | open (found on Android; iOS has no `zn dev` yet) |
| A13 | 2026-11-08 | device-info (shared JS) | `hasDynamicIsland`, `isDisplayZoomed`, `getBrightness` now read native values (iOS); Android answers stay false / -1 | fixed on ios (check the tests) |
| A14 | 2026-11-08 | location (shared JS) | On iOS the plugin asks core's Permissions for "location" (iOS's name), not Android's two names | fixed on ios (no Android change expected) |

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
- **Status:** open.
- **Problem:** on the Mac, `bun test packages plugins compiler tools` gives 1164 pass, 1 fail:
  `packages/core/test/app-events.test.ts` "native calls still settle after startApp". It passes when run alone
  (`bun test packages/core/test/app-events.test.ts`). In the full run its host logs about 50 lines like "app event 12
  already has a handler; the new one replaces it": an earlier test file leaves app-event handlers installed.
  Same result without the 2026-11-08 changes.
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
