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
| Timers owned by the screen | ARCHITECTURE §14 says a screen's timers stop when the screen is removed; `setTimeout` doesn't attach to owners yet. |
| More dynamic props | Text, colour, background, opacity, src, disabled, and (registry v4, step 2.3) per-edge padding can change at runtime. Sizes, margins, gap etc. still need layout-phase slots like padding's (`docs/styling-and-layout.md` §8.3; `layoutPadding` in `ZnTemplate.kt` is the pattern). |
| Deep-link query values | `zn://sample/dev/fetch?auto=1` reaches the route with params `{}`: query values are dropped (found in step 3.4) | Pass them as optional params, or document that deep links carry path params only. |
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
| Result hook | `ZnActivityResults.onResult` (step 2.6b) is the single entry point for results from other apps; the engine would save each result to FlowStore before JS hears about it | ARCHITECTURE §12.4 |
| Restored flows must finish | Restored runs logged 0 `/verify` calls in v0; the flow tests must assert `/verify` happens and a final screen shows | `docs/v0-findings.md` §D |
| `/pay` died mid-call | No `ztc` to verify with; UPI never opened, so "payment not started → try again" | `docs/v0-findings.md` §D |
| Backend idempotency key for `/pay` | Would make `/pay` `keyed` | `experiments/exp-notes/5-pay-idempotency.md` |

## Build and engine
| Item | Notes |
|---|---|
| Use what Hermes 260318099 added | `docs/hermes-features.md`: runtime data and `ISerialization` (JSI), faster JSON / Map / Set, `FinalizationRegistry`, built-in `TextDecoder`, bytecode version 99 (an OTA rule for milestone 4), with a suggested order. |
| Build `libjsi.so` from source | The RN repo has the JSI source for the same release (`node_modules/react-native/ReactCommon/jsi/jsi/jsi.cpp`). Today we ship the prebuilt `libjsi.so` copied from `react-android:0.87.1`, which is the exact binary Hermes was built against. Building it ourselves removes a copied binary but must produce an identical ABI. |
| Images: `zn://` handles, placeholders | Step 1.4 loads http(s) and `asset:` with Coil. `zn://` handles (ARCHITECTURE §15.4) and placeholder / error images are still to do. |
| Icons: strokes and an icon-set importer | Step 1.4 draws fill paths from "minX minY w h\|d" strings. Stroke icons (Lucide etc.) and a script that turns a folder of SVGs into `icons.ts` are still to do. |
| Upgrade Coil | **Done 2026-10-30:** Coil 3.6.3 with OkHttp 5.5.1. Coil 3.6 needs Kotlin stdlib 2.4, so the Kotlin compiler went 2.2.0 → 2.4.21 (the Compose compiler plugin version in `android/build.gradle.kts` sets it). |
| Dynamic transforms | **Done (step 3.6):** transforms can change at runtime and animate. |
| A bigger animation set (Pavan, 2026-10-30: after the framework is complete) | Layout animations (size / position changes, a leaving element's space closing smoothly, list reorders), keyframes (see "UI and animation" above), staggered list entrances, animated text colour and padding, looping animations (pulse, spinner), shared-element transitions between screens, gesture-driven values (ARCHITECTURE §10.3), animation callbacks to JS (`onAnimationEnd`). |
| Row overflow squeezes the last child | A `Row` wider than its space gives its last child only what is left (its text wraps); React Native keeps children at their size (`flexShrink: 0`) and lets them overflow. Match RN. Found in step 3.6. |
| Absolute fill in a Stack | `position: "absolute"` with `top / start / end / bottom: 0` doesn't stretch the element to the Stack's size (RN does). Found in step 3.6. |
| Slot cells as arrays | `ZnInstance` keeps slot cells in a hash map; switch to an array sized from the template when it matters (lists, step 2). |
| Direct `ByteBuffer` for batches | Batches cross JNI as a `byte[]` copy today (small). Switch to a direct buffer if measurements show a cost. |
| Generate the Baseline Profiles | The `:baselineprofile` module is ready, but generation fails on the Lava: after macrobenchmark force-stops the app, the ROM drops the "save profile" broadcast even once the app is relaunched (`result=0`; `am kill` instead of force-stop works). Not a `targetSdk` issue. Run it once on any other Android 13+ phone or an emulator: `.\gradlew.bat :sample:generateBaselineProfile :runtime:generateBaselineProfile`, then measure with and without the profile. |
| Lint in the step checklist | `NewApi` would have caught the API-35 crash in step 1.1. Run `.\gradlew.bat :runtime:lintDebug :sample:lintRelease` (0 errors at step 1.1). |
| Upgrade the Compose BOM | We use `2024.09.00` (what v0 verified); lint reports `2026.09.00`. Upgrade in one step and re-measure startup and frames. **Scheduled: milestone 2 step 2.0b** (needed by Navigation 3). |
| Hermes version | **Done 2026-10-30:** `260318099.0.5` (RN 0.88.1's Hermes), with its JSI headers, `libjsi.so` and `hermesc` (npm `hermes-compiler`). Cost: `libhermesvm.so` +228 KB raw, about +100 KB in download size. Next upgrade: same four together (`core/third_party/jsi/README.md`). |

## Project
| Item | Notes |
|---|---|
| Public name, npm scope, license (MIT suggested), GitHub org | Check the `zero-native` clash with `vercel-labs/native` first. |
| iOS renderer | After Android v1. Keep checking designs against SwiftUI on paper. |
