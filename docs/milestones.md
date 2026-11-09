# Milestones and progress

The build plan and a short log of what is done. **Update this file at the end of every working session.**
Approach (Pavan, 2026-10-29): build incrementally, don't aim for perfect on the first pass; one sample app grows with
the framework and is what we test on the phone.

## Repo layout (decided 2026-10-29)
```
zero-native/
  ARCHITECTURE.md, story.md, docs/      spec, history, detailed rules (start with docs/README.md)
  core/                                   C++ shared by Android and iOS (engine adapter, later batch, .zn.ui reader, FlowStore)
  android/                                Gradle build: runtime (library) + sample (app)
  examples/sample/                        the sample app's TypeScript (built to bytecode into android/sample assets)
  packages/  compiler/  cli/              added when their step starts (1.2 / 1.3)
  plugins/                                plugins: TS plus an Android library (docs/plugins.md); today the test plugin
  tools/                                  hermesc wrapper, bundletool, device.json
  experiments/                            v0 experiments and reports (reference only; exp2–4 kept for the Hermes/JNI code)
  claude-memory/                          mirror of Claude's memory for this project
```

## How to build and run the sample
```bash
bun install
```
```bash
bun run sample:js
```
Then, from `android/` (PowerShell), build and install the **debug** build for everyday work (readable stack traces):
```bash
.\gradlew.bat :sample:installDebug
```
Use the release build only to measure performance and for a final release check per step (R8 is on, but names are
kept with `-dontobfuscate`, so traces stay readable):
```bash
.\gradlew.bat :sample:installRelease
```
The release build is arm64 only (size numbers are for phones). To check it on the x86_64 emulator, add
`-PznX86Release` (the sample and the runtime then also pack x86_64; added 2026-11-05).
While working on screens, run `bun run dev` instead of `bun run sample:js` + reinstall: saved changes reach the
debug build on the phone in under a second (`docs/guide-notes.md` §17). Install the debug build once first.
Logs: `adb logcat -s zn zn-js zn-sample zn-dev`. Measure cold start as in `docs/startup-and-performance.md` §3 (release only).
Debug helper: `adb shell setprop debug.zn.js_delay_ms 3000` delays JS to watch the template skeleton on its own
(debug builds only; set back to `0`). After changing `packages/template/src/registry.ts`, run `bun run gen:registry`.

## Milestone 1: foundations (Android)
| Step | What | Done when | Status |
|---|---|---|---|
| 1.0 | Repo skeleton: Bun workspace, C++ core with the Hermes adapter, Android `runtime` library + `sample` app, `hermesc` from the matching `hermes-compiler` package | Sample release build runs Hermes on the phone | **done 2026-10-29** |
| 1.1 | C++ core: host functions, timers with fixed handles, binary batch buffer (`PATCH` / `MOUNT` / `REMOVE` / `MOVE`), one runtime per process | Tests pass; runtime survives Activity recreation | **done 2026-10-29** |
| 1.2 | `.zn.ui` format (own binary format, see ARCHITECTURE §6.1), TS writer, Kotlin reader + preparation, registry for Column / Row / Stack / Box / Text / Image / Pressable / Spacer / Icon, basic renderer | A hand-written template draws its skeleton with no JS | **done 2026-10-29** |
| 1.3 | Compiler: TSX → template + JS; signals; reactive wrapping; static style folding; `&&` / `? :` / `.map` (instead of `<If>` / `<For>`) | `bun test` covers the transforms; amount screen compiles | **done 2026-10-29** (and runs on the phone) |
| 1.4 | Compose renderer: remaining style keys, `Pressable` press states (in / out with cancel, long press) + native key repeat, Image / Icon, recomposition audit | Amount screen complete; typing recomposes only the changed text (measured) | **done 2026-10-29** |
| 1.5 | Measure in release on the Lava: cold start ≤ 250 ms, tap p95, frames, memory, Baseline Profile | Numbers in `docs/startup-and-performance.md` | **done 2026-10-29** (Baseline Profile generation parked: blocked by the Lava's ROM, `docs/after-foundations.md`) |

## Milestone 2: an app (Android)
Full brief with design decisions, tests and phone checks per step:
`docs/cross-communication/2026-10-29-milestone-2-brief.md`.

| Step | What | Builder | Status |
|---|---|---|---|
| 2.0 | Small fixes left from milestone 1 (`targetSdk`, `fontWeight` names, move `exp4-flow`, mock UPI app into `test-kit/`) | Gemini | **done 2026-10-29** (reviewed by Claude) |
| 2.0b | Compose BOM (runtime ≥ 1.11.2) + activity-compose ≥ 1.12 + Coil upgrade, needed by Navigation 3 1.2.0; re-measure | Gemini | **done 2026-10-29** (reviewed by Claude; BOM 2026.09.00 = Compose 1.12.1, activity 1.13.0, Coil 3.3.0) |
| 2.1 | `routes.ts`, several screens in one bundle, route manifest | Claude | **done 2026-10-29** |
| 2.2 | Navigation: JS-owned back stack, `NAV` op, native host + transitions, back button, deep links, screen-owned timers | Claude | **done 2026-10-29** |
| 2.3 | Safe areas: edge-to-edge, per-route option, `insets()` | Claude | **done 2026-10-29** |
| 2.4a | `<List>` with row types, window protocol, placeholders, splice anchor, `onEndReached` (feeds proposal) | Claude | **done 2026-10-29** |
| 2.4b | Rails inside rows (`Scroll horizontal`), gradient backgrounds | Claude | **done 2026-10-29** |
| 2.4c | `<Carousel>`: native paging, snap, auto-advance, dots | Claude | **done 2026-10-29** |
| 2.4d | Impressions: `impressionKey` + `useImpressions` (threshold default 35 %, `minMs`), native-measured, batched | Claude | **done 2026-10-29** |
| 2.4e | Benchmark: offers feed from `test-kit/offers-data.json` vs the RN Offers tab (release, Lava) | Claude | skipped by Pavan (no benchmarking for now); `tools/measure-frames.ps1` stays for later |
| 2.5 | `<Sheet>`: native drag and detents, controlled by JS (+ the native-call transport) | Claude | **done 2026-10-29** |
| 2.6a | Native module foundations: typed `nativeModule<T>`, events + listener counts, cancellation, error codes, versions (`docs/native-modules.md`) | Claude | **done 2026-10-29** |
| 2.6b | Built-in modules on top: `Os.upiApps` + `zn://app-icon`, small `Os` methods, `launchActivity` with results, permissions (`docs/cross-communication/2026-10-29-native-modules-brief.md`); `fetch` and codegen later | Gemini | **moved 2026-10-31** to the plugin plan (`docs/plugins.md` P.2 plumbing, P.3 `@zero-native/upi`); not started by Gemini. (`fetch` was built in 3.4) |
| 2.7 | FlowStore (C++): two-slot crash-safe file, checksums, growth; JS `flowStore` | Claude | **done 2026-10-29** |
| 2.8 | ~~Flows engine~~ (parked 2026-10-30, `docs/after-foundations.md`). Instead: a sample checkout with the save-then-verify pattern (`docs/guide-notes.md` §16) against the mock UPI app, including the app being killed while the UPI app is open | Claude | **moved 2026-10-31** to the ZeroBill checkout pilot (planned separately), after plugins P.3 |
| 2.9 | Release measurements; close the milestone | Gemini, Claude reviews | **covered 2026-10-31**: release numbers were taken at each step of milestones 3–4 (`docs/startup-and-performance.md` §4); proposed: treat milestone 2 as closed, since 2.6b / 2.8 moved (Pavan to confirm) |

## Milestone 3: real-app essentials + a fast dev loop (Android)
Agreed with Pavan 2026-10-30. The framework stays linked to the sample app (no separate npm / Maven packaging) until
milestone 3 or 4 ends. Registry ids are split so Gemini and Claude never pick the same number: Claude uses
components 15–19, props 122–199, events 11–29; Gemini uses components 20–29, props 200–249, events 30–39.

| Step | What | Builder | Status |
|---|---|---|---|
| 3.1 | `zn dev`: save a TSX file → the screen reloads on the phone (debug builds only); JS errors show a dev error screen with the TSX file and line (source maps) | Claude | **done 2026-10-30** |
| 3.2 | Compiler gaps: children for user components, fragments `<>…</>`, text spans, JSX types for editors | Claude | **done 2026-10-30** |
| 3.3 | `<TextField>`: the native field owns the text, `onChange` to JS, controlled value, keyboard insets | Claude | **done 2026-10-30** |
| 3.4 | `fetch` subset over OkHttp (method, headers, body, JSON, timeout, `AbortSignal`) | Claude | **done 2026-10-30** |
| 3.5 | `storage` (MMKV) with **synchronous** JSI calls (no Promises), `SecureStore` (Android Keystore) | Claude | **done 2026-10-30** |
| 3.6 | Animation: `animate` with spring / tween on slot values, enter / exit on `&&` and `? :` | Claude | **done 2026-10-30** |
| 3.7 | Small components: Switch, Checkbox, Spinner / Progress, Toast, image fallback + shimmer | Gemini, Claude reviewed + fixed | **done 2026-10-30** (note: `docs/cross-communication/2026-10-30-steps-3.7-3.8-gemini-done.md`) |
| 3.8 | Accessibility basics: `label`, `role`, `hidden`, font scaling with `maxFontScale` | Gemini, Claude reviewed + fixed | **done 2026-10-30** |
| 3.9 | **Resilience** (agreed 2026-10-30; **done 2026-10-30**, log below): (1) a screen that throws while being built stays on the stack and native shows a built-in fallback (release: "Something went wrong" + Go back / Try again; first screen: Try again; debug: the red screen with the TSX line); a failing part of a screen (conditional block, list row) stays empty, the rest works; (2) promise rejection tracking, so errors in `async` code are reported; (3) a time limit on each JS task (Hermes `watchTimeLimit`, ~5 s) instead of a frozen app; (4) `onError(handler)` for apps (screen name, bundle id) to send to Crashlytics / a backend; (5) checks on templates and values when they arrive (unknown ids, wrong value types, a node placed inside itself): refuse or report instead of crashing; (6) the back stack saved on every change and reopened after Android kills the app in the background (designed in ARCHITECTURE §11, built only in v0); (7) `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` reuse cached formatters per locale + options, so the simple way is also the fast way (today ~2 ms per call, guide note §25) | Claude | **done 2026-10-30** |

**Milestone 4 (OTA): design in `docs/ota.md`** (steps 4.0–4.9). 4.0 done 2026-10-30: Pavan took D1–D5 as
recommended; logged in ARCHITECTURE §16 / §24. 4.1, 4.2, step 3.9 and 4.3 (local store) done 2026-10-30 (log
below). 4.4 and 4.5 done 2026-10-30, 4.6, 4.7, 4.8 and 4.9 done 2026-10-31: **milestone 4 is done**.
`restorableSignal` (agreed below) done 2026-10-31. Next: the plugin system (`docs/plugins.md`, decisions D1–D7 taken
2026-11-02), then the ZeroBill checkout pilot: login, scan, UPI transaction (details in the app's private repo).
Order agreed 2026-10-30: framework first (milestone 4), the 2.8 sample checkout later; Gemini does 3.7 / 3.8.

**Agreed for after 4.9 (Pavan, 2026-10-30): `restorableSignal(key, initial)`** (**done 2026-10-31**, log below). Like `signal`, but its value comes
back when Android restores a screen after killing the app in the background (step 3.9 brings the screens back; their
signals start fresh today). For the amount typed on the keypad, a half-filled form, the selected tab. Each change
goes to native, which keeps the values per screen entry and saves them with the back stack (`ZnNav.saveState`); on
restore, the START payload hands them back as the starting values. JSON-able values only, a size cap (saved state
is small), nothing kept across normal launches (that is `storage`). About half a day; React Native has no such
thing, Flutter (`RestorationMixin`) and Compose (`rememberSaveable`) do.

Later milestones: **4** OTA (**done 2026-10-31**: signed bundles, bundle pool, boot guard, capability manifest, "an older app ignores a
newer bundle" test, release crash traces mapped back to TSX); **5** ZeroBill checkout pilot with a full-app size
measurement (planned separately, after plugins P.3); **plugins** (`docs/plugins.md`, proposal). Not planned yet: the
Hermes debugger (Chrome DevTools), the flow engine (parked), iOS.
Parked ideas: `docs/after-foundations.md`.

## iOS track (started 2026-11-08)
**The iOS status, phases and what's left live in `docs/milestones-ios.md`** (kept current after every iOS piece); the
table below is the original 2026-11-08 plan. iOS log entries stay in `## Log` below.
Agreed with Pavan 2026-11-08: the renderer mixes SwiftUI and UIKit, chosen per component (`ARCHITECTURE.md` §20).
Android fixes the port shows are made as it goes and recorded in `android-issues-found-when-building-ios.md`.
All iOS work happens on the `ios` branch (Pavan, 2026-11-08).
Minimum iOS version: open (17 suggested). Code lives in `ios/` (planned: `ZnRuntime` Swift package + `Sample` app).

| Step | What | Done when | Status |
|---|---|---|---|
| i.0 | Shared ground: Mac versions of the Windows-only tools; `gen:registry` also writes Swift; golden `.zn.ui` and batch files read by both test suites; OTA decision logic (bundle choice, health, signature) moved from Kotlin to C++, with each platform only reporting facts (Android: `ApplicationExitInfo`) | Android tests and the OTA phone matrix still pass; the C++ core tests run on the Mac | not started |
| i.1a | Hermes + core on iOS: `hermes-ios` 260318099.0.5 from Maven Central, core and MMKV built for the simulator and arm64, core tests on the simulator, `main.hbc` from `hermesc` runs | Core tests pass on the simulator; the Android bundle's bytecode loads unchanged | **done 2026-11-08** on the simulator (log below); arm64 device build not tried yet |
| i.1b | Spike, renderer: `zn::Platform` in Objective-C++, the JS thread, the batch applied on the main actor, the amount screen drawn by SwiftUI, skeleton before JS | Typing redraws only the changed text (measured with `_printChanges` / Instruments) | **done 2026-11-08** on the simulator (log below): a digit redraws 2 views of ~169 |
| i.1c | Spike, the hard parts, each tried both ways (SwiftUI vs UIKit): back stack driven by JS (several pushes / replace in one batch, back swipe), controlled text field (cursor, IME, paste), a long list, a sheet with detents, **press handling** (SwiftUI `Button` vs a UIKit gesture: fast taps, press-repeat, long press). Our own `Layout` for Column / Row against the Android sample | A written choice per component, with what was seen | **done 2026-11-08** on the simulator: **UIKit for all five** (log below). Open: the back swipe untested (the simulator tool can't start edge swipes; try by hand); the Layout checked by eye only (side-by-side tests in i.2) |
| i.2 | Milestone 2–3 equivalents: navigation, safe areas, lists, sheets, text input, animation, resilience, `zn dev` | The sample's screens run on iOS | **in progress**: route options, list window, multi-line field, sticky rows, absolute children, keyboard avoidance, transforms, animation, enter / exit, Image, Shimmer, corners and borders, text spans, Modal, app layers, Carousel, onLayout, gradients, Svg, layout conformance (50 / 50), registry 23 read (not all drawn, checklist §1b), Switch, Checkbox, Spinner, Progress, OtpInput, Tabs, pull to refresh, native modules done except Launches, background tasks and Updates (log below); layout tests, the RN props lab's missing parts open |
| i.3 | Platform modules: `fetch` (URLSession), storage (shared MMKV), SecureStore (Keychain), restore after the app is killed (file-based, no saved-state bundle on iOS), OTA | OTA matrix cases that apply to iOS pass | not started |
| i.4 | Plugins, in the order the ZeroBill checkout needs them (`auth`, `scanner`, `push`, …); UPI by URL scheme + server verify | ZeroBill checkout runs on iOS | **in progress**: plugins, native screens and views, scanner (simulator; camera untested) |

### Android fixes found by iOS
Kept in `android-issues-found-when-building-ios.md` (one entry per issue, with what to check on Android). Pavan
forwards them to the Android machine. Work on the `ios` branch.

## Tests
| What | How | Where |
|---|---|---|
| C++ core (batch, coalescing, ticks, timers) | `.\tools\run-core-tests.ps1` (builds with the NDK, runs on the phone) | `core/tests/core_tests.cpp` |
| C++ core on a Mac and the iOS simulator; the sample's `main.hbc` on Apple's Hermes (engine tests) | `bun run tools/fetch-hermes-apple.ts` once, `bun run sample:js`, then `bun run tools/run-core-tests-apple.ts` (add `--sim` with a booted simulator) | `core/tests/core_tests.cpp`, `core/tests/engine_tests.cpp`, `core/tests/apple/` |
| JS (runtime timers/events, template writer, registry drift) | `bun test packages` at the root | `packages/*/test/` |
| Kotlin (batch reader, template reader) | `.\gradlew.bat :runtime:testDebugUnitTest` in `android/` | `android/runtime/src/test/` |
| Lint | `.\gradlew.bat :runtime:lintDebug :sample:lintDebug` | 0 errors expected |
| On the phone | sample app: JS timer, taps, "Recreate activity" | `android/sample`, `examples/sample` |
| OTA and launches on the phone (38 cases, ~30 min) | `bun run ota:phone` (debug sample, phone unlocked) | `tools/ota/phone-matrix.ts`, `docs/ota-test-matrix.md` |
| Core plugin parts and the official plugins on the phone (~15 min without hands) | `bun run tools/plugin-phone.ts --no-hands`, then `--hands` | `tools/plugin-phone/` |

## Log
### 2026-11-10: iOS OTA steps 1–4: rules, check, download, install, safety nets (Claude, Mac)
Pavan's plan (docs/ios-ota-plan-2026-11-10.md, "go as recommended"): Android's Kotlin rules copied to Swift, no patches
and no push-triggered check yet. New in ios/ZnRuntime/Swift:
- **ZnOtaRules.swift** (Foundation + CryptoKit, no UIKit): bundle info and `requires`, signatures (P-256 DER, the same
  texts as Android), store answers, health rules. **ZnOtaInstall.swift**: a zip reader (stored / raw deflate through
  Compression) and the install checks (zip SHA, each file's size and SHA, the bundle SHA). `bun run ios:ota-test` runs
  52 tests on the Mac, against the CLI's signature fixture and a zip made the CLI's way.
- **ZnOta.swift**: the bundle choice at ZnApp.start (`zn-ota/current` in Application Support, not in backups; the
  built-in bundle when anything is wrong), the check (protocol 1, `patches: []`, `store: { os: "ios", version }`),
  resumable download, install, prune, state.json, the safety nets and the `Updates` module (v3; `applyNow` answers
  `not_started` until step 5).
- **How a launch ended** on iOS (no ApplicationExitInfo): a crash mark written by signal and exception handlers
  (sure: 1 blocks), else an unsure death if the app ended while active (2 block). The handlers go on 3 s after start,
  only while a downloaded bundle runs, and call the handler before them, because Crashlytics warned it "will interfere"
  when ours came first. A launch stops counting when the app goes inactive (an app-switcher swipe may end it there).
- Hooks: ZnModules.registerBuiltIns before the choice (module versions), `screensUp` at NAV STARTED, start / screen /
  hang errors → `errorScreen` (once per process), `asset:` files from the running bundle else the app's
  (ZnImage, Lottie, image viewer), zn-bundle.json in the app (ios/CMakeLists.txt). ZNHost gives bytecode and host API
  versions. The iOS sample talks to a server on this Mac (staging, the sample's key; debug: ZN_OTA_KEY,
  ZN_OTA_HEALTHY_MS).
- **Checked on the simulator** (reference server, a scratch store and key): the Android sample's bundle is refused
  (it needs AdId, Motion, Push, Notifications, Media, Perf, RemoteConfig, Device 6); a bundle that fits downloads,
  runs from the next start, turns healthy after 4 s; SIGSEGV before healthy → crash mark → blocked → the last good
  bundle runs; a main.hbc that can't start → blocked, last good from the next start; a pointer signed by another key →
  refused; kill switch → built-in; closed from the background → not counted.
- Not yet: apply in place and the launch gate (step 5), ZeroBill (step 6), the full iOS matrix (step 7: resume,
  no space, fuse, first-screen timeout). ZeroBill's bundle will be refused until iOS has AdId, Motion, Notifications
  and Push.

### 2026-11-10: iOS image viewer, made to behave as Android's (Claude, Mac)
Pavan's order (2026-11-10, through the Windows session): the image viewer first, working as on Android everywhere
ZeroBill opens it (Offer Details picture, Notifications hero picture: `ImageViewer.open({ images: [url] })`, route
`native: "imageviewer.full"`). plugins/image-viewer/ios/ImageViewerPlugin.swift:
- **One swipe skipped a picture (2 → 4)**: adding the next page during a swipe runs a layout, and the layout set the
  pager's offset again mid-swipe. The pages lay out again only when the screen's size changes.
- **Swipes moved to the next picture while zoomed**: Android's pager stops while a picture is zoomed (the drag pans to
  the picture's edge and stops there). Each page reports its zoom; the pager scrolls only at fit.
- **The bar is Android's**: a white back arrow (no circle) in a 48 pt touch area at the start of a 56 pt row under the
  status bar, the count in the middle, over a black 55 % → clear fade; it fades with the drag to close. The spinner is
  the small one; the error has a picture sign over "Couldn't load this photo" and Try again.
- iOS has no Back button: the viewer is a fade screen, so ZnNavHost's edge swipe doesn't close it (as an iOS modal);
  it closes with the back arrow or a drag up or down, both answering `{ index }`. With several pictures the left-edge
  swipe pages back, as in Photos. ZeroBill is portrait only, so turning the phone does nothing.
Checked on the simulator (sample's Image viewer lab, old screen): opens on the tapped photo, one page per swipe,
double tap zooms at the finger and back, pinch, pan while zoomed stays on the page, drag down closes and answers the
index, back arrow answers, broken / refused / good (error, Try again, the good one), 5000 × 3333, the options case
(grey, no drag close, no double tap), two opens at once (one screen, both answered). In ZeroBill (zn iPhone 16):
Offer Details picture opens, double tap is sharp, drag down returns to Offer Details. No notification in the test
account has a picture; that screen uses the same call. Waits for Pavan's iPhone.

### 2026-11-09: iOS, a Scroll with only maxHeight hugs its content (Claude, Mac)
- ZeroBill's checkout opens with the offers sheet: a header, `<Scroll style={{ maxHeight: 400 }}>` with the offer rows,
  then Continue. On Pavan's iPhone the sheet was too tall: a SwiftUI ScrollView takes all the height it is offered, so
  the Scroll was 400 tall with one or two rows. Android's verticalScroll Column is as tall as its content, up to what
  it is offered. ZnRenderer.swift `ZnScrollHugLayout`: a vertical Scroll with no height that doesn't fill (no flex, no
  stretch) takes its ScrollView's ideal height (its content's), capped by the offer (so maxHeight still caps it and it
  still scrolls). Scrolls with `flex: 1` (every ZeroBill tab and screen) are as before. LayoutLab case 47 (30 of
  content → 30; 150 of content, maxHeight 100 → 100); 97 / 97. Checked in ZeroBill: the Rewards tab fills and scrolls.
  ZeroBill's other sheets with a capped Scroll (payment methods 380, counter 320, txn details 640) hug the same way.

### 2026-11-09: iOS, three bugs from Pavan's iPhone test (Claude, Mac)
Pavan ran ZeroBill on his iPhone 11 (scan, a ₹1 payment) and the ZeroBill session passed on three iOS bugs.
- **A Row raised to its minHeight kept its children at the top** (ZnFlexLayout / ZnStackLayout / ZnWrapLayout,
  ZnRenderer.swift `innerMin`): ZeroBill's ListTile (`alignItems: "center", minHeight: 56`, padding 8) had its icon and
  text at the top of the card on TxnInfo, Profile, About. The min raised the box around the Row, not the Row's own
  layout. A container now gets its min (less padding and border) and lays its children out in it, as Yoga and
  Compose's heightIn do. LayoutLab case 46 (a Row and a Column); 95 / 95. Checked in ZeroBill: TxnInfo rows centred.
- **Sheets: the "content" detent was measured once** (ZnSheet.swift): when the sheet opened. Content that changed later
  left the sheet too tall or too short. The content now reports its height and the detent is invalidated when it
  changes; the first measure takes the bottom safe area off (UIKit adds it; sizeThatFits counts it once the sheet is on
  screen). Checked: the sample's Components sheet "More lines" grows and shrinks it; ZeroBill's scanner error sheet is
  20 pt grabber room + its padding + content + the home-indicator area (Android: 20 dp handle + content + the
  navigation-bar inset).
- **A sheet closed while it slid in stayed up** (ZnSheet.swift): ZeroBill's "Processing Secure Payment" was closed
  231 ms after it opened, and UIKit drops a dismiss during the present animation, so it stayed over the success screen.
  The dismiss now waits for the present's completion. Checked: the sample's "Sheet: close while it slides in" (closes
  500 ms after the tap, 187 ms into the slide): "closes when it has opened", then gone.
- Found on the way: with 200 ms between visible true and false, iOS never shows the sheet (both reach SwiftUI in one
  update). Android may show and close it; not a bug for ZeroBill.

### 2026-11-09: iOS, the scanner window and taps after switching tabs (Claude, Mac)
- **aspectRatio with a "%" side** (ZnRenderer.swift ZnSizeFrame): ZeroBill's scanner window (`width: "75%",
  aspectRatio: 1`, absolute corners) was drawn 0 tall: the ratio only worked with a width in points or with no side
  set. Now a "%" width (or a "%" height alone) gives the other side, the box's content fills the ratio's size, and a
  Stack / Column inside counts its height as set (bottom / end children at its bottom). LayoutLab case 45; 93 / 93.
  Checked in ZeroBill (Scan with `ZN_SCANNER_FAKE`): the window is 296 pt square with its corners on it.
- **Taps after switching tabs** (ZnPress.swift, ZnTabsRefresh.swift): a Pressable lets a smaller Pressable under the
  finger take the touch (nested buttons). A hidden tab's Pressables were faded out, not hidden, so a small button on
  the hidden Rewards tab "won" the tap on Offers' card and then couldn't take it: nothing happened (ZeroBill: Offers →
  Rewards → Offers, tap a card). A hidden tab's touch views are now hidden (environment `znInHiddenTab`, nested Tabs
  too). Needs a logged-in ZeroBill to check: the ZeroBill session checks it.
- `tools/ios-sample.ts --device <name or UDID>`: a second simulator ("zn iPhone 16 B") so this session and the ZeroBill
  session don't take turns on one.

### 2026-11-09: iOS flexWrap on Row (Claude, Mac)
- New ZnWrapLayout.swift, ZnWrap.kt's rules: lines by width (flex children 0 wide, then sharing their line's rest; "%"
  of the whole Row), justifyContent per line with gap, alignItems / alignSelf in the line (stretch only when written),
  alignContent with crossGap (rowGap, else gap). Points are floats as Yoga's dp, so no pixel slack is needed (Android's
  half pixel per child); a hundredth of a point is kept for float noise.
- **Checked on the simulator:** LayoutLab **91 / 91** (cases 30–37 were the last misses); RN gaps lab §6 chips wrap
  three lines, §7 centres each line. Not yet: a gap / rowGap from a signal (iOS doesn't apply layout values from slots,
  registry 23; ZeroBill uses none).

### 2026-11-09: iOS layout foundations from ZeroBill (Claude, Mac)
- Pavan, looking at ZeroBill on the simulator: "lot of glitches reg. width, height, margins, paddings, flex". Went
  through Home, Offers, Offer Details, Stores, Rewards, Profile, Welcome and Scan against their TSX and zn's rules
  (no Android device on the Mac). Found and fixed:
  - **min / max sizes** (ZnRenderer.swift `ZnMinMaxLayout`): SwiftUI's `.frame(maxWidth: 190)` grows a view to 190
    when offered more; RN and Android only cap. Offer Details' store pill (Text maxWidth 190) took 190 and squeezed
    the price pill beside it to three lines. Now a max only caps, a min only raises, a fill (stretch, flex) takes the
    offer kept between them. ZeroBill uses min / max 46 times.
  - **Pictures** (ZnImage.swift `ZnPictureBox`): a `contain` picture sat at the top left of its box and a `cover` one
    was cropped from the top left (the box took the picture's size; the node's frame then aligned it). Now centred,
    as Android. ZeroBill's offer cards and Offer Details' photo showed it.
  - **StatusBar / NavigationBar** (new ZnSystemBars.swift, ZnSystemBars.kt's rules): were drawn as nothing. barStyle
    (light / dark text), hidden, backgroundColor per screen, newest element wins; the colours are strips over the top
    and bottom safe areas under the content. ZeroBill uses them on 10 screens (Scan's light text checked).
- **LayoutLab** cases 41–44 (content-sized children with min / max, and the Offer Details pills): 74 / 91 on iOS; the
  17 misses are flexWrap (next). Android should pass 41–44 (Compose's widthIn only caps): not run on a phone yet.
- Not zn: Home's grey strip under the tab bar is the screen's own background (#F7F8FA) in the bottom safe area; on
  Android it shows in the gesture area too. ZeroBill can add `<NavigationBar backgroundColor={c.white} />` to Home.

### 2026-11-09: iOS, the ZeroBill session's zn issues (Claude, Mac)
- The ZeroBill iOS session (Phase 2) reported five zn issues. Checked each against ZeroBill's built bundle
  (`ios/bundle/main.zn.ui`, read template by template):
  - **ImageViewer** answered "unavailable": the JS asks for module 3, iOS had 2. iOS's module is now 3 with `release`
    (frees a viewer's held `data:` bytes and headers, as Android). Version 3's TSX screen (view `imageviewer.page`,
    useZoom) is still not on iOS; ZeroBill's route is `native: "imageviewer.full"`, so it gets the Swift viewer.
  - **"doesn't draw a runtime value for prop 1 / 2 / 293 (registry 23)"** at ZeroBill's start: those slots are only in
    image-viewer's TSX screen (ImageViewerScreen, ViewerPhoto), which comes with the package but ZeroBill never opens.
    No ZeroBill screen uses a registry 23 runtime value. Same for **Motion 1** in the bundle's needs.
  - **`OsInfo` had no `ios`**: added (`ios?: string`, "Missing on Android"); iOS already sent it. `android` is "" and
    `sdk` 0 on iOS, now said in the type's comments.
  - **Analytics screen names**: iOS's `AnalyticsPlugin` already takes `screenName:`; ZeroBill's `MyApp.swift`
    needs Android's `rnScreenName` mapping (ZeroBill's side).
- **Checked on the simulator:** image viewer lab, old screen, "data: picture, too big, bad": opens on the held picture,
  the two bad ones logged, close answers `{ index: 0 }`. `bun run test:types` clean; A7 grew to 5 order-dependent
  failures in the full `bun test` (same without these changes).

### 2026-11-09: iOS, Updates "OTA off" and Tasks modules for ZeroBill's bundle (Claude, Mac)
- ZeroBill's bundle calls five zn modules iOS didn't have. Checked each JS side: AdId, Notifications and Push already
  fall back when the module is missing (every call caught; listeners on a missing module are ignored), so nothing to
  add. Updates and Tasks get iOS modules (ZnBuiltInModules.swift): `ZnUpdatesOff` answers as Android does with OTA
  not configured (status `{ enabled: false, phase: "off" }`, check NONE / OFF, applyNow "off", hold until released,
  markHealthy); `ZnTasks.done` answers true (nothing starts a task on iOS yet). ZeroBill's About screen calls
  `void Updates.status()`, which would have been an unhandled rejection.
- **A15** (Android): with OTA off, `Updates.check()` answers without `status`, which its JS type promises; the sample's
  Updates screen threw on Check now. iOS includes it.
- **Checked on the simulator:** route `updates`: "Updates are off", Check now → "Check: NONE OFF" (no error), Apply now
  → "Apply: off", Hold / Release hold.
- Also: `docs/milestones-ios.md` (1a62100), the iOS status in one place; Pavan's answers for Phase 2 (secrets file: he
  copies it in; GoogleSignIn: build it now) recorded there.

### 2026-11-09: iOS Phase 1c, Splash hold, Sheet animateIn, error screen (Claude, Mac)
- **Splash hold** (ZnUiModules.swift `ZnSplash`, Android's ZnSplash.holdUntilReady): the scene delegate calls
  `ZnSplash.holdUntilReady(window, capMs:)` after `makeKeyAndVisible`; a copy of the launch screen covers the window
  until JS sent NAV STARTED and every `Splash.holdUntil` hold is released (or its maxMs / capMs passed), plus two frames
  for the screen it pushed, then fades in 0.2 s. A push under it has no slide; a sheet presented under it stays below
  the cover. Not called = hold ignored (as Android). Sample: `ios-sample.ts --splash-hold 3000`.
- **Sheet `animateIn`** (registry 21 / 22, ZnSheet.swift): read when the sheet opens; false presents it with no
  animation. A sheet visible on its screen's first frame used to be dropped by UIKit ("not in the window hierarchy"):
  it now waits until its screen is in the window (1 frame at a cold start).
- **Error screen** (new ZnErrorScreen.swift, ZnErrorScreen.kt's words, colours and buttons): NAV FAILED, a "hang" JS
  error on the top screen, Try again (RETRY 10: a fresh root, JS builds again), Go back; a failed start shows it
  without a button (iOS apps can't relaunch themselves). JS time limit 3 s debug / 2 s release, as Android (was 5 s).
- **Checked on the simulator:** props lab "Splash waits 1.5 s" (white cover, then the lab, no Home flash); "Open this
  lab at next start" (lab + processing sheet at rest under the splash); crash lab (screen that throws → error screen,
  Try again → "It works now", Go back; endless loop → "stopped responding", Try again); `--route nope` (start failed).
- **Not checked:** a real launch storyboard with an image (the sample's UILaunchScreen is empty: white); ZeroBill's own
  QR cold start (Phase 2).
### 2026-11-09: iOS Phase 1c, press feedback (Claude, Mac)
- **ZnPress.swift `ZnPressFeedback`**, Android's ZnRipple / ZnHighlight (ZnAnimation.kt, ZnTemplate.kt defaults):
  `pressFeedback` ripple (default) = a circle from the finger inside the node's shape, black at 12 % (a `rippleColor`
  at 24 %, `rippleOpacity` wins), growing to the farthest corner in ~225 ms and fading ~150 ms after release (a quick tap
  still shows it); `rippleBorderless` = not clipped, `rippleRadius` its size; `highlight` = a flat `highlightColor`
  (black at 10 %) while pressed; `none`. It sits under the press scale / opacity, as Android's indication. Before this,
  every iOS button without pressScale / pressOpacity showed nothing (ZeroBill: 18 files use pressFeedback).
- Also: a route named for a dev run (`--route`) now wins over state restoration (the tool's relaunch counts as a
  system end, so restore had opened the old screen instead).
- **Checked on the simulator (Press lab, screenshots while the finger is down):** default card grey ripple in its
  rounded shape; dark button white ripple; icon button borderless 24-point circle.
- **Not checked:** the ripple's timing against Android side by side (no phone here); Switch / Checkbox ripples
  (Android has them, iOS doesn't yet).

### 2026-11-09: iOS Phase 1b, restore after the system ends the app (Claude, Mac)
- **ZnApp.swift**, as ZnNav.kt saveState / restart: each entry's params and its `restorableSignal` values (NAV RESTORE,
  kind 9) are kept natively; `restorationActivity()` gives the stack (route names, params, values; up to the first
  `restore: false` route; nothing for the start screen alone) as an NSUserActivity for the scene's
  `stateRestorationActivity(for:)`; `start(…, restoring: session.stateRestorationActivity)` reopens the start screen +
  the saved screens with START `values`. iOS gives the activity back only after it ended the app itself, never after
  the user swiped it away, which is Android's saved-state rule. Values saved by another build (version + build) are
  dropped, screens kept (Android: another bundle). The sample's scene does both (two lines; ZeroBill's app will too).
- **Checked on the simulator:** amount screen (link) → ₹250 typed → Home button → `simctl terminate` → launch: "iOS
  restored the app; reopening 2 screen(s): home, amount", the amount screen shows ₹250 with its cashback line.
- **Not checked:** the swipe-away case (no restore) by hand; a restore with a launch "lost" at the same time.

### 2026-11-09: iOS fixes from Pavan's look at the Tabs lab (Claude, Mac)
- **Line over the Scan button:** iOS drew borderTopWidth / borderBottomWidth lines over a view's children; Android draws
  them behind (drawBehind), so a child standing out over the line (the raised Scan button) covers it. iOS now draws the
  side lines in the background layer (ZnRenderer.swift ZnSideBorders); the full border stays over the content, as
  Android's `border` modifier. Checked: Tabs lab, the bar's line runs under the button.
- **"Couldn't load":** the Tabs lab's data comes from tools/fetch-test-server.ts (port 8788), which wasn't running. The
  hint now says the iOS simulator needs no `adb reverse` (shared sample text: TabsLab.tsx). With the server: 40 items a tab.

### 2026-11-09: iOS Phase 1a, deep links and launches by URL (Claude, Mac, `main`)
- **Links** (ZnApp.swift `ZnLinks`, as ZnNav.kt + ZnRoutes.kt): a link's path matched to a `deepLink` route (most literal
  match, `:param` parts, "<path>/<tab>" for a route with tabs, query values as params). Cold start: the app starts on the
  "/" route with the link's screen on top (START entries carry `link`, so JS's `onLink` decides), or Home with the link's
  params when it points at Home; a start link with no route goes to `onUnmatchedLink` (OPEN, atStart). While running:
  OPEN (event 4) from the scene's `openURLContexts` / universal links; links during JS's start wait for START.
  The sample starts in its scene (where the opening link is known) and registers the `zn` scheme (Android's zn://sample).
- **Launches by URL** (ZnPlugins.swift `ZnLaunch.open`): "waiting" on disk, then `UIApplication.open`; nothing opened →
  no record, `no_app`. When the user comes back: resultCode -1 and `data` = the link the other app opened to come
  back, else resultCode 0 (`extras.returned` true); a kill in between is "lost" at the next start. iOS gives no result:
  JS (ZeroBill's UPI plugin, Phase 2) asks its server. Bug found and fixed: `open`'s completion comes after the app has
  already left, so the "away" mark is set before calling it.
- **Sample:** the iOS test plugin has a Device module (v6: info, slowEcho, fail, openMockUpi = Safari, openMissingApp);
  `tools/ios-sample.ts --link <url>` starts the app as if that link opened it (debug `ZN_LINK`). Without `--route` the
  sample now starts as a real app (Home), as on Android.
- **Checked on the simulator:** Launch lab: missing app → no_app; open mock → Safari; back by `zn://sample/dev/launch?…`
  → result -1 with the link; back by switching apps → result 0; a restart while waiting → "lost" with its id; ack.
  Links: cold `zn://sample/pay/m7` → Home + amount m7 (Back → Home), JS heard `atStart=true`; running: an unmatched link
  → onUnmatchedLink; `/dev/tabs/offers` → the Tabs lab on "offers".
- **Not checked:** universal links (need the associated-domains entitlement, Phase 2 signing), a real UPI app (Phase 2,
  on the iPhone; no real payment).

### 2026-11-09: gestures and motion, phases 1–3 on Android (Claude, main)
- Built per `docs/gestures-and-motion-v1.md` (D1–D10) and documented in `docs/motion.md`: motion values and timings,
  `derive` formulas (compiled), env / self / parent values, gestures (pan, pinch, rotate, tap, long press, fling,
  groups, links across elements, manual activation, drop zones), element values (box, scroll, page, press, sheet
  progress, pull), `format` text, 3D / blur / corner / Svg targets, layout motion (`animateLayout`, `itemAnimation`,
  new enter / exit presets), Sheet predictive back, `m.follow`, shared elements, List reorder, tilt, `useFrame`, and the
  plugin API (`ZnMotionApi`). Registry 24, `Motion` module 1, Device test module 6.
- Labs 1–9 in the sample (`Motion*Lab.tsx`). JS and Kotlin tests pass.
- **Phone check, Lava (same day, release build):** all 9 labs work. Fixes from it: `sharedTag` alone never moved,
  List rows that use the index kept their old one after a move, text around `v.format()` showed raw characters, a
  leaving screen's motion values fell to 0 during its exit, follow froze while its source moved, Row pinned top and
  bottom. Drag the store page down to close (Pavan's idea). Open: first push of a big screen loses its slide
  (second-opinions 193, pre-existing), `keyboardDismissMode` planned (waits on Pavan).
- Decisions: second-opinions 186–192. iOS port notes: `docs/motion.md` §14.

### 2026-11-08: iOS i.4, the document scanner (Claude, `ios` branch)
- **document-scanner** (`plugins/document-scanner/ios`): Apple's VisionKit document camera as a launch, so the JS side
  is Android's: the job ("zn.docscanner" / "job") is on disk before the camera opens; the pages come back as images in
  memory and are written at once as our JPEGs (and the PDF, by PDFKit, when asked) in ZnHandles.fileDir before JS hears;
  collect / forget / cleanup and the 7-day trim as on Android. iOS: getStatus / download answer "available" (nothing to
  download); `maxNumDocuments` keeps the first pages; `galleryImport` and `mode` are checked and ignored; a kill while
  the camera is open is "lost" (the pages were only in memory).
- **Runtime:** `ZnLaunch.start` / `finish` (a plugin's own launch: "waiting" on disk, then the result record and the
  Launches `result` event; "busy" / "unacked" as ZnLaunch.kt), and a launch still waiting at start becomes "lost".
  `<Image src="zn://file/…">` now loads (ZnImage → ZnHandles).
- **Debug hook:** the simulator's VisionKit opens but can't capture ("Unable to capture media"). With no camera,
  `ZN_DOCSCAN_FAKE=<pages>` (or `cancel`) makes a fake scan of drawn pages through the same files, job and launch.
- **Checked on the simulator:** the real camera's error comes back as "cancel" (Android: any answer that isn't OK);
  fake: 3 pages 1240x1754 with the tag, pages + PDF (3 pages) with a thumbnail through zn://file, bad option
  invalid_args, cleanup of 7 files, a kill with the camera open → next start "lost" with its tag.
- **Not checked:** a real camera scan (needs an iPhone).

### 2026-11-08: iOS, Linking.openURL opens any app's link (Claude, `ios` branch)
- As Pavan decided on main (second-opinions 185, ZnOs.kt): `Os.openUrl` / `Linking.openURL` open any scheme, except
  text with no valid scheme and `intent:`, `file:`, `javascript:` (not_allowed). `canOpenUrl` answers true for other
  apps' schemes only when the app lists them in LSApplicationQueriesSchemes, as in RN. The sample lists none (Android's
  sample has no `<queries>` either). Checked: canOpen https true, tel false, whatsapp false; openURL whatsapp → no_app
  on the simulator (was not_allowed).

### 2026-11-08: iOS i.4, the straight ports: lottie, pdf, webview, image-viewer; markdown checked (Claude, `ios` branch)
- **lottie** (`plugins/lottie/ios`): lottie-ios 4.6.1, static XCFramework (`bun run tools/fetch-lottie-apple.ts`, SHA-256
  pinned, `ios/third_party/lottie`, linked by CMake when there; the bundle's `lottie/` folder now ships in the app).
  `lottie.view` and `preload` with Android's play rules (LottieRules ported): autoPlay, loop, parts and backwards parts,
  progress, pause / resume / reset with onAnimationFinish(true) only for a reset that cut a play, colour filters, .json
  and .lottie, the same failure reasons. iOS: Reduce Motion shows the end frame (Android's "Remove animations");
  renderMode maps to Lottie's engines. Lottie lab: all of it, preload 200x200 36 frames 1200 ms as on Android.
- **pdf** (`plugins/pdf/ios`): downloads with Android's rules (https; debug http to localhost; redirects by hand, 5 at
  most, headers only to the same origin; size limit; `%PDF-` check; a dot part file renamed once PDFKit opens it; one
  download per file; cleanup by age), `pdf.view` on PDFKit's PDFView (scroll, pinch, double tap 2.5x, page and zoom
  events, debugZoom) and `pdf.preview` drawn by PDFKit. PDF lab with tools/plugin-phone/pdf-server.ts on this Mac: one
  page, 50 pages, password, broken, html, missing 404, both redirects, too big, not https, no server, bad handle.
- **ZnHandles** (`ios/ZnRuntime/Swift/ZnHandles.swift`): `zn://file/<name>` handles in Caches/zn-files, the same name
  rule as Android, for pdf now and document-scanner / media later.
- **webview** (`plugins/webview/ios`): WKWebView with Android's rules (WebViewRules ported: host list, link decisions,
  never-schemes, leave gate), an origin-checked bridge (`window.ZeroNative` only in allowed frames, native checks the
  sender, replies only to the main frame that wrote first, also after a back to a cached page), cookies and storage
  clearing, pause / resume. iOS: third-party cookies always blocked (WebKit), iOS's own file picker, no renderer kill.
  WebView lab with tools/plugin-phone/webview-server.ts: bridge echo, blocked host, upi out, intent / content refused,
  page2 and back, redirect to a blocked host, form post to a blocked host refused, blocked / network / 500 errors,
  inline page with a base, cookie set / kept / cleared, paused / resumed.
- **image-viewer** (`plugins/image-viewer/ios`): the `imageviewer.full` screen (paging, pinch, double tap, swipe up or
  down to close, counter, error and retry, VoiceOver labels and actions) and `hold` (data: pictures and headers in
  memory). Pictures decoded with ImageIO at most 4096 px (EXIF applied). Lab: strip (closed on 2), EXIF upright,
  broken / refused / good, data good / too big / bad, empty list rejects.
- **markdown**: JS only; the Markdown lab draws and its links reach JS.
- **Not checked:** a real iPhone; double tap and pinch by hand (the simulator tool can't do two quick taps); webview
  file upload; the header-only-to-same-origin rule of pdf redirects (the code follows Android, the server's record
  wasn't read).

### 2026-11-08: iOS i.4, Firebase: firebase-app, Crashlytics, Analytics (Claude, `ios` branch)
- **The SDK:** `bun run tools/fetch-firebase-apple.ts` downloads Google's prebuilt Firebase 13.1.1 XCFrameworks
  (GitHub release zip, SHA-256 pinned) into `ios/third_party/firebase` (not in git): Analytics, Crashlytics, Messaging.
  CMake links them when they are there (static, `-ObjC`), leaving out Analytics' IDFA part and on-device ad conversion.
  Without them the app still builds: the plugins' Swift checks `canImport(...)`.
- **Config:** `ios/Sample/GoogleService-Info.plist` (Firebase project zero-native-sample, bundle id
  `dev.zeronative.sample`), added to the app by CMake when present; `.gitignore` keeps every `GoogleService-Info.plist`
  out of git. No plist (or no SDK): Firebase off, every call answers "not available", as on Android without
  google-services.json.
- **firebase-app** (`plugins/firebase-app/ios`): `ZnFirebase.start()` (configure once; the first Firebase plugin calls
  it), the Firebase module (app info, data collection default) and Installations (id, token, delete).
- **Crashlytics** (`plugins/firebase-crashlytics/ios`): native crashes by Crashlytics itself; every JS error as a non-fatal with
  its JS frames as the stack and the full stack as a log line (30 per launch); keys zn_bundle ("built-in": no OTA yet),
  zn_host_api, zn_route; screen changes as log lines; the module's calls as on Android.
- **Analytics** (`plugins/firebase-analytics/ios`): AnalyticsRules ported (names, limits, items), a screen_view per top route,
  zn_bundle on every event. Firebase's own screen views are off in the sample's Info.plist
  (FirebaseAutomaticScreenReportingEnabled = NO): they would name UIKit classes.
- **Runtime:** `ZnApp.addJsErrorListener` and `addTopRouteListener` (Android's ZnRuntime.addJsErrorListener and
  ZnNav.stack), used by both plugins.
- **Checked on the simulator:** Crashlytics lab: available, app info (project zero-native-sample, install id), user and
  keys, a caught error, a handler error and a rejected promise recorded, a test crash, the next start's upload task ran
  (network ok). Analytics lab: available, an event and a purchase sent, a bad name refused with its reason, user set,
  app instance id. A build with no SDK and no plist: builds, Firebase off, labs say available false.
- **dSYMs:** the console showed the test crash as "unprocessed: upload 1 dSYM". Not a bug: Crashlytics needs each build's
  dSYM to name the frames of a native crash (JS errors don't: their frames are sent as text). `tools/ios-sample.ts` now
  uploads `ZnSample.app.dSYM` with Crashlytics' upload-symbols after every build when Firebase is on (`--no-symbols`
  skips it). A release build (not made yet) needs the same step. A second test crash was sent after the upload.
- **Not checked:** the reports and events in the Firebase console (Pavan); push (next, needs an APNs key in Firebase).

### 2026-11-08: iOS i.4, auth, device-info and location plugins (Claude, `ios` branch)
- **auth** (`plugins/android-play-auth/ios`): iOS has no phone number sheet, no SMS Retriever and no app hash, so the Auth module
  answers the way Android does without Play services (hint and OTP "unavailable", hash ""). The app's fallback (type
  it) runs; OtpInput's `.oneTimeCode` gives the code from Messages. Checked in the Auth lab.
- **device-info** (`plugins/device-info/ios`): react-native-device-info's iOS answers (identifierForVendor, model names,
  Dynamic Island / notch by model id, Simulator / TestFlight / AppStore installer, disk, memory, battery, IP, user
  agent). Shared JS: `hasDynamicIsland`, `isDisplayZoomed`, `getBrightness` now read native (A13); the lab prints the
  system name. Checked in the Device info lab (iPhone 16: island true, notch false).
- **location** (`plugins/location/ios`): Core Location one-shots and watches with Android's rules (accuracy targets,
  timeout with the best fix, cache by maxAgeMs, pause when hidden, "off"), CLGeocoder both ways. No turn-on dialog on
  iOS ("unavailable", the app opens Settings). Shared JS asks Permissions for "location" on iOS (A14). Checked in the
  Location lab: dialog, fix, cache, last known, a watch following the simulator, reverse geocode (Koramangala 560095)
  and geocode.
- Plugins' `ios/*.swift` are globbed by CMake (`plugins/*/ios`). JS tests for both changed plugins pass.
- **Not checked:** a real iPhone (battery, carrier, real GPS).

### 2026-11-08: main merged into `ios`; iOS reads registry 23 (Claude, `ios` branch)
- **Merge** of origin/main (25364bc: Gemini's batches 1 and 2, the review fixes, A11 and A12 on Android) into `ios`,
  a merge commit, no rebase. Two doc conflicts (this log and second-opinions), both sides kept. The iOS second
  opinion on BACK_WANTED (A8) was 161, which main also used: now **183**.
- **Registry 23 on iOS:** `Registry.swift` regenerated (`tools/gen-registry.ts`; Kotlin and the lock unchanged), so a
  23 bundle starts. What 23 adds isn't drawn yet: Canvas shows the debug marker, slot-driven sizes keep the
  template's value, display / selectable / adjustsFontSizeToFit / itemWidthPercent / scroll commands are ignored.
  Debug builds log each one once. The list and sizes are in ios-parity-checklist.md §1b (about 4.5 days). ZeroBill's
  bundle is still 22, so this waits.
- **Min beats max** (RN): iOS passed SwiftUI a min above the max (no promise which wins); now the max is raised to the
  min. New LayoutLab case 29 (c29a fixed width, c29b stretched). **iOS 50 / 50.** Android should pass it too (its
  A11-3 fix says min beats max); not run there.
- **Checked:** sample JS built (needs registry 23); iOS build; LayoutLab 50 / 50; DynamicLayoutLab and CanvasLab open
  (no crash, gaps as listed); JS tests 1290 pass, 1 known fail (A7).
- **Not done:** push (waits for Pavan), the §1b items.

### 2026-11-08: iOS i.4, the scanner plugin (Claude, `ios` branch)
- **plugins/scanner/ios** (ScannerCamera.swift, ScannerPlugin.swift), as the Android plugin: module `Scanner`
  (`available`), the full screen `scanner.full` and the view `scanner.qr`, with the same params, props, events, texts
  and defaults. AVFoundation: AVCaptureSession, a preview layer, AVCaptureMetadataOutput (iOS's own reader, no
  download). The same rules: codes ignored for 500 ms from the first frame of each start; the first code locks (only
  `scanKey` releases it); torch off when the camera stops, a view's torch held until its prop goes false then true;
  zoom clamped to the camera's range, pinch on by default; the camera off when covered, in the background or gone.
  The screen: shade with a cut-out, corner marks, a moving line, title, hint, link button (http / https only), torch
  and close buttons; permission and "can't start" messages over the whole page.
- **iOS differences:** `autoZoom` is ignored (AVFoundation has no "zoom to this code"); iOS asks once, so refused is
  `blocked` (Settings button) and not yet asked is `denied`; a UPC-A comes as an EAN-13 starting with 0 and is named
  `upca` only when the app asked for upca and not ean13. The plugin's Swift is compiled into the app (CMake glob of
  `plugins/scanner/ios/*.swift`); packaging a plugin's iOS code is still open.
- **Debug hook:** the simulator has no camera. In a debug build with no camera, the launch environment
  `ZN_SCANNER_FAKE=<code>` makes the scanner read that code (format qr) after the warm-up
  (`ZN_SCANNER_FAKE='upi://…' bun run tools/ios-sample.ts --route scannerLab --params '{}'`).
- **Checked on the simulator:** dressed full screen answered `upi://pay?pa=ravi@upi&am=120 qr`; the view sent
  `permission granted`, `scanned`, and scanned again after "Scan again"; without the fake: the iOS dialog, Don't
  Allow → "Camera is off / Open settings", Close → answer null; allowed with no camera → "Camera can't start" over the
  page, Close on top.
- **Not checked:** real camera reads, torch, zoom and pinch, the haptic (no iPhone with the device platform here).

### 2026-11-08: iOS i.2, alignSelf stretch in Stack and Row (Claude, `ios` branch)
- From the Android session's reading of A11: `alignSelf: "stretch"` didn't stretch in a Stack or a Row whose
  `alignItems` doesn't (iOS had the Column fix only). Fixed in ZnRenderer.swift (stack, childLayout); two new
  conformance cases, c27 (Stack) and c28 (Row with a height). iOS 48 / 48. LayoutLab.tsx and A11 sent to the Android
  session (it runs the screen on the Lava; fixes there wait for Pavan).

### 2026-11-08: iOS i.4 groundwork, plugins, native screens and views (Claude, `ios` branch)
- **Plugins** (`ZnPlugins.swift`, ZnPlugins.kt's shape): `ZnPlugins.register(ScannerPlugin())` before ZnApp.start;
  a plugin adds modules, native screens and native views; a taken name or a too-new host API fails it (debug: stops,
  release: skipped). The sample's `Sample/*.swift` are now globbed by CMake.
- **Native screens:** a route with `native: "<plugin>.<name>"` pushes the plugin's UIViewController in the back stack
  (no template). `ZnScreenScope`: params, `finish(value)` (first answer only), `cancel()` (as Back). The answer is saved
  in the "zn.launch" store (record format of ZnLaunch.kt) before NAV_RESULT (app event 12) reaches JS; JS closes the
  screen and acks.
- **NativeView:** the plugin's UIView sized by the node; `ZnViewScope`: props (again on change, `onProps`), `emit`.
- **Native storage** (`ZNStorage` in ZNHost.h/.mm): the JS stores from native code, same value format, its own
  zn::Storage on the same folder (as ZnStorage.kt). **Launches** module: `ack` (the rest, opening another app, is i.4).
- **Sample test plugin** (`ios/Sample/DeviceTestPlugin.swift`, as DeviceTestPlugin.kt): "device.fake-screen" and
  "device.fake-view" (its Device module stays Android-only).
- **Checked on the simulator (Core lab):** the view shows its prop, follows "Change view prop" ("view says two") and
  its tap reaches JS ("view event: tapped two"); "Open native screen" (pushForResult, title "Pay") → "Finish twice" →
  "answer: first", screen closed; Cancel → "answer: null"; "Push native screen" (no promise) → Finish → onNavResult
  "nav result: abc".
- **Not yet:** activity events and JS error / batch listeners for plugins, packaging a plugin's iOS code (Swift package
  per plugin), the real plugins (scanner, image viewer, …).

### 2026-11-08: iOS i.2, Tabs, pull to refresh, a Fetch bug (Claude, `ios` branch)
- **Tabs** (`ZnTabsRefresh.swift`): only the child at `selected` (static or a slot) shows, filling the container; a
  tab is built when first shown, and hidden tabs keep their views (hidden, out of the hit test and VoiceOver), so
  scroll positions and fields come back as they were (Android: a SaveableStateHolder).
- **Pull to refresh** on a vertical Scroll and a List (flat props, or RN's refreshControl, which the compiler turns
  into the same props): iOS's own UIRefreshControl, as Android draws Android's disc, with Android's controlled
  contract: a pull sends onRefresh and shows the spinner; JS's `refreshing` then decides; no `refreshing` within 1 s
  ends it; `refreshing` alone shows it; no onRefresh, no pull. refreshColor tints it (refreshBackground has no iOS
  counterpart).
- **Found and fixed (Fetch):** several fetches started together (the tabs lab loads four tabs at once) got one
  answer: `session` was a lazy property made on the call threads, so each call made its own URLSession, whose task ids
  all start at 1, and the answers overwrote each other (one came back with another request's label). The session is
  made once at start now, and requests are kept by task object, not id. Fetch checks still 27 / 27.
- **Checked on the simulator (tabs lab, with tools/fetch-test-server.ts):** all four tabs load (badges 40 / 40 /
  ₹22.1k+); Pay (a Scroll) pull → spinner → "refresh pay start … done 1" → spinner gone; Stores (a List with
  refreshControl) the same; tab switches.

### 2026-11-08: iOS i.2, OtpInput (Claude, `ios` branch)
- `ZnOtpInput.swift`, as ZnOtpInput.kt: one hidden UITextField (no text colour, no caret, caret kept at the end)
  over the boxes holds the code, so typing, paste, the keyboard's SMS code autofill (`.oneTimeCode`, on unless
  `autoComplete` says otherwise) and ref.setValue all go through it. Same theme parsing and defaults
  (react-native-otp-entry's), the same character filter (other scripts' digits to 0-9, the rest skipped), onChangeText /
  onFilled, blurOnFilled, disabled (read only, setValue ignored), invalid (error style), secure dots, placeholder,
  autoFocus (after the slide), `ref` focus / blur / clear, left to right always, one VoiceOver element with
  "2 of 4 digits".
- **Checked on the simulator (OTP lab):** typing "93"; "SMS 4821" → change 4821, filled 4821, blur; "Wrong OTP" →
  red boxes; "Clear + focus" → change "" and focus; the 6-box default with "•" placeholders; the hidden alphanumeric
  one: "a-B 9cZ" kept "aB9cZ", filled, drawn as dots; the numeric one kept only "9" of the same text.
- iOS difference: a secure OtpInput's hidden field isn't secure (the boxes draw the dots), as a secure field would
  turn off the SMS code autofill.

### 2026-11-08: iOS i.2, two bugs from the parity checklist (Claude, `ios` branch)
- **A runtime `disabled` on a Pressable was ignored** (ZnPress.swift read only the template's): the amount screen's
  Pay button (`disabled={!active()}`) fired at ₹0. Now read from its slot (`ZnNodeSpec.disabledNow`). Checked: Pay at
  ₹0 does nothing (no tap, no press-out); after a digit it fires.
- **A Scroll's padding sat around the scroll view**, so content was clipped at the padding and couldn't scroll into
  it. It is inside the scrolling content now, as Android's content padding; the scroll view keeps only its border
  inset. Checked: the input screen's 16 pt sides unchanged.

### 2026-11-08: iOS i.2, Switch, Checkbox, Spinner, Progress (Claude, `ios` branch)
- `ZnControls.swift`: drawn as android/runtime draws them (one zn look, not UISwitch): Switch (36 × 20 track,
  16 pt thumb) and Checkbox (20 pt box, tick) controlled by JS (a tap sends onValueChange(!value), JS decides; 150 ms
  change; disabled at 0.38 opacity and no taps; 48 × 48 touch area; toggle / button accessibility traits), Spinner (a
  270° arc, one turn a second, size and colour, stroke 10 % of the size within 2–4 pt), Progress (full width, height
  4 by default, a value animates in 150 ms, no value: the 40 % bar sliding every 1.2 s).
- **Checked on the simulator** (Components screen, route `components`): the interactive switch and checkbox turn on;
  "JS ignores tap" stays off; the 300 ms delayed switch moves after the delay; disabled ones ignore taps; spinners at
  16 / 24 / 36 and in blue and orange; progress 40 % → 75 %; the endless bar.
- iOS difference: every Spinner turns on one shared clock (Android: one per spinner), so spinners on a screen are in
  step.

### 2026-11-08: iOS i.2, layout conformance (Claude, `ios` branch)
- **The check** (ARCHITECTURE §9.5): `examples/sample/src/LayoutLab.tsx`, route `layoutLab`. 26 text-free layouts
  with fixed sizes covering the zn flex rules (stretch and its limits, flex shares, gap, every justifyContent,
  alignItems / alignSelf, percent of the content box, margins, borders taking space, min / max, aspectRatio, Stack
  stretch, absolute insets, R29, R44). Each measured node reports onLayout; JS compares 46 frames with the rules'
  frames (1 dp) and logs `layout-conformance …`. The same bundle checks both renderers; no screenshots (text and
  pixels differ by design), no native test code.
- **Found and fixed on iOS** (first run 41 / 46): percent sizes filled the parent instead of taking the fraction
  (now resolved by the parent layout, as fillMaxWidth(fraction): a size the child itself took would be taken again
  when the parent places it, 90 → 45); maxWidth / maxHeight didn't limit a stretched child; aspectRatio was ignored;
  `alignSelf: "stretch"` didn't stretch in a Column whose alignItems doesn't (RN does; Android likely has the same
  gap, A11).
- **Checked on the simulator:** 46 / 46; the props lab and the amount screen unchanged. JS tests 1167 pass, 1 known
  fail (A7).
- **Android:** not run here. A11 says how to run it on the Lava and the two misses the Kotlin suggests (alignSelf
  stretch; onLayout x / y in a padded parent).

### 2026-11-08: iOS i.2, Svg (Claude, `ios` branch)
- **Draw data** (`ZnSvgData.swift`): the compiler's format v1 read as Android's SvgScanner reads it (same tokens and
  checks): viewBox and preserveAspectRatio, gradients (linear, radial, focal), animated stops, clips, filters,
  patterns, masks, groups, shapes, text. Paths through the icon parser (SvgPathParser).
- **Drawing** (`ZnSvgDraw.swift`, ZnSvgDrawing + ZnSvgEffects): Core Graphics in a plain UIView's draw(_:). Groups
  with opacity / mix-blend-mode layers, clips, masks (luminance or alpha, drawn to a grey image at screen
  resolution), shapes with colour / currentColor / gradient / pattern fills and strokes, dashes, paint-order,
  non-scaling strokes, text with the system fonts, and every <SvgPart> override: paints, opacity, transforms around
  the pivot (with skew, frame and motion path), stroke width, dash offset, trims (group and shape, caps of zero
  pieces), morphs.
- **Parts** (`ZnSvgView.swift`): each value from the template, a slot or ZnMotion; on iOS all part animations run on
  the frame clock (values that follow JS too: `ZnMotion.follow`), per-part `paused` and `replay`, the Svg's own
  `paused` / `replay`, and timings that wait for a tap. `ZnSvgGeometry.swift`: path measuring (flattened curves),
  trim ranges, morphs, motion paths.
- **iOS differences** (written in ZnSvgDraw.swift): filters draw the group under the first drop shadow the compiler
  found in them (Android's fallback before Android 12); other filter primitives aren't run. Repeating / reflecting
  gradients repeat 10 times each way. Non-scaling strokes keep their width in points through the shape's scale but
  aren't redrawn on screen for uneven stretches. Trimmed curves are 24-step polylines.
- **Found and fixed:** a SwiftUI Canvas drawing only through Core Graphics, whose first frame drew nothing, kept
  showing nothing (the Wifi loader: all its paths at opacity 0 at first). Svgs draw in a UIView now.
- **Found and fixed:** a tap on an Svg inside a Pressable never reached the Svg (the Pressable is a UIKit view over
  its content), so SMIL begin="click" never started. One window-level tap recognizer, which cancels and delays
  nothing, tells the Svgs it landed in; the Pressable still gets its tap (both seen in the log).
- **Checked on the simulator:** the Svg lab: wallet card gradients, Material icons tinted with color, runtime parts
  (heart, tick, swap, avatar), effects (shadow and ₹ text, pattern with a fade mask, route markers, blend), the
  motion tiles (loops, keyframes, trims, gauge), all downloaded SMIL / CSS loaders including Wifi, morph, motion
  along a path, non-scaling chart lines at two sizes, "Pause the loops" freezes them, "Tap me" starts 5 animations,
  the 60-row list with an Svg and its shadow per row. RN props lab: the absolute Svg stretched to its box (R30).
- **Not checked:** RTL autoMirror, SvgPart `frame` on a real file, drawing cost on a device (every animated Svg
  redraws on the CPU each frame).

### 2026-11-08: iOS i.2, props lab part 4: Carousel, onLayout, zIndex in rows, gradients (Claude, `ios` branch)
- **Carousel** (`ZnCarousel.swift`, ZnRenderer.kt's pager): a paging horizontal scroll, pages full width (minus the
  padding, which is content padding inside the scroll) or `itemWidth`, `gap` apart; no height → as tall as the
  tallest page (pages measured, not drawn twice), with a height → pages get all of it but the dots (R35); dots;
  `autoAdvance` (wraps, skips while touched and for `pauseAfterTouch`); `onPageChange` when a new page settles.
- **onLayout** (registry 15): { layout: { x, y, width, height } } of the box inside the margin, sent on real changes,
  x / y relative to the parent node (a named coordinate space only on nodes with such a child). iOS difference: an
  instance's root reports x / y in window coordinates (its parent is in another template).
- **zIndex among Column / Row children** (it worked only in a Stack): the R23 tooltip from row 1 now draws over row 2.
- **backgroundImage** (CSS linear gradient, angle and stops as ZnGradient in ZnTemplate.kt) over the background
  colour; the elevation shadow follows the gradient too.
- **Checked on the simulator:** props lab: the carousel with a height (page fills, dots at the bottom, swipe to
  page 2), the tooltip over row 2, `rn-props layout 40x24`. Offers screen: gradient banners with shadows, 300 pt
  pages with the next one peeking, auto-advance (`banner page 1`, then `0`).
- **Still not on iOS:** Svg (the lab's absolute shape, the Svg lab), `zn://` image handles.

### 2026-11-08: iOS i.2, props lab part 3: Modal and app layers (Claude, `ios` branch)
- **Modal** (`ZnModal.swift`, ZnModal.kt's contract): a layer presented over full screen from the frontmost view
  controller (so also over a sheet), its children laid out as a Column that fills it; `visible` (shown when not
  written), `transparent` (else white), `animationType` none / fade / slide (250 ms), `statusBarTranslucent` /
  `navigationBarTranslucent`, above the keyboard, `onShow` after the animation. iOS difference: no system Back and
  no swipe on a full-screen presentation, so `onRequestClose` is never sent (as RN on iOS).
- **App layers** (`ZnLayers.swift`, NAV LAYER, host API 9): the window's root is now `ZnRootController`, the back
  stack plus startApp's `top` layer (the status bar area plus its content, height animated 200 / 250 ms, screens
  moved down by the content's height with extra safe area so their own padding stays; status bar icons follow the
  layer's background while it shows) and `overlay` layer (whole window; taps go through where it has nothing
  tappable).
- **Found and fixed:** moving the screens changed their safe area for a moment and JS's insets() heard 83 then 59.
  The root controller (whose safe area never changes) reports insets now.
- **Checked on the simulator:** layers lab: Fake offline → red "You are offline" strip, white status bar icons, the
  screen 24 pt lower, insets unchanged; Fake back online → "back", closes after 1.5 s; the overlay's "No Internet"
  sheet opens over the screen and closes; screen taps work under the overlay. RN props lab: dialog modal (fade, own
  dim, onShow), "Alert from modal" above it (OK reached JS), close; page modal (slide, white, below the status bar).
- **Still not on iOS** (lab): Svg, Carousel, onLayout.

### 2026-11-08: iOS i.2, props lab part 2: corners, borders, text styles and spans (Claude, `ios` branch)
- **Per-corner radii** (start / end beat left / right, else borderRadius) as one uneven rounded shape for the
  background, border and clip. Images and shimmers clip to a rounded shape by default (RN, Android).
- **Borders:** width and colour may change at runtime (slots); **borders take space** (content sits inside them,
  zn flex rule 2: on iOS the content used to sit under the border); dashed / dotted borders and top / bottom lines
  with RN Android's pattern (dashed 3 widths on, 3 off; dotted 1 and 1).
- **Text** (`ZnText.swift`): italic, lineHeight (as extra line spacing; RN iOS places it above each line),
  textDecorationLine with textDecorationStyle (SwiftUI's own dash / dot line patterns), nested <Text> spans
  (template or slot JSON: colour, size, weight, italic, decoration, letterSpacing, background) and span presses as
  links (onSpanPress with the index). includeFontPadding is Android-only.
- **Checked on the simulator (RN props lab):** the green corners box (top-left and bottom-right round), the OTP box's
  border with its inner box inside it, the dashed pill, the dotted box, the dashed bottom line, "Platform Fee"
  dashed underline, ₹499 dotted line-through, Terms / Privacy as links ("span terms" reached JS), the bold spans'
  colour change and the italic "(changed)" piece, tint green → red at runtime.
- **Still not on iOS** (lab): Svg, Carousel, Modal, app layers, onLayout.

### 2026-11-08: iOS i.2, props lab part 1: transforms, animation, images, shimmer (Claude, `ios` branch)
- **Transforms** (scale, scaleX / Y, rotate, translateX / Y, each static or a slot) around `transformOrigin`, and
  opacity, as one layer over the node's background and borders (`ZnLayer` in ZnRenderer.swift; Compose's order:
  scale, rotate, translate). Checked: the R11 bar is half width from the left edge.
- **`animate`** (`ZnAnimation.swift`, ZnAnimation.kt's encoding): a value that follows JS animates to each new value
  with the element's tween (Compose's curves, cubic-bezier, step) or spring (Compose's damping ratio and stiffness)
  as a SwiftUI animation scoped to that one modifier; a value that plays by itself (`from`, keyframes, repeat,
  reverse, repeat delay, delay) runs on one shared CADisplayLink, starts when the element appears, again on
  `replay`, holds on `paused`, and a `from` plays again towards a new resting value. backgroundColor too.
  Checked: the props lab's 10 s keyframe fill, the animation screen's card (opacity tween, slide spring, bouncy
  scale), the 300 ms colour and the spring arrow.
- **`enter` / `exit`:** enter plays once when the element first appears; a removed root with `exit` stays in the
  store (exiting, takes no taps) until its animation ends, and JS's indexes skip it, as ZnStore.kt does. Checked:
  the animation screen's demo loop and "Remove first" end with the right chips (`exit: … done, removed` in the log).
- **`textTransform`** (upper, lower, capitalize by word, no phone locale), **elevation** as a soft shadow under the
  background (y = elevation / 2, blur = elevation, 20 % of shadowColor; only under a background).
- **Image:** `asset:` sources (the bundle's `images/` folder is now copied into the app by CMake), http(s), file;
  src → fallbackSrc → empty, never back; contentScale; tintColor (also at runtime); RN onLoad (pixel size) /
  onError / onLoadEnd; `loading="shimmer"`. **Shimmer** component: base colour with a sweeping band, every shimmer in
  step. Checked: the lab's three images (load 16x16, error with a message, end) and the UPI tile's shimmer fill.
- **Found and fixed (A10):** those image events reached JS before JS had drawn the screen (a local picture loads at
  once, while the screen is still the pre-JS skeleton) and were dropped. Events wait for JS's first batch now.
- **Not on iOS yet** (seen in the lab): per-corner radii, borders whose width / colour change at runtime, dashed
  and dotted borders, text decorations and spans, Svg, Carousel, Modal, app layers. `zn://` image handles.

### 2026-11-08: iOS i.2, keyboard avoidance (Claude, `ios` branch)
- **`keyboard: "resize"` (default):** SwiftUI already lays a screen out above the keyboard (its keyboard safe area),
  the same room Android's `imePadding` gives: the Pay button sits on the keyboard. The handoff said content didn't
  move; it did, but the simulator was using the Mac's keyboard, so the on-screen one never opened (turn it on with
  the simulator tool's `set_keyboard show`).
- **`keyboard: "none"`:** read from the route (`ZnRoute.resizeForKeyboard`, as ZnTemplates.kt) and the screen ignores
  the keyboard's safe area: the keyboard covers it. Checked with the input screen set to "none" for the test only.
- **The focused field scrolls into view** (Compose's text field keeps itself in view): on focus, and while the
  keyboard opens. The whole box shows, not just the one-line native view (an empty UIView behind the box gives its
  frame); every scroll view around it moves the least it can. SwiftUI moves the screen to its new size frame by
  frame over the keyboard's animation, so one look at any moment was wrong (tried: right after the notification,
  after a forced layout, at fixed delays): a display link keeps the box in view on every frame while the keyboard
  moves, so the content rides up with it in one motion.
- **KEYBOARD to JS when the keyboard starts to move** (keyboard.ts: "when it starts"; Android sends its target
  height), not when it has arrived. The height is how much of the screen it covers, so a hardware keyboard gives 0.
- **Found and fixed:** the same keyboard went to JS twice (phone pad → number pad, both 291 pt): the JSON came from a
  dictionary, whose key order changes. Written by hand now.
- **Checked on the simulator:** input screen: phone pad (291 pt) with Pay above it; tap the half-hidden OTP box →
  it scrolls fully into view (20 pt); hide, tap the note box at the bottom → keyboard 336 pt, the note box rides up
  with it (22 frames) and ends fully above Pay; `keyboard: "none"` → the keyboard covers the note and Pay.
- **Not checked:** a field in a list row (the UIKit list is a scroll view, so the same code runs; no sample screen
  has one), sheets with fields (UIKit lifts a sheet over the keyboard itself; no sample sheet has a field), a real
  iPhone. No Android issue from this step.

### 2026-11-08: iOS i.2, the remaining modules and system events (Claude, `ios` branch)
- **System events** (`ZnSystemEvents.swift`): COLOR_SCHEME at start and on change (it was always "light"),
  APP_STATE "active" / "background" (background as soon as the user can't touch the app: Control Center, a system
  dialog, the app switcher, as Android's pause), LOW_MEMORY, KEYBOARD `{ visible, height }` once per show or hide.
- **Found and fixed:** going to the home screen, iOS draws the app in light and in dark for the app switcher's
  snapshots, and each flip reached JS as a setting change. Colour-scheme changes are held while in the background
  and the scheme is read again on becoming active (checked: background → dark set → active gives one "dark").
- **Modules** (`ZnUiModules.swift`): Keyboard v2 (dismiss; a `<TextField ref>`'s focus, blur, clear, isFocused),
  Vibration (iOS's one system buzz per buzz step, as RN on iOS; false on the simulator), Toast (zero-native's own
  pill above the home indicator and the keyboard, over every screen), Alert (UIAlertController; JS now also sends
  each button's `style`, so cancel and destructive look like iOS's; Android ignores it), Permissions (camera,
  microphone, location + location.precise, notifications, contacts; not asked = "denied", refused = "blocked"; a
  missing Info.plist usage text is `not_declared`, since iOS would end the app), Splash (iOS holds no splash: hold
  and release answer false, "nothing happens" as for an Android app that doesn't hold it).
- **Found and fixed:** the toast never showed: its fade-out was started with the fade-in, so UIKit set alpha 0 at
  once. The fade-out now starts when the fade-in ends.
- **Checked on the simulator:** OTP ref focus → keyboard (291 pt) and `isFocused` true, blur → keyboard hidden;
  3-button alert in iOS styles, "Cancel it" runs its onPress; toast "Saved"; camera status "denied" → iOS's dialog
  with the usage text → Don't Allow → "blocked" (the dialog read as background, then active); Os.info, haptic.
- **Not on iOS yet:** Launches (Android activity results; UPI on iOS returns by URL, i.4), background tasks
  (BGTaskScheduler, its own design), Updates (OTA, i.3), app layers, keyboard avoidance (content doesn't move up
  for the keyboard yet: Android's `keyboard: "resize"`).

### 2026-11-08: iOS i.2, native modules (Claude, `ios` branch)
- **The module system** (`ios/ZnRuntime/Swift/ZnModules.swift`), ZnModules.kt's contract: typed arguments
  (`invalid_args`), exactly one answer per call, cancel hooks (AbortSignal → `URLSessionTask.cancel`), the `__v`
  version check, module events only while JS listens (app event 8, newest-only when JS is busy), binary input and
  binary answers (app event 9), and `constants()` set as `__zn_constants` before the main script. The host
  (`ZNHost.mm`) now passes call bytes and cancels, and sends binary answers. JS `console` lines are printed too.
- **Modules:** Os (info, haptic, openSettings, share, openUrl, canOpenUrl; same scheme allow-list), NetInfo
  (NWPathMonitor; `fetch` and "change" with Android's 250 ms settle), SecureStore (Keychain), Clipboard, Fetch
  (URLSession). Storage (MMKV) already worked through the core.
- **iOS choices:** SecureStore items are readable after the first unlock and never leave the device; a new install
  clears what an earlier install left (Keychain items outlive the app on iOS; Android's Keystore data doesn't), and a
  locked phone is `temporarily_unavailable`. NetInfo's `isInternetReachable` is "the path is satisfied" (iOS has no
  "validated" flag). Fetch keeps Android's rules with our own whole-call timer, drops `Authorization` across hosts
  (URLSession keeps it), refuses HTTPS → HTTP, splits the joined `Set-Cookie` again, and gives `statusText` "" (no
  reason phrase in URLSession). `Os.info` keeps Android's keys and adds `ios`.
- **Platform:** DEVICE (16) and WINDOW (17) are sent after the main script. `Platform.OS` was always "android" in
  JS (A9): it now reads `nativeConstants("Platform")`, so it is right at the top level of a file too; `select`
  picks `ios`; `Version` is the major iOS version as a number (RN gives "18.0"; `constants.Release` has it).
- **Checked on the simulator:** fetch checks 27 / 27 (against `tools/fetch-test-server.ts`; POST sent once, timeout,
  abort, redirects, Authorization dropped, too_large, cut body, cleartext_blocked, dns, tls, insecure_redirect). One
  check expected exactly "gzip" (OkHttp's Accept-Encoding); URLSession offers "gzip, deflate", so it now accepts any
  list with gzip. Storage checks 7 / 9 (MMKV and SecureStore pass; the 2 others use the sample's own Kotlin `Device`
  module). RN basics lab: `platform ios 18 18.0 Apple iPhone17,3`, window 393×852 ×3, NetInfo wifi (fetch and the
  live header), clipboard read back (after iOS's "Allow Paste"), canOpenURL, `whatsapp:` refused.
- **Not on iOS yet:** Vibration, Toast, Alert, Keyboard events, Splash, Permissions, Launches, Background tasks,
  Updates (OTA, i.3), AppState and colour-scheme changes; plugins (i.4). A call to one answers "unavailable".

### 2026-11-08: iOS i.2, sticky rows, absolute children, presses in a scroll (Claude, `ios` branch)
- **Sticky rows** (`stickyHeaderIndices`, a list or a slot): the UIKit list's layout pins the last sticky row that
  has scrolled past the top; the next one pushes it up as it arrives (Compose's `stickyHeader` does the same). The
  cell itself moves, so it keeps its presses. Pinned rows are left out of the range sent to JS, as on Android.
  Checked in the RN props lab: "Today" pins over rows 6–11; "Earlier" pushes it out (seen half way) and pins;
  scrolling back brings "Today" back; with `[0]` only, "Today" stays to the end and "Earlier" scrolls away.
- **Found and fixed:** changing the indices at runtime moved the list 34 rows (a new layout pass forgets the scroll
  position). The first unpinned row now keeps its place, as for row splices (rows 2–9 stay through both toggles).
- **Absolute children in a Stack** (`position: "absolute"` with top / bottom / start / end), a SwiftUI `Layout` with
  Android's rules: the Stack's size comes from its normal children, absolute children take no room (R29), both sides
  of a pair stretch (absoluteFill), a child pinned start + end has a definite width (R44), the rest are placed by
  alignItems / justifyContent. Before, absolute was parsed and ignored. Checked in the lab: the overlay, the inset
  bar, the side bar, the centred dot, the floating "Scan" button.
- **Found and fixed:** the RN props lab drew as one purple screen. "No clip" was `clipShape(Rectangle().inset(by:
  -1e6))`, and SwiftUI filled that 2,000,000 pt rectangle with the background of an empty box (the lab's progress
  bars). Nodes now clip only with `overflow: "hidden"`.
- **Found and fixed:** a slow drag that started on a Pressable didn't scroll the page (only flicks did). The press
  view was a `UIControl`, and a scroll view never cancels touches in a control. It is now a plain view that tracks
  its touches: a scroll cancels the press (onPressOut true), as on Android. Taps, long press and press-repeat checked
  again on the amount keypad (₹420, hold ⌫ to ₹0).
- **Not drawn on iOS yet** (seen in the lab, i.2 items): transforms and `transformOrigin`, `animate`, `textTransform`,
  Svg, Carousel, Shimmer, Image, shadows, app layers (`startApp` layers), Modal. No Android issue from this step.

### 2026-11-08: iOS i.2, lists, sheet timing, multi-line field (Claude, `ios` branch)
- **Sheet + stack change in one batch** (UPI picker → receipt): the sheet now closes without animation when the same
  batch pushes, removes or clears screens, so the push starts at once (was ~0.5 s late). About 230 ms remain between
  the tap and the receipt in a debug build on the simulator, most likely the receipt's first SwiftUI layout: measure
  in release on a phone.
- **List window** (`ZnList.swift`): `onRange` and `onEndReached` (within 5 rows of the end, once per length) as on
  Android. Splices are diffed by common prefix and suffix and applied as one batch update; the first visible row
  keeps its place on screen (10100 → 10101 rows with an insert at the top: nothing moved). `inverted` flips the
  collection view and each cell, so a chat's newest message stays in view. Chat lab: older messages load
  60 → 90 → 120 → 150.
- **Found and fixed:** loading older messages crashed with "Invalid batch updates": the row keys changed before
  `performBatchUpdates`, so UIKit's count before the update was already the new one. The keys now change inside the
  update block, after a `layoutIfNeeded`.
- **Multi-line `<TextField multiline>`** is a `UITextView` with the single-line field's change protocol, a
  placeholder label, and a height that grows with the text (minHeight from the style still applies). As on Android,
  Return makes a new line unless the field sets `returnKeyType`; then Return sends `onSubmitEditing` and closes the
  keyboard. `returnKeyType` now also sets the single-line field's key (default Done).
- **Found and fixed:** a tap in a field's box but outside its one text line (the note's 64 pt box, the padding of
  any field) did nothing; on Android the whole box is the field. Now any tap in the box focuses the field.
- Checked on the simulator (Inputs): a tap low in the note box focuses it (`focused: note`); typing wraps to three
  lines and the box grows; Return submits the text, no new line, `focused: none`; a tap on the name field still
  types there. No Android issue from this step.

### 2026-11-08: iOS i.2, route options (Claude, `ios` branch)
- **Transitions** (routes.ts `transition`, same rule as Android: a push uses the new screen's, a pop the leaving
  screen's): `push` is UIKit's slide; `modal` slides up over the old screen and back down; `fade` cross-fades;
  `none` is instant (`ZnTransitionAnimator`). The back swipe only pops `push` screens: a modal closes with its own
  button, as iOS modals do.
- **Safe area per route** (`safeArea`: "all", "none", `{ top, bottom }`): unsafe sides draw under the bars, and the
  screen's root background fills behind the bars either way. **INSETS** go to JS (dp) once JS has started, before
  START, and on every change, so `insets()` works. **Status bar** per route (`statusBar: "light"`).
- **Runtime padding and margin** (a slot, e.g. `paddingTop: insets().top + 32`) are now applied; before, the iOS
  renderer used static padding only.
- Checked on the simulator: the receipt (modal, `safeArea: { top: false }`, light bar) slides up, its green header is
  full-bleed under a white status bar, and its text clears the notch (insets top 59, bottom 34). Done (a
  `nav.reset`) slides Home in from the side, as the resulting stack says.
- **Found:** a batch that closes a sheet and pushes (UPI picker → receipt) starts the push ~0.5 s late: UIKit waits for
  the sheet's dismiss animation. Fix for later: when a batch also changes the stack, dismiss the sheet without
  animation. No Android issue from this step.

### 2026-11-08: A8, native back gestures only where JS has no back handler (Claude, `ios` branch)
- JS sends NAV BACK_WANTED for any screen with a `useBack` / `BackHandler` (tabs as before); Android puts its back
  handler after `NavDisplay` so such screens get no predictive preview; iOS has its own edge pan. The iOS app shell is
  now UIKit (`ZnNavController` is the window root, app + scene delegates; an install that ran the SwiftUI-App build
  must be uninstalled once, or its saved scene session shows a black screen).
- Checked on the simulator (all three cases) and by JS tests; Android not compiled here (A8 lists the phone checks).
  Details: `second-opinions.md` 183, guide §7.

### 2026-11-08: iOS step i.1c, SwiftUI or UIKit for the hard parts (Claude)
Each part built both ways in `ios/ZnRuntime/Swift/` behind a launch switch (`ZnImpl.swift`, `ZN_IOS_<PART>=swiftui|uikit`)
and tried on the iPhone 16 simulator (iOS 18.0, debug) with the Android sample's bundle, unchanged.

| Part | Choice | What was seen |
|---|---|---|
| Press handling | **UIKit** (`UIControl` over the content, `ZnPress.swift`) | 5 zero-length taps in a row: UIKit 5 / 5 in order, SwiftUI `Button` 1 of 3 (and one landed late). Press-repeat (backspace held 0.7 s: 3 deletes) and long press (amount held 0.8 s: cleared, no stray tap) are native timers, as on Android; `Button` does taps only. A `UIControl` *under* SwiftUI content gets no touches (SwiftUI's hosting view takes them), so it sits over it; a nested Pressable wins by a hit-test rule (the smaller control on the same screen) |
| Back stack | **UIKit** (`UINavigationController`, one `UIHostingController` per entry, `ZnNavHost.swift`) | Push: tap → JS → PUSH in 11–12 ms, transition settles in ~580 ms (simulator). Replace (REMOVE + PUSH in one batch) → one `setViewControllers`. `useBack` through the ← button keeps the screen ("Discard ₹6?"). UIKit has every hook (a batch = one `setViewControllers`; `gestureRecognizerShouldBegin` can send the swipe to JS; `didShow` reports native pops as FORCED_BACK); `NavigationStack(path:)` has none, and hiding its bar turns swipe-back off. **Correction (later 2026-11-08):** the simulator tool's synthetic swipes don't start UIKit's edge-pop gesture in *any* app: Settings didn't pop either when retried properly (the first "reference" was General's push animation still running). So nothing is known to be wrong with our host; try the swipe with a mouse drag in Simulator.app or on a phone. The app shell is now UIKit (`ZnNavController` is the window root) and the swipe policy follows NAV BACK_WANTED (A8) |
| Sheet | **UIKit** (`UISheetPresentationController`, `ZnSheet.swift`) | Both sized to content (the UPI picker). UIKit keeps Android's contract exactly: `presentationControllerShouldDismiss` → false, `didAttemptToDismiss` → onDismiss, JS sets `visible` false → dismissed 2 ms later. SwiftUI's `.sheet` has no "attempted" callback: it dismisses first and tells JS after, so JS cannot keep it open. Picking an app closes the sheet and pushes the receipt in one batch (1 ms apart) |
| Text field | **UIKit** (`UITextField`, `ZnTextField.swift`) | Phone field: letters rejected by JS ("98a7b6" → "987", then "x" undone), answers to older changes skipped, ~3 ms per JS round trip; amount reformats ("1234" → "1,234") with the cursor kept by its distance from the end; marked text (IME) never replaced. SwiftUI `TextField`: after JS rewrote the text the caret sat in the middle, and the next digit gave "987985" (field and binding out of step); its tap area is only the text, not the box. One key was lost at 5 ms per key (machine typing) in UIKit; none at a human pace [check on a device] |
| List | **UIKit** (`UICollectionView` + `UIHostingConfiguration` cells, `ZnList.swift`) | Both follow the window protocol (JS keeps ~38 rows mounted, `onRange` moves it; rows real even mid-fling at row 340+). Memory after ~500 rows: `LazyVStack` 34 → **122 MB** (peak 133), `UICollectionView` 45 → **61 MB**. LazyVStack keeps every row view it made; the collection view reuses cells |

- **SwiftUI keeps:** everything inside a screen and a sheet (text, stacks, images, our flex `Layout`) and the cells.
- **Bugs found and fixed on the way:** a covered screen's Pressables took taps from the top screen (the nested-Pressable
  rule now looks only at the same screen); a UIKit field filled all the height a Scroll offered (needs
  `sizeThatFits`); a UIKit field re-applied JS's last value on every SwiftUI update and undid typing (applies a value
  only when it changes).
- **Not built yet (i.2):** route options (`transition: "modal"`, `safeArea`; the receipt pushes like any screen),
  `multiline` fields (UITextView), `onEndReached`, sticky headers, `inverted`, a diffable data source (inserts at the
  top keep the scroll position), Image clipping, percent sizes.
- **Android:** the back swipe question applies to Android 14+ predictive back too: `android-issues-found-when-building-ios.md` A8.

### 2026-11-08: iOS step i.1b, the amount screen drawn by SwiftUI (Claude)
- **Built:** `ios/` (on the `ios` branch). `ZnRuntime/Host/ZNHost.mm`: `zn::Platform` in Objective-C++, the `zn-js`
  thread (an `NSThread` with its own run loop and an 8 MB stack; tasks are run-loop blocks, timers run-loop timers),
  batches handed to the main thread. `ZnRuntime/Swift/`: template and batch readers (ports of the Kotlin ones, same
  checks), `ZnStore` with one `@Observable` cell per slot, prepared node specs, `ZnFlexLayout` (our own SwiftUI
  `Layout` with zn's flex rules), the renderer, an SVG path parser for `<Icon>`, body counters. `Registry.swift` is
  generated by `gen:registry` (and checked by `registry.test.ts`, like `Registry.kt`). The app builds with CMake's
  Xcode generator: `bun run tools/ios-sample.ts` builds, installs on the booted simulator and launches.
- **Results** (debug, iPhone 16 simulator, iOS 18.0; the Android sample's bundle unchanged, route `amount`):
  - The skeleton draws from the template before JS (checked with `--delay 3000`): header, back icon, Passbook pill,
    ₹ and cursor, hint. Then JS fills it: merchant name and photo, the 12 keys (components JS mounts), the button.
  - `main.hbc` evaluated in 3–4 ms (simulator on a Mac: not a phone number). The first batch: 38 ops.
  - **Leaf-only updates hold.** A cursor blink (1 op) runs 1 SwiftUI body (the cursor's opacity). Typing "5" runs 2
    bodies: the amount text and the "You pay" text. Typing the digit that first shows the cashback pill (5 ops, 2
    mounts) runs 14: the new views, their parent Column once, and the amount text. ~169 views on screen. No Row,
    Column or Key body runs for a plain digit.
- **Found, for i.1c:**
  - Zero-duration synthetic taps (the simulator tool's default) were dropped by SwiftUI `Button`, then one landed
    late (the amount got a digit nobody pressed at that moment). Taps of 120 ms always worked. [check on a device
    with fast typing]; press handling is now an i.1c item (SwiftUI `Button` vs a UIKit gesture, as Android has its
    own press handling).
  - The amount text body ran 3 times for the first digit (once per batch while the first tap's batches arrived
    within the report window, or SwiftUI measuring; [check]).
  - Not drawn yet: `<Sheet>`, `<List>`, `<TextField>`, `<Modal>`, press-repeat and long press, `Image` clipping to
    `borderRadius` (the avatar is square), percent sizes (treated as fill). Native modules answer "unavailable".
- **Spike shortcuts** (each to be removed before i.2): Swift 5 language mode (Swift 6 strict concurrency later); one
  CMake build folder per SDK (CMake picks the Hermes slice when it configures); the bundle is copied from
  `android/sample/src/main/assets`; one screen at a time, no transitions.
- **Xcode 26 note:** with only the simulator runtime installed (no iOS 26.2 device platform), `xcodebuild -scheme`
  finds no destination; building with `-target ZnSample -sdk iphonesimulator` works.
- No new Android issue from this step (the grey skeleton in the first screenshot was iOS's launch transition, not a
  template default).

### 2026-11-08: iOS step i.1a, Hermes and the core on the iOS simulator (Claude)
- `com.facebook.hermes:hermes-ios:260318099.0.5` (same release as `hermes-android`) has `hermesvm.xcframework`
  (iOS device, simulator, Catalyst, tvOS, visionOS), a macOS `hermesvm.framework` and the headers. JSI is built into
  `hermesvm` on Apple (no `libjsi`). Its JSI headers match `core/third_party/jsi` except one comment.
  `tools/fetch-hermes-apple.ts` downloads it into `ios/third_party/hermes/` (not in git), checking a pinned SHA-256.
- `core/tests/apple/CMakeLists.txt` is a host for the core on a Mac or the iOS simulator. `hermes_engine.cpp` built
  unchanged.
- Results (debug, Mac and iPhone 16 simulator on iOS 18.0): core tests 166 / 166 (MMKV killed mid-write 100 / 100,
  FlowStore 200 / 200, one 800-byte FlowStore write ≈ 2.3–2.5 µs). The new engine test runs the **Android sample's
  `main.hbc` unchanged** (bytecode 99) and sends START for route 0: a 122,867-byte batch, 7 native calls, no JS error.
  So one OTA bundle can serve both platforms [check: a release build and a real device].
- Android fixes found on the way: `android-issues-found-when-building-ios.md` A3–A7. Not rebuilt on Android yet (no Android SDK on
  this Mac): the Android-side changes are `core/CMakeLists.txt` (`log` only on Android), `flowstore.cpp` (the skip in
  the fallback path) and the tests. Run `run-core-tests.ps1` and a sample build on the phone before relying on them.

### 2026-11-08: review fixes for Gemini's batches 1 and 2 (Claude, parent session; branch `opus/parity-fixes`)
The review (`docs/cross-communication/2026-11-08-opus-review-of-gemini-batches.md`) found 5 blockers, 12 majors and a
list of small ones. All fixed on one branch, on top of Gemini's last commit (`b9bd1ba`):
- **Blockers:** B1 Row / Column keep `justifyContent` with a gap again; B2 `listController` from core only, and a build
  error for runtime names imported from ui; B3 two Canvas draw crashes, plus a try/catch around the draw; B4 core's own
  WebSocket / Splash calls are left out of a bundle's requirements (second-opinions 176); B5 List extras and negative
  margins raise the registry to 23 (177).
- **Majors:** NaN / Infinity from JS can't crash a layout (175); WebSocket call order, server close, stale sockets (179);
  destructured default naming another prop; row Touchable with flex in a Row; List scroll commands in dp, absolute
  offsets, before-mount commands (174); negative margins measured like padding; List extras out of the row map (perf),
  one item order, range by arithmetic; auto-fit text with `TextAutoSize`; Canvas leaks, colours in JS (180).
- **Docs:** second-opinions 174-180 and corrections under 161, 163, 171, 173; guide-notes §71 rewritten, §72-§74 new;
  `lists.md`, `components.md`, `fetch.md`, `rn-compatibility.md`.
- WebSocket / fetch progress and Canvas were done by two Opus helpers; the rest by the parent session. Diffs read in full.
- **Not checked on a phone yet:** the List range and scroll paths, WebSocket against a real server, Canvas on API < 28.

### 2026-11-08: Horizontal List via LazyRow (Gemini, batch 1 stretch G6)
- Enabled `<List horizontal>` and `<FlatList horizontal>` in compiler, writer (`LIST_HORIZONTAL_SINCE = 23`), and runtime (`ZnRenderer.kt`).
- Native implementation uses Jetpack Compose `LazyRow`, with unconstrained child widths (`definiteWidth = false` unless row root specifies width), `contentContainerStyle` padding, and `gap` along the row.
- Build-time safety: rejects `stickyHeaderIndices`, `inverted`, and pull-to-refresh on horizontal lists with actionable errors.
- Added horizontal rail lab tile in `RnPropsLab.tsx`; tests in `rn-compat.test.ts` and `writer.test.ts`. Second-opinions entry 164.

### 2026-11-08: Text onPress and row Touchables (Gemini, batch 1)
- Bumped registry to version 23 with `TEXT_PRESS_SINCE = 23`.
- Top-level `<Text onPress>` and `<Text onLongPress>`: enabled in compiler, template writer, and runtime (`ZnRenderer.kt`).
  Uses Compose `clickable` / `combinedClickable` with `Role.Button` for TalkBack accessibility, zero ripple, and zero opacity change (matching React Native). Nested spans continue to use `onSpanPress`.
- Row-laid Touchables (`Pressable`, `TouchableOpacity`, `TouchableHighlight`, `TouchableWithoutFeedback` with `flexDirection: "row"`):
  compiler-only rewrite wraps children in a `<Row>`, moving child layout keys (`alignItems`, `justifyContent`, `gap`, `rowGap`, `columnGap`) to the Row while box styles (`padding`, `background`, `borderRadius`, `borderWidth`, `height`, etc.) stay on the Touchable. Sets `height: "100%"` on Row when Touchable has fixed height or flex.
- Second-opinions entry 163; docs updated in `components.md`, `guide-notes.md`, `rn-compatibility.md`, `rn-compat-sweep.md`.
- Tests added in `rn-compat.test.ts` and `compile.test.ts`; 3 sample lab tiles in `RnPropsLab.tsx`.

### 2026-11-08: destructured props read live (Gemini, batch 1)
- Compiler rewrite for destructured component & screen props: `function Card({ title, size = "md", user: u }: Props)`
  rewritten to `Card(__p: Props)` with live property reads (`__p.title`, `(__p.size === undefined ? "md" : __p.size)`).
- AST scope traversal guards against inner variable/parameter shadowing.
- Kept clear build errors for `...rest`, nested destructuring (`{ user: { name } }`), array patterns, non-constant defaults,
  and prop reassignment (`title = x`).
- Second-opinions entry 162; docs in `docs/guide-notes.md` §61, `docs/rn-compatibility.md`.
- 16 test cases in `compiler/test/destructured-props.test.ts`.

### 2026-11-08: WebSocket (Gemini, batch 1)
- Added browser-compatible `WebSocket` API (`packages/core/src/websocket.ts`), exported from `@zero-native/core` and installed on `globalThis.WebSocket`.
- Android runtime module `ZnWebSocket` (`ZnWebSocket.kt`, v1): uses OkHttp `newWebSocket` with the shared `ZnFetch.client` (pins, interceptors, user agent apply). Sockets closed on dev reload / OTA restart.
- 1 MB message limit in both directions; v1 text frames only (`send(string)`).
- Second-opinions entry 161; docs in `docs/guide-notes.md` §20b, `docs/rn-compatibility.md`.
- 10 unit tests in `packages/core/test/websocket.test.ts`.

### 2026-11-08: fetch upload and download progress (Gemini, batch 1)
- Added `onUploadProgress` and `onDownloadProgress` to `FetchInit` (`{ loaded, total }`, `total = -1` when unknown).
- Android runtime (`ZnFetch.kt`): `CountingRequestBody` wrapping Okio `Sink`, and throttled response body read
  with `ProgressThrottler` (≥ 100 ms interval, always emits final byte count).
- JS tests in `packages/core/test/fetch.test.ts` (616 pass), Kotlin unit tests in `ZnFetchTest.kt`.
- Docs updated: `docs/fetch.md`, `docs/guide-notes.md` §20.

### 2026-11-08: dynamic layout survey (Gemini, batch 1)
- Fact survey in `docs/dynamic-layout-survey.md` covering all 30 layout-related style keys: build-time errors, compiler
  and runtime locations, affected Compose phases, and end-to-end trace of dynamic `paddingTop`.
- Prepared for Opus 5.5's dynamic layout architecture design. No code changed.

### 2026-11-07: open items at the end of the day (Claude, parent session)
Written down before a break (Pavan near his weekly limit). [zn] = framework, [ZB] = ZeroBill app.
- **[zn] Processing Sheet stuck on a live cancel** (Lava, release build, ZeroBill payment pass): the sheet went into
  its closing state (taps pass through) but never slid down or went away. Not seen on Android 13 (plain, Back, tap,
  covered app, changing content). Fix (a), no dim layer, is done (entry below). On hold by Pavan ("we'll see if
  needed"): (b) a 1 s safety net that removes a closing window that didn't finish; (c) release-build log lines for
  the close steps. Next: app-home-tabs retests the live cancel on the Lava; if it sticks again, do (c) first.
  Doesn't block the release unless it shows again.
- **[zn] Lava retests waiting (app-home-tabs):** the smooth auto-zoom glide; the live-cancel sheet above.
- **[ZB] QR cold start:** `Splash.holdUntil` hit its 400 ms limit by ~30 ms (entry below). App decides: larger
  `maxMs` or `/init` earlier.
- **[zn] Not committed yet:** the auto-zoom glide (`CameraSession.kt`) and `Splash.holdUntil` (core + runtime +
  sample + docs). Ready for `/git`.
- **[zn] Gestures v1:** plan only (`docs/gestures-v1-plan.md`), nothing built. Not like RNGH in full: no worklets, two
  pointers at most, no gesture graph, no rotation or manual gestures. After the release.
- **[zn] Declined:** our own auto zoom-out for the scanner (Pavan: "let's leave it here").
- **[zn] RN props phone steps that fail:** bars, sticky, modal (see their entries); not looked into yet.

### 2026-11-07: `Splash.holdUntil(promise, { maxMs })` (Claude; ask from app-home-tabs, Pavan's go "Sure")
- **Why:** a QR link cold-starts ZeroBill: splash, Home, a black "starting" screen, then checkout. Now the splash can
  wait for `/init` (at most 400 ms) and lift straight onto checkout.
- **JS** (`packages/core/src/splash.ts`, new module `Splash` v1, so a bundle using it needs a new APK; no host API
  bump): `hold` now, `release` one JS turn after the promise settles, so a push made then reaches native first.
- **Native** (`ZnSplash.kt`): app holds keep the splash up to their `maxMs` after the first screens, then until the
  top screen is composed (`ZnNav.topComposed`; without it Home showed for one frame). `capMs` still wins. A PUSH
  while the splash is held gets no slide (`openedAtStart`). Too late: ignored, with a log line.
- **Tests:** `splash.test.ts` (4); core JS tests (613); Kotlin tests.
- **Emulator (API 33), sample dev hook** (two tiles in the RN props lab; Home calls `holdUntil` at the next start):
  work ending 1.2 s after the first screens lifts straight onto the pushed lab, no Home frame, no slide (shots every
  250 ms); work that never ends lifts at maxMs (412 ms). Not on the Lava.
- **Lava, ZeroBill QR cold start (app-home-tabs, after this was built):** the splash lifted at the 400 ms limit;
  `/init` answered about 30 ms later, so the black "starting" screen still showed. [ZB] app's call, not decided: a
  larger `maxMs`, or start `/init` earlier. Second-opinions 160.

### 2026-11-07: scanner zoom: `zoom`, `autoZoom`, `pinchZoom` (Claude; ask from app-home-tabs, Pavan's go "get all of them done")
- `@zero-native/scanner`, on `<QrScanner>` and the full screen's params. Plugin props: no registry or host API change, a
  new APK only. README "The full screen" and "The view".
- **`zoom`:** CameraX `setZoomRatio`, inside the camera's range, set at each camera open (CameraX goes back to 1x when
  it closes). The preview is hidden until it takes, 0.6 s at most, so no 1x frame shows. A refusal before the camera is
  active tries again (3 tries).
- **`autoZoom`:** ML Kit's `ZoomSuggestionOptions` (in `play-services-mlkit-barcode-scanning` 18.3.1, which
  `barcode-scanning` 17.3.0 brings; checked in the jar), up to the camera's max zoom. **`pinchZoom`** (default on): a
  `ScaleGestureDetector` on the preview; a pinch stops ML Kit's suggestions for that scan.
- **Tests:** `ScannerRulesTest` (zoom range, start value, pinch stops auto); scanner JS tests; sample types.
- **Emulator (API 33):** "Open zoomed scanner" in the scanner lab: `scanner: zoom 1.4x on` 0.6 s after "camera on". The
  emulator's camera gives no frames, so the picture, ML Kit's suggestions and the pinch are **not checked**: Lava only.
  Log lines to look for: `scanner: auto-zoom on, up to Nx`, `scanner: zoom Nx (ML Kit's suggestion)`.
- **Lava (20:42 APK, app-home-tabs and Pavan):** all three work (1.4x on 0.65 s after camera on; ML Kit 1.6x, then 4x,
  then the code read; pinch). Pavan: auto-zoom "steppy". Now each suggestion glides over 300 ms, easing out
  (`ValueAnimator`, one `setZoomRatio` per frame: CameraX 1.4 has no smooth zoom; checked in the jar). A new
  suggestion goes on from where it is; a pinch stops the glide. With animations off in Android settings, it jumps.

### 2026-11-07: Sheet and Modal windows have no dim layer (Claude; found on the Lava by app-home-tabs, Pavan's go)
- **Bug:** on Android 14 the first keypad taps after closing the offers sheet were dropped ("untrusted touch",
  occluded by "Dim Layer for Task", alpha 0). The closing window passed taps through, but kept `FLAG_DIM_BEHIND`.
- **Fix** (`ZnSheet.kt`, `ZnModal.kt`): clear `FLAG_DIM_BEHIND`; the dim was 0 already and our own scrim draws it.
- **Emulator (API 33):** `rn props sheet close` passes (Sheet and Modal). Android 13 never dropped these taps, so
  only the Lava can prove the fix.
- **Lava (Android 14):** taps right after the close now land. Second-opinions 158.

### 2026-11-07: Sheet `animateIn={expr}` (registry 22) (Claude; ask from app-home-tabs, Pavan's go)
- `animateIn` can be a value, not only a literal: read when the sheet opens (its window fade and its slide). So an
  app uses one sheet for "opened by the user" (slides) and "restored with the screen" (at rest). Guide §12.
- **Tests:** compiler test (literal = prop, expression = slot); all JS tests (1161), types; Kotlin tests.
- **Emulator (API 33):** RN props lab, `animateIn={!restored()}`: opened from a tile it fades and slides in (no
  sheet in the first two shots); opened with the lab at the next start, it is at rest in the first frame after the
  splash. Not on the Lava.

### 2026-11-07: after a kill, a late launch result is waited for, up to 1 s (Claude; found on the Lava in the ZeroBill payment pass, Pavan's go)
- **Bug:** after a kill, Android brought a UPI result 24 ms after the app's first resume (a process a service had
  started). ZnLaunch had already marked it `lost`, so the first screen showed "lost", then the result.
- **Fix** (`ZnLaunch.kt`): at that resume, a launch with no result waits up to 1 s, START still held; a result in that
  time settles at once. The marker now goes after the `lost` record is saved. Guide §31; second-opinions 156.
- **Tests:** emulator with the new debug prop `debug.zn.launch_result_delay_ms` (sample): 300 ms late gives the result
  at the first read, 1800 ms gives `lost` then the result, 0 as before. Two matrix cases added
  (`late-result-after-kill`, `result-after-the-wait`), not run in a full matrix yet. Not on the Lava.

### 2026-11-07: phone steps scroll the RN props lab by its edge (Claude)
- `rnprops.ts` has its own `tap`, and `byId` scrolls at x=20 (the page's padding), so a swipe no longer lands on the
  sticky list. `push.ts` opens the lab again before "Show plain" (it sits above "Cancel all").
- **Emulator:** `push local notifications` passes. `rn props bars`, `sticky`, `modal` now reach their real checks and
  fail there: the status bar hidden doesn't move the screen up (105 -> 105), "Today" isn't pinned after a drag, and
  the dialog card doesn't move up for the keyboard in the step (by hand, without the Alert first, it does: 871 -> 461).
  All 7 passed on 2026-11-04; sticky and modal already failed on 2026-11-06. **Open, not looked into.**

### 2026-11-07: hitSlop on an absolute child measured the whole Stack (Claude; found by the phone steps)
- **Bug:** a Pressable with `hitSlop` placed absolutely in a Stack took taps 100 dp away (a 24 dp icon with
  `hitSlop={20}`). Since R29 (2026-11-05) an absolute child is laid out in a box the Stack's size and placed inside
  it (`absoluteChild`); `WithHitSlop` measured outside that box, so its touch size was the Stack's plus the slop.
- **Fix** (`ZnRenderer.kt`): measure after the parent's modifiers, where the press handling sits.
- **Emulator:** `rn props pointer events slop` passes again (15 dp outside counts, 26 dp doesn't); before the fix a tap
  100 dp right of the edge pressed it.
- **Also:** the RN props lab's shimmer now shows only after a tap: a shimmer redraws every frame, and uiautomator then
  takes ~8 s per screen read, so the phone steps timed out.

### 2026-11-07: a push at START joins the first screens; Sheet `animateIn` (registry 21) (Claude; asks from app-home-tabs, Pavan's go "op1 with no slide in")
- **Why:** after a kill during a payment, ZeroBill showed Home, then checkout sliding in, then the processing sheet
  sliding up. The app pushed checkout in a `setTimeout`, because a push during Home's build went below Home.
- **nav.ts:** a `nav.push` while a screen is being built waits until it is in the stack; at START until all the
  first screens are in, before NAV STARTED. **ZnNav / ZnNavHost:** a PUSH before NAV STARTED comes in with no
  slide (`openedAtStart`); Back from it slides as usual. No host API change.
- **Sheet `animateIn={false}`** (registry 21, prop 291): opens at rest, no window fade. Guide §12, §70;
  second-opinions 155.
- **Tests:** `nav-start-push.test.ts` (5); all JS tests (1160) and types; Kotlin tests, runtime lint.
- **Emulator (API 33), 10x animations:** sample dev hook ("Open this lab at next start" in the RN props lab; Home
  pushes it at the next start). With the splash hold on: the splash fades straight onto the lab with its sheet at
  rest, no Home frame. With it off: Home's frames show for ~1.5 s first (the sample doesn't hold), then the lab with
  no slide.
- **Not checked:** the Lava, ZeroBill's checkout itself.

### 2026-11-07: fetch pings its HTTP/2 connections; a closing Sheet passes taps through (Claude; asks from the ZeroBill payment pass via app-home-tabs, Pavan's go for the ping)
- **PAY-5** (`ZnFetch.kt`): after a start in the background from the UPI result, one HTTP/2 connection to the API
  went dead silently (on the Lava: ESTABLISHED, 7.6 KB never acknowledged, retransmitting; a new connection from the
  phone worked, the app was allowed on the network). Every verify for minutes was queued on it; the pool only drops
  idle connections. Now `pingInterval` 10 s: no answer by the next ping drops the connection and its calls. Not
  closing on a timeout (it would also end healthy calls sharing it). Why the connection died is not known.
  `ZnFetchPingTest`: a silent fake HTTP/2 server; with the ping the call fails in ~1 s and the next call opens a new
  connection; without it the call waits its whole timeout and the dead connection stays pooled.
- **Sheet / Modal** (`ZnSheet.kt`, `ZnModal.kt`): while closing, the window is not touchable or focusable
  (`passTouchesThrough`), so the next tap reaches the screen below; one `onDismiss` per close. Lab case "Open offers
  sheet" and step `rn props sheet close` (animations at 5x so the tap lands during the close).
- **Shimmer `highlightColor`:** already built (step 3.7); only `components.md` missed it. Row added, compiler test.
- Native: needs a new APK.
- **Status bar:** the closing sheet's window takes the screen's bar icons at once (Pavan saw white icons ~1 s after a
  close: the sheet's window stays on top until its slide ends, and Android takes the icons from it).
- **Emulator:** `rn props sheet close` passes (the sheet and the dialog Modal; no second onDismiss). Measured: the
  window stops taking taps 50-90 ms after "Continue" (the JS round trip); Android still routes taps by the old window
  for ~150 ms more, so a tap within ~0.25 s of the close can still be lost; from ~0.29 s on, every tap got through.
  Screenshots: bar icons white while open, dark 0.7 s into the close. The shimmer inside a `scaleX` 0.6 fill: the band
  sweeps across the visible fill (squeezed by the same factor). Not run against the old code.
- **Not checked:** the Lava; PAY-5 itself again.

### 2026-11-07: A branch goes away before its parts update (core; ask from the ZeroBill payment pass via app-home-tabs, Pavan's go)
- **Bug:** one store write `set({ sessionData: null, activeTransaction: null })` ran a slot inside
  `{txn !== null && <TxnDetailsBody/>}` with `txn` null, before the branch removed the body: "Cannot read property
  'merchant' of null" (caught and reported, not a crash). Effects ran in the order they went stale, and a part's
  root is owned by the screen, not by the branch effect, so nothing put the branch first.
- **Fix** (`signals.ts` `runTop`, `view.ts` `mountChild`): each part's root keeps a `guard`, the `when` / `insert` /
  `each` / `<List>` effect that mounted it. Before an effect runs, flush runs the stale guards above it, outermost
  first; if one removed the part, its effect doesn't run. Same as Solid's `runTop`; React gets it from rendering
  top-down. JS only: no registry or host API change, reaches apps with their next bundle.
- **Tests:** `packages/core/test/branch-order.test.ts`: `when`, `insert`, `each`, a branch in a branch (all four fail
  without the fix), and a branch that stays open still updates once. All JS tests (1154) and types pass.
- **Emulator (API 33):** all no-hands steps: 106 of 112 pass, 0 crashes. The 6 failures are the same with the fix
  switched off: torch (no flash), a location timeout, and four steps that can't scroll to their tile (a swipe lands on
  the sticky list in the RN props lab; the push step looks for a tile above the one it scrolled to). `rn props
  pointer events slop` also measures the 24 dp hitSlop button as 277 dp wide, with or without R44: a real regression,
  fixed the same day (next entry).
- **Not checked:** the Lava; ZeroBill's TxnDetailsSheet itself (app-home-tabs scouts ZeroBill for the same shape).

### 2026-11-07: R44 absolute child pinned on both sides; `transformOrigin` (registry 20) (Claude; asks from the ZeroBill payment pass via app-home-tabs)
- **R44** (`ZnRenderer.kt`, Stack): an absolute child with `start` + `end` now has a set width for its children, as in
  RN, so they stretch (a centred spinner inside one sat at the left; the scan screen's dim drew nothing). Not gated
  by registry: a bug fix; an older APK keeps the old layout (the app's workaround stays harmless).
- **R11 `transformOrigin`** (registry 20, prop 290): RN's keywords and percents, turned into "x y" fractions by the
  compiler (`transformOriginOf`), Compose `graphicsLayer.transformOrigin` in both the static and the animated layer.
  Physical left / right, as RN. Guide §68, rn-compatibility row.
- **Tests:** compiler tests (keywords, either order, percents, arrays; px, z and nonsense fail; runtime value fails),
  Kotlin `TransformOriginTest`, all JS tests (1149), types, runtime lint 0 errors, debug sample build.
- **Emulator (API 33), RN props lab:** R44 dot centred (centre x 540.5 in a box centred at 540, and vertically);
  `transformOrigin: "left"` + `scaleX: 0.5`: the bar fills the left half; with keyframes 0 → 1 it grows from the left
  edge (two screenshots).
- **Not checked:** the Lava; right-to-left.

### 2026-11-07: R53 rest: no stray `main.hbc.*`, split template timing (Claude; asks from app-home-tabs, Pavan's go)
- **zn-build:** hermesc's temp file (`main.hbc.<hex>`, left by a stopped build) once went into a ZeroBill AAB. hermesc
  now writes into `<app>/build/`; the finished file is copied into the assets, and leftovers there are deleted at the
  start of each build. Checked: a planted `main.hbc.dead01` was gone after `bun run sample:js`.
- **Timing:** a second log line `template <asset> timing: started N ms after process start (waited W ms for zn-io);
  read R ms, prepare P ms (K nodes), manifest M ms`. The old line stays as it was.
- **Emulator (debug, just booted, slow: seconds, not ms):** sample, 232 templates / 1603 nodes: prepare 1.15–1.42 s,
  read 0.07–0.71 s, manifest 30–90 ms. Only the shares mean anything; the Lava numbers decide the fix.
- **Lava (app-home-tabs, ZeroBill zn app, staging release, speed-profile, 3 cold starts, built-in bundle):** started
  70-101 ms after process start, zn-io wait 0-2 ms; read 41-48 ms, **prepare 121-140 ms (3156 nodes)**, manifest
  ~1 ms; first frame (splash held) 329-398 ms. No `main.hbc.*` in the assets, the APK or the AAB.
- **Where prepare goes (a JVM probe on ZeroBill's file, then deleted):** no single slow part. About 2 µs per node
  warm on the JVM, spread over ~150 small field reads per node (on the Lava, cold, ~40 µs).
- **Tried and taken out: prepare on 4 threads.** Lava: an even split, helpers on time, but all 4 threads took as long
  as one (107-119 ms against 121-140): they wait on something shared, not found. A GC check on the emulator showed
  11 MB allocated and 0 GCs, so GC is not proven either. Removed: no gain, more moving parts.
- **Parked (Pavan, 2026-11-07: stop the micro-optimising).** The user-visible problem (a blank frame) is solved by
  `ZnSplash`; prepare runs off the main thread behind the splash, and cold start is ~520 ms TotalTime. If start time
  matters again: (1) store props without boxing (ids go to 289; `HashMap<Int, …>` makes an object per lookup above
  127), (2) prepare on first use, route screens first. Kept: the one-line timing split, to spot a regression.
- Gestures v1 plan: `docs/gestures-v1-plan.md`.

### 2026-11-07: `@zero-native/android-ad-id`, the Google advertising id (Claude; ask from the ZeroBill app via app-home-tabs, Pavan's go: for ad attribution)
- **What:** an opt-in plugin, not part of device-info, because its library adds the `AD_ID` permission. `AdId.get()`
  answers `{ id, limitAdTracking }` and never rejects. `id` is null for all zeros (id deleted, or no `AD_ID` on
  Android 13+), for no or failing Play services, and for an APK without the plugin. A real id with
  `limitAdTracking: true` is given: the app decides (Pavan). Its own thread, not the shared 2-thread call pool.
  README (Play's rules), guide §67.
- **Tests:** 4 Kotlin tests (`AdIdRules`), 2 JS tests, all JS tests (1146), types, plugin lint 0 errors, debug
  sample build.
- **Emulator (API 33, Google Play image):**
  - The sample as it is (its manifest removes `AD_ID`): `ad id none, limit ad tracking true` (550 ms, first read).
  - A scratch build that kept `AD_ID` (the manifest was put back after): `ad id 1936c422-…, limit ad tracking
    false` in 154 ms.
- **Not checked:** a phone without Play services; an id the user deleted in Settings (the same zeros as the
  no-permission case); Android 11 and older with personalisation off.

### 2026-11-07: `ZnSplash.holdUntilReady`, Android's splash until the first screens are built (Claude; R53 from app-home-tabs, Pavan's pick "(b)")
- **Why:** the ZeroBill app's 780 templates are ready ~50 ms after Android's first frame, so a cold start showed an
  empty box, then the home. Android takes its splash away at the first frame.
- **What:** `ZnSplash.holdUntilReady(activity, capMs = 1000)` cancels frames until JS's NAV STARTED (new
  `ZnNav.firstScreensUp`) or the cap. Guide §66, second-opinions 153. Sample: off unless
  `adb shell setprop debug.zn.splash_hold_ms 1000`.
- **Tests:** Kotlin tests, runtime lint 0 errors, debug sample build.
- **Emulator (API 33, debug, busy: load ~14, cold starts 3-5 s):** splash held, then the first frame came right after
  "first JS batch applied" (screenshot: icon during the hold); cap 1500 with JS late: drew at the cap; Activity rebuilt
  by a font-size change: no frame held; fresh start in a kept process (`-f 0x10008000`): held 14 frames for the new
  screens; hold off: no splash line.
- **Lava (app-home-tabs, ZeroBill zn app, staging release, speed-profile, 3 cold starts):** held 10-14 frames; first
  frame 345-348 ms after process start, the home already built; `am start -W` TotalTime 501-510 ms; cap never hit.
  Recording: splash goes straight to the home, no empty frame. Templates still take 158-178 ms to prepare.
- **Found on the way (not fixed, debug only):** `debug.zn.js_delay_ms` loses the START event (sent before the delayed
  JS exists: "global function not defined: __zn_onEvent", error screen), with or without the hold.
- **Still open in R53:** making template prepare faster (measure first), and the stray `main.hbc.*` file in assets.

### 2026-11-06: SecureStore keeps a value it can't read right now; notification settings link (Claude; old-phone audit, Pavan's go)
- **SecureStore** (`ZnSecureStore.kt`, `secure-store.ts`): before, any error on a read deleted the value and answered
  null. An app that reads "no token" as "logged out" then signs the user out and wipes their data (the zn ZeroBill app
  does). Now each step is tried 3 times (waits 50 and 200 ms). Only "this can never be read again" deletes
  (`Rules.lostForGood`: bad tag, broken or missing key, damaged file; Android 13+'s own "key gone" codes). Anything else
  keeps the file and rejects with code `"temporarily_unavailable"`; JS: `SecureStore.isTemporary(e)`. On save, a known
  passing error (busy Keystore, disk) no longer makes a new key.
- **Notification settings link** (`NotificationsModule.openSettings`): the notifications page took `package:` data,
  which stock Android doesn't match, so the tap did nothing. Now it sends only `EXTRA_APP_PACKAGE`, and falls back to
  the app's info page.
- **Tests:** 6 Kotlin tests (`ZnSecureStoreTest`), 1 JS test, all JS tests (1144), types, lint (runtime, push) 0 errors.
- **Emulator (API 33, debug), storage lab's new "Save / Read kept secret" buttons:**
  - File made unreadable (`chmod 000` with run-as): 3 tries, then `temporary (kept)`; the file is still there. After
    `chmod 600`: reads `kept-1`.
  - One ciphertext byte changed: `AEADBadTagException` (Keystore code -30), reads `null`, the file is deleted.
  - Push lab's 3 new buttons: notifications, exact alarms and battery each open the right Settings page and answer true.
- **Not checked:** a real busy Keystore (an Android 7-9 phone); the Lava; an R8 release build.

### 2026-11-06: R50 permission answer after a kill, R51 OtpInput after a new Activity, R52 restorableSignal start value (Claude; asks from app-home-tabs' process-death audit, Pavan's go)
- **R50** (`ZnPermissions.onResult`, `ZnActivity`): Android gives the dialog's answer to the new process when the app
  was killed under it; no request waits there, and the answer was dropped, so a first "no" was never kept and two
  refusals read "denied" (a request then shows no dialog). Now it is kept with no request waiting; JS isn't told.
- **R51** (`ZnOtpInput`, `ZnInstance.keptText`): the typed code is kept with the instance (the process), and a new
  Activity draws the boxes from it, as RN. The kept code is the start text, so `onTextChange` / `onFilled` don't fire
  again (no second verify).
- **R52** (compiler): `restorableSignal` and `persistedSignal` count as signals, like `signal` / `computed`: a start
  value from a signal no longer fails the build. Guide: the "worked out once" rule notes it.
- **Tests:** 2 compiler tests (one fails without the fix), all JS tests (1143), types, Kotlin tests, debug sample build.
- **Emulator (API 33, debug):**
  - R51: typed 4821, then a font-size change made a new Activity in the same process ("template skeleton composed"
    again, same pid): boxes show 4821, no `change` / `filled` line again; typing goes on (482, 4820, filled).
  - R50: camera dialog open, app killed in the background (`am kill`), back from Recents (new pid), "Don't allow";
    then a normal request and "Don't allow" again: `camera: blocked`, status `blocked`, and the next request shows no
    dialog. Without the fix the second answer reads "denied" (from the code; the old build wasn't run).
- **Found on the way:** `am start` from the shell while the dialog is on top makes a second MainActivity (singleTop
  only checks the top); come back through Recents to test this. And `settings put global always_finish_activities 1`
  didn't make the emulator finish the Activity; a font-size change did rebuild it.

### 2026-11-06: a tap's native calls and timeouts belong to the screen (Claude; Pavan's pick "option 3", same family as bug A below)
- **What:** directly in an event handler, native calls, `setTimeout` and `useAbortSignal()` belong to the screen, so
  they end even if the tapped part went away first (before: the call never settled, the timeout never fired, no
  error). `setInterval` and listeners still stop with the part. A native call made in an effect rejects "cancelled"
  when the effect runs again (before: it never settled). Guide §8, second-opinions 151. JS only.
- **Tests:** `one-shot-owner.test.ts` (6; 4 fail on the old code), all JS tests (1141), types; the zn ZeroBill app's
  tests (870) and typecheck pass against it.
- **Emulator (API 33, debug):** core lab "Hide me, then answer" (the button hides itself right after it asks native
  and starts a timeout): call answered and timeout fired, 3 of 3. `tools/plugin-phone.ts --no-hands`: 107 of 112, no
  crash. The 5 that fail (scanner torch, location denied blocked approximate, rn props slop, sticky, modal) fail on the
  build without this change too (106 of 112 there; "location off" also failed once and passed on a re-run): emulator
  limits or older issues, not this change. Not looked into yet.

### 2026-11-06: two runtime bugs from the Lava: dead taps after a refresh, lost answers after a restart (Claude; found by Pavan in the zn ZeroBill app, Pavan's go)
- **A, dead taps:** `nav.push` built the new screen under the caller's owner. From a tap that is the tapped part (a
  list row), from an effect that effect. When the row was built again (its item changed: the refresh wrote the
  transaction) or the effect ran again, the screen was stopped with it, and native kept showing it: every tap said
  "no handler", the refresh spinner never stopped. Screens and app layers are now built with no owner (nav.ts); only
  closing a screen stops it. JS only.
- **B, lost answers:** while the runtime is replaced (Back then the launcher icon: `ZnNav.startFresh`;
  `Updates.applyNow`; dev reload), `ZnRuntime.dispatchAnswer` dropped every native answer until the main thread attached
  the new runtime. The new main script's calls (Os.info, SecureStore) are answered in that window, so their promises
  never settled. Now only the runtime generation decides. Same window: module events are no longer dropped (a
  dropped latest-only event stayed stuck for good), and a late answer of an old call no longer takes a new call with
  the same id out of the active list. Kotlin: needs a new APK.
- **Tests:** new nav test (fails without the fix); all JS tests (1135), types, Kotlin tests, debug sample build.
  Sample: `main.ts` logs `sample: Os.info answered at start after N ms` (a call from the main script).
- **Emulator (API 33, debug):** same-process restart with `am start -f 0x10008000` (a new Activity without saved
  state): old build 0 of 2 answered, fixed build 3 of 3 (1-23 ms, before the new runtime was attached); a store row
  tap after the restarts opens the amount screen.
- **Lava, zn ZeroBill app (dev release, 16:28):** A: 6 refreshes of the transaction info screen, then Back and a card:
  taps work, the icon stops, no "no handler" lines. B: `am start -f 0x10008000` in the same process (pid 10018):
  "starting fresh", then the session was ready in 45 ms (at 16:03, before the fix, it never got ready).
- **Not run:** the OTA phone matrix (`applyNow` uses the same restart path).

### 2026-11-06: `<List inverted>` for chats (Claude; ask R13 from app-home-tabs, Pavan's go)
- **What:** RN FlatList's `inverted` (registry 19): Compose reverseLayout, bottom arrangement, a new row 0 stays in view
  while at the newest row. A List flipped with `scaleY -1` is a build error (its fling ran the wrong way in the merchant
  chat). Guide §65, second-opinions 149, rn-compatibility row. Sample: "Chat list" lab (`/dev/chat`).
- **Tests:** all JS tests (1134), Kotlin tests, debug sample build.
- **Phone:** Pavan checked it on the Lava in the zn ZeroBill app's chat (2026-11-06, dev release build, registry 19): works.
  The sample's chat lab (`zn://sample/dev/chat`: fling both ways, add a message, older rows at the top) has not been run.

### 2026-11-06: app layers, `startApp(routes, { top, overlay })` (Claude; asked by app-home-tabs, Pavan's go)
- **What:** `top`, an app-wide bar above every screen (the offline strip); the screens move down by its height, with
  its own height animation. `overlay`, content over every screen (one "No internet" sheet). NAV LAYER, host API 9.
  Guide §64, second-opinions 148. Sample: "App layers" lab (`/dev/layers`), strip on NetInfo plus a fake switch.
- **Tests:** all JS tests (1133) and type checks, runtime Kotlin tests, debug sample build.
- **On the emulator (Android 13, debug sample):** strip shows red with light icons; screens, a native screen and the
  core lab all sit under it; the sheet stays open over a screen push and Back closes it; "Back online" green for
  1.5 s, then closed; data and Wi-Fi off and on drive it through NetInfo. The first run showed no strip: core's C++
  refused NAV kinds above 10 (fixed in `runtime.cpp`).
- **On the Lava (debug sample, screen recording):** opens in about 190 ms (one hitch of about 38 ms in the middle),
  closes in about 235 ms with no hitch; green shows about 1.6 s.
- **Not checked:** a dev reload, a release build, the pilot app.

### 2026-11-06: device-info, push presses and HTML, unmatched links (Claude; Pavan's go, asks R39 R40 from app-home-tabs)
- **What:**
  - Core: native constants before the JS starts (`ZnModule.constants()`, JS `nativeConstants()`; engine
    `setGlobalString`).
  - `@zero-native/device-info`: react-native-device-info's API, with sync fixed values (guide §63).
  - Push native version 3: HTML text when it has a tag or entity; `Notifications.onPress` /
    `getInitialNotification` for taps with no link, group summaries too (`group.data`). Each press carries a secret
    per install, so another app can't fake one through the exported launcher (found by app-home-tabs).
  - `startApp({ onUnmatchedLink })`: links that match no route reach JS whole.
  - second-opinions 147.
- **Tests:** all JS tests (1131 before the last fixes; push and device-info again after), type checks, Kotlin tests
  (runtime, device-info, push), lint (runtime, device-info, push), debug sample with the C++ change.
- **On the Lava (debug sample):**
  - Every fixed value shows, also one read at module level. The read takes 10-13 ms, on its own thread from
    Application.onCreate: the JS start waited 0 ms on 3 cold starts.
  - Unmatched links: while running (`atStart=false`) and at a cold start (`atStart=true`).
  - HTML notification: bold amount, green store name, `&amp;`, the line break.
  - A tap while running → `onPress` with id and data. The first try reported nothing: the tap Intent was the launcher's
    own, which Android drops when the app runs; press Intents now have their own action.
  - A tap that starts the app → `getInitialNotification`. A group summary with no link → press with the group key.
  - Faked press Intents from adb (no secret, a wrong secret): ignored, with a warning.
- **Not checked:** a release build, the pilot app, an app whose Activity isn't `singleTop` (a press would make a
  second Activity there and be lost; the guide asks for `singleTop`).

### 2026-11-06: `Os.info().packageName`, and Crashlytics' Gradle setup in an included build (asked by app-home-tabs, R38)
- **What:** `Os.info()` gives `packageName` (applicationId with the flavor suffix), as RN's `DeviceInfo.getBundleId()`.
  Optional in the type: older APKs don't send it. Guide §33. `firebase.gradle.kts` now asks the app's own dependencies
  for `plugin-firebase-crashlytics`, so an app that takes zero-native with `includeBuild` gets Crashlytics' Gradle plugin too
  (before: none, and the Crashlytics SDK stopped the app at start).
- **Tests:** JS tests, type checks, runtime compile; the sample still gets Crashlytics' Gradle tasks. app-home-tabs then
  used the fixed script in the pilot's included build: Crashlytics' tasks are there, and Crashlytics starts on the Lava
  with no crash (prototype 764e315). The pilot picks its backend from `packageName`.
- **Next (Pavan, 2026-11-06):** a sync flavor value, as a DeviceInfo-style plugin. Not built yet.

### 2026-11-06: SMS hash and OTP auto-read work in a real login (Pavan, on the Lava)
- **What:** the first real end-to-end login on the pilot app (`my-app-prototype`, now `my-app`, R37 in 5230779), with the dev
  backend (`v1-nodejs-backend-api` dev 930002e) sending a real carrier SMS with the app hash. Phone hint sheet → number
  picked → OTP sent → `@zero-native/android-play-auth` SMS Retriever read it → `OtpInput` `setValue` filled the boxes → `onFilled`
  verified → logged in. No typing.
- **The hash:** `Auth.appHash()` on the release APK (signed with the debug key) matched the backend's entry for that key.
  This closes the "SMS steps not tested" line in the P.3b–P.6 entry and the "a real SMS" lines in registry 17 and 18.
- **Time:** about 8.5 s from the hash log line to "login done", mostly the SMS on its way.
- **Still not checked:** a wrong code on the real screen, TalkBack on Verify, a long-press paste, the hash of the Play
  build (Play App Signing has its own key: read it from the internal test track before real users), other phones.

### 2026-11-06: registry 18: OtpInput, react-native-otp-entry built in (Claude)
- **What:** `<OtpInput>` in core with RN's props, ref (`focus`, `blur`, `clear`, `setValue`) and `theme`; zn adds
  `error`. Native boxes over one hidden field: caret, paste, `sms-otp` autofill, TalkBack as one field, LTR in RTL.
  Registry 18 (component 34, props 285-288, event onFilled 24), guide §62, second-opinions 146, rn-compatibility row,
  lab Dev → OTP input. Kotlin changed: needs a new APK. The paused G3/G4 would take registry 19.
- **Tests:** new compiler tests (`otp-input.test.ts`), the ref in `rn-basics.test.ts`, Kotlin `ZnOtpInputTest`
  (filter, theme, order), all JS tests, type checks, runtime lint, debug sample. Lava (debug): see second-opinions 146.
  Not checked: TalkBack speaking, a real SMS, long-press paste, other keyboards, a release build.
  **Update:** a real SMS filled it in a real login the same day (entry above).

### 2026-11-05: registry 17: Carousel with a height, TextField autoComplete (Claude)
- **What:** from the ZeroBill port (asks R35, R36). (1) A Carousel with `height` or `flex` gives each page the full
  height and puts the dots at the bottom (a welcome screen's slides); one with no height draws exactly as before.
  (2) `autoComplete` on TextField with RN's names, as Android autofill hints (`tel-national`, `sms-otp`, `email`,
  `name`, `password`, ...); `textContentType` accepted and ignored. Registry 17 (`CAROUSEL_FILL_SINCE`, prop 284),
  second-opinions 145, guide §11 and §19, rn-compatibility rows, labs (RN props: "Carousel with a height"; Inputs:
  name, phone, OTP hints). Kotlin changed: needs a new APK. The paused G3/G4 would take registry 18.
- **Tests:** 1115 JS tests and the type checks, runtime unit tests (new `ZnAutofillTest`), runtime lint, debug sample
  build. A field with a hint and `autoFocus` focuses after the screen's slide (the pilot's login got no offer before).
  Lava (debug): offers banner positions the same to the pixel before and after; the full-height lab carousel
  centred, dots at the bottom, swipe ok; the phone field's Gboard strip offers the number (with the hint; nothing
  without it, on the prototype's login). Not checked: `sms-otp` with a real SMS, a release build, TalkBack.
  **Update 2026-11-06:** the pilot's login read a real SMS through the SMS Retriever (entry "SMS hash and OTP auto-read").

### 2026-11-05: React habits that read a value once are build errors; `return null` in a child draws nothing (Claude)
- **What:** from the RN dos / don'ts sweep (B1, B2, T1–T3), all checked again first. (1) A child returning `null` /
  `undefined` / `false` draws nothing (was a TypeError and an empty part; `view.ts` `mountChild`). (2) An `async`
  component is a build error. (3) A body value that is shown, an early return, and destructured props are build
  errors where the value can change: a signal read, or a child's props that can change while it stays mounted. Not in
  screens or rows. Guide §61, second-opinions 144, rn-compatibility §9 rows. JS only: no APK, registry or host API change.
- **Tests:** 1114 JS tests and the type checks (new: `once-traps.test.ts`; the "child may return early" test in
  `screen-roots.test.ts` now expects the error). The sample builds with no trap. Lava (debug): five sample screens,
  only the expected lab logs. **Breaks a build:** the ZeroBill prototype has one real trap, which its session fixes.

### 2026-11-05: Document scanner plugin (Claude)
- **What:** official, opt-in `@zero-native/document-scanner` (`plugins/document-scanner/`), native module `DocumentScanner` v1,
  on Google ML Kit's document scanner (`play-services-mlkit-document-scanner:16.0.0`). react-native-document-scanner-plugin's
  names (`scanDocument`, `maxNumDocuments`, `scannedImages`, `status: "success" | "cancel"`), plus `formats` (JPEG pages and / or
  a PDF), `mode`, `galleryImport`, `tag`, `pages`, `pdf`. ML Kit's scanner is a Play services download (Pavan: the one exception
  to "bundle"): `getStatus`, `download`, `onStatus`, each Play failure a status with a reason. Results on `ZnLaunch` (on disk
  first, one handler per run, until `ack`), files moved into `zn://file` handles. No registry or core change. Sample: lab
  `zn://sample/dev/document-scanner`. Guide §60, second-opinions 139–141, plugins.md and rn-compatibility rows.
- **Found on the emulator and fixed:** (1) `GmsDocumentScanning.getClient` throws "MlKitContext has not been initialized" in an
  app with `@zero-native/scanner` (its manifest removes ML Kit's start-up provider): the plugin starts ML Kit itself, off the main
  thread. (2) After a kill while the scanner was open, Android rebuilt ML Kit's helper Activity in the new process and crashed the
  same way, and the scan came back `lost`: a marker file, and ML Kit started in `register` only when it exists (12 ms debug,
  21 ms release). The ZeroBill prototype's own `plugins/docscan` likely has the same crash (told app-home-tabs).
- **Size (release, R8):** about 135 KB of uncompressed dex (ML Kit client 127 KB, plugin 11 KB). No R8 rule needed.
- **Tests:** JS 13 (plugin) of 1045 and both type checks; Kotlin 10 (`DocScanRulesTest`); `:plugin-document-scanner:assembleDebug`;
  lint 0 errors.
- **Emulator (Android 13, Play services 26.40), debug and R8 release:** status `not_downloaded`, then a first scan showed Play's
  download screen and then the scanner; status `available`; cancel (X and Back); a gallery scan with 1 page + 1-page PDF, moved
  out of `cache/mlkit_docscan_ui_client`; "Don't keep activities" (both our Activities rebuilt, the promise got the answer);
  `am kill` with the scanner open, then cancel and then a real scan: each came to `onResult` once after the restart, and not again
  after ack; `cleanup`; a wrong option rejects with `invalid_args`. **Not tested:** the camera (the emulator gives no frames),
  `download()` with progress events (the module came through the first scan, and it can't be removed again), a phone with no
  space or no Play services.

### 2026-11-05: Lottie plugin (Claude)
- **What:** official, opt-in `@zero-native/lottie` (`plugins/lottie/`): `<LottieView>` with lottie-react-native 7.x's
  props, defaults and events, `ref` with `play` / `pause` / `resume` / `reset` (callback or `useRef`), the default
  import, `Lottie.preload`. `.json` and `.lottie` files from `asset:` paths (in the bundle, so OTA can change them).
  "Remove animations" shows the last frame. Airbnb lottie-compose 6.7.1, bundled. On `<NativeView>`: no registry
  change (still 16), module `Lottie` v1. Sample: lottie lab (`zn://sample/dev/lottie`), 3 animations of our own made
  by `examples/sample/make-lottie.ts`. Guide §57, second-opinions 130–132, plugins.md and rn-compatibility rows.
- **Size (release, R8, arm64):** +85 KB for the plugin (`classes.dex` +83.6 KB compressed, `resources.arsc` +0.5 KB).
  No R8 rule needed (dexdump: 161 Lottie classes kept; appcompat adds no classes).
- **Tests:** JS 1032 (lottie 10) and both type checks; Kotlin 11 (`LottieRulesTest`); `:plugin-lottie:assembleDebug`;
  lint 0 errors (`:plugin-lottie:lintRelease :sample:lintRelease`); sample debug and R8 release built.
  Android 13 emulator, debug and R8 release, same results (screen hashes equal): JSON and `.lottie` draw; play, pause,
  resume, reset; a play at the end starts again; frame parts both ways; `onAnimationFinish` false / true (reset while
  playing); resume after a 3 s pause goes on (no jump); `progress` 0 / 0.5 / 1; colour filter; speed −1; resizeMode
  cover / center; ref null after hide; the 3 failure reasons; preload; "Remove animations" (last frame, finish at once,
  moves again when turned back on); 0 frames drawn in the background. The emulator run found 3 bugs, all fixed:
  resume / play jumped ahead (`continueFromPreviousAnimate`), a second `play()` after an ended play did nothing (now a
  `plays` counter and an "ended" rule), preload's size was in pixels.
- **Cold start (emulator, x86_64 release, home screen, 2 × 10 runs each):** median 1631 ms without the plugin and
  1668 ms with it; round medians swing from 1140 to 3060 ms, so the emulator's noise is far bigger than any effect.
  The plugin does no work at start (`register` makes 3 small objects; Lottie's classes load with the first view).
  Not measured on the Lava.
- **Also:** the sample's and the runtime's release builds take `-PznX86Release` (also x86_64) for R8 checks on the
  emulator; the runtime needed it too for `libzn.so`.

### 2026-11-05: `@zero-native/markdown`: server Markdown as native text (Claude)
- **What:** asks R16 / R21 from the ZeroBill port (offer details, notifications). A JS-only, opt-in package:
  `<Markdown>` (each block one native `<Text>` with spans from registry 16, in a `<Column>`) and `<MarkdownText>`
  (inline, 1–3 lines). Own parser (~10 KB minified with the components, 3.7 KB gzip, ~27 KB Hermes bytecode). Links
  only through the app's `onLinkPress`; no HTML, no images. Sample lab `zn://sample/dev/markdown`. README, guide §58,
  second-opinions 133–135, plugins and rn-compatibility rows. No Kotlin, no registry change.
- **Tests:** 34 package tests (parser, span styles, link taps, a compile of `Markdown.tsx`); the full `bun run test`
  and type checks. Android 13 emulator, debug build: the lab draws every part right; four link taps reach
  `onLinkPress` with the right URL and text (the lab's own check refuses `javascript:` and `zn://`); a tap on plain
  text does nothing; text and style changes at runtime; the 2-line note ends with "…"; broken text shows as text, no
  error. Not run on the Lava; TalkBack (headings, links) not tried; no release build.
- **Then (same day): spacing for reading** (second-opinions 142), after the prototype's offer screen on the Lava
  looked dense: 22 dp lines, 6 dp between items, 16 / 24 dp marker columns, heading sizes and line heights, a quote
  with a bar on the start side, runtime box colours (`colors`). Then a runtime `spacing` prop (every gap, the marker
  columns, the indent and box padding as per-edge padding; `DEFAULT_SPACING`), Pavan's ask. 27 templates (was 19).
  Tests: 1092 JS tests and both type checks; sample JS. Lava, debug build, before (the committed package) and after
  in the same lab: before, "10." pushed its text right of the other numbers; after, bullet text 16 dp from the dot,
  "10." text lined up with 1-9, the quote bar full height. The lab's compact spacing changed at runtime with the text
  still lined up; a link tap reached `onLinkPress`. Not checked: TalkBack, a release build.

### 2026-11-05: official image viewer plugin `@zero-native/image-viewer` (Claude)
- **What:** ZeroBill ask R15. `ImageViewer.open({ images, imageIndex })` opens the native screen `imageviewer.full`
  (the app adds one route) for store photos and receipts: pinch 1x–5x, pan, double tap 2.5x, swipe between pictures
  and up / down to close, Back, a "2 / 5" count, loading and error states. Coil's screen-size copy plus a sharp part read
  from the original once the zoom rests (region decoder, EXIF turns), so big photos stay sharp without running out of
  memory. react-native-image-viewing's names. The close button is the RN app's back arrow (asked by Pavan). A debug-only
  two-finger gesture tool for adb. Sample lab, README, guide §59, second-opinions 136–138, plugins and rn-compatibility rows.
- **Tests:** 1032 JS tests and the type checks; 19 plugin unit tests; plugin lint; debug and R8 release sample builds
  (the plugin's package is 25.5 KB of dex). Lava (debug): open from a thumbnail on the right picture, pinch to 5x
  (injected), pan stops at the edges, sharp at 5x on a 5000 x 3333 photo (app graphics 33 MB), EXIF 6 upright when
  zoomed, swipe between pictures, swipe down and Back close with `{ index }`, rotation keeps the picture, a kill -9 in
  the background restores the viewer on the same picture and `onNavResult` hears the close, TalkBack tree has a
  48 dp "Close" button. Pavan tried pinch, double tap, swipes and close by hand on the Lava. Not checked: TalkBack
  turned on, real two-finger pinch speed in release by hand (see the report), GIFs.
- **Follow-up, same day (Pavan's asks):** more kinds of links. `content://` links, read with ContentResolver. `file://`
  links, but only inside the app's own folders, checked after `../` is resolved. `data:image/...;base64` up to 5 MB
  (20 MB held in all). Per-picture `headers`, sent with Coil's request and never logged. Headers and `data:` stay in
  native memory, not in the saved params: module v2 `ImageViewer.hold`. A pinch can go to 0.8x (this was already in;
  now in the docs). Second-opinions 143 (138 points to it), guide §59, README, rn-compatibility and plugins rows. A
  `/image-auth` route in `tools/fetch-test-server.ts` for the lab. **Tests:** 1096 JS tests (17 in the plugin), 24 plugin
  unit tests, plugin lint (warnings only), debug and R8 release sample builds. Android 13 emulator (debug): pinch held
  at 0.8x, then back to fit; a `data:` picture shows, too-big and bad ones show the error; the header picture loads
  (the server saw the header) and the same link without it gets 401 and the error; the token is in no logcat line;
  `file://` in the cache and `content://` from the media plugin's own provider load (EXIF upright); a missing MediaStore
  id, a `../` escape and a real file on `/sdcard` show the error. R8 release on the emulator: `data:` and the header
  picture. Not checked: the Lava, a `content://` from another app's share, a kill with held pictures on screen.


### 2026-11-05: zIndex on a child of Column / Row / Box / Pressable (Claude)
- **What:** R23 part 2 from the ZeroBill port: a row with `zIndex` draws its absolute tooltip over the rows after it,
  as in RN (before: only a Stack's children took zIndex, elsewhere a build error). Registry 16 (`ZINDEX_ANY_SINCE`),
  second-opinions 129, guide notes, rn-compatibility and styling rows.
- **Tests:** 1022 JS tests and type checks, runtime unit tests and lint, debug sample build. Android 13 emulator: RN
  props lab tooltip rows. Not run on the Lava.

### 2026-11-05: registry 16: runtime text spans with onPress, dashed / dotted lines, includeFontPadding (Claude)
- **What:** from the ZeroBill port (asks R16 / R21 / R22, R11 / R23 / R7, R28). (1) Nested `<Text>` spans from data
  (`.map`, `&&`, `? :`), with runtime styles and `onPress` on a span (a Compose link). (2) `borderStyle: "dashed" |
  "dotted"` on borders and top / bottom lines. (3) `textDecorationStyle: "dashed" | "dotted"` on a whole Text.
  (4) `includeFontPadding: true` (default false, Pavan's option A). Registry 16, second-opinions 128, guide §18 and
  styling notes, rn-compatibility rows. Kotlin changed: needs a new APK; bundles that use these need registry 16.
- **Tests:** 1020+ JS tests and the type checks pass (new: runtime span compiler tests, `text-spans.test.ts`, style
  key tests). Runtime unit tests, runtime and sample lint, debug sample build. Android 13 emulator: RN props lab
  "Dashed lines, font padding, spans" (all drawn right, span taps logged, runtime colour and `&&` span). Not run on
  the Lava; not run in a release build; TalkBack on span links not tried.

### 2026-11-05: absolute Stack children take no room, absolute Svg size, missing-plugin warning (Claude)
- **What:** from the ZeroBill port (asks R29–R31). (1) An absolute child of a `Stack` no longer makes the Stack bigger,
  as in RN (`ZnRenderer.kt` `absoluteChild`). (2) An absolute `<Svg>` with `start` + `end` (or `top` + `bottom`) gets no
  aspect ratio on that axis, so `preserveAspectRatio="none"` stretches it to its box (it drew 360 x 792 in a 360 x 220
  slot). (3) At start, a bundle that needs a module no plugin registered gives one clear `zn` error, and the dev error
  screen in debug. second-opinions 127, guide notes, styling-and-layout §4. Kotlin changed: needs a new APK; no
  registry or host API change.
- **Tests:** 1013 JS tests and the type checks pass (new: R30 test in `svg.test.ts`). Runtime unit tests and the debug
  sample build. Android 13 emulator: RN props lab "Absolute children take no room", Tabs lab (Scan button, badges),
  Offers banner, the older Stack FAB, no missing-module error. Not run on the Lava; not run in a release build.

### 2026-11-05: RN-compat sweep P0.4–P0.9 and P1: new build errors, RN names in the compiler and JS core (Claude)
- **What:** (1) Build errors for RN code that built and did nothing: absolute / zIndex outside `Stack`, a press event
  on anything but `Pressable`, `<List horizontal>`, a destructured `row`, a `transform` order zn would draw
  differently, a tag imported from `@zero-native/ui` that zn doesn't have (`SafeAreaView` crashed at run time)
  (second-opinions 115). (2) Props checked per element from a table generated from the UI types
  (`bun run gen:tag-props`, second-opinions 116). (3) RN names: `View`, `FlatList` (`renderItem`, `keyExtractor`),
  the three Touchables, `ActivityIndicator`, `marginLeft` and friends, `flexGrow`, `rowGap`, `textAlign: "left"`,
  `StyleSheet.flatten` / `hairlineWidth`, `aria-*`, `role`, Image `source` / `resizeMode`, Switch `trackColor`, ...
  (second-opinions 117); `useFocusEffect`, `useCallback`, `useRef`, `useNavigation`, `useRoute`, `AsyncStorage`,
  `BackHandler`, `Appearance`, `useColorScheme`, `setImmediate` (second-opinions 118); 148 CSS colour names and
  `hsl()` (second-opinions 119). Guide §56, rn-compatibility rows, the sweep doc marks, adding-components step.
  No registry, host API or Kotlin change: no new APK needed for this part.
- **Tests:** 1012 JS tests and the type checks pass (new: `rn-compat.test.ts` P0.4–P1, `tag-props.test.ts`,
  `packages/core/test/rn.test.ts`, colour tests). Sample JS, sample types and debug build. Prototype: every TSX file
  compiled with the new checks (no new errors), HEAD d804c82 builds (394,210 bytes of JS, about 4.5 KB more for the
  colour table), 717 tests pass. New lab `zn://sample/dev/rn-names` (Dev screens → RN names) on the Android 13
  emulator: layout looks right, the three Touchables, spinner hide (keeps its space), effect cleanup (ticker stops),
  Image `source`, FlatList rows, AsyncStorage, BackHandler (Back kept) and `goBack` all logged as expected. Not run on
  the Lava; not run in a release build.

### 2026-11-05: scanner fix: the code reader never started in release builds (Claude)
- **What:** in a release (R8 full mode) build without Firebase, R8 dropped the empty constructors of ML Kit's 3
  registrar classes. ML Kit creates them by reflection, so the code reader never started and the scanner showed its
  camera error (the ZeroBill pilot on the Lava). Cause: ML Kit pulls `firebase-components` 16.1.0, whose rule keeps
  only the class names; 20.0.0 fixed it, and the sample got 20.0.0 through its Firebase plugin, so it never showed.
  Fix: `plugins/scanner/android/consumer-rules.pro`, the same one rule as 20.0.0 (keep only `<init>()`).
- **Tests:** the pilot's release APK read with `dexdump`: without the rule the 3 classes have no constructor; with it
  they have one, and nothing else changes (APK 14,146,110 bytes both ways). Not yet run on the Lava with a real QR.
- **Lesson:** the plugin phone tests ran only on debug builds. Plugins that use reflection need one release run.

### 2026-11-05: RN-compat sweep P0.1–P0.3: gap with justifyContent, no negative margin crash, effect cleanup (Claude)
- **What:** (1) `gap` is kept with `justifyContent` center / flex-end / space-* (before, it was dropped), with
  Yoga's numbers: for space-* the gap is the smallest space (`ZnArrangement.kt`, second-opinions 112). (2) A negative
  margin crashed the app as the bundle loaded (Compose's padding refuses negative values). Now a negative margin,
  padding or border width fails the build with a translate hint, and `Edges.toPadding()` clamps at 0 for slot
  padding and old bundles (second-opinions 113). (3) An `effect` that returns a function gets it as its cleanup, as
  React's `useEffect` (second-opinions 114). Guide §2, §3, §8; rn-compatibility rows; the sweep doc marks them done.
  No registry or host API change. (1) and the clamp in (2) need a new APK.
- **Tests:** 10 Kotlin tests for the arrangement math (one caught that Compose's `spacedBy(gap, alignment)` is a new,
  unequal object each call, which would remeasure rows on every recomposition), 3 for the clamp, 3 compiler tests,
  5 signal tests. 976 JS tests, type checks, 197 runtime unit tests and runtime lint pass. Sample JS and debug build.
  Prototype: 539 tests, typecheck, app:check, JS build, with no edits. On the Android 13 emulator, before and after:
  sample Amount screen (₹, amount and cursor 8 dp apart; hint 10 dp lower) and the Offers banner (2 dp between its
  lines). The 11 prototype rows that change are listed in second-opinions 112; not run on the Lava.

### 2026-11-05: RN layout matches from the ZeroBill port: List padding, contentContainerStyle, Stack stretch (Claude)
- **What:** (1) A `<List>`'s padding is now content padding: it scrolls with the rows, so `paddingBottom: 100` keeps
  the last row above a floating button (`ZnTemplate.kt` `paddingIsContent`, `ZnRenderer.kt` `contentPaddingOf`).
  Padding from a slot on Scroll, Carousel and List is read now; before, it was dropped on a Scroll. (2) RN's
  `contentContainerStyle` on `<Scroll>` and `<List>`: padding keys only, and padding in both it and `style` fails the
  build (`compile.ts` `contentContainerStyle()`, `packages/ui` types). (3) A `<Stack>`'s normal children stretch to
  its width like a Column's (zn flex rule 4). Second-opinions 111, guide §11, styling-and-layout §3 and §5,
  rn-compatibility rows. No registry or host API change, but (1) and (3) need a new APK.
- **Tests:** 2 new compiler tests (alias on List and Scroll, a slot value, 5 errors). All 968 JS tests and the type
  checks pass. Sample JS and debug build. On the Android 13 emulator (RN props lab, new section): the last row
  scrolls 72 dp above the button, and Stack rows with a background are full width. All 29 `<Stack>` uses in the
  sample and the ZeroBill prototype read by hand (second-opinions 111). Not run on the Lava.
- **Also:** an RN-compat sweep (3 read-only subagents: props, styles, APIs). Its ranked list waits for Pavan's picks.

### 2026-11-05: two bugs from the ZeroBill port: screens with two returns, tall single-line fields (Claude)
- **What:** (1) A route's screen with a second, different JSX return (or `return null`) drew a blank screen with no
  error: native mounts the root from the manifest's one template, and JS filled in another. The app build now fails
  with "a screen needs one JSX return" and the fix (`compiler/src/plugin.ts` `checkScreenRoots`, fed by
  `CompileOutput.roots`). Same-shape returns pass; child components are not checked. `renderRoot` throws a clear
  error for a screen that returns no View. The bug dates from 288554d (2026-10-29), not the compiler pack.
  (2) A single-line `TextField` now centres its text, cursor and placeholder in a tall box; multiline stays at the top
  (`ZnTextField.kt`). Guide §4 and §19, rn-compatibility rows, second-opinions 108 and 109. No registry or host API change.
- **Tests:** 12 new build tests (`compiler/test/screen-roots.test.ts`): two returns, same shape, `return null`, bare
  return, a helper's value, another component, switch / case, root ternary, G4 consts, parens and fragment, nested
  functions, the same component as child and screen, native routes. All 965 JS tests and the type checks pass. Sample
  JS and debug build, runtime unit tests. The sample and the ZeroBill prototype build with no edits. On the Android 13
  emulator: the sample's new tall OTP field shows its placeholder and typed digits in the middle; the note field
  stays at the top. Not run on the Lava.
- **Later the same day:** an outside review found that moving a whole screen into a child (the easy way past the
  build error) turns an error screen into a blank one in release, because a failed part is left empty. The build
  error and guide §4 / §26 now warn about it; a regression test is shaped like ZeroBill's VerifyScreen (13 tests).
  Checked on the emulator: debug builds already show a part's error on the red dev screen, even with no `zn dev`.

### 2026-11-04: FlowStore can't crash or fail on a full disk once a key's file exists (Claude)
- **What:** Pavan's ask 8 (a save must fail only for size). FlowStore files were sized with `ftruncate`, which leaves
  holes; a store into a hole on a full disk is a SIGBUS crash. Now `posix_fallocate` reserves every block when a file
  is made or grown (with a rewrite-in-place fallback), and an older file is filled on its first write. A full disk
  fails only the first save of a key or a growing save, cleanly. The guide keeps the write-ahead rule (never open the
  UPI app after a failed save) and says to show a low-storage screen when the first save fails. Second-opinions 106,
  guide §16, ARCHITECTURE §13.2. Core C++ only: no API, host API or registry change.
- **Tests:** core tests on the Android 13 emulator (x86_64 build): 167 checks, 0 failed. New: files have no holes, an
  old file with holes is filled and keeps its value, and a fake full disk (`RLIMIT_FSIZE`) fails a new key cleanly
  (still "missing", not "broken"), fails a grow with the old value kept, and still lets a write that fits go through.
  Also fixed a stale check from 4cd56c5 (nav kind 10 is now BACK_WANTED, so the "unknown kind" test uses 11). Sample
  debug build and runtime unit tests pass. Not run on the Lava (arm64) or on f2fs.

### 2026-11-04: plugins add only an interceptor to fetch (Claude)
- **What:** `ZnFetch.addClientSetup { builder -> }` (eae7b49) is replaced by `ZnFetch.addInterceptor(interceptor)`. A
  plugin no longer gets the OkHttp builder, so it can't undo the app's pins, redirects, retries or timeouts. A plugin
  interceptor that throws a runtime error now fails only that fetch (`connection_lost`). Before, OkHttp threw it again
  on its own thread, which crashed the app. The request is never sent twice. Perf uses the new call. Second-opinions
  105, guide §30, `docs/fetch.md` §5. Kotlin API only: no host API or registry change.
- **Tests:** `ZnFetchTest` 6 / 6 (3 new: a working plugin, one that throws before and after the request went out, and an
  IO error kept as it is); `:plugin-firebase-perf` compiles.

### 2026-11-04: two fixes from a light audit of new work vs old code (Claude)
- **What:** an audit of the commits since hardening (`eb3f7e0`) for newer work that changed older behaviour, and for
  doc gaps. Findings: `audit-2026-11-04.md` in the session notes (not in the repo). Two framework fixes, asked by Pavan:
  - **Handler calls made once** (found in d4f97f1, RN-style handlers): `onPress={once(pay)}` was made again on every
    tap, so once / debounce guards did nothing (a double-pay trap). A handler written as a call is now made once when
    the element appears; a handler prop of a user component too. Names, `props.onPress` and ternaries are still read
    at tap time (guide §5, second-opinions 104).
  - **Remote Config `activate`** read the task result without checking success: a failed task threw on the main thread
    (a crash). Now the same guard as `fetchAndActivate`.
- **Tests:** JS 953 (all pass, with types; a runtime test shows `once()` firing once in 3 taps, and 3 times with the
  old compiler), Remote Config plugin tests and lint, sample debug built. Sample templates unchanged; its JS changes
  only where 8 `tapped("...")` handlers are now made once (same behaviour: `tapped` keeps no state).

### 2026-11-04: compiler pack: JSX in variables, build-time values in a component body (Claude)
- **What:** guide-notes §47, second-opinions 100–103, ARCHITECTURE §3 principle 7. JSX in a `const` (or a `let` never
  assigned again), in a component body or at module level, used as a child, a prop, `return x`, in `.map` / `<List>`
  rows and branches; each use is its own copy. `return c ? <A/> : <B/>`, `return c && <A/>` and nested ternaries with
  `null` work. Build-time values: consts in a component body, `? : ?? || && !`, comparisons, `+ - * / %`, template
  strings; names follow JavaScript's scope (a `.map` parameter no longer folds to a module const of the same name).
  Errors with hints: a reassigned JSX `let`, `push(<X/>)`, JSX in an array, a JSX const used as a value, JSX that would
  read a different name where it lands, JSX in a lowercase helper. No registry, host API or Kotlin change.
- **Not built (decided):** per-call-site sizes for atoms ("G3": named sizes instead, entry 100) and the NativeWind
  `className` translator ("G5", entry 103).
- **Tests:** JS 951 (all pass, with types; 23 new in `compiler/test/jsx-vars.test.ts`, with a runtime run on the fake
  host), Kotlin 181, lint 0 errors, sample debug and R8 release built.
- **Same bytes:** the sample's `main.zn.ui`, manifest, `main.js` and `main.hbc` are identical before and after; the
  ZeroBill prototype's templates and JS too (built with the old and the new compiler). So no phone or emulator run.

### 2026-11-04: Analytics on by default; the docs say collection starts before consent (Claude)
- **What (d2911e4, docs in 480dc3d):** Pavan's call: Analytics is on from the first start, as in RN Firebase and like
  Crashlytics and Perf. The first version (cc8853b) was off until the app said yes. The manifest flag that kept it off
  is gone. `setAnalyticsCollectionEnabled(false)` is the user's opt-out, and Firebase keeps it across starts. An app
  that must wait for consent sets `firebase_analytics_collection_enabled=false` in its own manifest (JS is too late:
  Firebase starts before JS). Guide §50, second-opinions 96, `plugins/firebase-analytics/README.md`, `plugins.md` §7.
- **Said plainly in the docs (480dc3d):** `first_open`, `session_start` and screen views, with the app instance id, are
  sent before any consent.
- **Phone step:** new step "analytics on from the first start" in `tools/plugin-phone/analytics.ts` (fresh app data, no
  tap, the first events must be logged).
- **Not done:** the DPDP check (is data from the first start allowed with a privacy notice only?) before real users.
  Perf has the same default (second-opinions 126). Its "off until consent like Analytics" option no longer matches
  how Analytics works.

### 2026-11-04: Crashlytics check for an OTA bundle's error (Claude)
- **What (690f5bd, test tool only, no product code):** a new phone step "crashlytics error from an OTA bundle" in
  `tools/plugin-phone/crashlytics.ts`. Run it with `ZN_OTA=1 bun run tools/plugin-phone.ts crashlytics`. It builds a
  bundle into a test store of its own (`.zn-ota-test/plugin-phone/ota-store`, signed with the sample's key), serves it on
  this computer only (port 8790, `adb reverse`), clears the sample's data before and after, records a caught error from
  the downloaded bundle, and sends it at the next start. Nothing is published anywhere else.
- **Console check by hand:** the event's keys must say `zn_built_in=false` and `zn_bundle_id=<id>`.
- **Not done:** no run result is recorded here. The step is not in the Tests table or the plugin README yet.

### 2026-11-04: Performance plugin (Claude)
- **What (eae7b49):** `@zero-native/firebase-perf` (`plugins/firebase-perf/`): Firebase Performance Monitoring. The app start, a network
  trace per `fetch` and a trace per screen (with slow and frozen frame counts) happen by themselves; custom traces with
  `Perf.trace(name, fn)`. On by default (Firebase's default; it is diagnostics, like Crashlytics). URLs go without the
  query; `PerfPlugin(url = ...)` rewrites or drops them. Guide §55, second-opinions 126, README, `rn-compatibility.md` row.
- **Core (Kotlin only, add-only):** `ZnFetch.addClientSetup { builder -> ... }`, which adds to core's OkHttp client after
  the app's `ZnFetch.configure`. A plugin must not call `configure`: it would replace the app's own setup.
- **Size:** the sample's R8 release APK 15.21 → 15.35 MB (**+0.14 MB**), the lab included.
- **Lab:** `/dev/perf`. Phone step: `bun run tools/plugin-phone.ts perf`.
- **Not done:** whether ZeroBill's consent screen covers diagnostics (second-opinions 126). Only the query of a URL is
  cut, so ids in a path go to Firebase unless the app sets `url`.

### 2026-11-04: Remote Config plugin (Claude)
- **What (16f0b56):** `@zero-native/firebase-remote-config` (`plugins/firebase-remote-config/`): Firebase Remote Config with RN Firebase's
  API. Every answer (`setDefaults`, `fetch`, `activate`, `fetchAndActivate`, `getAll`) carries all values with their
  source, so `getValue` is a plain call with no promise (second-opinions 125). `onConfigUpdated` gives live updates.
  Guide §54, README, `rn-compatibility.md` row.
- **Size:** the sample's R8 release APK 15.16 → 15.21 MB (**+0.06 MB**), together with push native version 2 and the lab.
- **Lab:** `/dev/remote-config`. Phone steps: `bun run tools/plugin-phone.ts "remote config"` (3 steps); the lab server is
  `tools/remote-config-lab.ts`.
- **Fixed later:** `activate` read the task result without checking success (see the audit entry above).

### 2026-11-04: Push v2: taps, buttons, progress, scheduled notifications, the OTA check push (Claude)
- **What (edd378b; `Notifications` native version 2):** guide §51–53, second-opinions 120–124, `plugins/firebase-messaging/README.md`.
  - A tap on FCM's own notification: `Push.getInitialNotification()` and `Push.onNotificationOpenedApp(fn)` give the
    data to JS; the app opens `data.link` itself (121). `Push.setAutoInitEnabled` for apps that wait for consent.
  - The data message `zn_ota=check` runs `ZnOta.check` natively and never reaches JS (120). `PushPlugin(otaCheck = false)`
    turns it off.
  - Buttons (a button with a `link` opens the app; one without runs the JS task `push.action`), progress bars, inbox
    lists, channel groups. The lock screen default is "private" (122, 123).
  - `Notifications.schedule(options, { at, repeat?, exact? })`: an alarm shows it with no JS, inexact by default (a
    10 minute window; 1e9ccc4 fixed the docs). The boot receiver is in the plugin but declared only by an app that
    wants it (124).
- **Native files:** `Actions.kt`, `Opens.kt`, `Schedule.kt`, `ZnNotificationTrigger`, `ZnNotificationAction`.
- **Lab:** `/dev/push` grew. Phone steps are in `tools/plugin-phone/push.ts` (`bun run tools/plugin-phone.ts push`).
- **Not done:** the OTA server's load when one topic message reaches every phone (120); alarms on Xiaomi or Oppo phones
  with the app swiped away (124).

### 2026-11-04: Analytics plugin (Claude)
- **What (cc8853b):** `@zero-native/firebase-analytics` (`plugins/firebase-analytics/`): Google Analytics for Firebase with RN Firebase's
  API. A `screen_view` per top route by itself (`AnalyticsPlugin(screenName = ...)` renames or drops routes; do not call
  `logScreenView` for whole screens). Event names are checked in the plugin (a bad name answers `false` and warns),
  booleans are sent as 1 or 0, consent mode, and the app removes the ad id permissions (second-opinions 96–99). Guide §50,
  README, `rn-compatibility.md` row. The first version was "off until consent"; d2911e4 changed it (entry above).
- **Size:** the sample's R8 release APK 14.71 → 15.16 MB (**+0.44 MB**), the lab included.
- **Lab:** `/dev/analytics`. Phone steps: `bun run tools/plugin-phone.ts analytics`.
- **Not done:** the DPDP check (see the entry above).

### 2026-11-04: Firebase base plugin (Claude)
- **What (7bd50f1):** `@zero-native/firebase-app` (`plugins/firebase-app/`), RN Firebase's `app` module. Every Firebase
  plugin stands on it: the one Firebase BoM, `firebase.gradle.kts` (an app applies it at the end of its own
  `build.gradle.kts`; it turns Firebase off when `google-services.json` is missing and uploads the R8 mapping only
  with `-PznUploadMapping`), `Firebase.app()`, `setDataCollectionDefault`, and Installations `getId` / `getToken` /
  `delete`. The sample's Gradle lines moved into the shared file; the Crashlytics and push plugins now depend on it.
  Guide §49, second-opinions 95, README.
- **Phone step:** "firebase app and installations" in `tools/plugin-phone/crashlytics.ts`.
- **Not done:** no size number of its own. With Crashlytics or FCM it adds only a few classes (README).

### 2026-11-04: Firebase plugins: Crashlytics and push (Claude)
- **What:** `@zero-native/firebase-crashlytics` and `@zero-native/firebase-messaging` (`plugins/firebase-crashlytics/`, `plugins/firebase-messaging/`), opt-in, like
  RN Firebase's modules. Firebase project "zero-native-sample" (not ZeroBill's). Analytics, Remote Config and Perf
  were planned here and came later the same day (entries above; `plugins.md` §7). Guide §46 and §48 (§47 is the compiler pack's), second-opinions 90–95, READMEs, `rn-compatibility.md` rows. No registry or host API
  change (modules `Crashlytics` v1, `Push` v1, `Notifications` v1).
- **Core (Kotlin only, add-only):** `ZnRuntime.addJsErrorListener` and `ZnOta.addReportListener`, next to the single
  `onJsError` / `onReport` hooks, so a plugin and the app can both listen (second-opinions 90).
- **Gradle:** google-services 4.5.0 and Crashlytics 3.0.8 work with AGP 9.2.1 / Gradle 9.4.1. The sample applies them
  only when `android/sample/google-services.json` is there (git-ignored); else one line, and both plugins answer
  "not available". Mapping upload only with `-PznUploadMapping`. NDK only with `-PznCrashlyticsNdk`.
- **Crashlytics:** every JS error as a non-fatal (JS stack frames, so `ota symbolicate` works), at most 30 per launch;
  serious OTA outcomes as `zn.ota.<kind>` non-fatals; keys `zn_bundle`, `zn_bundle_id`, `zn_built_in`, `zn_host_api`,
  `zn_route`, `zn_js_kind`; screen changes as log lines. Nothing masked unless the app passes `redact` (Pavan).
- **Push:** every data message, new token and swipe runs a JS task (`push.message`, `push.token`, `push.dismissed`),
  the FCM service waits for it (15 s). `Notifications`: channels, big text, big picture, large icon, groups with a
  summary from 2 on, a tap opens `link` through core's link path, `canShow`. `tools/push-send.ts` sends a test message
  with the FCM v1 API and the developer's gcloud login.
- **Lab:** `/dev/crashlytics`, `/dev/push` (dev screen). Phone steps: `bun run tools/plugin-phone.ts crashlytics`,
  `... push` (they say SKIP without the json).
- **Tests:** JS 896 pass (crashlytics 6, push 8), types clean; Kotlin: crashlytics 8, push 8, runtime 179; lint 0 errors
  (`:runtime:lintDebug :plugin-firebase-crashlytics:lintDebug :plugin-firebase-messaging:lintDebug :sample:lintRelease`); debug builds with
  and without the json; R8 release built.
- **Size (R8 release, arm64):** Crashlytics about **+232 KB** (classes.dex +225 KB compressed; JS assets left out of the
  count, the baseline build had none); NDK **+1.30 MB** more (about 460 KB to download); push about **+54 KB** on top
  of Crashlytics (they share Firebase's core; push alone not measured). Release APK with both: 14,659,376 bytes.
- **Verified on the Lava (debug, Android 14), 2026-11-04:**
  - `bun run tools/plugin-phone.ts crashlytics`, 3 of 3 steps: status and opt-out; a caught error, a tap handler that
    threw and a promise nobody caught, sent at the next start (`crashlyticsreports-pa`, status 200); a Kotlin crash, sent
    at the next start (200).
  - In the console (read with the Firebase MCP): the crash as FATAL, the 3 JS errors as NON_FATAL issues named after
    their JS function (`main.js - zn.js.handlerThrows`). An event carries the user id, the lab keys and every `zn_` key
    (`zn_bundle=sample_0@b84baa331430`, `zn_route=crashlyticsLab`, `zn_js_kind=handler`, `zn_host_api=8`), and the
    logs: screen changes, the bundle, an OTA check, the full JS stack.
  - The console's stack mapped back with `bun run ota keep-map` + `ota symbolicate`: `main.js:10002` →
    `CrashlyticsLab.tsx:60`, the `throw` line.
  - Push, 3 of 3 local steps: the permission (revoked: `canShow` off, `show` refused; Android's dialog, Allow →
    granted), plain, long, picture (picsum), a group of 3 with its summary, a tap on a notification opens
    `/dev/push?from=notification` through `onLink`, "Clear all" runs `push.dismissed` with the notification's data.
    An FCM token and a topic subscribe work.
- **Fixed after the phone run:** the first breadcrumb was `nav: - -> -` (before any screen); the push lab read
  `canShow` before it made its channels (`no_channel`).
- **Not verified yet:** a real FCM message in front and with the app killed (the two FCM steps; gcloud's login had
  expired), an OTA bundle's error with `zn_built_in=false`, the NDK build and a native crash, a release build on the
  phone, the R8 mapping upload.

### 2026-11-04: RN props pack 2 (Claude)
- **What:** more React Native names, so ported screens keep their code (guide-notes §43, components §13,
  second-opinions 74–79). Registry **14**: `Pressable` long press as in RN (a passed-through `onLongPress` with no
  handler lets a long hold be a tap). Registry **15**: iOS shadow keys dropped (as RN on Android), per-corner radius,
  `borderColor` / `borderWidth` at runtime (ZeroBill gap G10), `StyleSheet.absoluteFill` and stretch between `start`
  and `end` (G16), `textTransform`, `testID`, `pointerEvents`, `hitSlop`, `onLayout`, `Image` `tintColor` / `onLoad` /
  `onError` / `onLoadEnd`, RN's `<Modal>` (G13), `<StatusBar>` and zn's `<NavigationBar>` with colours drawn by zn
  (G8), `List` `stickyHeaderIndices` (G9). No host API change.
- **Found on the way:** Compose's `touchBoundsExpansion` is for a stylus only, so `hitSlop` uses the minimum touch
  size (entry 75). zn lets taps through an element with no handlers; RN stops them. Pavan chose: an absolute layer with a background
  or children stops taps as in RN (entry 74).
- **Lab:** `/dev/rn-props` ("RN props" on the dev screen). Phone steps: `bun run tools/plugin-phone.ts "rn props"`
  (7 steps; they find elements by `testID`).
- **Tests:** JS 889 (all pass, with types), Kotlin 181, lint 0 errors, sample debug and R8 release built.
- **Emulator** (`Medium_Phone_API_33`, Android 13, debug, gesture navigation): all 7 "rn props" steps pass: long press
  with and without a handler (also changing at runtime), fills and stretches to the pixel, text case at runtime, corner
  pixels, the OTP border colour and width, every `pointerEvents` mode, `hitSlop` 15 dp out (and 26 dp out: no tap),
  image events and tint, `onLayout` (and none while scrolling), status and navigation bar colours and icons, `hidden`,
  both Modals (dim tap, an Alert above it, the keyboard, back), sticky rows (push, far down, indices at runtime).
- **Not done:** the Lava, 3-button navigation, a Modal over a Sheet, sticky rows with pull to refresh on a phone.
  Release APK 14,363,588 bytes (with the bigger lab; not compared with main).

### 2026-11-04: core location asks for precise and approximate together (Claude, Pavan's call)
- **What (8f76d29):** core `Permissions` "location" is now two Android permissions, `ACCESS_FINE_LOCATION` and
  `ACCESS_COARSE_LOCATION`, asked together. The state is `granted` if the user gave either. The answer of `request` and
  `status` also has `"location.precise"` (the precise permission alone). Before, "location" asked for precise only,
  which Android 12+ may ignore. Guide §32 and §45; second-opinions 88 (its title still says core "stays the precise
  one alone", which is no longer true). No host API change.
- **Manifest rule:** a manifest with only the precise line fails with `not_declared` (for the coarse one), because
  Android 12+ would show no dialog. A manifest with only the coarse line is fine ("approximate only"). The location
  plugin's manifest brings both.
- **Tests:** two Kotlin tests (`ZnPermissionsTest`: the two names, the manifest rule) and one JS test
  (`packages/core/test/permissions.test.ts`). Totals not recorded here.
- **Not done:** the same button on an Android 12 or 13 phone (second-opinions 88, "evidence wanted"). ZeroBill's own
  manifest must have the coarse line too.

### 2026-11-03: PDF plugin (Claude)
- `@zero-native/pdf` in `plugins/pdf/`, on Android's own `PdfRenderer`: no PDF library. No registry or host API change
  (module `Pdf` v1, views `pdf.view` and `pdf.preview`). Covers everything ZeroBill's RN app uses from
  `react-native-pdf-renderer`: a file source, the page list, pinch zoom to 5×, the 220 dp card preview (pilot gap G14).
- `Pdf.download`: native, streamed to `cacheDir/zn-files`, joined when two screens ask, cached by `url` + `key`, checked
  before it gets a handle, https only (http to localhost in debug), the app's headers only to the first host. `pdfFile`
  gives it as signals. Every failure is a `reason`, never a throw.
- The viewer: our own Canvas and gestures. Page bitmaps only near the screen, within a memory budget; a view-sized
  sharp layer at the real zoom when the fingers rest. The preview draws only the box. One thread for all PDF work.
- Guide notes §44, second-opinions 80–84, README, `rn-compatibility.md` row, sample lab `/dev/pdf`.
- **Tests:** JS 856 (pdf 8), Kotlin 17 (`PdfRulesTest`), `:plugin-pdf:assembleDebug`, lint 0 errors
  (`:plugin-pdf:lintRelease :sample:lintRelease`), sample R8 release built.
- **Emulator** (`Medium_Phone`, Android 13, debug): `bun run tools/plugin-phone.ts pdf --no-hands`, 10 of 10 steps:
  download, preview and view; cache with no network; 50 pages and fling; zoom 3× from code and double tap; a long
  receipt; password, broken, error page, 404, too big, not https, no server, bad handle; redirects keep or drop the
  header; after a kill the file opens again; a kill during a download leaves only a part file; cleanup. 0 crashes.
- **Size:** about **15 KB** of Play download (5,602,360 → 5,618,052 bytes, brotli method), 43 KB of classes.
- **Not done:** pinch by a finger (adb can't), the Lava, the R8 release run on a phone, low-RAM memory numbers.

### 2026-11-03: official location plugin (Claude)
- **What:** `@zero-native/location` (`plugins/location/`): one fix, updates, permission (precise or approximate,
  denied, blocked), location off with the Location screen, last known fix, geocoder both ways, and an RN-named
  `Geolocation`. Android's `LocationManager` and `Geocoder` only: no Play services, no new library. ZeroBill's pilot gap G1
  (Stores and Offers need coordinates). Guide §45, second-opinions 85–89. No registry or host API change (module
  `Location` v1, host API 6).
- **Added 2026-11-04 (Pavan, after his Lava test):** Google's "Turn on location" dialog, `Location.turnOn()`, from Play's
  `SettingsClient` (`play-services-location` 21.4.0, in this plugin), opened through `ZnLaunch`. Module `Location` v2.
  Fixes still come from `LocationManager`. On the Lava: no dialog when on; the dialog when off ("Device location",
  No, thanks / Turn on); No thanks → `declined`, location stays off; Turn on → location on, a fix 25 ms later.
  Size now: the whole plugin adds **50 KB** to the R8 release APK (14,265,581 → 14,315,536 bytes, main with PDF):
  `classes.dex` +45 KB raw (+21 KB compressed; it was +25 / +13 before the dialog), `main.hbc` +33 KB with the lab.
  JS 25 tests (all 881 pass), Kotlin 14, lint clean, all 9 location phone steps pass.
- **Lab:** `/dev/location` ("Location plugin" on the dev screen). Phone steps: `bun run tools/plugin-phone.ts location`.
- **Tests:** JS 19 (all 867 pass), Kotlin 13 rules tests, `:plugin-location:assembleDebug`, lint (no issues), R8 release.
- **Size:** release APK 14,229,589 → 14,275,941 bytes (**+46 KB**): `classes.dex` +25 KB raw (+13 KB compressed),
  `main.hbc` +30 KB, which includes the sample's lab screen. The manifest gains the two location permissions. Measured
  before the rough-permission fix below (a few lines).
- **Verified on the Lava (debug, Android 14, indoors), `bun run tools/plugin-phone.ts location`, 7 steps pass:**
  - A real fix: network, 14–100 m, in 0.1–1.4 s. The GPS never answered indoors. Reverse geocode found a pincode;
    forward geocode found the place. No coordinate in the log.
  - Cached (`maxAgeMs`) answers with nothing started; `"low"` asks the network only; a 1 s `"high"` ends at 1.0 s with
    the best fix so far, or `timeout` and the last known fix.
  - A watch: 2 live requests in `dumpsys location`, 0 after Home, and fixes again on return. Stop and closing the screen
    both remove it. A one-shot running when the app goes to the background answers at once.
  - Location off: one-shot `off`, watch `off`, then fixes again when turned back on; the Location screen opens and the
    lab reads the state again on return.
  - Permission, through Android's real dialog: denied, then blocked after the second "Don't allow" (no dialog after
    that), then "Approximate": granted, not precise, a 2000 m network fix.
- **Fixed after the phone run:** with "Approximate" only, every one-shot ran to its timeout. Android sends a rough-only
  app a new fix at most every 10 minutes and the cached one at once, which the "fresh" rule threw away. Now a fix up to
  11 minutes old counts there and the first one wins (22–32 ms on the Lava). Second-opinions 89.
- **Found:** core's `Permissions.request(["location"])` asked for the precise permission alone (`ZnPermissions.kt:24`).
  Android's docs say 12+ may ignore that, but on the Lava a dialog still showed. Not changed in this entry
  (second-opinions 88). Changed later the same day: see "core location asks for precise and approximate together" above.
- **Not checked:** a GPS fix outdoors, Android 12 or 13, the emulator (`adb emu geo fix`; the PDF session had it), a
  release build on the phone, battery use over time.

### 2026-11-03: SVG branch merged with main; all SVG at registry 13 (Claude)
- Main took registry 11 (Tabs) and 12 (pull to refresh) while SVG was built as 11–13 on its branch. None of it had
  shipped, so all SVG entries (phases 1–4: components, props, dynamic props, the four formats) moved to 13, one number
  (Pavan's call; second-opinions 73). Doc numbers moved too: guide §40 SVG → §42, components §10 → §12,
  second-opinions SVG entries 44–66 → 50–72. Next free: registry 14 (the long press fix), then 15 (props pack 2).

### 2026-11-03: SVG phase 4 built (registry 13): effects, text, more motion, the known limits fixed (Claude)
- **What:** still pictures with filters, masks, patterns, focal gradients, markers, blend modes, `paint-order`, nested
  `<svg>`, `<switch>` and simple `<text>`; animated files with `<animateMotion>` / CSS `offset-path`, `<set>`, `steps()`,
  skews, animated gradient stops, `points` morphs, CSS extras (`@media`, combinators, `:nth-child`, `var()`) and
  `begin="click"` (a tap on the Svg). Phase 2/3 limits fixed: trims on skewed shapes, nested trims, round-cap dots,
  non-scaling strokes under uneven scales, a group's `strokeWidth` over a child's own. Big SVGs read in the background
  after the first frame. Registry 13 (props 197–199, 250–252; formats "svg.effects", "timing.tap"). `docs/svg.md` §17;
  guide §42; components §12; rn-compatibility rows; second-opinions 68–72.
- **Corpus:** a new set of 78 real files (resvg tests, Meteocons, line-md, Fluent emoji) as fixtures: 75 compile, 3 refused
  on purpose. The loader corpus: 104 of 104 (was 100).
- **Checked:** JS 829 tests, both type checks, Kotlin 168, lint (0 errors), sample debug build.
- **On the Lava (debug and release):** every new tile draws and moves right; tap to start, pause, "Remove animations"
  and RTL work. Release: 8 s of loops 731 frames 0 janky (99th 16 ms), list flings 818 frames 0 janky (99th 15 ms).
  **Found and fixed:** filter RenderNodes were shared by every instance of an SVG, so list rows showed another size's
  drawing; they are per Svg node now. **Found, fixed after the SVG commit (framework, older):** a `Pressable` whose
  `onPress` was `undefined` threw "undefined is not a function" on tap. Handlers written as an expression are now read
  at event time and an undefined one does nothing, as in RN (`latest()` in `packages/core/src/view.ts`; guide §5).
- **Not checked yet:** TalkBack itself (the tree only), an Android 9–11 phone (the filter fallback).

### 2026-11-03: SVG phase 3 built (registry 12): stroke motion, morphing, non-scaling strokes, typed part names (Claude)
- **What:** stroked shapes that grow (the outline scales, the stroke keeps its width), `strokeWidth` and `dashOffset` on
  `.svg` parts, one-dash animations as exact trims, `vector-effect="non-scaling-stroke"`, path morphing (SMIL `d`, CSS
  `d: path()`), and `logo.d.svg.ts` part-name types. Registry 12 (props 192–196, format "svg.nonScaling"). Masks,
  patterns and "SVG by value" (remote files, icons the server picks; a later official plugin) are written down as later
  (`docs/svg.md` §10). `docs/svg.md` §16; guide §42; components §12; rn-compatibility rows; second-opinions 63–67.
- **Corpus:** 100 of 104 real loaders compile (was 95); the 4 left use filters.
- **Checked:** JS 821 tests, both type checks (a wrong part name fails in the sample), Kotlin 163, lint, sample debug build.
- **Found while writing the docs, fixed:** a static non-scaling stroke would have asked for registry 11, which can't read it.
- **On the Lava (debug):** the six new tiles draw and move, the chart line stays 2 dp at 20/40/52 dp, pause holds,
  "Remove animations" shows each file's rest values, 729 frames in 8 s with 1 slow frame (99th percentile 19 ms).
- **Not checked yet:** a release build, TalkBack.

### 2026-11-03: animated `.svg` files play (S.14) and SVG phase 2 checked on the phone (Claude)
- **What:** SMIL (`<animate>`, `<animateTransform>`, `<set>`, begin chains) and CSS (`@keyframes`, `animation` shorthand and
  longhands, `transform-origin`) inside a `.svg` file compile into part animations. New timing option `z` (one easing per segment)
  and a step easing. `docs/svg.md` §15, guide §42, components §12, rn-compatibility row, second-opinions entries 59–62.
- **Tests:** 104 real MIT loaders (svg-spinners SMIL + CSS, svg-loaders) as fixtures: 95 compile, the 9 refused are listed by name
  with their reason. SMIL and CSS copies of the same loader give the same motion. JS 403 tests, both type checks, Kotlin 143 tests,
  lint, sample debug build.
- **On the Lava (debug):** every Motion tile and six imported loaders play; pause holds; "Remove animations" shows rest values.
  16 loops at once: 737 frames in 8 s, 0 janky, GPU median 3 ms. **Bug found on the phone, fixed:** a crash when a shape's own trim
  was the whole line (`ZnSvg.kt:722`).
- **Release (R8) on the Lava, after merging main:** the lab opens and everything moves. Motion section and loaders on screen, 4 runs of
  8 s: 734–739 frames, 0 janky. GPU median moved 11–19 ms between runs on the same screen (CPU at 56 °C), so read it as the phone's
  clock, not a code number. SVG code in release dex: 12.0 KB (phase 1: 6.6 KB); `ZnAnimation`: 9.4 KB.
- **TalkBack labels** (read from the accessibility tree, TalkBack itself not turned on): every animated tile and loader has its label.
- **Not checked yet:** "Remove animations" on imported files (some show empty, guide §42); TalkBack itself, by hand.

### 2026-11-03: SVG phase 2 built: motion for every element, moving SVG parts (Claude)
- **What:** timing options on every element (`repeat`, `reverse`, `from`, `delay`, `repeatDelay`, `keyframes` + `times`, bezier
  easing), the element props `paused` and `replay`, `enter` / `exit` `delay`. SVG parts move (`rotate`, `scale`, `translateX` / `Y`
  around their own centre) and draw themselves (`trimStart` / `trimEnd` / `trimOffset`), with per-part `animate`; inline elements take
  the same props. Registry 11 (SVG moved from 10, which main took for the RN basics `ref`; second-opinions entry 58), with a new
  `format` registry kind (entry 57). `docs/svg.md` §9, §15; guide §22, §42; components §12; rn-compatibility rows; entries 55–58.
- **Checked:** JS 385 tests, both type checks, Kotlin 142 tests, lint, sample bundle build. The SVG lab has a Motion section.
- **Not checked yet:** on the phone (looks, frame times, "Remove animations"). Animated `.svg` files (SMIL / CSS) are still refused;
  an import is proposed (`docs/svg.md` §15).

### 2026-11-03: SVG phase 1 built, static SVG (Claude; Kotlin by an Opus agent, reviewed)
- **What:** `import Logo from "./logo.svg"` as a component, inline `<Svg>` with react-native-svg's names, runtime `color` and
  `parts` (fill, stroke, opacity), `autoMirror`. Compiled at bundle build time into draw data, a string prop in `main.zn.ui`
  (registry 10; host API and template format unchanged). A fixed subset; text, images, patterns, filters, CSS and SMIL fail the build
  with a hint. `docs/svg.md` (§14 as built), guide §42, components §12, second-opinions entries 50–53.
- **Checked:** JS 376 tests (59 new for SVG), Kotlin 139 tests, lint 0 errors, sample debug and R8 release build. The RN app's 27
  `.svg` assets and 95 Material icons compile (180 KB → 112 KB). The draw data of 39 SVGs, turned back into SVG in the browser,
  matches the originals (only anti-aliased edge pixels differ). SVG code: ~7.8 KB of release dex.
- **Bug found by the new tests, fixed:** number pairs after `M x y` were read as moves, not lines.
- **On the Lava:** the lab screen (`/dev/svg`) looks right and its taps work, in debug and release. Release cold start **176.5 ms**
  median (same as before). A 23 KB SVG parses in 6–7 ms on a fresh install, 1.4 ms with AOT code (second-opinions entry 54).
  Scrolling 20 full-width big SVGs: 0.6 % janky frames.
- **Not checked yet:** TalkBack on the lab, right to left, an older Android version. Phase 2 (animated parts) waits for a check-in
  with Pavan.

### 2026-11-03: pull to refresh (Claude)
- **What:** pull to refresh on a vertical `<Scroll>` and a `<List>` (gap #4 in `docs/rn-compatibility.md` §10; all four
  ZeroBill home tabs use it). Controlled like RN: a pull sends `onRefresh`, JS owns `refreshing`. Flat props
  (`refreshing`, `onRefresh`, `refreshColor`, `refreshBackground`), or RN's `refreshControl={<RefreshControl ... />}`,
  which the compiler turns into the flat props. Compose foundation only (`ZnPullRefresh.kt`), no material3.
- **Versions:** registry **12** (props `refreshing` 170, `refreshColor` 171, `refreshBackground` 172; event `onRefresh` 25).
  Host API stays 8. The SVG branch (registry 11 too) must move to 13 when it merges.
- **Docs:** guide §41, `docs/components.md`, `docs/lists.md`, `docs/rn-compatibility.md`, second-opinions 49.
- **Checked** (second check by the tabs session, on main at `bac6d1c`): JS 740 tests + types, `gen:registry` gives no
  change, Kotlin unit tests (7 new, pull numbers and the 1 s wait), lint 0 errors, sample debug and R8 release builds.
  Lab: Dev → "Tabs", every tab (Pay and Rewards: flat props; Stores (List) and Offers: `<RefreshControl>`).
- **On the Lava** (debug): `bun run tools/plugin-phone.ts tab pull --no-hands`: the 10 tabs steps and the 3 pull to
  refresh steps passed (long pull refreshes once, short pull doesn't, a List and a Scroll across a tab switch, a pull on
  a scrolled list scrolls it up and doesn't refresh), 13 of 13, 0 crashes.

### 2026-11-03: bottom tabs and focus (Claude)
- **What:** tabs inside one screen, for the ZeroBill pilot's home (4 tabs, each loading its own data).
  - Route option `tabs: [...]` and `useTabs(route)` (`packages/core/src/tabs.ts`).
  - The native `<Tabs selected>` container: it draws only the selected tab. The bar is the app's own JSX.
  - Lazy by default (`preload: true` builds all). A hidden tab keeps its JS state and scroll position.
  - Back on a later tab goes to the first tab, also on the only screen.
  - The selected tab comes back after a kill.
  - A link to `<path>/<tab>` opens the tab, or goes back to the tabs screen if it is under other screens.
- **Also:** `useFocus(fn)` and `tabs.onFocus(name, fn)` (gap #3 in `docs/rn-compatibility.md` §10). `useBack` works in
  any part of a screen, and a screen can have several handlers (the newest first).
- **Versions:** host API **8** (NAV BACK_WANTED 10, route `tabs` in the manifest, a cold link to the start route keeps
  its params), registry **11** (component `Tabs` 30, prop `selected` 149; Claude's component ids are now 30–39). The SVG
  branch also takes registry 11: whoever merges second renumbers and reruns `bun run gen:registry`.
- **Docs:** guide §40 (and §7 Back), `docs/rn-compatibility.md` §3 and §10, second-opinions 44–48.
- **Checked:** JS 737 tests + types, Kotlin unit tests (with tab links), lint (0 errors), sample debug and R8 release
  builds. Lab: Dev → "Tabs" (`/dev/tabs`). Phone steps: `bun run tools/plugin-phone.ts tabs`. Startup numbers:
  `bun run tools/measure-tabs.ts` (release, Lava).
- **On the emulator** (`Medium_Phone`, x86_64 debug): the 10 tabs steps passed, plus the core nav steps (native screen,
  kill while a native screen is open, native view) and the plugin steps that match those names: 17 of 17, 0 crashes.
- **On the Lava** (debug): the 10 tabs steps and the core nav steps passed. Media, auth and webview "kill while ... open"
  failed only because their helpers read a stale "last ANR" record (4:20 pm, before this run) at the top of
  `dumpsys window`; not a live dialog. Fixed: the helpers now read `dumpsys window displays`. Rerun on the Lava: media,
  auth, webview and "task with no screen", 31 of 31 no-hands steps passed, 0 crashes.
- **Startup (Lava, release, n=10):** tabs add nothing measurable to the first frame (171 ms vs 167 ms baseline; preload
  160 ms). The 4 loads run side by side, so the first tab's data doesn't wait for the others. Numbers in
  `docs/startup-and-performance.md` §4.

### 2026-11-03: RN basics pack (Claude; URL and four native modules by two Opus agents, reviewed)
- **What:** React Native's small everyday APIs with their RN names, from `@zero-native/core`: `Alert`, `Clipboard`, `Share`,
  `Linking` (`openURL`, `canOpenURL`, `openSettings`, `getInitialURL`, `addEventListener("url")`), `Platform`, `Dimensions`,
  `useWindowDimensions`, `PixelRatio`, `Keyboard` listeners / `isVisible` / `metrics`, `AppState`, `Vibration`, `ToastAndroid`,
  `NetInfo` / `useNetInfo`, `URL` / `URLSearchParams`, `requestAnimationFrame`. `atob` / `btoa` come from Hermes.
- **`TextField` `ref`** with `focus()` / `blur()` / `clear()` / `isFocused()` (gap #5 in `docs/rn-compatibility.md` §10; the pilot's OTP login).
- **ZeroBill's framework asks 7 and 8:** `URL` / `URLSearchParams` built; `flowStore.MAX_BYTES` (262,128) is public, with a warning over 128 KB.
- **Versions:** host API **7** (app events DEVICE 16, WINDOW 17, KEYBOARD 18), registry **10** (event `ref`), `Os` v2,
  `Keyboard` v2, new built-in modules `Alert`, `Clipboard`, `Vibration`, `NetInfo` (v1). A new APK is needed; older apps
  refuse new bundles.
- **Not built, on purpose:** `StatusBar` component / `setBarStyle`, toast gravity, `Alert.prompt` (iOS only), `WebSocket`, `XMLHttpRequest`.
- **Docs:** guide §39, `docs/rn-compatibility.md` (rows, §11 usage counts), second-opinions 38–43.
- **Checked:** JS 723 tests, Kotlin unit tests (148), lint (0 errors), sample debug and R8 release builds. Lab screen: Dev → "RN basics" (`/dev/rn`).
- **On the emulator** (`Medium_Phone`, Android 13, x86_64 debug; the Lava was busy with another session), every lab check passed:
  - OTP: a tap on a box focuses, 4 digits auto-blur, and Focus / Blur / Clear / isFocused work. Next jumps to the third field through a ref.
  - Keyboard: show and hide events, 292 → 336 dp when the keyboard changes.
  - Alert: buttons placed as in RN, and it stays up through a rotation and answers once. Back closes it with `onDismiss`.
  - Platform 33; Dimensions 411.4 dp at scale 2.625, and a change event on rotation.
  - NetInfo: cellular → none → cellular with mobile data off and on.
  - Clipboard round trip, Share, Toast, openURL https, canOpenURL (https and tel true, whatsapp false), `whatsapp:` refused.
  - `web ok` (URL, URLSearchParams, Hermes' atob/btoa, TextEncoder), rAF 16 ms. Vibration: a `[0, 200]` vibration recorded by Android.
  - AppState changed around the share sheet and the browser. The `url` listener heard a link.
- **Found and fixed there:** `TextField` sent `onBlur` when a field first appeared and after a rotation (an old bug, from 3.3). Now only
  real focus changes are sent.
- **Not on a real phone yet:** the Lava check (MediaTek keyboard heights, DuraSpeed, real vibration feel).

### 2026-11-03: emulator support (x86_64, debug builds)
- The runtime and the sample's **debug** builds also pack x86_64; release stays arm64-only. Hermes already shipped x86_64; the only
  missing piece was `libjsi.so`, taken from the same `react-android:0.88.1` AAR (`core/third_party/jsi/README.md`). Guide §34.
- **On the Android 13 x86_64 emulator (`Medium_Phone`):** the sample starts, and the no-hands phone suite passed 49 of 50. The one fail is
  "scanner torch off on the full screen": the emulator's camera has no flash.
- Test tools: `stopApp()` falls back to `am force-stop` when the `run-as` kill fails and the device has no DuraSpeed (the emulator's
  Play image refuses that kill). The webview tel step presses Back until it is back in the app (Google's dialer needs two). The OTA matrix
  accepts `ANDROID_SERIAL` when a phone and an emulator are both connected. The two changed steps were re-run on the Lava and pass.
- Not run on the emulator: the hands steps and the OTA matrix.

### 2026-11-03: P.3b–P.6 done, the rest of the framework plugins (Claude; plugins by three Opus agents, reviewed)
- **Core:** native screens (`native:` routes, `nav.pushForResult`, `onNavResult`), `<NativeView>` (registry 9), `zn://file`, background
  JS tasks (`defineTask`, `ZnBackground.run`), secure screens, dark mode, low memory, right to left. Host API 6. Guide §35–37.
- **Official opt-in plugins:** `scanner` (CameraX, bundled ML Kit), `auth` (phone hint, SMS Retriever), `media`, `webview`. Guide §38,
  each plugin's README. Out: push / Firebase (later), certificate pinning.
- **Bugs found in review and on the phone, fixed:** a second ML Kit start crashed the scanner; the camera state listener went deaf
  while stopped; the compiler's event wrapper could hide a handler's name. Second-opinions entries 18–36.
- **Found on the Lava:** `am force-stop` puts an app on MediaTek DuraSpeed's list, and then no WebView page loads (entry 36). The phone
  scripts now end the app with a kill -9. Our own test scripts had six more timing or method mistakes; all fixed.
- **On the Lava, debug:** every no-hands step of `tools/plugin-phone.ts` passes, 0 crashes. With Pavan's hands: QR scan (also after a kill,
  double scan, stale frames), photo / three photos / PDF / camera, a photo after a kill, phone hint, WebView upload. JS 316 tests,
  Kotlin tests and lint (0 errors) pass.
- **Final runs:** no-hands **50 of 50**, 0 crashes; OTA matrix **38 of 38** (run alone: a second session's matrix on the same phone had
  broken both runs). Release (R8): cold start **177.5 ms** median, same as after P.2; APK 13.98 MB, Play download **5.50 MB**, of which the
  scanner is about 2.5 MB (`docs/startup-and-performance.md` §4).
- **Not tested:** the SMS steps (no second phone; Lava to itself did nothing; the emulator can't run the arm64-only sample). Real
  carrier SMS, other phones, real UPI apps wait for the pilot.
  **Update 2026-11-06:** real carrier SMS with the app hash now tested and working in the pilot's login (entry "SMS hash
  and OTP auto-read"). Other phones and real UPI apps still wait.
- **Independent review:** 6 issues found, all fixed the same day (`docs/reviews/2026-11-03-p3b-p6-independent-review.md`): the launch
  marker on the UPI return path, a task's hang judging a bundle, a Back press after a scan closing two screens, FLAG_SECURE during
  animations, and two in media. After the fixes: JS 317, Kotlin tests, lint (0 errors), OTA matrix 38 of 38; the no-hands suite 47 of
  50, and the 3 that failed (two scanner torch steps: the camera didn't open once; one WebView step after them) passed on an
  immediate rerun. Cause not known.

### 2026-11-02: P.3 done, an app outside this repo with its own UPI plugin (Claude)
- **Changed plan (Pavan):** UPI belongs to the app, so `@zero-native/upi` is gone. The plugin and host live in the app's private
  repo, which makes this the first real test of an app outside this repo (second-opinions entries 16, 17; guide §34).
- **Framework:** `tools/zn-build.ts` (moved out of the sample's `build.ts`; same bundle hash). The outside host built with no runtime
  change, through a composite build.
- **Fixed three bugs in P.2's result reading** (`ZnLaunch.extrasOf`, `Rules.extras`), all on the return from paying: one bad extra lost all
  of them; a NaN double could crash on the main thread; a long lost digits, and other types were dropped. Now as RN: each read alone, the
  rest as text.
- **On the Lava, mock only, debug and R8 release with names changed:** real app list with icons; approve, decline, cancel and back parse
  right; `result` after a kill, `lost` after a swipe, and in debug `lost` after a kill under the see-through window (needs `run-as`); a retry after
  clear; refused: bad link, no package, missing app, second launch; a link while the mock is on top. 0 crashes.
- **No native pump needed:** a JS-driven screen drew 28 frames in 926 ms behind the see-through window (release), against 33 per second
  with nothing on top. It's set by the test's 33 ms timer.
- Release cold start of the one-screen outside app: 169 ms median (p90 183, n=10).
- A real payment, real UPI apps' answers and other phones wait for the pilot. Next: `auth` (P.3b).

### 2026-11-02: P.2 done, the plumbing every plugin needs (Claude)
- Built: `ZnActivity`, `ZnLaunch` + `launches`, `Permissions`, `Os`, `detached`, activity events for plugins, `zn://app-icon`,
  the link guard for the link that starts the app. `Device` is v4. Guide §31–33; second-opinions entries 11 to 15.
- **Found:** the mock UPI app's first window is see-through for 1.8 s, as real UPI apps' are. If the process dies then, Android
  drops our Activity and the result is gone; the next open reads `lost` (entry 15).
- **Host change:** every app adds `ZnActivity.attach(this)` in `onCreate`. Bundles built from here need an APK with P.2.
- Phone matrix 38 of 38 on the Lava (debug, mock UPI app only). Release (R8) with a temporary test gate off: mock result alive and
  after a kill, all permission flows, 0 crashes. Release cold start 182–187 ms median in three rows (n=10 each), same as
  before P.2 within noise. `/dev/storage` 9 of 9 in debug, so the "Kotlin thread and JS write" row stays under the limit.
- A late result winning over `lost` has a Kotlin test only. Real UPI apps and other phones come with P.3.
- Next: P.3.

### 2026-11-02: P.1 done, the plugin base (Claude)
- `ZnPlugin`, `ZnPluginRegistry`, `ZnPlugins.register` and typed arg helpers in the runtime. The sample's `Device` module
  now lives in the test plugin `plugins/device-test`. Guide: `docs/guide-notes.md` §30.
- A failed plugin stops a debug build and is skipped in release (`docs/second-opinions.md` entry 10); both tested on the
  Lava, the release one with a plugin that fails after adding its module. Found in that test: R8 renamed the plugin in the
  log, fixed with a keep rule in `consumer-rules.pro`.
- `invalid_args` checked on the phone. OTA matrix 28 of 28; an earlier full run was 27: `check-stall` missed a line on screen
  though the log shows JS updated it. It passed when run again, so it looks like the script's screen read.
- Release cold start 183 ms median (p90 192, n=10), on the APK's bundle. Next: P.2.
- The "Kotlin thread and JS write" row on `/dev/storage` went over the 3 s JS limit in debug builds on the Lava. Fixed in P.2:
  the loop gives way every 2,000 rounds.

### 2026-11-02: hardening done, H.1 to H.7 (Claude)
- Full OTA matrix 28 of 28 on the Lava (debug). Release cold start 180 ms median. Next: P.1 (`docs/plugins.md` §9).

### 2026-11-02: H.7 done, app state reaches JS (Claude)
- `onAppState()` and `appState()`, new app event 11, host API 5. They follow resume and pause, so a see-through
  payment window counts (`docs/second-opinions.md` entry 9). Tested on the Lava (`docs/hardening-plan.md` H.7).

### 2026-11-02: H.6 done, swipe and reopen applies a waiting update (Claude)
- On a phone that keeps the process alive, a swipe from recents now runs a waiting update, as a process death would. A
  bundle that throws at start falls back to the one that ran. A cover hides the old screens. New matrix cases
  `swipe-update` and `swipe-bad-update` (`docs/hardening-plan.md` H.6).

### 2026-11-02: H.5 done, a frozen JS task is not a hang (Claude)
- The time limit no longer counts time when the process was stopped. A 1.5 s task frozen for 6 s was reported as a hang
  before the fix and isn't now; an endless loop inside `try / catch` is still stopped (`docs/hardening-plan.md` H.5).
- The storage comment now says a damaged store opens empty.

### 2026-11-02: H.4 done, unusable bundles and private data in errors (Claude)
- A bundle that fails its checks at a start now falls back to the last good bundle, or else the APK's, and is reported
  once as `bundle_unusable` (`docs/second-opinions.md` entry 6).
- JS error text is masked before it is stored or sent: digit runs, `a@b`, URL query strings, bearer tokens. An app can
  add `ZnOta.Config.redact` (entry 4). Tested by hand on the Lava (`docs/hardening-plan.md` H.4).

### 2026-11-02: H.3 done, crashes are counted over 24 h (Claude; design with Fable)
- Every foreground visit is watched, healthy or not. Deaths stay counted for 24 h: 1 sure crash, 2 unsure deaths, or 3
  for the last good bundle block a bundle. A crash on return from a UPI app now counts (F4 option D).
- A blocked bundle can't become last good (F6). Two failed starts of the last good bundle in 24 h block it (F9). A crash
  mark file makes Kotlin crashes "sure" below Android 11.
- New matrix case `crash-on-return` passes on the Lava (`docs/hardening-plan.md` H.3).

### 2026-11-02: H.2 done, OTA calls have time limits (Claude)
- The check has 30 s for the whole call, and its answer is capped while reading. The download fails after 60 s with no
  bytes and resumes at the next check. Before, a server that never answered blocked the OTA thread for good.
- Two new matrix cases, `check-stall` and `download-stall`, pass on the Lava (`docs/hardening-plan.md` H.2).

### 2026-11-02: H.1 done, a second Activity never restarts JS (Claude)
- `ZnNav.handleExtraActivity` forwards a link from a second Activity and closes it. The sample is `singleTop`, so our
  icon no longer closes a UPI app above us. `startApp(routes, { onLink })` lets an app refuse a link. Query values reach
  the route as params; the log prints their names only, never values.
- Test kit: a Crash lab button opens the mock UPI app (debug only, Device module version 3); the mock can send a link.
- 8 phone cases pass on the Lava (`docs/hardening-plan.md` H.1). Not tested: `onLink` on the phone, other ROMs, a
  release build. The full matrix runs after H.7.

### 2026-11-02: reviews done, plugin decisions taken, plan written (Claude; reviews by Argon and Fable 5.1)
- Argon and Fable reviewed the architecture. Fable read the code and found real gaps: OTA calls with no time limit (F1),
  no app-state event (F3), crashes after healthy never counted (F4), and a second Activity that could restart JS during
  a payment (F11). Report: `docs/cross-communication/2026-11-02-fable-review-response.md`.
- Plugin decisions D1–D7 taken (`docs/plugins.md` §8). Pilot scope set: login, scan, UPI transaction, with failure
  paths (details in the app's private repo). `zn://` will be ported from the exp4 prototype. Crash count: `docs/second-opinions.md`
  entry 1.
- Next: `docs/hardening-plan.md`, waiting for Pavan's go. No code changed in this entry.

### 2026-10-31: docs brought up to date for an outside review (Claude)
- Checked every main doc against the code. Fixed: `ARCHITECTURE.md` ("Where things stand", "As built" notes, §24 /
  §25 / glossary), `docs/ota.md` (status, where bundles load from, swipe-from-recents note), `docs/native-modules.md`
  (built-in modules never built, moved to `plugins.md`), `docs/startup-and-performance.md` (milestone 4 numbers),
  this file (2.6b / 2.8 moved, 2.9, 3.9 status, later milestones), `docs/after-foundations.md` (stale rows, pointer
  to `plugins.md`), both READMEs, a history note on `story.md`.
- Review brief for Gemini 4 Argon: `docs/cross-communication/2026-10-31-argon-review-brief.md`.

### 2026-10-31: a swipe from recents now starts the app fresh (Claude, Pavan approved option (a))
- **Found by Pavan:** swiping the sample away and reopening it showed the amount screen again. RN and Flutter apps on
  the same Lava open on their home screen. Cause: the Lava keeps the process alive after the task is removed, and
  `ZnNav` keeps the stack per process (on purpose, for rotation), so the new Activity showed the old stack.
- **Fix:** `ZnNav.start` from `onCreate` with no saved state while screens are already up → `startFresh`: a new JS
  runtime (the same steps as an update applied in place, same bundle; storage / FlowStore untouched) and the start
  screen. Links while running: new `ZnNav.openLink(link)` for `onNewIntent` (app code: one line changed; guide notes
  §26).
- **Verified on the Lava (debug):** typed 2450, task removed like a swipe (`am stack remove`), same pid → opens on
  home ("starting fresh"); a deep link while running → amount on top, no restart; rotation with 2450 typed → same
  screen and value; Home + background kill → restored with 2450.
- **Known limit:** an OTA bundle downloaded meanwhile still waits for a real process start (the fresh start keeps
  the running bundle). Possible follow-up: apply a waiting update at this moment, since the user sees a fresh start
  anyway.

### 2026-10-31: `restorableSignal` done (Claude): screen values that survive Android killing the app
- **What it gives** (guide notes §26.1): `restorableSignal("amount", "0")` works like `signal`; when Android kills
  the app in the background and the user comes back, the screen opens again (step 3.9) **with that value**. Sample:
  the keypad amount (`AmountScreen.tsx`).
- **How:** JS sends each change as NAV RESTORE (kind 9, `{"key","value"}`); `ZnNav` keeps values per entry, saves
  them with the stack (`zn.nav.stack` entries get `"values"`, plus `zn.nav.bundle` = the running `id@sha12`), and
  hands them back in START's `values`. Works anywhere inside a screen (it finds its screen through the owner chain,
  so also in parts shown later); a key twice on one screen throws.
- **Limits chosen:** JSON values only, ≤4,000 chars each (else not kept, one warning, and the older value is
  forgotten); if the whole stack with values passes 50,000 chars, the screens are saved without values; values come
  back only into the same bundle that saved them, not after an OTA update in between, a dev reload or an update
  applied in place (second-opinions entry 7). The home screen alone is now saved too when it has values.
- **Host API 4** (C++ `NavKind::Restore`, `kHostApiVersion`, `HOST_API_VERSION`): every bundle built from now on
  needs an app with host API 4; older bundles still run on this app (`kHostApiOldest` stays 1).
- **Tests:** C++ core 148 (the "unknown NAV kind" check now uses 10); JS 4 new (first value + changes, START values
  used once, a part shown later, errors, too big /
  not JSON); Kotlin `ZnNavSavedTest` 4 (round trip, without values, a stack saved before host API 4, broken JSON).
- **Verified on the Lava (debug):** amount screen, typed 2450, Home, killed in the background (SIGKILL as the
  low-memory killer does; `am kill` doesn't kill it on this ROM), reopened from the launcher → "Android restored
  the app; reopening 2 screen(s): home, amount" and ₹2,450 (the cashback line recomputed from it). A fresh launch
  after a force stop → ₹0.
- **Not verified on the phone:** values dropped when another bundle runs (needs an OTA install between the kill and
  the return; the check is one comparison, and the log line says so); a value too big for the saved state.

### 2026-10-31: step 4.9 done (Claude): OTA phone test matrix, low storage, docs
- **Phone matrix:** `bun run ota:phone` (`tools/ota/phone-matrix.ts`) runs 22 OTA cases on a real phone in ~15 min:
  installs the debug sample fresh, releases test bundles into its own store (`.zn-ota-test/`), and breaks things on
  purpose through a fault proxy (changed zip byte, wrong signatures, replayed answer, cut / slow download, server
  down, app killed mid-download, half-installed files, full phone, start without UI, newer APK). It puts the phone's
  settings and the sample's sources back. **22 of 22 on the Lava**; table and the cases not scripted (with why):
  `docs/ota-test-matrix.md`. Decisions (Pavan, 2026-10-31): D1 (a) a debug-only setprop fakes low space, D2 (a) a
  debug-only way to start the process without UI, D3 (a) a re-runnable script now.
- **Low storage (new):** `ZnOta.checkSpace` before a download (rest of the zip + 4× zip + 50 MB for the user), outcome
  `no_space`; a full disk mid-download removes the half-written files at once. `ZnOta.freeSpaceOverride` (the sample
  sets it from `debug.zn.ota_free_bytes` in debug builds only). Numbers: second-opinions entry 5.
- **Debug-only sample parts:** `DebugWakeProvider` (`adb shell content query --uri
  content://dev.zeronative.sample.debugwake/start`, shell only). A provider, because the Lava's ROM won't start a
  stopped app's process for a manifest broadcast receiver.
- **CLI:** `--store <dir>` on every store command (the matrix uses its own store).
- **Found by the matrix:** (1) the Lava's "app has stopped" dialog keeps a crashed process alive until closed; a force
  stop while it shows is recorded as a force stop and the watchdog misses that crash (second-opinions entry 1, not
  changed). (2) A downloaded bundle that can't run falls back to the APK's bundle, not the last good one, until the
  channel moves (second-opinions entry 6, not changed). No runtime bugs found.
- **Guide notes:** saved data across updates and rollbacks (add-only formats), when the phone is full, the "needs a
  store release" list in §23.
- **Not verified:** a release (R8) build in the matrix (it needs debug helpers; 4.8 ran the main paths in release),
  Android < 11, a real network (airplane mode can't affect `adb reverse`), kills timed inside apply.

### 2026-10-31: step 4.8 done (Claude): crash traces and telemetry
- **What it gives** (docs/ota.md §3.7): every report names the bundle as `<id>@<sha12>`; each released bundle's
  source map is kept in the store by SHA (`ota build`, and `ota keep-map` for the APK's own bundle at APK release);
  `bun run ota symbolicate` turns a release trace (logcat, `onJsError`, Crashlytics, or `--from-telemetry`) into TSX
  lines. Decisions D1–D4 (2026-10-31): keep-map (a), stacks for error_screen / error_rollback to the server plus the
  Crashlytics form (a), other JS errors stay the app's (a), the watchdog blocks after 1 sure crash (yes).
- **Phone side:** `ZnJsError.bundleLabel` + `asThrowable()` (`ZnJsException`, JS frames as Java frames);
  `ZnBundles.watchRunning { }` (for a Crashlytics custom key); `error_screen`, `error_rollback`, `apply_failed`
  outcomes carry `stack` (top 8 frames, ≤1 KB) and `sha`; `ZnOtaReport.stack`. Sample logs all of it.
- **Watchdog change:** one launch Android's record says crashed blocks a bundle never healthy on this phone; 2 in a row
  are still needed on Android < 11, with no exit record, for an ANR, and for the phone's **last good** bundle. That
  last part is my addition to D4: the healthy mark is per process, so a bundle proven for weeks is watched for 4 s
  on every launch, and one native-SDK crash there shouldn't cost the user the update until the next APK.
- **Bugs found and fixed:** (1) the bundle bytes depended on the working folder (Bun's `// path` module comments, and
  hermesc's baked-in input path): `ota keep-map` (app folder) gave another SHA than `bun run sample:js` (repo root),
  so the kept map wouldn't have matched the APK. Both fixed; every bundle's SHA changed once. (2) In release, R8
  merged `ZnJsException` into coil's `HttpException` (logs said `coil3.network.HttpException: JS error ...`): runtime
  R8 rule keeps it. (3) Crashlytics-style frames (no column) mapped one line early (Bun maps a line's leading spaces
  to the line before): now the line most points map to. (4) `ota symbolicate` with a paste or a pipe ended at once
  with no output: a waiting stdin read doesn't keep Bun 1.4 running, and the CLI didn't await `main()`. Now it does.
- **Judgment calls for a second opinion** (watchdog limits, ANR, the per-process healthy mark, error text in
  telemetry): `docs/second-opinions.md`.
- **Last good bundle, errors only reported** (Pavan chose option (a) of second-opinions entry 3): an error screen, a
  hang or no first screen on the phone's last good bundle no longer blocks it forever; it is reported
  (`error_screen`). `Rules.errorsRollBack` + unit test (Kotlin 72). Lava (debug): healthy on launch 1, home throws on
  launch 2 → reported only, launch 3 runs it normally; the stack maps to `HomeScreen.tsx:26` via `--from-telemetry`.
- **Tests:** JS 202 (source map compose / round trip / same bytes, build bytes don't depend on the folder,
  symbolicate 5, keep-map / findMap, hermesc same bytes in two folders); Kotlin 71 (`ZnJsErrorTest` 3,
  `ZnOtaHealthTest` 15: sure crash, sure after unsure, last good keeps 2, stack round trip); lint clean.
- **Verified on the Lava:** release: tap-handler and async errors in the APK's bundle → `symbolicate` from logcat gives
  `CrashLabScreen.tsx:78` / `:82` with and without columns; a bundle whose home screen throws → rolled back,
  `--from-telemetry` → `HomeScreen.tsx:24`; `watchRunning` logs the label at start and after the rollback; cold start
  median 195 ms (n=10, as before). Debug: a never-healthy bundle crashing once (`Device.crash`) → `launch_crashed
  (1 of 1)` + `watchdog_block` at the next start; force stop still not counted.
- **Not verified:** a real Crashlytics project (no Firebase in the sample; the Throwable and custom key are logged
  instead), the last-good 2-crash path on the phone (unit-tested), Android < 11, `apply_failed` stack on the phone
  (same code as error_rollback). Next: **4.9** phone test matrix, docs, guide notes.

### 2026-10-31: step 4.7 done (Claude): OTA safety nets
- **What a downloaded bundle goes through** (docs/ota.md §3.6, `ZnOtaHealth.kt` + `ZnOta.kt`): on trial until
  *healthy* (screens up 4 s in the foreground, or `Updates.markHealthy()`); during the trial an error screen, a hang
  or no first screen in 10 s → blocked ("error") and rolled back **in place** to the last healthy bundle (or the
  APK's); 2 launches in a row ended by a crash / native crash / ANR (Android's exit record of that process) → blocked
  ("watchdog"); a blocked bundle never runs or downloads again (a newer pointer to it → `NONE BLOCKED`); a new APK
  install resets the counts and clears watchdog blocks; the startup guard runs the APK's bundle if choosing fails,
  and turns OTA off until the next APK after 2 failures in a row.
- **"Screens up" is a new NAV op, STARTED (8)**, sent by JS `start()` after the first screens are built: host API 3.
  Bundles built for host API 2 use "the JS thread handled START" instead. The 4.6 cover now lifts on it too (the
  first batch was a weak signal: a screen with nothing dynamic sends none).
- **Reporting:** every outcome reaches the server with the next check and `ZnOta.Config.onReport` at once
  (`ZnOtaReport`: kind, bundle, detail, serious). `bun run ota status` now sums 7 days of telemetry per bundle.
  `Updates` module v3 (`markHealthy`; status: healthy, lastGood, blocked, otaOff). Sample: `Device.crash()` (v2,
  debug only) and the Updates screen shows healthy / last good / blocked.
- **Bug found on the phone and fixed:** the watchdog first matched the exit record by time with 1 s of slack, so a
  launch right after a force stop was judged by the *previous* process's record ("force stop, not counted"). Now the
  pending launch saves its pid and only that process's record counts.
- **Tests:** Kotlin `ZnOtaHealthTest` 12 (watchdog counting, ignored exits, pid, healthy, blocks, APK change, fuse,
  limits, file round trip); JS nav STARTED + `markHealthy`; telemetry summary; 188 JS tests in all; lint clean.
- **Verified on the Lava** (debug, `ota serve` over `adb reverse`): an old host-API-2 bundle → healthy via the
  fallback signal; throws at cold start → blocked, back to #1 in place in the same launch (swap 12 ms), no error
  screen (debug shows the dev error box); home screen throws → same (14 ms); `applyNow` to a bundle that throws → old
  one back, new one blocked; crash 1.5 s after the home screen → counted twice → blocked, next start on #1; Home after
  1 s and force stop on screen, twice each → nothing counted; never calls `startApp` → rolled back after 10 s; error
  screen on a healthy bundle → only `error_screen`; a newer pointer to a blocked bundle → `NONE BLOCKED`, nothing
  downloaded; `adb install -r` of the same build → `apk_changed`, watchdog block cleared, error blocks kept.
- **Release (R8) on the Lava:** cold start median 192–196 ms (p90 207 ms, n=10, speed-profile), same as 4.5's
  196 ms; start checks 0.9–3.2 ms off the main thread; launch mark 0.5–0.8 ms on the main thread (no fsync);
  `applyNow` 30 ms; healthy 4 s after the screens; status shows the blocks.
- **Not verified on the phone:** the startup fuse (needs choosing the bundle to throw; rules unit-tested), a rollback
  while updates are held (then the good bundle runs from the next start), Android < 11 (every death while pending
  counts), ANR and native-crash exits (same code path as a crash).

### 2026-10-31: step 4.6 done (Claude): apply an update while the app runs
- **`Updates.applyNow()`** (`ZnOta.applyNow`): runs the bundle installed for the next start now, without a new
  process. The bundle is checked like at a cold start and its templates read on the client's thread while the old
  screens run; then a cover in the top screen's colour goes up, the process switches files (`ZnBundles.candidate` /
  `switchTo`; `running` can now change), the JS runtime is replaced (`ZnRuntime.restart`, the release-safe form of
  the `zn dev` reload), and the open screens open again by route and params. Storage, SecureStore, FlowStore untouched;
  native calls, timers and events of the old JS dropped; back presses wait. If the new code throws while starting,
  the old bundle runs again the same way and stays current (outcome `apply_failed`, `status().lastError`).
- **`Updates.holdApply()`** returns a release function; it is a native call that is never answered, so closing the
  screen that asked cancels it by itself. While any is open, `applyNow` answers `held`. Module `Updates` v2.
- **Fixed in the server's decision (from 4.4): row 11 `ALREADY_DONE`.** A phone that already acted on the channel's
  pointer (same seq) but runs something else (an install waiting for the next start, a kill switch taken but not
  restarted, a failed apply) got USE_LOCAL / BUILT_IN / UPDATE without a pointer, which the phone must refuse: every
  check ended as an error. Now NONE `ALREADY_DONE`.
- **Tests:** JS updates 3 (hold released once, hold ends with its screen, applyNow refusal); decide row 11; 187 JS
  tests in all (31 of them for the OTA tools); Kotlin unit tests and lint pass.
- **Verified on the Lava** (debug build, `ota serve` over `adb reverse`): #1 installed, "Hold updates" → Apply =
  `held`; released → applied in 46 ms (JS 26 ms), Home + Updates reopened, home title from #1, native calls answer
  on the new JS; #2 built to throw at start → applied, threw, #1 ran again in 203 ms with both screens, `current` back
  to #1, `apply_failed` sent; cold start then runs #1 and the check answers `NONE ALREADY_DONE`; a hold on a screen
  that then closed no longer holds; #3 applied in 62 ms; kill switch applied live to the APK's own bundle in 32 ms;
  Apply with nothing waiting = `nothing`; the server got every outcome. Phone OTA state, store and port forward
  removed afterwards.
- **Release (R8) build on the Lava:** hold → `held`; applied in 37 ms (JS 27 ms); #2 that throws → #1 again in
  49 ms, no error screen, the restarted screen shows `status().lastError`; cold start then runs #1, check
  `NONE ALREADY_DONE`. **Cover checked frame by frame** (screen recording, every frame): old screen → plain cover in
  the screen's colour for ~100–170 ms → the new screens fade in over ~180 ms, already laid out; no flash, nothing
  jumps (also on the fallback path). The whole change takes about a third of a second to the eye.
- **Not yet:** a bundle that throws at a **cold** start still shows the error screen,
  and a bad bundle can come back with a newer pointer; both are 4.7 (error-before-healthy rollback, bad-bundle list).

### 2026-10-30: step 4.5 done (Claude): the phone's update client
- **`ZnOta.kt`**: configure (server, channel, main + backup keys), checks ~3 s after the UI comes on screen and on
  returns (at most every 5 min; never for starts without UI), one at a time; the phone's own rules (`docs/ota.md`
  §3.5: signed pointer with a higher seq for every change, seq saved only when the action is done, NONE still
  corrects `current`); resumable download; kept bundles (4 + running + current); outcomes for telemetry.
  **`ZnOtaInstall.kt`**: manifest / pointer verification and the safe unzip (info first, listed files only, size
  caps, per-file SHA, bundle SHA, needs), atomic `current`. JS: `Updates.status() / check() / onStatus()`
  (`packages/core/src/updates.ts`, built-in module `Updates`); sample dev screen `/dev/updates`.
- **Bug found and fixed (from step 3.9): native call answers were dropped.** Step 3.9 gave the new RETRY app event
  number 7, already the native-call answer event; `startApp` registered later and took over, so every native call
  answered after the app started never settled (`fetch`, SecureStore, `Device`, ...). The Crash lab made no native
  calls, so 3.9's phone runs missed it. Fix: RETRY = 10; every app event number now lives in one list per side
  (`packages/core/src/app-events.ts`, `ZnAppEvent.kt`), a test checks they are unique and equal, a test makes a
  native call after `startApp`, and registering a second handler for an app event now logs an error.
- **Also fixed while reviewing:** an installed update waiting for the next start would still have started after a
  kill switch or a rollback (the server only sees what runs now); `java.time` (API 26+) replaced for minSdk 24.
- **Sample:** `ZnOta.configure` to `http://127.0.0.1:8790` (staging) with the sample's key, made by `bun run ota
  keygen` (private key in `~/.zero-native/keys/sample-main.pem`, public key in `SampleApp.kt` and `zn-ota.json`).
- **Tests:** Kotlin 11 for the installer (good install, tampered manifest, changed / oversized / missing files, wrong
  bundle or needs, `../` paths refused before any write, bundle SHA equal to the CLI's, pointer signatures, atomic
  writes); JS app-events 3; JS 183 total; lint 0 errors.
- **Verified on the Lava** (`ota serve` over `adb reverse`, bundles with visible titles): first launch downloads
  and installs #1 (check 188 ms), the next start runs it; a cut download (first 50,000 bytes left on the phone)
  resumes at 50000 of 133102 and #2 runs; rollback to kept #1 = USE_LOCAL, no download; kill switch from the
  Updates screen (`Updates.check()`), the restart runs the built-in bundle; an update waiting for the next start is
  cancelled by a kill switch; a zip with one byte changed is refused (`zip_sha`), nothing installed; the server
  received every outcome (downloaded, started, switched, zip_sha); a **release** build (R8) switches to kept #2 and
  runs it. Phone OTA state, store and test files removed afterwards.
- **Note:** the ZeroBill staging app came to the front during these runs; it was Gemini, working on the phone at the
  same time (Pavan). Launches here now use `am start` only (`adb shell monkey ... 1` also sends one random input).
- **Not yet:** applying while the app runs (4.6); not re-downloading a bundle that failed twice, the watchdog and
  error-before-healthy rollback (4.7); a bundle lists every built-in module the core *loads* (not only those it
  uses), so a future built-in module would make new bundles need a newer app even if unused: scan the final
  bundle instead of the loaded files (later).

### 2026-10-30: step 4.4 done (Claude): reference update server
- **Option B** (Pavan): Bun.serve over the local release store: zips as static files with Range, plus `POST
  /v1/check` running the decision on the server (`tools/ota/server.ts`, `bun run ota serve`). No private key on the
  server. Telemetry: one ndjson line per check with the phone's outcomes. GCS stays unused for now (test folder
  `gs://my-test-bucket/zn-ota` noted for later).
- **Decision** (`tools/ota/decide.ts`): one pure function, 10 rows in order (`docs/ota.md` §3.4), one test per row;
  stable rollout buckets (raising the rollout only adds installs); capability rule identical to `ZnCapabilities.kt`.
- **Tests:** decision 12, server 7 over HTTP (check → download → both signatures verify with the public key; a cut
  download resumed with Range gives the same SHA; 416 past the end; UP_TO_DATE, rollback to a kept bundle =
  USE_LOCAL, kill switch, stale seq, incompatible app; bad shapes 400, too big 413, paths outside released zips 404;
  telemetry lines). JS 180 total.
- **Real run** with the sample (throwaway key): `ota build` → #1 (130,709-byte zip), `publish` staging, `ota serve`;
  curl: UPDATE, a two-part Range download with the manifest's SHA, both signatures valid, the zip holds the bundle
  laid out for the loader; after applying UP_TO_DATE; an app without Toast INCOMPATIBLE. **From the Lava** (the app's
  own `fetch` over `adb reverse`, temporary code): check 200 UPDATE, zip 130,709 bytes, Range part `206 bytes
  50000-130708/130709`, the resumed copy identical to the whole file; the server logged the phone's check and
  outcome. Store, telemetry, key and test code removed afterwards. (The phone shell's toybox `nc` can't use adb's
  forward, so the phone side went through the app.)

### 2026-10-30: step 4.3 done (Claude): signing and the release CLI
- **Signing** (`tools/ota/signing.ts`, phone: `ZnOtaSignature.kt`): ECDSA P-256, DER signatures, base64 SPKI keys;
  bundle and pointer texts as in `docs/ota.md` §3.3 (the app is now in the pointer text; serial, requires line, zip
  SHA and size in the bundle text). Cross-checked: the JVM test verifies signatures the CLI made
  (`ota-signature-fixture.json`, a throwaway key; no private key stored) and refuses a changed seq or channel,
  another key and bad input.
- **Store** (`tools/ota/store.ts`): create-once files (bundles, manifests, marks, one file per pointer change), so
  two releases can't take one serial or seq. Local folder adapter; GCS waits for a test bucket.
- **CLI** (`bun run ota ...`, rules in `tools/ota/core.ts`): keygen, build (same bytes reuse their serial; never
  publishes), publish (rollback = publish older), stable, rollout, kill, status, verify; the RN OTA v2 rules for
  production (stable on staging, built from a commit, explicit rollout, typed `PRODUCTION #N`) and the kill switch
  (typed `KILL <CHANNEL>`, reason on production); a lock for one action at a time. The sample's settings:
  `examples/sample/zn-ota.json` (store `.zn-ota-store/`, gitignored). `bundle-info.ts` gained `readBundleInfo` and
  `setBundleSerial`. New dev dependency: `fflate` 0.8.2 (zips; the RN release tool uses it too).
- **Tests:** 11 for the release rules (serial reuse, racing serial / seq, production rules, kill switch, rollback,
  verify finds a tampered zip / pointer), 4 Kotlin (cross-check, base64); JS 161 total; lint 0 errors.
- **Dry run** with the sample and a throwaway key: build #1 (128 KB zip), build again → same bytes, staging,
  production refused before `stable` and again for a build from uncommitted changes, kill switch refused with the
  wrong text and accepted with `KILL STAGING`, status, verify clean. Store and key deleted afterwards.
- Not yet: GCS adapter (needs a test bucket), source maps per bundle (4.8), deleting bundles (RN rule 10), a
  release page like RN's console.

### 2026-10-30: step 3.9 done (Claude): resilience
- **A screen that throws** stays on the stack; native draws `ZnErrorScreen` (NAV FAILED): Try again (native makes a
  fresh root, JS builds it again: RETRY) and Go back (the normal back path). Fixes the bug where Back then closed the
  screen underneath. **A failing part** (child component, `&&` block, list row) is caught where it mounts: what it
  started is stopped, what it sent is removed, the rest works. **JS that fails to start**: every screen shows the
  error screen with Restart app (a new process). Texts and colours: `ZnErrorScreen.texts / colors`.
- **Async errors**: Hermes' Promise rejection tracker is on; unhandled rejections are reported (kind async).
- **Time limit** per JS entry, in the C++ core: a watchdog thread calls Hermes' `asyncTriggerTimeout` when one
  entry runs too long; bytecode is built with `-emit-async-break-check`. `ZnRuntime.jsTimeLimitMs` (2 s release,
  3 s debug, lowered from 5 s / 30 s at Pavan's request; sample: `debug.zn.js_time_limit_ms`). A hang shows the error
  screen on the top screen. Every entry over 200 ms is logged as "slow JS" (what ran, how long).
- **Reporting**: `onError(handler)` in JS (kind screen / part / async / handler, where, screen) and
  `ZnRuntime.onJsError` in Kotlin (the same kinds plus hang / start / renderer, screen, **bundle id**) for crash
  reporting. The kind travels from JS through the C++ core (`__zn_error`'s optional third argument).
- **Bad data**: the template reader also checks each value's type against its prop (it caught Gemini's `value`
  holding booleans, which is intended: `value` is now an explicit exception on both sides); each batch op is wrapped
  (a bad one is reported as kind renderer and skipped); a mount that would put a node inside itself is refused.
- **Back stack after process death**: `ZnNav.saveState` / `ZnNav.start(..., savedInstanceState)` (two lines in the
  app's Activity); route option `restore: false`.
- **Intl**: `toLocaleString` and the three Date methods keep cached formatters (same text as the originals, tested).
- **Host API 2** (NAV FAILED, app event RETRY).
- **Tests:** JS 150 (nav 3, view 2, errors 2, intl 3 new); compiler routes; Kotlin tests; core 148 on the phone;
  Android lint 0 errors.
- **Verified on the Lava (debug), sample "Crash lab" screen (`zn://sample/dev/crash`):** screen that throws → error
  screen, Try again builds it, Go back and system back return to the screen under it; tap, async and part errors
  reported to `onError` and `onJsError` (with screen and bundle `sample_0`); an endless loop stopped after the 3 s
  test limit, error screen "stopped responding", Try again rebuilds the screen; a node inside itself refused (kind
  renderer), app keeps running; JS that throws at start → "The app couldn't start" + Restart app → new process;
  killed in the background (`am kill`) and reopened from the launcher → home + crash lab back (the `restore: false`
  screen left out), Back works; a fresh launch after force-stop starts on Home. Intl: cached = fresh formatter 4/4.
- **Cost (release, speed-profile, n=10, two rounds):** break checks add 757 bytes of bytecode (0.2 %); cold start
  186 / 190 ms without vs 196 / 193 ms with: within the usual spread.
- Not done here: OTA rollback after errors (4.7, builds on this).

### 2026-10-30: step 4.2 done (Claude): capability manifest
- **Registry:** `BASE_VERSION = 8` (everything today) and an `Added` table for anything added or visibly changed
  later. `registry.lock.json` keeps the last accepted registry; the test and `bun run gen:registry` refuse removed,
  renumbered or retyped entries, new entries missing from `Added`, and a `since` that goes down.
- **Bundle side:** the template writer computes the lowest registry version the templates need (also in the
  `.zn.ui` header, which used to hold the compiler's own version, i.e. "one framework version"); the compiler reads
  native modules from `nativeModule` / `callNative` calls (string-literal names, build error otherwise); the build
  adds the bytecode format from the `.hbc` header and the host API of the bundled core. All in `requires` of
  `zn-bundle.json`. Sample: `{registry 8, bytecode 99, hostApi 1, modules Device, Fetch, Keyboard, SecureStore,
  Toast}`.
- **App side:** `ZnCapabilities.kt` (registry, Hermes format via the root API, host API range from
  `core/include/zn/engine.h`, registered modules). `ZnBundles` refuses a downloaded bundle the app can't cover and
  reads its templates while choosing it: `TemplateReader` now refuses unknown components, props, enum values, events
  and slots on props that can't change at runtime (the parsed file is kept, so templates are read once). Built-in
  modules are registered by `ZnModules` itself; apps register theirs **before** `preload` / `evalAsset` (a late
  registration throws in debug builds). The sample now registers `DeviceModule` first.
- **Tests:** template 5 new (lock rules, version per kind), compiler 5 (module scanning, requires), core 1 (JS and
  C++ host API equal), Kotlin 7 bundle + 1 reader (each refusal); JS 140 total; Android lint 0 errors.
- **Verified on the Lava (debug), bundles built from real source:** #1 runs from files; **#2 uses a `Scanner` module
  this app doesn't have → refused ("needs native module Scanner"), built-in runs** (the must-pass test of
  ARCHITECTURE §16.2); #3 whose `zn-bundle.json` claims it fits but whose templates use component 999 → refused by
  the id check. Release cold start (speed-profile, n=10): **OTA folder median 196 ms, built-in 195 ms**; choosing an
  OTA bundle takes ~10 ms on zn-io (templates read there instead of later). Test bundles removed afterwards.

### 2026-10-30: `Intl` crashed the app (fixed, Claude)
- Any `Intl` use (`toLocaleString("en-IN")`, `Intl.NumberFormat`, date formatting) aborted the app on the zn-js
  thread, debug and release: Hermes calls Java through fbjni for `Intl`, and fbjni was never set up (its
  `JNI_OnLoad` runs only for libraries loaded with `System.loadLibrary`; ours loaded it as a dependency of libzn),
  then fbjni's Java side needed `NativeLoader.init(SystemDelegate())`. Fixed in `ZnNative.kt` (both, before
  `zn`); `com.facebook.soloader:nativeloader:0.10.5` declared (already in the APK through fbjni, same version).
- **Verified on the Lava, debug and release:** `1,25,000.5`, `₹12,50,000.50`, `₹400` (no decimals), compact `12L`,
  `30 Oct 2026`, `2:35 pm`, time zone `Asia/Calcutta`. Cost: `toLocaleString("en-IN")` **~2 ms per call** (it
  builds a formatter each time); a reused `Intl.NumberFormat` **0.004 ms**. Guide note §25.
- **Startup cost of the fix: none measurable.** Release, speed-profile, n=10, built back to back: without the two
  lines median 209 ms / p90 220 ms; with them 211 ms / 216 ms. Loading the native libraries takes 5–9 ms without
  and 5–14 ms with, on the zn-js thread (not the main thread).

### 2026-10-30: steps 3.7 / 3.8 reviewed and fixed (Claude)
Gemini built them (step note in `docs/cross-communication/`). Review found and fixed:
- **Image fallback loop:** a fallback that loaded made the image go back to the broken `src`, forever. On the Lava,
  470 requests in 10 s for one broken URL. Now one way per `src` (src → fallback → empty box): 1 request. Gemini's
  test missed it because its "working" fallback URL was also a 404.
- **`maxFontScale` crash:** a nested `<Text>` span without its own `fontSize` threw (Compose can't scale an unset
  size) when the phone's font size was above the cap. Now unset sizes are left alone (`scaledSp`). Checked at font
  scale 1.3 with spans: no crash, capped text stays smaller (setting put back to 1.0).
- **Toast under a sheet:** a toast shown from an open `<Sheet>` was drawn behind the sheet's window. Now the newest
  window draws it (`ZnToast.openWindow`); timing moved out of composition so it keeps its time between windows.
- Smaller: TalkBack label set twice on a labelled image (now once, with the image role, one shared
  `accessibilitySemantics`); toast text vanished at the start of its fade-out; Shimmer ignored `highlightColor`;
  Switch / Checkbox ignored `rippleColor`; the Offers feed had no fallback (now a placeholder from
  `examples/sample/assets/images/`, shipped in the bundle); test screen text and broken demo URLs.
- **Known, left as is:** the `value` prop now takes a boolean / number / string on any component (needed for
  `<Switch value>` and `<Progress value>`), so a wrong static `value` on a TextField is no longer a build error.

### 2026-10-30: step 4.1 done (Claude): bundle format and loader
- `zn-bundle.json` (`tools/bundle-info.ts`): app, serial, id `<app>_<serial>`, one SHA-256 for the bundle, every file
  with size and SHA-256. The sample build writes it into the APK's assets (`--serial N`, `--out DIR` options) and
  copies the app's images from `examples/sample/assets/` into the bundle.
- `ZnBundles.kt`: the one place that decides where bytecode, templates, manifest and `asset:` images come from: the
  APK or `noBackupFilesDir/zn-ota/bundles/<id>/` (named by `zn-ota/current`). A downloaded bundle runs only if it is
  for this app, its format is known, its serial is bigger than the built-in one (a newer APK wins), it has every
  code file, and every file has its listed size. Anything else, or any error: the built-in bundle, reason logged.
  Chosen once per process off the main thread. Bytecode from a folder is memory-mapped (`evalFile`, no copy).
  Apps change nothing: `ZnTemplates.preload("main.zn.ui")` and `ZnRuntime.evalAsset("main.hbc")` read the
  running bundle.
- **Found and fixed: builds were not repeatable.** Template ids followed the order Bun happened to load files, and
  Bun adds a random `debugId` line, so every build of the same source had a new SHA (it would make "one SHA = one
  serial" and small patches impossible). Now ids are given by file path after all files are compiled (fixed-width
  placeholders, so source-map columns don't move) and the `debugId` line is dropped. Same source = same bytes
  (checked: 3 builds of the sample, identical; hermesc itself is repeatable).
- **Tests:** Kotlin `ZnBundlesTest` (11: each refusal rule, path escapes, parsing); compiler `build-app.test.ts`
  (3: id order by path, same bytes twice, source map after filling ids); JS 123 total; Android lint 0 errors.
- **Verified on the Lava:** bundle #1 copied by hand runs from the folder (new title and an image that exists only
  in the bundle, navigation works); refused with the right reason and the built-in bundle running: a cut
  `main.hbc`, `current` = `../bundles`, a missing folder, an APK whose built-in bundle is #2. Release cold start
  (speed-profile, n=10): **built-in median 179 ms, OTA folder 182 ms** (same within noise); choosing takes ~2 ms
  (60 ms only on the first start after install). Test bundle removed from the phone afterwards.
- **Not yet (later steps):** a bundle whose templates file is damaged but the right size crashes at start until the
  watchdog (4.7) exists; checksums and signatures are checked at install (4.3, 4.5), not at start.

### 2026-10-30: step 3.6 done (Claude): animation
- `animate`, `enter`, `exit` props (registry v7, ids 136–138), transforms can change at runtime (draw phase). Native:
  `ZnAnimation.kt` (`Animatable` per animated value, read in `graphicsLayer` / `drawBehind`); `ZnStore` keeps an
  exiting instance until its animation ends (`finishExit`); JS indexes skip exiting children (`liveIndex`).
- Author rules: `docs/guide-notes.md` §22; ARCHITECTURE §10.
- **Tests:** compiler 3 new (encoding, presets, errors), Kotlin `ZnAnimationTest`, JS 120 total.
- Sample `/dev/animation`: value animations (tween, spring, bouncy, colour, rotate), toast enter / exit, a swap in a
  Stack, list rows entering / leaving; a 6-second demo loop for frame measurements.
- **Verified on the Lava (release):** 6-second demo loop (card, colour + rotate, toast, swap, chips): **441 frames,
  1 janky (0.23 %), p50 5 ms, p90 7 ms, p99 15 ms**; fast taps while animating: 0 janky, p99 10–12 ms. Toast and
  swap enter and leave; 5 fast swaps leave exactly one button; chips added / removed fast (2 taps per 150 ms) all
  register, leave in order, none stuck after their exit (UI dump), no errors in logcat.
- **Found (layout, not animation):** (1) a full `Row` squeezes its last child (its text wrapped onto two lines) where
  React Native would let it overflow; (2) a leaving element keeps its space until its exit ends. Together they made
  a button below a chip row jump for ~200 ms, so fast taps at its old position missed (traced with temporary probes:
  the Scroll saw every press, the button only those where it was). Sample fixed (3 chips); both noted in
  `docs/after-foundations.md`. Also: `position: "absolute"` with `top/start/end/bottom: 0` doesn't stretch an element
  in a Stack.
- **Pavan:** the animation set should grow later (after the framework is complete): list in after-foundations.
- Press feedback added after review: `Pressable` ripples by default (our own ripple on `material-ripple`'s node, no
  Material theme; +6 KB APK), `rippleColor`, `pressScale` (spring), `pressFeedback` ("ripple" / "highlight" /
  "none"); registry ids 139–141. The keypad keys use ripple + `pressScale={0.94}`: checked on the Lava (screenshot
  mid-press: key scaled down, ripple filled).
- More press options after review (registry ids 142–146): `rippleOpacity`, `rippleBorderless`, `rippleRadius`,
  `pressOpacity`, `highlightColor` (our own highlight node). Checked on the Lava (`/dev/press`): borderless round
  ripple around an icon; highlight pixel = brand colour at 12 % over white; dimmed card = white at 50 % over the page.
- Sample: **Dev screens** list (route `/dev`, button on the home screen) with every test screen; add new dev screens
  there.

### 2026-10-30: step 3.5 done (Claude): `storage` (MMKV) and `SecureStore`
- Design, numbers and rules: `docs/storage.md`; author rules: `docs/guide-notes.md` §21.
- JS: `storage`, `createStorage(id)`, `persistedSignal(key, initial)`, `onChange`; `SecureStore.get / set / delete`.
- MMKV 2.4.3's C++ core vendored in `core/third_party/mmkv` (BSD-3) and built into `libzn.so`; `libzn.so` now hides
  everything but its JNI entry points (509 → 356 KB raw).
- Kotlin access added after review: `ZnStorage.store(context, id)` (same stores, same types, any thread). Checked on
  the Lava: JS ↔ Kotlin round trip with Hindi + emoji, types kept, wrong-type read throws (`/dev/storage` 8 / 8).
- Background work checked after review: a Kotlin thread (like a push handler) and JS each wrote 20,000 times at once,
  sharing one key: 0 torn values, counters exact (`/dev/storage` 9 / 9, 3 runs). `ZnStorage` throws and
  `ZnRuntime.start` does nothing outside the app's main process (`ZnProcess.kt`; not tested with a real second
  process: the sample has none).
- `storage.flush()` added after review (forces a store to flash, ~1 ms). The speed check now compares all 10,000
  values it reads back, and a value written on one open is checked exactly on the next (after a force-stop): passed
  three opens in a row.
- **Tests:** core 148 checks on the phone, including real MMKV and a 100-round kill test; JS 117 (8 new); lint 0
  errors.
- **Verified on the Lava (release):** `/dev/storage` 6 / 6: types round trip (Hindi, emoji, -0, bytes), wrong-type
  read throws, stores separate; **write 4.0–4.5 µs, read 1.2–1.3 µs** per call from JS; SecureStore set 19–65 ms, get
  9–18 ms; values kept across force-stop (visits counter 1 → 5 over kills). Cold start median 193 ms (n=10).
- **Found:** killed mid-write, MMKV damaged its file in ~6 % of rounds (writing nonstop); its "recover" mode returned
  value bytes as keys. We drop damaged stores instead (never a wrong value). Authors told: `storage` is for data the
  app can rebuild.
- **Size:** release APK 6.86 → 7.05 MB raw (+190 KB, MMKV + storage + SecureStore, after the symbol hiding).
- **Not checked:** SecureStore after an OS update or backup restore (the "unreadable → null" path is code-reviewed
  only), a real power cut.

### 2026-10-30: version upgrades (Claude, asked by Pavan): Hermes, OkHttp, Coil, Kotlin
| Library | Before | Now | Why it was safe / what it took |
|---|---|---|---|
| Hermes (`hermes-android`, npm `hermes-compiler`) | 250829098.0.17 | **260318099.0.5** | RN 0.88.1's Hermes. JSI headers and `libjsi.so` from `react-android:0.88.1` (only `decorator.h` changed). `-Xes6-block-scoping` still needed (still off by default). |
| OkHttp | 4.12.0 (through Coil) | **5.5.1** | Coil asks for 4.12; our declaration wins. `fastFallback(true)` now on. |
| Coil | 3.3.0 | **3.6.3** | Needs Kotlin stdlib 2.4 (why step 2.0b stopped at 3.3.0) and Compose foundation ≥ 1.12 (BOM has 1.12.1). |
| Kotlin compiler (Compose plugin) | 2.2.0 | **2.4.21** | Needed by Coil 3.6. No code changes. |
- `setFetchDefaults({ timeout, maxBodySize })` added (Pavan asked if the defaults can be changed app-wide).
- **Verified on the Lava (release):** `/dev/fetch` 27 / 27 after each upgrade (with OkHttp 5 the PUT in the
  pooled-connection test is sent 3 times, the POST still once); offers feed images load (Coil 3.6.3); amount keypad
  → ₹1,250 with the cashback lines; no JS errors on offers / modules / input / amount; cold start median **199 ms**
  (183–213, n=10), same as before. Kotlin tests, lint (0 errors), JS 109, `:baselineprofile` builds.
- **Size:** release APK 6.59 MB → 6.63 MB (Coil + OkHttp + Kotlin stdlib, +38 KB) → 6.86 MB (Hermes, +227 KB raw;
  `libhermesvm.so` deflated 1.03 → 1.13 MB, so about +100 KB download).
- **Not checked:** `zn dev` reload with the new `hermesc`, a network with broken IPv6.

### 2026-10-30: step 3.4 done (Claude): `fetch`
- Design and the problem list (RN / Flutter / OkHttp production bugs and what we do): `docs/fetch.md`. Author rules:
  `docs/guide-notes.md` §20.
- Globals: `fetch`, `Headers`, `Request`, `Response`, `FormData`, `TextEncoder` / `TextDecoder`; `AbortSignal.timeout /
  any / abort`, a small `DOMException`; `useAbortSignal()`; `FetchError` with codes.
- New bridge piece for every module: binary input (`callNative(..., { bytes })` → `call.bytes`) and binary answers
  (`call.resolveBytes` → one ArrayBuffer, app event 9). UTF-8 decode / encode in C++ (`core/src/utf8.cpp`).
- Native answers now carry the runtime generation; an answer for a runtime replaced by `zn dev` is dropped.
- Runtime manifest now declares `INTERNET` and `ACCESS_NETWORK_STATE`. OkHttp is a direct dependency (5.5.1 after
  the upgrade below).
- **Tests:** JS 108 (14 new for fetch), core 127 checks on the phone (UTF-8 rules, bytes in / out), Kotlin
  `ZnFetchTest` (error codes), lint 0 errors.
- **Verified on the Lava (debug and release):** `/dev/fetch` 27 / 27, including the pooled-connection test where
  OkHttp sent a PUT twice and our POST once. Numbers in `docs/fetch.md` §6.
- **Not checked:** Wi-Fi ↔ mobile switch, airplane mode, `content://` file upload, release cold start after this
  change (the client is built on the first fetch, not at start).
- Found on the way: a deep link's query values (`?a=1`) don't reach the screen's props (`→ fetch {}`); noted in
  `docs/after-foundations.md`.

### 2026-10-30: steps 3.2 and 3.3 done (Claude): children, fragments, spans, JSX types; TextField and the keyboard
- Registry v6: `Fragment` (15), `TextField` (16), prop `spans` (122), TextField props 123–135, events
  onChangeText / onSubmitEditing / onFocus / onBlur (11–14). Ids stay inside Claude's ranges (Gemini brief).
- Compiler: children of a user component and JSX props → functions that make a View, shown by `insert()`; fragments
  (as roots, in branches, and flattened inside elements); nested `<Text>` → spans; controlled TextField → `textInput()`.
- Runtime: `childRefs` expands Fragment roots into the parent; `ZnTextField.kt` (numbered changes, as RN);
  `ZnKeyboard` (`Keyboard.dismiss()`); route option `keyboard` (`imePadding`); a vertical `<Scroll>` now stretches its
  children like a Column (found on the phone: cards shrank to their content inside a Scroll).
- Types: JSX namespace in `@zero-native/ui`, `examples/sample/tsconfig.json`; `bun run test:types` also checks the
  sample.
- Sample: `/dev/input` (zn://sample/dev/input).
- Verified on the Lava (debug): fast typing into the formatted 7-digit amount gave "12,34,567" 3/3 (the first version
  lost a digit; fixed with numbered answers); phone field strips letters, 10 digits max; PIN masked, max 6; Done on the
  note fires onSubmitEditing and closes the keyboard; Hide keyboard (`Keyboard.dismiss()`) closes it; Pay stays above
  the keyboard; spans, children, JSX prop and fragment render as written. JS tests 94, compiler tests in them, type
  checks, Kotlin unit tests, lint 0 errors, release build OK.
- Verified by Pavan on the phone (2026-10-30): Hindi / Kannada typing, paste, emoji, fast typing in the amount field.
- Not checked: TalkBack on fields; text field in a Sheet.

### 2026-10-30: step 3.1 done (Claude): `zn dev` live reload + error screen
- `bun run dev` (`tools/zn-dev.ts`): watches `src/` and `packages/core|ui/src`, rebuilds, sends the build to the phone
  over TCP (`adb reverse tcp:8082`). The sample's `build.ts` now uses the same `buildApp` (`compiler/src/build-app.ts`).
- Phone (`ZnDev.kt`, debug only): new runtime, same back stack reopened, native calls cancelled, event sources
  stopped; error screen with Dismiss / Reload. JS errors caught by the runtime now go through `reportError` →
  `__zn_error` → `Platform::jsError` (logcat as before, plus the error screen in debug).
- Compiler: a small source map per `.tsx` (`compiler/src/sourcemap.ts`); the server maps stacks to `file.tsx:line:col`.
- Verified on the Lava (debug): edit on `/dev/modules` → title changed, still on that screen, native calls and ticks
  work; edit on the offers feed → reload in 17–18 ms; a throwing handler → error screen with
  `ModulesScreen.tsx:43`; JS tests 84, compiler tests 23, core tests 104; release APK has no `ZnDev` class; release
  cold start 197–235 ms (normal).

### 2026-10-29: step 2.7 done (Claude): FlowStore
- `core/src/flowstore.cpp`: one file per key, two copies (slots), each with a sequence number and a CRC-32. A write
  fills the older copy and bumps its number last, so a kill at any moment leaves the previous value or the new one,
  never half. Grows up to 256 KB by writing a temp file and renaming it.
- JS: `flowStore.write / read / list / remove` (framework internal; app code will use flows from step 2.8).
- Android: files in `noBackupFilesDir/zn` (not in cloud backup).
- Verified: core tests (104 checks) including 200 rounds of SIGKILL mid-write: 200 / 200 read a complete value.
  One 800-byte write: 4.5–6 µs. On the Lava (debug and release) the `/dev/modules` visit counter survived
  force-stops (1 → 4).

### 2026-10-29: step 2.6a done (Claude): native module foundations
- Pavan approved the module design (`docs/native-modules.md`) with: async only for now, cancellation yes, foundations
  only; libraries go to Gemini (`docs/cross-communication/2026-10-29-native-modules-brief.md`); `fetch` later.
- **JS:** `nativeModule<T>(name, { version })` (typed `Proxy` handle: methods + `on`), `callNative` with
  `{ signal }`, `NativeError { code }`, `onNativeEvent`, `AbortController` for Hermes (`abort.ts`), calls and
  listeners owned by the screen (dropped / ended when it closes), listener counts to native, `__v` version marker.
- **Native:** `__zn_cancel` → `Platform::cancelNative` → JNI → `ZnModules.cancel`; `ZnCall` (resolve / reject with
  code / isCancelled / onCancel), `ZnModuleBase` (function table, per-function thread), `emit(..., latestOnly)` with
  one queued delivery per event that reads the newest value (`ZnRuntime.dispatchLatest`), version check →
  `unavailable`.
- **Sample:** `DeviceModule` (Kotlin) + `device.ts` + `/dev/modules` screen.
- **Verified on the Lava** (debug + release): see `docs/native-modules.md` §1 "Proof". Tests: C++ 82, JS 82 + types,
  Kotlin 14, lint 0. A test of cancelling first looked broken: my tap helper took ~2 s per tap, so the 3 s call had
  finished before "Cancel"; with fast taps it cancels as designed.

### 2026-10-29: step 2.5 done (Claude): `<Sheet>` + the native-call transport
- **`<Sheet visible onDismiss detents dismissible onDetentChange>`** (component 14; props 119–121; events 9–10;
  `visible` is a slot). Native (`ZnSheet.kt`): a full-screen `Dialog` window (scrim over the status bar; back closes
  the sheet before the screen), spring open / close, drag with rubber-band above the top, fling and position decide
  close vs snap (35 % / 1200 px/s), detents `content` / `half` / `full`, nested scroll (an inner list scrolls first),
  content padded above the navigation bar, dark nav-bar buttons on a light sheet. **Controlled:** a user close sends
  `onDismiss` and animates down; if JS still says `visible` 400 ms later it springs back. Native never writes
  `visible`. Children are drawn with the Column rules (`ZnColumn`, extracted from the renderer).
- **Native-call transport** (start of step 2.6, see `docs/native-modules.md`): `callNative()` (`calls.ts`) →
  `__zn_call` → `Platform::callNative` → JNI (args as UTF-8 bytes) → `ZnModules` (I/O pool or main) → app event 7.
  `os.upiApps()` was written and then **parked** on Pavan's call: the module system (typed declarations, events,
  codegen) is designed first.
- **Sample:** "Pay Now" on Amount opens "Pay ₹X with" listing 5 UPI apps (static, from v0's checkout); picking one
  closes the sheet and opens the receipt "Paid with <app>".
- **Bugs found on the phone and fixed:** the last row was cut off (the dialog window learns its navigation-bar inset
  after the first layout; the height is now recomputed every composition); white nav-bar buttons on the white sheet.
- **Verified on the Lava** (debug + release): open; close by scrim tap, back (Amount stays), drag down; a small drag
  springs back; pick an app → receipt; dark-mode recreation with the sheet open keeps it open; release run, no R8
  issues. Tests: C++ 81, JS 79 + types, Kotlin 14, lint 0.
- **Not verified on the phone:** "JS keeps it open" spring-back (the sample always closes), `half` / `full` detents and
  dragging between them, a scrolling list inside a sheet (designed and coded, no sample uses them yet).

### 2026-10-29: steps 2.4c and 2.4d done (Claude): Carousel and impressions
- **`<Carousel>`** (component 13; props `itemWidth`, `autoAdvance`, `pauseAfterTouch`, `dots`, `dotColor`,
  `activeDotColor`; event `onPageChange` 8): Compose `HorizontalPager` with fixed page width (next page peeks),
  content padding, dots. Auto-advance is a coroutine that runs only while the carousel is composed and the app is
  resumed (`repeatOnLifecycle(RESUMED)`), and skips ticks within `pauseAfterTouch` of a touch. `onPageChange` only
  if bound. Sample: the offers banner rail is now a carousel.
- **Impressions** (`impressionKey` prop 118, dynamic; NAV kind 6 IMPRESSIONS; app event 6): `useImpressions(handler,
  { threshold = 0.35, minMs = 0, once: "screen" | "session" })`. Native (`ZnImpressions.kt`): nodes with a key report
  their visible fraction from `onGloballyPositioned` + `boundsInWindow` (clipped by lists and rails); counted when ≥
  threshold (for minMs), only on the top screen while resumed, once per screen visit; batches every 500 ms and on
  pause / screen leaving. Counted keys skip measuring afterwards. Session dedupe in JS.
- **`tools/measure-frames.ps1`:** the same flings + `gfxinfo` for any app, for fair comparisons (2.4e).
- **Verified on the Lava:** carousel advances ~every 4.5 s on screen; 0 page changes in 10 s off screen and in
  10 s in the background; a manual swipe pauses it ≥ 3 s. Impressions: first screen 3, rail swipe +2, scroll +3 / +4,
  scroll back 0, background 0, new visit counts again. Release flings with both on: p50 6–7 ms, p95 11–13 ms,
  p99 14–17 ms, 0–2 janky of ~420 (4 runs). Tests: C++ 79, JS 77 + types, compiler 19, Kotlin 14, lint 0.
- **Known limits:** a node with `impressionKey` on a screen's **root template** of a cold-start screen isn't tracked
  (the screen draws before JS turns impressions on); rows, rails and carousels are fine. Carousel pages snap to the
  start edge (RN's banner centres them).
- **2.4e (benchmark vs the RN Offers tab):** waiting for Pavan to run `tools/measure-frames.ps1` on the RN app.

### 2026-10-29: step 2.4b done (Claude): rails and gradients
- **`Scroll`** (registry v5, component 12, prop `horizontal`): horizontal = `LazyRow` over the children (anchors
  expanded), so only visible cards are composed and a rail scrolls without JS; padding becomes content padding;
  vertical = scrolling `Column`.
- **`backgroundImage: "linear-gradient(...)"`** (RN's CSS form, prop 111): parsed by the compiler (angle or `to side`,
  stops with optional `%`), drawn natively with a cached brush over the background colour in the node's shape.
- **Colours:** `rgb()` / `rgba()` accepted everywhere (RN has them; banner overlays need them).
- **Bug found on the phone and fixed:** JSX text showed `&amp;` literally. The compiler now decodes HTML entities in
  JSX text and string attributes, like React (`&amp;`, `&#8377;`, `&#x20B9;`).
- **Sample:** `OffersScreen` (route `/offers`, deep link on; "Offers" button on Home): the real offers from
  `test-kit/offers-data.json` grouped like the RN `HomeOffersTab` (banner rail, a product rail per merchant, message
  cards, section headers), repeated ×10 (260 rows). Image URLs built like the RN app (`OFFER_IMAGE_BASE` +
  `image_id`); image banners get a dark gradient overlay. Pavan re-exported the data with `image_id` (88 products,
  10 banners, 10 messages have one).
- **Verified on the Lava:** screenshots: gradient banners, image banners with overlay, product photos, tagline
  strips, `&` decoded. Release: flinging the feed (vertical + rails): p50 6 ms, p95 11 ms, p99 15 ms, 1 janky frame
  of 427, 0 slow bitmap uploads; 111 MB PSS. Tests: JS 75 + types, Kotlin 14, lint 0.
- **Not done / noticed:** one product image is a 404 on storage (data); its card shows an empty box until image
  fallbacks exist (after-foundations). Cards in a lazy rail don't stretch to the tallest one (RN's do).

### 2026-10-29: step 2.4a done (Claude): `<List>` with row kinds
- Plan approved by Pavan (`docs/cross-communication/2026-10-29-feeds-and-lists-proposal.md`): 2.4 split into a–e.
- **Ops 6–8** (`LIST_SET`, `LIST_SPLICE`, `LIST_ROW`) in C++ (`batch.h/.cpp`, runtime, host functions
  `__zn_listSet/Splice/Row`), Kotlin (`BatchReader`, `ZnStore` → `ZnList`) and JS. Registry **v5**: `List` (11),
  events `onRange` (6), `onEndReached` (7).
- **Compiler:** `<List data key row onEndReached style gap>`; each JSX leaf of `row` (`cond ? <A/> : <B/>`) is a row
  template; generated `type(item)` picks the leaf without building it; every compiled component gets `Comp.__zt`
  (its template id), so a row component can live in any file. Errors for missing props, children, non-JSX rows.
- **JS (`list()` in `view.ts`):** one `LIST_SET`, then one `LIST_SPLICE` per change (common start / end kept); rows
  mounted 8 behind to 12 ahead of the visible range, removed outside twice that; changed items remounted;
  duplicate keys logged and made unique (Compose would crash).
- **Native:** `LazyColumn` with key + `contentType` per kind; unmounted rows draw a shared read-only placeholder
  instance of their kind; visible range → JS at most once per frame; `onEndReached` once per row count; scroll
  position saved (back navigation and recreation keep it).
- **Bug fixed while building:** `jsi::Value` can't be copied (C++ compile error in the new host functions).
- **Sample:** Home = 10,000 generated merchants + 100 area headers (2 kinds), "New payment arrives" inserts at the
  top.
- **Verified on the Lava:** debug: list draws, inserting at the top while scrolled keeps the visible row in place,
  tap → Amount, back → same scroll position. **Release:** 491 frames of fast flings: p50 6 ms, p90 9 ms, p95 11 ms,
  p99 15 ms, **0 janky frames, 0 slow UI-thread frames**; cold start **180 ms** median (p90 201 ms) with the 10,100-row
  list on the first screen; memory 106 MB PSS. Tests: C++ 79 checks, JS 71 + types, compiler 18, Kotlin 14, lint 0.
- **Not done yet:** grey-bar placeholder text (`placeholder` prop); rails, carousel, impressions (2.4b–d).

### 2026-10-29: step 2.3 done (Claude)
- **Edge to edge:** `MainActivity` calls `enableEdgeToEdge()`; the blanket `safeDrawingPadding()` is gone.
- **Per-route safe areas** (`ZnNavHost.kt`): each screen is padded by system bars + display cutout on the edges its
  route's `safeArea` asks for; the screen root's background fills behind the bars. Status bar icons from the route's
  `statusBar`; navigation bar icons from the screen's background luminance (applying `statusBar` to both gave a grey
  scrim over the bottom bar on the full-bleed receipt; fixed and checked on the Lava).
- **`insets()`** in `@zero-native/core` (`insets.ts`): read-only signal `{ top, bottom, start, end }` in dp, fed by a
  new app-level event (id 5) that native sends only when the insets change.
- **Dynamic per-edge padding (registry v4):** `paddingTop / Bottom / Start / End` may be slots, so a header can use
  `paddingTop: insets().top + 32`. Read in the layout phase (`layoutPadding` in `ZnTemplate.kt`): a change re-measures
  one node, recomposes nothing. Shorthands (`padding`, `paddingHorizontal`, ...) stay build-time (compiler test).
- **Sample:** Receipt is full-bleed (`safeArea: { top: false }, statusBar: "light"`): green header behind the status
  bar, text below it.
- **Verified on the Lava** (screenshots): Home and Amount clear of both bars with dark icons; Receipt header behind the
  status bar with white icons, light navigation bar; landscape keeps content clear of the cutout (left) and the
  navigation bar (right). Release: cold start **189 ms** median (p90 210 ms), full flow works, no R8 issues. Tests:
  JS 63 + types, compiler 16, Kotlin 13, lint 0 errors.
- **Phone setting changed for the landscape check:** auto-rotate (`accelerometer_rotation`) is now **off**, rotation
  back to portrait. It was most likely off before (the rotate-suggestion button had been used), but the old value
  wasn't recorded.
- **Not done (parked in after-foundations):** insets with START (one-frame gap for a full-bleed start screen),
  horizontal full-bleed, keyboard inset (with `TextField`).

### 2026-10-29: step 2.2 done (Claude)
- **NAV op (code 5)** in C++ (`batch.h/.cpp`, `runtime.cpp`, host function `__zn_nav` in `hermes_engine.cpp`),
  Kotlin (`BatchReader.kt`) and JS. Kinds: PUSH, REMOVE, CLEAR, EXIT, BACK_ANSWERED; replace = REMOVE + PUSH, reset
  = CLEAR + PUSHes in one batch (native applies a batch at once and only sees the result). Never merged.
- **JS (`packages/core/src/nav.ts`):** the back stack; `nav.push / back / replace / reset / current / depth`;
  `useBack(() => boolean)` (true = handled, like RN's BackHandler); `startApp(routes)`. Typed: apps register their
  routes once (`declare module "@zero-native/core" { interface Register { routes: typeof routes } }`), then
  `nav.push("amount", { merchantId })` is checked (missing / wrong params and unknown routes are type errors).
  Native → JS app events on instance 0: START (first stack), BACK, FORCED_BACK, OPEN (deep link while running).
- **Screen-owned timers:** a timer created under an owner (screen body, component, or an event handler of one: `on()`
  now runs handlers under their instance's owner) is cleared when the owner is disposed. One set of handles per
  owner, so many short timers don't pile up cleanups.
- **Native (`ZnNav.kt`, `ZnNavHost.kt`):** Navigation 3 1.2.0 `NavDisplay` draws the stack; transitions per route
  (push = RTL-aware slide, modal = up from the bottom, fade, none; the leaving screen stays on top on pop). Native
  opens the first stack (start route, plus a cold deep link's route on top), allocates top-bit ids, creates the
  roots, then sends START. A popped screen's instances live until its exit animation ends; entries that were never on
  screen (under the top) are freed at once. System back → JS; 300 ms fallback if JS doesn't answer.
  `ZnTemplates.whenReady` lets native open the stack before the first frame. Patches for unknown instances are now
  ignored with a warning (they used to create an empty instance).
- **Bug found and fixed on the phone:** native ids (top bit set) are negative as Kotlin `Int`s; the first START sent
  -2147483647, the C++ bridge cast it to some other u32 and Home's rows mounted under a parent that didn't exist
  (silently). Native now sends ids to JS as unsigned numbers, and the bridge's `u32Arg` **throws** on negative,
  fractional or too-big numbers instead of an undefined C++ cast.
- **Sample:** Home → Amount (← and back ask "Discard ₹X?" when an amount is typed) → Pay → Receipt (modal) → Done
  resets to Home. `MainActivity` is a thin `singleTask` host (debug footer removed; recreate with
  `adb shell cmd uimode night yes`).
- **Verified on the Lava:** debug: every flow above; double tap on Pay → one receipt; Amount's 500 ms cursor timer
  stops after popping (0 batches in 3 s idle on Home); dark-mode recreation keeps the screen and amount, JS not
  restarted, `useBack` still works; cold deep link `/pay/m3` → Amount over Home, back → Home; warm link `/pay/m4`
  pushes; `/receipt/...` (no deep link) ignored; back on the last screen → app goes to the background.
  **Release:** cold start **193 ms** median (p90 198 ms, 11 runs, load avg ~18), tap → new screen's first frame
  12–17 ms, full flow works, no R8 issues; APK 5.83 MB (+0.1 MB for Navigation 3).
  Tests: C++ 63 checks, JS 62 + type tests, Kotlin 13, lint 0 errors.
- **Not verified / not done:** the 300 ms fallback (JS never hung); the predictive back gesture (the Lava uses
  3-button navigation); a last screen's `useBack` (the system handles back there).

### 2026-10-29: step 2.1 done (Claude)
- **Routes:** `defineRoutes` in `@zero-native/core` (`packages/core/src/routes.ts`) with types: every `:param` in a
  path must be a string prop of the screen (checked by `bun run test:types`, now part of `bun run test`);
  `RouteParams<R, name>` gives the params `nav.push` will need. Options: `transition`, `safeArea`, `statusBar`,
  `deepLink` (**off by default**: a link is an outside entry point, each route opts in).
- **Compiler:** `compiler/src/routes.ts` reads the `defineRoutes({...})` call **without running it** (running it would
  run the screens). Build errors with file:line:col for: no `"/"` route, bad paths, repeated params, two routes with
  the same pattern, unknown screens or options, names that aren't plain names (JS key order = route index). The
  Bun plugin writes `routes` into `main.zn.ui.json`: name, path, screen template id, options, in source order.
- **Kotlin:** `ZnRoutes.kt`: route table on `ZnBundle.routes`, `named`, `at(index)`, `start` (the `"/"` route),
  `matchDeepLink(path)` (literal segments beat params, query/fragment ignored, `%XX` decoded as UTF-8, `+` kept,
  malformed escapes don't match, routes without `deepLink` never match). 5 JVM tests.
- **Sample:** `routes.ts` (home `/`, amount `/pay/:merchantId` with deep links, receipt `/receipt/:ztc` modal),
  new `HomeScreen` (5 merchants), `ReceiptScreen`, `merchants.ts`; `AmountScreen` takes `merchantId`. Native opens
  the start route from the manifest; a `zn://sample/...` link is matched and **logged** (opening it is step 2.2).
- **fontWeight:** the compiler checks React Native's values (100–900 in steps of 100, `"normal"`, `"bold"`) and fails
  with file:line:col otherwise (it used to pass bad values on to the writer).
- **Verified:** JS 52 tests + type tests, Kotlin 12 tests, lint 0 errors; on the Lava (debug): Home draws from the
  manifest's start route; `zn://sample/pay/Kalyan%20J` → `amount {merchantId=Kalyan J}`; `zn://sample/receipt/abc`
  → no route (receipt has no deep link).
- **Not done here (step 2.2):** `main.ts` and `MainActivity` still hard-code the root id `0x80000001`; Amount and
  Receipt can't be reached on the phone until navigation exists.

### 2026-10-29: step 2.0b done
- **Upgraded Compose BOM & Activity Compose:**
  - Upgraded Compose BOM to `2026.09.00` in `:runtime` and `:sample`. Maps to Compose `1.12.1` across runtime, UI, animation, and foundation (satisfies Navigation 3's requirement of runtime $\ge 1.11.2$ and UI/animation $\ge 1.10.0$).
  - Upgraded `activity-compose` to `1.13.0` (satisfies $\ge 1.12.0$).
  - Upgraded Coil to `3.3.0` (`io.coil-kt.coil3:coil-compose:3.3.0` and `coil-network-okhttp:3.3.0`). Tested and noted: Coil 3.6.x was compiled with `kotlin-stdlib:2.4.10` which caused metadata version conflicts against AGP 9.2.1's built-in Kotlin 2.2.0 compiler; Coil 3.3.0 compiles with Kotlin 2.2.0 seamlessly.
- **Phone verification on physical Lava Blaze 2 5G (Android 14):**
  - Interactive checks: press states, native repeat backspace, long press clear to ₹0, Coil circular avatar loading, SVG icon drawing all verified on device.
  - Recomposition audit: typing a digit recomposes **only the amount `Text` node** (`recomposed: {Text#-2147483647.15=1}`); blinking cursor timer recomposes 0 body nodes.
  - Latency: `tap→applied` measured at **9.32 ms** to **11.45 ms**.
- **Performance benchmarks in release build (`:sample:installRelease`, R8 enabled):**
  - Cold start: **200 ms** median (min 187 ms, p90 229 ms, max 244 ms, 11 runs after first drop) — **improved by 27 ms** from Step 1.5's 227 ms.
  - Release APK size: **5.73 MB** (5,728,905 bytes, delta +64.1 KB / +0.06 MB, well below the +0.3 MB limit).
  - Play Store download size: **2.02 MB** (brotli -q 11 on extracted bundletool device splits).
  - Idle memory: **86.1 MB PSS** after 10 s idle (Total RSS 165 MB, Native heap 22.3 MB, Java heap 3.3 MB).
- **Tests & Lint:**
  - 48 JS tests pass (`bun run test`).
  - Kotlin unit tests pass (`.\gradlew.bat :runtime:testDebugUnitTest`).
  - Lint: 0 errors (`.\gradlew.bat :runtime:lintDebug :sample:lintRelease`).

### 2026-10-29: step 2.0 done
- **Target SDK restored to 36:**
  - Restored `targetSdk = 36` in `android/sample/build.gradle.kts` and `android/baselineprofile/build.gradle.kts`. (The Lava ROM broadcast issue is documented to be due to `am force-stop` on Android 14 MediaTek firmware, not `targetSdk`).
- **`fontWeight` string mapping in compiler:**
  - Added string `fontWeight` normalization in `compiler/src/compile.ts` (`"normal"` → 400, `"bold"` → 700, and numeric strings like `"600"` → 600) for both JSX props and `style` objects.
  - Added unit test in `compiler/test/compile.test.ts`. 48 JS tests pass.
- **Relocated `exp4-flow/` and preserved mock backend:**
  - Copied `exp4-flow/mock-backend.ts` → `tools/mock-backend.ts` for native host calls (Step 2.6) and flows (Step 2.8).
  - Moved `exp4-flow/` into `experiments/exp4-flow/`.
- **Mock UPI app added to test kit:**
  - Copied source and Gradle files from `C:\work\zero-native-bkp\P2pUPIapp` to `test-kit/p2p-upi-app/` (omitted all build artifacts, `.gradle`, `.idea`, `.kotlin`, `local.properties`).
  - Verified it builds cleanly with `cd test-kit/p2p-upi-app; .\gradlew.bat assembleDebug` (30s, 36 tasks executed).
- **Verification:**
  - JS: 48 tests pass (`bun run test`).
  - Kotlin: 7 unit tests pass (`.\gradlew.bat :runtime:testDebugUnitTest`).
  - Lint: 0 errors (`.\gradlew.bat :runtime:lintDebug :sample:lintRelease`).
  - Sample bundle: `bun run sample:js` writes `main.zn.ui` (1917 bytes) and `main.hbc` cleanly.

### 2026-10-29: step 1.5 done
- **Fixed Opus handoff build blockers:**
  - Migrated to AGP 9.2.1 built-in Kotlin (`android.builtInKotlin=true`, removed external `org.jetbrains.kotlin.android`), completely eliminating Windows `provider(?)` path failure (`InvalidPathException`).
  - Aligned `targetSdk = 34` in `sample` and `baselineprofile` modules, unblocking Android 14 broadcast delivery to `ProfileInstallReceiver` (`result=12` / `RESULT_SAVE_PROFILE_SIGNALLED`).
  - Reset `always_finish_activities` to `0` and whitelisted background execution against MediaTek OEM cleaner.
- **Hardware baseline profile & benchmark verification (Lava Blaze 2 5G, Android 14):**
  - Direct ART runtime profile dumped via `cmd package dump-profiles dev.zeronative.sample` (hot methods across `ZnNodeSpec`, `LayoutNode`, Hermes bridge).
  - Cold start: **227 ms** median (min 197 ms, p90 263 ms, 10 runs after first drop) in release build (`:sample:installRelease`, R8 enabled with `-dontobfuscate`). Startup budget of $\le 250\text{ ms}$ satisfied.
  - Process start to first JS batch: **140 ms** (19 ops applied before first composition at 159 ms).
  - Memory: **77.8 MB PSS** after 10 s idle (total RSS 162 MB, Native heap 21.5 MB, Java heap 3.2 MB).
  - Template preparation: **2.58 ms** for 7 templates (memory-mapped binary asset).
  - Tests: 47 JS unit tests pass (`bun run test`), 7 Kotlin unit tests pass (`:runtime:testDebugUnitTest`).
- **Milestone 1 (Foundations) is complete.** Ready for Milestone 2 (`<List>`, navigation, safe areas, Sheet, flows).
- **Press handling** (`android/runtime/.../ZnPress.kt`): `onPressIn`, exactly one `onPressOut` (payload `true` when
  cancelled), `onLongPress`, native `onPressRepeat` (`repeatDelay`, `repeatInterval`), `onPress` only for a completed
  plain tap; press highlight clipped to the shape; `haptic` (respects the system setting); accessibility role Button
  with TalkBack activate/long-activate.
- **Images** (Coil 3.0.4, http(s) and `asset:`; failures are logged; clip to rounded corners by default) and **icons**
  (SVG path data "minX minY w h|d", folded at build time from `.ts` files, drawn natively; fill paths).
- **Style keys added** (registry v3): `transform` (build-time), `elevation` + `shadowColor`, `borderTopWidth` /
  `borderBottomWidth`, `position: 'absolute'` + offsets + `zIndex` in `Stack`, `fontStyle`, `textDecorationLine`.
  Full status: `docs/styling-and-layout.md` §10.
- **Recomposition counter** (`ZnDebug`, debug builds): logs which template nodes recomposed after each batch.
- **Verified on the Lava (debug unless noted):**
  - Recomposition audit while typing: a digit that changes only the amount recomposes **only the amount `Text`**;
    the first digit also recomposes the Pay button (it becomes active); crossing the cashback threshold recomposes
    the parent `Column` (a branch mounted) plus the new branch nodes; later digits recompose the amount and
    "You pay" texts. Nothing else.
  - Holding backspace 1.3 s deleted all 7 digits by native repeat; the next tap ("6") stayed: no zombie deletes.
  - Dragging off the Pay button: `onPressOut(true)` and no payment; a real tap: `onPressOut(false)` then `onPress`.
  - Long-pressing the amount clears it. The image loads and is clipped round; the backspace icon, italic text and
    the Pay button's shadow draw correctly.
  - Release: cold start 204–248 ms (median ~222 ms); APK 5.66 MB (+0.3 MB, Coil + OkHttp); no R8 issues.
  - Tests: JS 47, Kotlin 7, lint 0 errors.

### 2026-10-29: step 1.3 done
- **Signals** (`packages/core/src/signals.ts`): push-pull and glitch-free (an effect never sees half-updated values;
  a computed that didn't really change stops the update), `set()` ignores equal values, owners dispose child effects
  and cleanups. v0's signals ran subscribers immediately and had no cleanup.
- **View runtime** (`packages/core/src/view.ts`): `view`, `slot` (first values travel inside MOUNT), `on`, `ready`,
  `component` (props as getters), `when` (`&&`, `? :`), `each` (keyed `.map`: MOUNT / MOVE / REMOVE; a changed item
  with the same key is mounted again), `renderRoot`. Removing a subtree stops its effects and events; only the top
  instance sends REMOVE.
- **Compiler** (`compiler/`, uses the TypeScript compiler API, build-time only):
  - components = capitalised module-level functions returning JSX; their JSX → templates + setup code;
  - build-time constants (literals, `const`s, `StyleSheet.create`, tokens imported from side-effect-free `.ts`
    files) go into templates; other values become slots, or a build error for props that can't change yet;
  - `&&`, `? :` and `.map` (key required) become Anchor nodes; user components mount at anchors;
  - clear errors with file:line:col for anything unsupported;
  - a Bun plugin compiles every `.tsx` while bundling and writes `main.zn.ui` + `main.zn.ui.json` (component →
    template id).
- **Registry v2:** `Anchor` component (where child instances mount; draws its children in the parent's layout).
- **Kotlin:** instances keep children per anchor (observable lists); the renderer expands anchors in place; a screen
  root keeps JS's early patches and child mounts; the bundle manifest tells native which template a screen uses.
- **Sample:** a real TSX amount-entry screen (`examples/sample/src/AmountScreen.tsx`): tokens, a `Key` component in
  nested `.map` rows, cashback `&&` and `? :` branches, ZeroBill's money rules in paise.
- **Fixed after testing on the Lava:** the press highlight is now clipped to rounded corners (Pavan's screenshot);
  a Column only stretches children when its own width is definite (the cashback badge went full width).
- **Verified on the Lava:** typing ₹25,000 shows Indian grouping, the cashback branch and "You pay ₹24955 (incl.
  ₹5 platform fee)" (correct); backspacing removes the branches; recreating the Activity keeps everything incl.
  mounted branches; tap → screen 4.5–12 ms (debug). Release: template file (6 templates) read + prepared in 4 ms,
  JS ready with 20 ops in the first frame, cold start 201–257 ms (median ~217 ms).
- **Tests:** JS 46 (signals 11, view 9, compiler 10, + earlier), Kotlin 7, lint 0 errors. Run JS tests with
  `bun run test` (plain `bun test` also picks up the old `exp4-flow` tests while that folder is still at the root).
- **Not verified:** the rounded press highlight (adb couldn't capture the pressed state; please long-press a button).

### 2026-10-29: step 1.2 done
- **Format:** `.zn.ui` is our own versioned binary format (decision in ARCHITECTURE §6.1 / §24): string table, then
  per template the nodes in tree order (component id, parent, static props), slots (node, prop, default) and events
  (node, kind, event id). Values are typed: number, string, ARGB colour, percent, enum, bool, null.
- **Registry:** `packages/template/src/registry.ts` is the one source (9 components, ~45 props incl. style keys,
  4 event kinds, enums, which props may be dynamic). `bun run gen:registry` writes `Registry.kt`; a test fails if
  they drift.
- **Writer** (`packages/template`): `el()`, `slot()`, `event()`; validates everything at build time (unknown props,
  bad values, colours, props that can't be dynamic yet, duplicate slot names) and parses colours to ARGB. Also
  writes the ids module JS imports (slot and event numbers).
- **Kotlin:** `TemplateReader` (checks magic, format and registry version: the capability check), `ZnTemplate` /
  `ZnNodeSpec` (each node prepared once: typed fields, decoded colours/enums, RN edge precedence, the modifier chain
  pre-built in the fixed order), `ZnTemplates` (loads off the main thread, memory-maps the uncompressed asset),
  `ZnStore.mountRoot` (screen root with slot defaults; keeps values JS sent earlier), `ZnScreen` renderer:
  Column / Box / Pressable as columns with zn flex rule 4 (stretch), Row, Stack, Text (colour read in the draw
  phase), Spacer; Image / Icon draw their box only (image loading comes later). Dynamic background and opacity
  are read in the draw phase.
- **Sample:** the screen is now a template (`examples/sample/src/screen.ts`); JS uses generated ids.
- **Verified on the Lava:**
  - With JS delayed (`debug.zn.js_delay_ms`), the full screen draws from the template alone with its defaults
    (screenshot checked), then fills in when JS starts. **Done criterion met.**
  - Taps through the template's `Pressable` (debug build): tap → applied 5–13 ms; "Recreate activity" kept the
    values (activity #2, runtime #1).
  - Release: template read + prepared in **1.8 ms**; JS first batch applied 129 ms after process start, before the
    first composition (163 ms), so users normally see real values in the first frame; cold start 212–302 ms over 7
    runs (median ~244 ms). The budget is 250 ms; step 1.5 adds Baseline Profiles.
  - Tests: JS 16, Kotlin 7, lint 0 errors.
- **Notes:** a debug cold start is far slower (template prepare 131 ms vs 1.8 ms in release; skeleton at ~1.4 s):
  never judge speed from debug builds. Gemini's v0 `Pressable` fired `onPress` even for cancelled presses
  (`tryAwaitRelease()` result ignored); the new one uses `clickable`, which doesn't.

### 2026-10-29: step 1.1 done
- **Core** (`core/`): `zn::Value` (null / bool / number / string only), `zn::Batch` (binary format documented in
  `core/include/zn/batch.h`; a later patch to the same slot replaces the earlier one), `zn::Runtime` (one per
  process: engine + batch + timers; ends every tick by draining microtasks, merging the tick into the pending batch
  and asking the UI thread **once** to take it), `zn::Platform` (what Android/iOS provide). Split into
  `zn_core_base` (no engine, testable) and `zn_core` (Hermes adapter with the host functions `__zn_patch`,
  `__zn_mount`, `__zn_remove`, `__zn_move`, `__zn_setTimer`, `__zn_clearTimer`, `__zn_log`, `__zn_now`).
- **Timers:** native keeps the handle → timer table; a repeating timer keeps one handle and is rescheduled before JS
  runs; a cleared timer's queued fire never reaches JS; repeat intervals are at least 1 ms.
- **JS** (`packages/core`): `installRuntime()` (console → logcat `zn-js`, timers, event dispatch), `patch / mount /
  remove / move`, `onEvent`, `setTimeout / setInterval / clear*` with the same rules.
- **Android:** JNI platform (timers posted on the `zn-js` thread, apply requests posted to main); `BatchReader`
  (Kotlin); `ZnStore` (process-wide instances, one Compose state cell per slot, each batch applied in one
  `Snapshot.withMutableSnapshot`). Compose runtime is now an `api` dependency of the runtime library.
- **Tests:** C++ 43 checks on the phone, JS 10 tests, Kotlin 4 tests: all pass.
- **Verified on the Lava (release):**
  - Tap → JS → batch applied: **1.9–9.7 ms** over 10 taps (median ~4.3 ms); applying a batch 0.4–0.9 ms.
  - "Recreate activity": activity #2, **runtime still #1**, same process, tap count and JS timer kept going.
  - Microtasks drained within the same tick (`Promise.then` patch arrives with the first batch).
  - Cold start 199–233 ms over 8 runs (median ~205 ms), runtime + JS ready in ~20 ms.
- **Lessons** (added to `docs/v0-findings.md` §P): Hermes needs `-Xes6-block-scoping` for real `let`/`const`;
  `SystemClock.uptimeNanos()` is Android 15+ only (crashed on the Lava, Android 14); PowerShell 5.1 treats adb's
  stderr progress as an error.

### 2026-10-29: step 1.0 done
- Repo skeleton created (layout above). Experiments moved to `experiments/` (`exp4-flow` was locked by another
  program and still sits at the root; move it when free).
- `core/`: `zn::Engine` interface (`include/zn/engine.h`) + Hermes adapter (`src/hermes_engine.cpp`): microtask queue
  on, bytecode checked with the Hermes V1 root API, errors returned with the JS stack.
- `android/runtime`: CMake builds the core; JNI bridge runs a bytecode asset **without copying it**
  (`AASSET_MODE_BUFFER`, `.hbc` stored uncompressed); `ZnRuntime` is one per process, with its own `zn-js` thread.
- `android/sample` + `examples/sample`: TS → JS (Bun transpiler) → `hermesc` → `main.hbc`.
- **Verified on the Lava (release build, not debuggable):** log shows `main.hbc -> 2`; Hermes runtime created in
  7–8 ms; cold start `am start` TotalTime 180–236 ms over 7 runs (median ~194 ms; first run after install 236 ms).
  APK 5.2 MB.
- Lessons (added to `docs/v0-findings.md` §P):
  - Hermes V1 moved `isHermesBytecode` to the root API (`makeHermesRootAPI()` + `castInterface`).
  - A library that links Hermes via prefab must exclude its own copies of `libhermesvm.so` / `libfbjni.so`, or the
    app gets "2 files found".
  - **R8 strips fbjni's Java classes** and the release app crashes at start; keep rules now ship in the runtime's
    `consumer-rules.pro`.
  - Bun's transpiler drops a bare final expression as dead code; don't rely on a script's completion value.
- 2026-11-08 (late): known layout issues cleared (branch opus/known-issues). The iOS session's layout conformance lab
  (examples/sample/src/LayoutLab.tsx, 48 cases) went from 42/48 to 48/48 on Android (Lava and emulator):
  - A11-1: alignSelf "stretch" works under a centring parent (Column, Stack, Scroll) and in a Row with a height.
  - A11-2: onLayout x / y from the parent's corner, padding and border included (ZnLayoutBox.kt, second-opinions 181).
  - A11-3: maxWidth / maxHeight beat a stretch and a % size (second-opinions 182).
  - A12: a new Activity in the same process after a `zn dev` reload ran the APK's JS with the dev build's templates
    (a screen drew parts of another, or Compose threw "infinity maximum height"); it now runs the dev build's JS.
  - Checked: Kotlin tests + lint, 1288 JS tests, emulator screen compare against main (no change outside the cases),
    Lava LayoutLab 48/48 and the List / chat checks.
- 2026-11-08 (night): the iOS branch is in main (fast-forward to 3f2272d: iOS i.1-i.2, i.4 groundwork and scanner,
  registry 23 read on iOS, A8 back handlers). Android checks of it: JS 1291/1291, Kotlin tests, lint, LayoutLab 50/50
  on the Lava after one fix (c29a: a fixed width / height ignored its own min / max; znClampSize), A8 on the sample
  and in ZeroBill `.dev` with gesture navigation (Pavan: 6 of 6). Then predictive back (second-opinions 184): the
  runtime's manifest turns it on for Android 13+, and NavDisplay's back pops a screen without a handler natively
  (`ZnNav.navDisplayBack`); before, the screen froze where the finger let go (~150 ms, waiting for JS) and then
  jumped. Checked on the Lava (Android 14, gestures): preview on Dev, none on the guarded amount screen, Discard /
  Keep, sheet first, tabs, exit from the last screen; Pavan checked the feel ("just like in ios now").
