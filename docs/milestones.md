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

## Tests
| What | How | Where |
|---|---|---|
| C++ core (batch, coalescing, ticks, timers) | `.\tools\run-core-tests.ps1` (builds with the NDK, runs on the phone) | `core/tests/core_tests.cpp` |
| JS (runtime timers/events, template writer, registry drift) | `bun test packages` at the root | `packages/*/test/` |
| Kotlin (batch reader, template reader) | `.\gradlew.bat :runtime:testDebugUnitTest` in `android/` | `android/runtime/src/test/` |
| Lint | `.\gradlew.bat :runtime:lintDebug :sample:lintDebug` | 0 errors expected |
| On the phone | sample app: JS timer, taps, "Recreate activity" | `android/sample`, `examples/sample` |
| OTA and launches on the phone (38 cases, ~30 min) | `bun run ota:phone` (debug sample, phone unlocked) | `tools/ota/phone-matrix.ts`, `docs/ota-test-matrix.md` |
| Core plugin parts and the official plugins on the phone (~15 min without hands) | `bun run tools/plugin-phone.ts --no-hands`, then `--hands` | `tools/plugin-phone/` |

## Log
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
