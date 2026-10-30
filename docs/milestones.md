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
| 2.6b | Built-in modules on top: `Os.upiApps` + `zn://app-icon`, small `Os` methods, `launchActivity` with results, permissions (`docs/cross-communication/2026-10-29-native-modules-brief.md`); `fetch` and codegen later | Gemini | next |
| 2.7 | FlowStore (C++): two-slot crash-safe file, checksums, growth; JS `flowStore` | Claude | **done 2026-10-29** |
| 2.8 | ~~Flows engine~~ (parked 2026-10-30, `docs/after-foundations.md`). Instead: a sample checkout with the save-then-verify pattern (`docs/guide-notes.md` §16) against the mock UPI app, including the app being killed while the UPI app is open | Claude | after 2.6b (`launchActivity`) |
| 2.9 | Release measurements; close the milestone | Gemini, Claude reviews | |

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

**Milestone 4 (OTA): design in `docs/ota.md`** (steps 4.0–4.9). 4.0 done 2026-10-30: Pavan took D1–D5 as
recommended; logged in ARCHITECTURE §16 / §24. 4.1 done 2026-10-30 (log below). Next: 4.2 (capability manifest),
Claude.
Order agreed 2026-10-30: framework first (milestone 4), the 2.8 sample checkout later; Gemini does 3.7 / 3.8.

Later milestones: **4** OTA (signed bundles, bundle pool, boot guard, capability manifest, "an older app ignores a
newer bundle" test, release crash traces mapped back to TSX); **5** ZeroBill checkout pilot with a full-app size
measurement. Not planned yet: the Hermes debugger (Chrome DevTools), the flow engine (parked).
Parked ideas: `docs/after-foundations.md`.

## Tests
| What | How | Where |
|---|---|---|
| C++ core (batch, coalescing, ticks, timers) | `.\tools\run-core-tests.ps1` (builds with the NDK, runs on the phone) | `core/tests/core_tests.cpp` |
| JS (runtime timers/events, template writer, registry drift) | `bun test packages` at the root | `packages/*/test/` |
| Kotlin (batch reader, template reader) | `.\gradlew.bat :runtime:testDebugUnitTest` in `android/` | `android/runtime/src/test/` |
| Lint | `.\gradlew.bat :runtime:lintDebug :sample:lintDebug` | 0 errors expected |
| On the phone | sample app: JS timer, taps, "Recreate activity" | `android/sample`, `examples/sample` |

## Log
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
