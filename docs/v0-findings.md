# v0 findings: everything the experiments taught us

Every issue, bug and lesson found while Gemini 3.8 Flash ran the v0 experiments and spikes (2026-10-27 to 10-29),
with the root cause and where the spec now handles it. Reviewed by Claude; corrections to the original reports are
marked **Review**. Source files are listed per section.

How to use this file: before building any part of the framework, read the sections for that part. Most of these bugs
will try to come back.

---

## A. Size (exp 1)
Sources: `exp-notes/1-result-exp1-size.md`, `RESULTS.md`.
- **Result:** the app shell without React Native (Compose + Hermes + bundled ML Kit + Firebase + Play services, no
  screens) is a **6.42 MB** Play download, vs 14.88 MB for the RN app and 13.06 MB for Flutter. **Review:** Claude
  rebuilt the device APKs and got exactly 6,422,175 bytes. Compare with RN + packaging fix (≈13.0 MB), not 14.88.
  A full app with screens, assets and its bundle is estimated at 8–9 MB (not measured).
- material3 adds 0.58 MB → we build on Compose foundation (ARCHITECTURE §9.2).
- The scanner (ML Kit barcode + CameraX + doc scanner) is 2.30 MB, the biggest single part. It stays bundled
  (unbundled ML Kit caused Play low-storage install blocks on old phones).
- **Review: the Hermes share is ≈0.83 MB, not 0.39 MB.** Variant D ("A minus Hermes") was a bad build: its master
  APK had two dex files and was 1.5 MB bigger. Lesson: when comparing variants, check that only the intended part
  differs (`docs/startup-and-performance.md` §3).
- `libjsi.so` is not in the Hermes AAR; v0 vendored it from `react-android` (same binary RN ships).
- `libc++_shared.so` is needed by other libraries (MMKV) anyway, so it isn't a Hermes cost.

## B. Renderer (exp 2)
Sources: `exp-notes/2-result-exp2-renderer.md`, `exp-notes/hermes-bridge.md`.
- **Result:** tap → update p50 0.97 ms / p95 2.08 ms; typing a digit recomposed only the changed `Text` nodes;
  batch apply 0.38 ms; cold start 222 ms (`am start`) / 158 ms ready with AOT. All release builds.
- **Hermes `MicrotaskQueue` is off by default** (`hermes/Public/RuntimeConfig.h`). Without
  `withMicrotaskQueue(true)` and `drainMicrotasks()` after every entry into JS, Promise callbacks run late or never.
  → ARCHITECTURE §7.2.
- **Review:** the RN tap-latency numbers in the report ("~35–45 ms") are estimates; the RN app has no tap
  instrumentation. Memory (59 MB vs RN 181 MB) and cold start compare a one-screen prototype with the full app, so
  they are directional only.

## C. Navigation and the UPI handoff (exp 3)
Sources: `exp-notes/3-result-exp3-upi.md`, `exp-notes/compose-lifecycle.md`.
- **Compose keeps animating while the activity is paused.** In AndroidX `WindowRecomposer.android.kt`, `ON_PAUSE`
  does nothing; the frame clock pauses only on `ON_STOP`. Behind PhonePe's translucent launch window, frames kept
  coming at p50 16.6 ms with 0 `onStop` calls. So a zero-native app needs **no Choreographer frame pump and no native
  overlay**. (The RN app still needs both; this is only true for zero-native.)
- The 2.4 s "slow UPI app" fallback screen works as a plain signal change.
- **Building a whole screen through ops took 17 ms** on forward navigation (a full frame). → v1 inflates templates
  natively; budget ≤ 8 ms (ARCHITECTURE §19).
- **Id collision bug:** screen root ids started at 100 and node ids at 1. When screen 1 reached 99 nodes, screen 2's
  root id collided with a node id, creating a cycle (`StackOverflowError`). → ARCHITECTURE §8.3: native-allocated and
  JS-allocated ids use separate ranges (native: top bit set); never "magic offsets".
- **Review:** the JS-driven progress bar asked for in the brief has no log evidence; only the native bar was logged.
  Progress animations should be native anyway (ARCHITECTURE §10).
- Harmless: the end of the exp 3 report calls experiment 4 "OTA updates"; exp 4 is flows and process death.

## D. Flows and process death (exp 4 + gaps G1/G2)
Sources: `exp-notes/4-result-exp4-flow.md` (§6 has G1), `exp-notes/5-pay-idempotency.md`,
`exp-notes/4b-keypad-zombie-timers-architecture.md`, `exp4-flow/run-gap-scenarios.ps1`.
- **Result:** 17 scenarios (S1, S2, S3, S3b, S3c, S4, S4b, S4c, S4d, S7, S8, S11, S12a/b, S17a/b, SM), G1 ones run 3
  times each, with "Don't keep activities" and "No background processes" on. **Never more than one `/pay` and one UPI
  launch per attempt.** The `/verify` request matches the RN app's format byte for byte.
- **Translucent windows protect the caller.** While the UPI app shows a translucent window, our activity is only
  paused and Android treats it as visible (`oom_adj` ~100), so it is not killed. Real process-death tests need the
  UPI app's opaque screen. v0 built `P2pUPIapp` (1.8 s translucent spinner, then an opaque payment screen with
  `FLAG_ACTIVITY_FORWARD_RESULT`) for this. → keep it in the framework's test kit (ARCHITECTURE §12.4).
- **Singleton JS thread bug:** a `HandlerThread` in a Kotlin `object`, quit in `onDestroy`, threw
  `IllegalThreadStateException` when the Activity was recreated in the same process. v0's fix (new thread per
  Activity) restarts JS and loses state. → ARCHITECTURE §8.2: **one runtime per process**; Activities are view hosts.
- **Activity results arrive before JS is ready.** Writing the raw result into FlowStore first, then telling JS,
  works. → ARCHITECTURE §12.4.
- **Zombie timer bug:** holding backspace past "0", releasing, then typing erased the new digit. `setInterval` was
  built by chaining `setTimeout`s and returned only the first id, so `clearInterval` cancelled a timer that had
  already fired while the live one kept running forever. → ARCHITECTURE §14 (logical timer handles, `clear*` always
  wins), §5.2 (`set()` ignores equal values), §5.3 (`onPressOut` fires on cancel; native key repeat).
- **`/pay` is not idempotent (G2).** The backend (`payments-api`,
  the payment handler) creates a new payment row and gateway request on every call; no idempotency
  header is read. So `/pay` is a `once` effect. The report includes a backend proposal (an `X-Idempotency-Key`
  header, keys kept 15 minutes) that would make it `keyed`; not decided, out of framework scope.
- **Open, deferred by Pavan to the framework build:** in restored runs (S4b, S4c, S12b, S17b) the mock logged
  0 `/verify` calls; and when the app dies during `/pay` there is no `ztc` to verify with (money can't have moved,
  since the UPI app never opened). The framework's flow tests must cover both.
- **Review:** the 91 ms "restore" time was a debug build with no stated clock start; re-measure in release.

## E. Lists (Dish A, Frontier 2, list deep-dive, Argon's answers)
Sources: `gemini-flash-individual-experiments/dish-a-virtual-list.md`, `frontier-2-zn-ui-slot-virtual-list.md`,
`zero-jitter-virtual-list-deepdive.md`, `gemini-4-argon-problem-solving-suggestions.md`,
`argon-solutions-verification.md`, `ten-lakh-records-architecture-proposal.md`.
Full rules: `docs/lists.md`.
- **Eager lists crash.** 10,000 items as nodes: 110,000 nodes, ~1.2 million ops, ~350 MB JSON → `OutOfMemoryError`;
  before that, 424 ms blocking GC pauses (38 dropped frames).
- **Synchronous JSI pull from the UI thread ("Option B") is rejected:** Hermes is single-threaded (crash), and a lock
  makes the UI thread wait for JS and GC (jank).
- **Sliding window works:** 50 rows of values over the bridge, a new window when the visible range moves by 8 rows,
  ~15 rows prefetched; Dalvik heap ~5.7–6.2 MB, no blocking GC, 90 fps.
- **Placeholders must have the same height** as real rows, or rows jump when data arrives.
- **Generic node trees per row jank** (18–25 ms per frame, 14–26% smooth frames) because of hash-map lookups and
  observable reads per node per row. **One shared row template with values looked up per row** ran at 2.8–4 ms per
  frame. → the fast template interpreter (`docs/lists.md` §4); **no Kotlin code generation** (it would break OTA).
  **Review:** the reports' "compiled `.zn.ui` = 2 ms / 120 fps" numbers are projections, not measurements.
- **10 lakh rows can't live in the JS heap** (~350–500 MB). → native data source on an I/O thread, v1.1
  (`docs/lists.md` §6). "Dilemma C" read SQLite on the UI thread; that part is rejected.

## F. The slot-token leak
Source: `argon_opus_architecture_report_modifiers_vs_props.md` §2.
- During fast or reverse scrolling, rows outside the data window showed **`{{slot:merchant}}`** on screen. The v0
  renderer stored slots as strings like `"{{slot:x}}"` and, when the value was missing, returned the raw string.
- → v1 has no string tokens: slots are ids; a missing value shows the slot's placeholder (`docs/lists.md` §3).

## G. Styling: the modifier report
Source: `argon_opus_architecture_report_modifiers_vs_props.md`.
- Four visual bugs on the Passbook screen: status bar overlap, cards touching the screen edges, the slot-token leak,
  and the navigation bar covering the last cards.
- **Review of the causes:** the bars were an insets bug (§H); the edge-touching cards were missing padding after a
  refactor; the token leak was a renderer fallback bug (§F). None was caused by modifier chaining itself.
- The report's conclusion still holds: order-dependent chains cause bugs and feel foreign in JSX. → `style` props with
  RN names in one fixed order (`docs/styling-and-layout.md`). **No Yoga**: Compose and SwiftUI do the layout.
- **Review:** the report assumes ZeroBill uses `StyleSheet`; it mostly uses NativeWind `className`. A compile-time
  class translator is a v1.1 option.

## H. Safe areas
Source: same report §6.
- A JS `SafeAreaView` fed by insets over the bridge caused a blank screen and status-bar / nav-bar overlap with
  edge-to-edge on.
- → safe areas are handled by native code per route (`docs/styling-and-layout.md` §6). **Review:** the report's
  fix used material3's `Scaffold`; we use foundation's `windowInsetsPadding` instead.

## I. Native resources: `zn://` handles
Sources: `gemini-4-argon-problem-solving-suggestions.md` Part 2, `argon-solutions-verification.md` §3.
- Passing UPI app icons as Base64 through JS costs 40–100 KB of JS heap per icon and copies pixels three times.
- `zn://app-icon/<package>` strings resolved natively (a resource registry + a Coil mapper) rendered 9 real UPI app
  icons with zero pixel data in JS. → ARCHITECTURE §15.4. Added rule: memory-only handles die with the process, so
  **flows may only store file-backed handles** (a KYC photo must survive process death).

## J. Gesture bottom sheet (Frontier 1)
Source: `gemini-flash-individual-experiments/frontier-1-gesture-bottom-sheet.md`.
- Native drag, velocity, rubber-band and spring on the UI thread: 2.8–4.2 ms frames, **0 bridge events during the
  drag**, one event when it settles. Confirms native components for gestures (ARCHITECTURE §10.3).
- **Bug pattern:** the native sheet wrote `visible = false` directly into JS-owned state on dismiss. Native and JS can
  then disagree. → ARCHITECTURE §9.7 (controlled components: native sends an event, JS owns the value).

## K. Shared-element transitions (Frontier 4)
Source: `gemini-flash-individual-experiments/frontier-4-shared-element-hero-transitions.md`.
- A list row expanding into a detail header at 90 fps with Compose `SharedTransitionLayout`. → v1, optional
  (`heroTag`), ARCHITECTURE §11.
- Cautions: the Compose shared-transition API is still marked experimental; the prototype used its own
  `AnimatedContent` navigation host, so this must be re-checked with Navigation 3; the prototype put `onPress` on a
  `Row`, which v1 doesn't allow (taps only on `Pressable` / `Button`).

## L. Hot reload (Dish B)
Source: `gemini-flash-individual-experiments/dish-b-fast-refresh.md`.
- Save → screen in **127 ms**: Bun build 5 ms, `hermesc` 74 ms, send over WebSocket, drop and recreate the Hermes
  runtime (~3 ms), evaluate (~45 ms), re-render. Same process, no Activity restart.
- Restarting the runtime is fine **for development only**; it must re-read FlowStore and stay on the current route.
  → ARCHITECTURE §17.

## M. PrimJS vs Hermes (Dish C)
Source: `gemini-flash-individual-experiments/dish-c-primjs-analysis.md`.
- PrimJS is ~300 KB smaller (stripped `.so` ~520 KB vs ~830 KB) and starts about as fast. Its main reason to exist in
  Lynx (running JS on the UI thread for gestures) doesn't apply to us: gestures are native Compose. → Hermes stays.
- The report's "0 KB dirty RAM via mmap" is Hermes's capability; the v0 prototype actually read bytecode into a Java
  byte array. → `docs/startup-and-performance.md` rule 5.

## N. Startup (measured by Claude, 2026-10-29)
Source: `docs/startup-and-performance.md` §4.1.
- exp4-flow looked slow (1,318 ms) because it was a **debug** build. Release: ~400–420 ms vs Flutter ~300–330 ms.
- The extra time came from prototype choices: 10,000 fake rows built at module load, UPI app listing + icons on the
  main thread, the whole app's bytecode evaluated at start, a "Loading…" screen, and building the screen through JSON
  ops. → startup rules 1–8.

## P. Building v1 (milestone 1, from 2026-10-29)
Lessons found while building the real framework. Details in `docs/milestones.md` (log).
- **Hermes V1 API:** `isHermesBytecode` (and `getBytecodeVersion`, `prefetchHermesBytecode`) are on the root API:
  `jsi::castInterface<IHermesRootAPI>(makeHermesRootAPI())`, not static methods of `HermesRuntime`.
- **Prefab + library module:** CMake copies linked prefab `.so` files into the library's output, and the Hermes AAR
  ships them too → "2 files found with path lib/arm64-v8a/libhermesvm.so". The runtime library excludes its copies.
- **R8 and fbjni:** `libhermesvm.so` loads `libfbjni.so`, whose `JNI_OnLoad` looks up Java classes by name. R8
  removed them and the **release** app crashed at start (`ClassNotFoundException: com.facebook.jni.HybridData$Destructor`).
  Keep rules ship in `android/runtime/consumer-rules.pro`. Debug builds hide this; always test release.
- **Bun transpiler** removes a bare final expression (`answer`) as dead code.
- **Hermes block scoping is off by default.** Without the hidden `hermesc` flag `-Xes6-block-scoping`, `let` and
  `const` behave like `var`: closures created in a loop all see the last value (every `console` level logged as
  "error"). `tools/hermesc.ts` always passes the flag. The compiler (step 1.3) must keep using it, and a JS test
  should cover loop closures on the device.
- **`SystemClock.uptimeNanos()` is API 35+.** The release app crashed on the Lava (Android 14). Use `System.nanoTime()`.
  Lint (`NewApi`) would have caught it: run `.\gradlew.bat lint` before each step is called done.
- **PowerShell 5.1 + adb:** adb prints progress on stderr; with `$ErrorActionPreference = 'Stop'` that becomes an
  error. Scripts use `'Continue'` and check `$LASTEXITCODE`.

## O. Process and testing lessons
- Always say which build was measured and where the clock starts.
- "Don't keep activities" was left on after exp 4 testing; it changes the whole phone's behaviour. Turn it off after
  process-death tests.
- Experiments should stay small. `exp4-flow` grew into a pile of v0 shortcuts (string slot tokens, JSON ops,
  hand-written cards, taps on `Row`); it is frozen as a reference, and v1 starts in the real repo layout.
