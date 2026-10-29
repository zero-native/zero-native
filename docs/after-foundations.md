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
| Children for user components (`<Card>…</Card>`) | Build error today. Needs a "children" anchor passed as a prop. |
| Fragments `<>…</>` and several roots | Build error today. |
| Nested elements inside `<Text>` (spans) | Build error today. |
| Conditional entries in style arrays (`[s.a, on && s.b]`) | Build error today with a hint to use a ternary inside the style object. |
| Row items as signals | `.map` mounts a row again when its item object changes (same key). Per-row signals would update in place. |
| Timers owned by the screen | ARCHITECTURE §14 says a screen's timers stop when the screen is removed; `setTimeout` doesn't attach to owners yet. |
| More dynamic props | Text, colour, background, opacity, src, disabled, and (registry v4, step 2.3) per-edge padding can change at runtime. Sizes, margins, gap etc. still need layout-phase slots like padding's (`docs/styling-and-layout.md` §8.3; `layoutPadding` in `ZnTemplate.kt` is the pattern). |
| Safe-area gaps (step 2.3) | Insets reach JS after the first frame, so a full-bleed **start** screen would draw its header without the inset for one frame (send them with START). No horizontal full-bleed option (`safeArea` has top / bottom only). Keyboard inset (`keyboard: 'resize'`) comes with `TextField`. |
| Types for JSX | `@zero-native/ui` has loose types; a proper JSX namespace and tsconfig for editors. |

## Data and porting
| Item | What | Source | Notes |
|---|---|---|---|
| Native list data source | SQLite / mmap rows read on an I/O thread straight into the row cache (10 lakh rows) | `docs/lists.md` §6 | v1.1. |
| NativeWind `className` translator | Compile-time Tailwind subset → style keys, for porting ZeroBill RN code | `docs/styling-and-layout.md` §9 | v1.1, not decided. |
| Cronet / HTTP/3 backend for `fetch` | Optional network backend | ARCHITECTURE §14 | Only if needed. |

## Flows (deferred by Pavan to the framework build)
| Item | What | Source |
|---|---|---|
| Restored flows must finish | Restored runs logged 0 `/verify` calls in v0; the flow tests must assert `/verify` happens and a final screen shows | `docs/v0-findings.md` §D |
| `/pay` died mid-call | No `ztc` to verify with; UPI never opened, so "payment not started → try again" | `docs/v0-findings.md` §D |
| Backend idempotency key for `/pay` | Would make `/pay` `keyed` | `experiments/exp-notes/5-pay-idempotency.md` |

## Build and engine
| Item | Notes |
|---|---|
| Build `libjsi.so` from source | The RN repo has the JSI source for the same release (`node_modules/react-native/ReactCommon/jsi/jsi/jsi.cpp`). Today we ship the prebuilt `libjsi.so` copied from `react-android:0.87.1`, which is the exact binary Hermes was built against. Building it ourselves removes a copied binary but must produce an identical ABI. |
| Images: `zn://` handles, placeholders | Step 1.4 loads http(s) and `asset:` with Coil. `zn://` handles (ARCHITECTURE §15.4) and placeholder / error images are still to do. |
| Icons: strokes and an icon-set importer | Step 1.4 draws fill paths from "minX minY w h\|d" strings. Stroke icons (Lucide etc.) and a script that turns a folder of SVGs into `icons.ts` are still to do. |
| Upgrade Coil | Pinned at 3.0.4 (the v0 size check); lint reports 3.6.3. Upgrade together with the Compose BOM. **Scheduled: milestone 2 step 2.0b.** |
| Dynamic transforms | `transform` is build-time only; press-scale and animated transforms need slot-bound transforms (draw phase). |
| Slot cells as arrays | `ZnInstance` keeps slot cells in a hash map; switch to an array sized from the template when it matters (lists, step 2). |
| Direct `ByteBuffer` for batches | Batches cross JNI as a `byte[]` copy today (small). Switch to a direct buffer if measurements show a cost. |
| Generate the Baseline Profiles | The `:baselineprofile` module is ready, but generation fails on the Lava: after macrobenchmark force-stops the app, the ROM drops the "save profile" broadcast even once the app is relaunched (`result=0`; `am kill` instead of force-stop works). Not a `targetSdk` issue. Run it once on any other Android 13+ phone or an emulator: `.\gradlew.bat :sample:generateBaselineProfile :runtime:generateBaselineProfile`, then measure with and without the profile. |
| Lint in the step checklist | `NewApi` would have caught the API-35 crash in step 1.1. Run `.\gradlew.bat :runtime:lintDebug :sample:lintRelease` (0 errors at step 1.1). |
| Upgrade the Compose BOM | We use `2024.09.00` (what v0 verified); lint reports `2026.09.00`. Upgrade in one step and re-measure startup and frames. **Scheduled: milestone 2 step 2.0b** (needed by Navigation 3). |
| Hermes version | Lint reports `hermes-android 260318099.0.5`. We stay on `250829098.0.17` because JSI headers, `libjsi.so` and `hermesc` must all match; upgrading means replacing all four together (`core/third_party/jsi/README.md`). |

## Project
| Item | Notes |
|---|---|
| Public name, npm scope, license (MIT suggested), GitHub org | Check the `zero-native` clash with `vercel-labs/native` first. |
| iOS renderer | After Android v1. Keep checking designs against SwiftUI on paper. |
