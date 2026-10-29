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
