# After the foundations: parked ideas

Things we want, but only **after** the foundations (milestones 1–2) work. Each item says where it came from and why
it is parked. When we pick one up, move its rules into the right spec file and add a row to ARCHITECTURE §24.

## UI and animation
| Item | What | Source | Notes |
|---|---|---|---|
| `keyframes(...)` animations with easing | Multi-segment native animation, e.g. 0→60% in 400 ms `easeOutCubic`, →82% in 600 ms, →94% in 1400 ms | Flutter UPI tile (`txn_v1_bottom_sheets.dart` `_AnimatedUpiAppTile`), 2026-10-29 | Compose `keyframes` / `Animatable`; SwiftUI `keyframeAnimator` (iOS 17+). Start on mount, reset on unmount (put it inside `<If>`). |
| `Shimmer` component | Native animated gradient sweep (base + highlight colour, period) | Same tile; also `<List>` placeholders | Draw-phase only, no JS per frame. |
| `Image fallback` | A node shown when an image fails to load | Same tile (`errorBuilder`) | Part of the `Image` registry entry. |
| Merge decoration-only boxes | A `Box` with one child and only drawing/padding styles merges into the child's modifier chain | `docs/styling-and-layout.md` §8.3 | Build only if it causes no real problems. |
| Read slots in the cheapest Compose phase | Colours/opacity/transforms in draw, sizes/padding in layout, content in composition | `docs/styling-and-layout.md` §8.3 | Same condition. |
| Gesture expressions on the UI thread | Explicitly marked tiny expressions for drag-driven values | ARCHITECTURE §10.3 | v2. |

## Feeds: built quickly in step 2.4, to finish to framework standard
What exists works and is measured, but each item below is the "minimum that the offers feed needed". Finish before
calling these features done for outside users (each needs: full spec in the docs, tests on both axes / RTL, guide
notes, conformance screenshot).
| Item | Built today (2.4a–b) | Missing |
|---|---|---|
| Gradients (`backgroundImage`) | `linear-gradient` with angle or `to <side>`, colour stops with `%`, drawn over `backgroundColor` in the node's shape | Build-time only (no slot: can't change at runtime or animate); no `radial-gradient`; no `px` stops; no repeating gradients; `to <corner>` uses a fixed 45° steps, not CSS's corner-aware angle; no RTL flip for `to left/right`; no tests on the native side (only compiler parsing); iOS mapping not designed |
| Colours | `#hex`, `rgb()`, `rgba()`, `transparent` | `hsl()`; named colours (deliberately not: tokens); `PlatformColor` / dark-mode tokens (ARCHITECTURE §5.4) |
| `Scroll` | `horizontal` = lazy rail; vertical = plain scrolling `Column` | Vertical is not lazy (fine for short content, document); no `snap`; no scroll events / `scrollTo` from JS; no nested-scroll rules; no `showsScrollIndicator`; rail cards don't stretch to the tallest card (RN's do) |
| `<List>` | Row kinds, window protocol, splice anchoring, `onEndReached`, placeholders of the right kind | Grey-bar placeholder text (`placeholder` prop); `scrollTo(key)`; `inverted` (chat); horizontal `<List>`; grids; pull to refresh; JS-side list of row ids for tests |
| Images in feeds | Coil loads `https://` and `asset:` | Fallback node on error (one offer image is a 404 today: empty box); placeholder / shimmer while loading; prefetch for rows about to appear; `zn://` handles |

## Lists: pinned headers ("slivers")
Pavan, 2026-10-29: feeds and catalogues need Flutter-sliver-like behaviour:
| Pattern | Plan |
|---|---|
| **Sticky section headers**: a header stays pinned at the top while its section scrolls, and the next header pushes it up and takes its place | Compose `LazyColumn` does this natively (`stickyHeader`), including the push. API idea: a row kind marked sticky (`sticky={(f) => f.kind === "header"}` on `<List>`), so native emits that kind's rows as sticky headers. No JS per frame. |
| **Collapsing app bar**: a large header that shrinks into a small bar as you scroll | Native: the list's scroll offset drives the header's height/opacity in the layout/draw phase (nested-scroll connection). Declarative props on the screen header (`collapse={{ from: 180, to: 56 }}`), not JS scroll handlers. |
| **Pinned tab bar under a header** (category tabs that stick, Blinkit / Swiggy) | Same as sticky headers, with a tab row as the sticky kind; tapping a tab = `scrollTo(key)` (to build). |
| **Scroll-linked effects** (parallax image, fade header) | Needs scroll offset on the UI thread: v2 gesture/scroll expressions (ARCHITECTURE §10.3), or a fixed set of declarative effects first. |

## Compiler and runtime (gaps left on purpose in step 1.3)
| Item | Notes |
|---|---|
| Children for user components (`<Card>…</Card>`) | **Done (step 3.2):** children and JSX props are functions that make a View; `{props.children}` shows them. Left: reading / mapping / counting children (not planned). |
| Fragments `<>…</>` and several roots | **Done (step 3.2):** Fragment node; `.map` / `<List>` rows still need one root element (a row needs a key). |
| Nested elements inside `<Text>` (spans) | **Done (step 3.2)** for build-time span styles. Left: span styles that change at runtime, `onPress` on a span (links), inline icons / images. |
| Conditional entries in style arrays (`[s.a, on && s.b]`) | Build error today with a hint to use a ternary inside the style object. |
| Row items as signals | `.map` mounts a row again when its item object changes (same key). Per-row signals would update in place. |
| Timers owned by the screen | **Done (step 2.2):** a timer made inside a screen or component is cleared when it closes (`packages/core/src/timers.ts`). |
| More dynamic props | Text, colour, background, opacity, src, disabled, and (registry v4, step 2.3) per-edge padding can change at runtime. Sizes, margins, gap etc. still need layout-phase slots like padding's (`docs/styling-and-layout.md` §8.3; `layoutPadding` in `ZnTemplate.kt` is the pattern). |
| Deep-link query values | **Done (2026-11-02, H.1):** query values reach the route as params; a value from the path wins. |
| Safe-area gaps (step 2.3) | Insets reach JS after the first frame, so a full-bleed **start** screen would draw its header without the inset for one frame (send them with START). No horizontal full-bleed option (`safeArea` has top / bottom only). Keyboard inset: done (step 3.3, route option `keyboard`); a `<TextField>` inside a `<Sheet>` doesn't resize the sheet yet. |
| Types for JSX | **Done (step 3.2):** JSX namespace in `@zero-native/ui`, `examples/sample/tsconfig.json`, `bun run test:types` checks the sample. Left: props are typed per component but slot / build-time rules are only checked by the compiler. |

## Data and porting
| Item | What | Source | Notes |
|---|---|---|---|
| Storage follow-ups | Stores that go into Android backups, Block Store for staying signed in after a reinstall, encrypted stores, a backup copy for important stores, SecureStore with fingerprint / screen lock | `docs/storage.md` §5 | Only when an app needs one. |
| Native list data source | SQLite / mmap rows read on an I/O thread straight into the row cache (10 lakh rows) | `docs/lists.md` §6 | v1.1. |
| NativeWind `className` translator | Compile-time Tailwind subset → style keys, for porting ZeroBill RN code | `docs/styling-and-layout.md` §9 | v1.1, not decided. |
| Cronet / HTTP/3 backend for `fetch` | Optional network backend | ARCHITECTURE §14 | Only if needed. |
| `fetch` follow-ups | Streaming bodies, progress events, download to file, OkHttp 5 (`fastFallback`), an extra root for Android 7.0, sharing the client with Coil, a network-status module | `docs/fetch.md` §7 | Two need Pavan's call (OkHttp 5, Android 7.0 root). |
| Own TS lib types (no DOM) | Apps get `fetch` / `Response` types from TypeScript's DOM lib, which also offers `document`, `window`, `Blob`, `ReadableStream` that don't exist here | step 3.4 | A `@zero-native/types` lib file with only what the runtime has. |

## Flows (parked by Pavan, 2026-10-30)
Apps keep payments safe with FlowStore and the save-then-verify pattern (`docs/guide-notes.md` §16). The flow engine
below would make those rules automatic for every journey; pick it up when several apps or teams need it.
| Item | What | Source |
|---|---|---|
| Flow engine | `defineFlow`, saving before every step, effects `safe` / `keyed` / `once` with a required reconcile step, restoring screens and state after a kill, safe mode, flow versions with OTA, lint for missing `reconcile` | ARCHITECTURE §12 (full design kept there) |
| Result hook | `ZnActivityResults.onResult` (was step 2.6b; now `launchForResult` in `docs/plugins.md` P.2) is the single entry point for results from other apps; the engine would save each result to FlowStore before JS hears about it | ARCHITECTURE §12.4 |
| Restored flows must finish | Restored runs logged 0 `/verify` calls in v0; the flow tests must assert `/verify` happens and a final screen shows | `docs/v0-findings.md` §D |
| `/pay` died mid-call | No `ztc` to verify with; UPI never opened, so "payment not started → try again" | `docs/v0-findings.md` §D |
| Backend idempotency key for `/pay` | Would make `/pay` `keyed` | `experiments/exp-notes/5-pay-idempotency.md` |

## Build and engine
| Item | Notes |
|---|---|
| Use what Hermes 260318099 added | `docs/hermes-features.md`: runtime data and `ISerialization` (JSI), faster JSON / Map / Set, `FinalizationRegistry`, built-in `TextDecoder`, bytecode version 99 (an OTA rule for milestone 4), with a suggested order. |
| Build `libjsi.so` from source | The RN repo has the JSI source for the same release (`node_modules/react-native/ReactCommon/jsi/jsi/jsi.cpp`). Today we ship the prebuilt `libjsi.so` copied from `react-android:0.87.1`, which is the exact binary Hermes was built against. Building it ourselves removes a copied binary but must produce an identical ABI. |
| Images: `zn://` handles, placeholders | Step 1.4 loads http(s) and `asset:` with Coil. Fallback and shimmer while loading: done in step 3.7. `zn://` handles (ARCHITECTURE §15.4): moved to the plugin plan (`docs/plugins.md` P.2). |
| Icons: strokes and an icon-set importer | Step 1.4 draws fill paths from "minX minY w h\|d" strings. Stroke icons (Lucide etc.) and a script that turns a folder of SVGs into `icons.ts` are still to do. |
| Upgrade Coil | **Done 2026-10-30:** Coil 3.6.3 with OkHttp 5.5.1. Coil 3.6 needs Kotlin stdlib 2.4, so the Kotlin compiler went 2.2.0 → 2.4.21 (the Compose compiler plugin version in `android/build.gradle.kts` sets it). |
| Dynamic transforms | **Done (step 3.6):** transforms can change at runtime and animate. |
| A bigger animation set (Pavan, 2026-10-30: after the framework is complete) | Layout animations (size / position changes, a leaving element's space closing smoothly, list reorders), keyframes (see "UI and animation" above), staggered list entrances, animated text colour and padding, looping animations (pulse, spinner), shared-element transitions between screens, gesture-driven values (ARCHITECTURE §10.3), animation callbacks to JS (`onAnimationEnd`). |
| Row overflow squeezes the last child | A `Row` wider than its space gives its last child only what is left (its text wraps); React Native keeps children at their size (`flexShrink: 0`) and lets them overflow. Match RN. Found in step 3.6. |
| Absolute fill in a Stack | `position: "absolute"` with `top / start / end / bottom: 0` doesn't stretch the element to the Stack's size (RN does). Found in step 3.6. |
| Slot cells as arrays | `ZnInstance` keeps slot cells in a hash map; switch to an array sized from the template when it matters (lists, step 2). |
| Direct `ByteBuffer` for batches | Batches cross JNI as a `byte[]` copy today (small). Switch to a direct buffer if measurements show a cost. |
| Generate the Baseline Profiles | **Runtime profile done (2026-11-11):** recorded on the Android 13 emulator with `bun run tools/baseline-profile.ts` (journeys: Home list, amount screen and UPI sheet, Offers, tabs, components, input), committed in `android/runtime/src/main/generated/baselineProfiles/` (startup rule 6). Still open: the sample's own profile, and the before / after proof on a slow phone. History: the `:baselineprofile` module was ready, but generation fails on the Lava: after macrobenchmark force-stops the app, the ROM drops the "save profile" broadcast even once the app is relaunched (`result=0`; `am kill` instead of force-stop works). Not a `targetSdk` issue. Run it once on any other Android 13+ phone or an emulator: `.\gradlew.bat :sample:generateBaselineProfile :runtime:generateBaselineProfile`, then measure with and without the profile. |
| Lint in the step checklist | `NewApi` would have caught the API-35 crash in step 1.1. Run `.\gradlew.bat :runtime:lintDebug :sample:lintRelease` (0 errors at step 1.1). |
| Upgrade the Compose BOM | **Done (step 2.0b, 2026-10-29):** BOM `2026.09.00` (Compose 1.12.1), re-measured. |
| Hermes version | **Done 2026-10-30:** `260318099.0.5` (RN 0.88.1's Hermes), with its JSI headers, `libjsi.so` and `hermesc` (npm `hermes-compiler`). Cost: `libhermesvm.so` +228 KB raw, about +100 KB in download size. Next upgrade: same four together (`core/third_party/jsi/README.md`). |

## Production areas not built yet (listed 2026-10-30; Pavan: for later, in this order unless an app needs one sooner)

**Update 2026-10-31:** these are now planned as plugins and core plumbing in **`docs/plugins.md`** (sections 6–7, steps
P.1–P.6, decisions D1–D7 open). This table is kept as the earlier notes; plugins.md is the current plan.
| # | Area | Notes |
|---|---|---|
| 1 | **QR scan / camera** | Core for ZeroBill (Scan & pay). **An optional package, not core:** `@zero-native/scanner` + an Android module that registers a `NativeView` (ARCHITECTURE §15.2, to build first; also used later by WebView, maps, etc.). Apps that don't add it pay 0 bytes; the capability manifest lists it with its version, so a bundle using it never runs on an app without it. Inside: CameraX preview + **bundled** ML Kit barcode (~2.4 MB; Play-services-downloaded models fail to install on low-storage phones, Pavan 2026-10-30). Sends `onScan(text)` once, then pauses until JS calls `resume()`; torch, gallery-image scan, camera permission handled natively. **Stale frames rule** (an RN / Flutter bug ZeroBill hit: going back to the scan screen scanned an old QR at once): every pause (scan sent, screen covered, app in background) bumps a generation number and unbinds the analyser; a result is sent only if its generation is current **and** its frame was captured after the screen became visible again. Test: scan, go to the next screen, come back pointing at the same QR: no scan until `resume()`, and none from frames before returning. iOS: AVFoundation, no extra library. |
| 2 | **Back stack after the app is killed in the background** | Done in step 3.9. |
| 3 | **JS for background work** (FCM messages, WorkManager jobs) | Like RN's Headless JS: native starts the one JS runtime without a screen and calls a registered JS task (`registerTask("pushReceived", async (data) => ...)`), with a time limit; the task's code ships in the bundle, so it can be updated over the air. Main process only (as storage). Needs: start without UI, a task registry, "done" signal back to native, and the rule that UI launches (not tasks) count for the OTA watchdog (already in `docs/ota.md`). |
| 4 | **WebView** | Yes, mostly another registry component (`<WebView src onMessage onNavigation>`), but with its own rules: it is a classic Android View inside Compose (`AndroidView`), cookies / storage are per app, file upload and camera for KYC need `onShowFileChooser` + permissions, payment pages need `onNavigation` to catch the return URL, and the JS ↔ page bridge must check the page's origin. |
| 5 | **Screenshot blocking and certificate pinning** | Not built. Screenshots: a route option `secure: true` sets `FLAG_SECURE` while that screen is on top (hides it from screenshots, screen recording and the recent-apps preview). Pinning: an OkHttp `CertificatePinner` set **in Kotlin app config** (`ZnFetch.pins("api.example.com", "sha256/...")`), not from JS, so a bundle can't turn it off; always two pins (current + backup key). |
| 6 | **Low memory, dark mode, right-to-left** | Low memory: `onTrimMemory` → clear Coil's memory cache and the list row caches. Dark mode: colour tokens with a light and a dark value (ARCHITECTURE §5.4), switched natively. RTL: `start` / `end` already exist; check icons, gradients (`to left/right`) and the keypad. |
| 6b | **Native media pipeline** (Pavan, 2026-10-30) | Camera / gallery photos, 4K images, video and PDFs stay native and reach JS only as `zn://` handles (ARCHITECTURE §15.4). Build the pieces apps need around them: resize / compress / crop / rotate natively (`Media.resize(handle, { maxSide: 1600, quality: 0.8 }) → handle`), EXIF orientation, upload a handle with `fetch` (body = handle, streamed from the file, no bytes in JS), thumbnails for lists, and clean-up of temp handles. KYC and receipt photos are the first users. |
| 7 | **Research the building blocks apps use** (Pavan's idea) | Ask Gemini (`agy`) to list what RN / Flutter apps commonly build custom views from: a `<Canvas>` with draw commands (Flutter's `CustomPainter`), clip / mask, blur, blend modes, gradients, paths, gesture detectors, layout builders. Building the common low-level pieces once means app UI changes rarely need a framework (registry) change, so OTA bundles rarely need a newer app. |

## RN gaps pack: parked (Pavan, 2026-11-09)
Items 4 and 5 of the RN gaps pack. Items 1-3 (fontFamily, flexWrap, List numColumns) are built (registry 24). Pavan
parked these two when the focus moved to iOS and OTA for ZeroBill. The API proposal with options is in the session
notes (`rn-gaps-header-datepicker-proposal-2026-11-09.md`); the short form:

| Item | Proposed (Opus's pick) | Notes |
|---|---|---|
| **Header bar** (RN's `headerShown`, `headerTitle`, `headerLeft` / `headerRight`, back button, large collapsing title) | Not in the framework for now: the app writes its own `AppHeader.tsx` from Row / Text / Pressable, `insets().top`, `nav.back()`, and motion values for a collapsing title. If more zn apps need one: a `<ScreenHeader>` TSX component in `@zero-native/ui` with RN's prop names (no native code, no registry ids). | A route option (`header: {...}` + `useHeader()`, RN's `setOptions`) was the other option: it needs new native work to show JSX in a native bar. |
| **Date / time picker** (`@react-native-community/datetimepicker`) | A plugin `@zero-native/datetimepicker`: Android's own `DatePickerDialog` / `TimePickerDialog` (what RN uses; no new dependency), both RN forms (`DateTimePickerAndroid.open({...})` and `<DateTimePicker>` that opens on mount), `onChange(event, date)` with `"set"` / `"dismissed"`, `mode` date / time / datetime (date then time), `minimumDate` / `maximumDate`, `is24Hour`. Colour from the app theme. | Other options: the Material 3 Compose picker (adds material3), or a picker drawn in TSX (days of work). iOS later with UIDatePicker. |

## Project
| Item | Notes |
|---|---|
| Public name, npm scope, license (MIT suggested), GitHub org | Check the `zero-native` clash with `vercel-labs/native` first. |
| iOS renderer | After Android v1. Keep checking designs against SwiftUI on paper. |
