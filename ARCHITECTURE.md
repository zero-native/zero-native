# Architecture

zero-native (`zn`) is built around one core idea: **do as much work as possible at build time, let the OS draw the UI natively, and ship only tiny, contract-verified updates over the air.**

This document explains how the pieces fit together — from TSX source code to pixels on Android and iOS.

---

## 1. The Big Picture

```
BUILD TIME (zn build)
  Screen.tsx ──► @zeronative/compiler (TypeScript AST + Bun plugin)
                   ├─► main.zn.ui        binary UI templates (static tree, slots, events)
                   ├─► main.js ──► hermesc ──► main.hbc   Hermes bytecode (logic + signals)
                   ├─► main.zn.ui.json   routes, screen metadata, fonts
                   └─► zn-bundle.json    bundle ID, SHA-256, per-OS capability manifest

RUN TIME (one app process)
  ┌────────────── Main / UI Thread ──────────────┐        ┌────────── JS Thread ───────────┐
  │ Jetpack Compose (Android)                    │ events │ Hermes Engine (C++ adapter)    │
  │ SwiftUI + UIKit (iOS)                        │◄──────►│ Signals, screen logic, fetch   │
  │ Template Inflater (.zn.ui → flat arrays)     │ batch  │ C++ Batch Buffer (flushed/tick)│
  │ Leaf Slot Cells (1 observable per dynamic)   │◄───────│ Host API (timers, calls, nav)  │
  │ Native Navigation (Nav3 / UINavigationCtrl)  │        └──────────────┬─────────────────┘
  └──────────────────────────────────────────────┘                       │
                       ▲                                                 ▼
                       └──────── Shared C++ Core (Engine, Batch, FlowStore, MMKV) ────────┘
```

### Design Principles
1. **The OS draws everything.** No custom pixel renderer, no Yoga layout engine, no Skia requirement. Compose and SwiftUI/UIKit own layout, text shaping, scrolling, accessibility, and sheets.
2. **Structure is compiled; values are live.** Static JSX trees, static styles, and SVG draw commands are folded into binary templates at build time. At runtime, only dynamic values (*slots*) and structural ops (`MOUNT`, `MOVE`, `REMOVE`) cross the bridge.
3. **No React, no VDOM, no re-renders.** Component functions run once when mounted. Reactive expressions become fine-grained signals wired directly to leaf slot cells.
4. **JS never blocks the UI thread.** Hermes runs on its own dedicated thread. The UI thread never makes synchronous calls into JS, and renders the static screen skeleton before JS even finishes booting.
5. **OTA is a typed contract.** Every bundle declares the exact native capabilities it requires. A phone refuses any bundle it cannot safely run.

---

## 2. Build Pipeline & Bundle Format

When you run `zn build` (or `bun run sample:js`), the compiler (`compiler/`) parses your `.tsx` files using the TypeScript compiler API and separates every component into two halves:

1. **Static structure → `main.zn.ui`**
   A compact, versioned binary format (`packages/template/src/writer.ts`) containing:
   - A shared string table
   - Flat arrays of nodes (component ID, parent index, folded static props, folded static styles)
   - A slot table mapping each integer `slotId` → `(nodeIndex, propId, valueType)`
   - An event table mapping `(nodeIndex, eventId)` → `handlerId`
   - Sub-template references for conditional branches (`&&`, `? :`), list rows (`.map`, `<List>`), and child components
   - Component, prop, event, and enum IDs all come from one versioned registry (`packages/template/src/registry.ts`), code-generated to Kotlin and Swift via `bun run gen:registry`.

2. **Reactive logic → `main.hbc`**
   The compiler rewrites JSX into lightweight calls (`view()`, `slot()`, `when()`, `each()`, `list()`, `on()`) and compiles the resulting JavaScript ahead-of-time with `hermesc -O -Xes6-block-scoping` into Hermes bytecode.
   - Static style objects and `StyleSheet.create(...)` are folded at build time.
   - Unsupported style keys or props fail the build immediately with a file, line, and column error.
   - Every `@zeronative/ui` import is stripped completely — `@zeronative/ui` exists purely for types and compiler recognition.

3. **Manifest & assets → `zn-bundle.json` + `assets/`**
   Lists the bundle ID, SHA-256 hashes, routes, fonts, and the **capability requirements** (`requires.registry`, `requires.hostApi`, `requires.bytecode`, `requires.modules`, and `requires.os.{android,ios}`).

---

## 3. Runtime Threading & Lifecycle

| Thread | Owns | Never Does |
|---|---|---|
| **Main / UI Thread** | Compose / SwiftUI+UIKit, slot cells, navigation, gestures/motion | Runs JS, waits for JS, or performs disk I/O |
| **JS Thread (single, dedicated)** | Hermes runtime, signals, screen logic, timers, batch buffer | Touches UI widgets directly |
| **I/O & Call Pools** | `fetch` (dedicated thread), images (dedicated pool), `storage` / `SecureStore` / plugins | Runs JS |

### One JS Runtime per Process
The JS thread and Hermes runtime are created once per app process and live until the OS kills the process. On Android, an `Activity` is just a view host: when the Activity is recreated (rotation, dark-mode switch, "Don't keep activities"), the new Activity re-attaches to the existing Hermes runtime and slot values with zero state loss.

### Cold Start Sequence
1. Native picks the newest valid bundle (built-in or verified OTA) and checks crash/watchdog state.
2. Native resolves the initial route (restored back stack, deep link, or `"/"`) and **inflates the `.zn.ui` template immediately**, drawing the first frame before JS starts.
3. In parallel, the JS thread initializes Hermes, evaluates `main.hbc`, and mounts the initial screen logic.
4. JS flushes its first batch of slot values; the skeleton fills in seamlessly. (Optionally, `Splash.holdUntil(...)` keeps the native splash up until your initial data is ready.)

---

## 4. The Bridge: Batches & Slot Cells

### JS → Native (The Batch)
All UI mutations are written into a compact C++ binary batch buffer (`core/include/zn/batch.h`) on the JS thread and flushed **once per JS tick** (after each task and its microtasks drain):

- `PATCH(instanceId, slotId, value)` — update a single leaf slot value.
- `MOUNT(templateId, parentInstance, anchor, newInstanceId, index, initialValues)` — instantiate a branch, list row, or child component along with its initial slot values in one op.
- `REMOVE(instanceId)` / `MOVE(instanceId, toIndex)` — update keyed lists and conditional branches.
- `NAV(kind, entryId, routeIndex, paramsJson)` — atomic navigation stack changes (`PUSH`, `REMOVE`, `CLEAR`, `EXIT`, `BACK_ANSWERED`, `RESTORE`, etc.).
- `LIST_SET` / `LIST_SPLICE` / `LIST_ROW` — virtualized `<List>` windowing updates.

If the main thread hasn't applied the previous batch yet, the next batch **coalesces** into it (latest `PATCH` per `(instanceId, slotId)` wins; structural ops keep order). On the UI thread, the entire batch applies atomically inside one `Snapshot.withMutableSnapshot` (Android) or main-actor transaction (iOS).

### Leaf Slot Cells (Zero Tree Diffing)
Each mounted template instance holds an array of slot values.
- **Android:** Each visible slot is backed by a `MutableState<Any?>`. Only the exact leaf composable reading that slot recomposes when patched.
- **iOS:** Each visible slot is its own small `@Observable` `SlotCell` object so only the leaf SwiftUI view invalidates.
- **Off-screen instances** (e.g., scrolled-out list rows or background screens) store plain value arrays and drop their observable cells until visible again.

### Native → JS
User events (`onPress`, `onChangeText`, navigation back, deep links, timers, native module results) are posted asynchronously to the JS thread via `ZnEngine::dispatchEvent` / `callGlobal`, followed immediately by `drainMicrotasks()`.

---

## 5. Native Renderers

### Android (Jetpack Compose Foundation)
- Built directly on **Compose Foundation** (no Material 3 dependency, keeping APK size tiny).
- Navigation uses AndroidX **Navigation 3** with native predictive back support.
- Styles are applied in **one fixed, deterministic modifier order**:
  `margin → size → transform → shadow → background → border → clip → press feedback → padding → content`
- Ships an embedded **Baseline Profile** so cold start and list scrolling are smooth even on older low-end phones.

### iOS (SwiftUI + UIKit Hybrid)
- Uses **SwiftUI** for layout and leaf views inside each screen, paired with **UIKit** for the areas where UIKit gives tighter control: navigation (`UINavigationController`), virtualized lists (`UICollectionView`), text fields (`UITextField` / `UITextView`), press handling, and a dedicated root popup layer box (`ZnPopups.swift`) for `<Sheet>` and `<Modal>`.
- Minimum target: **iOS 17**.

---

## 6. Shared C++ Core (`core/`)

Shared between Android (JNI) and iOS (Objective-C++):
- **Engine Adapter (`ZnEngine`)** — narrow C++ interface wrapping **Hermes V1** via JSI (`withMicrotaskQueue(true)` enabled).
- **Batch Buffer** — binary encoder/decoder and coalescing queue.
- **FlowStore** — crash-safe, memory-mapped two-slot key-value file with `posix_fallocate` space reservation so payment/redirect state survives sudden process death without corruption.
- **Storage (MMKV)** — fast synchronous key-value storage.

---

## 7. UI-Thread Motion & Gestures

State-driven animations (`animate`, `enter`, `exit`) run natively via Compose `Animatable` / SwiftUI transitions — JS only sends the target value.

For 60/120 fps gesture-driven interactions (`useMotion`, `usePan`, `usePinch`, `useElementMotion`, shared elements):
- Motion values live as native objects on the UI thread and are read in the draw phase (`graphicsLayer`), causing zero recompositions.
- Expressions inside `derive(() => ...)` are compiled at build time into a tiny **postfix formula** (≤ 64 ops, stack ≤ 16) that native evaluates every frame with zero allocations — no JS runs on the UI thread, and no untrusted code from an OTA bundle ever executes on the UI thread.

*(Currently implemented on Android; iOS port planned.)*

---

## 8. OTA Updates & Capability Contract

Every OTA bundle carries a machine-checked `requires` block:
- `requires.registry` — lowest UI registry version that supports every component/prop used by the bundle
- `requires.hostApi` — required bridge/host API version
- `requires.bytecode` — exact Hermes bytecode format version
- `requires.modules` — native modules and minimum versions required on both platforms
- `requires.os.{android,ios}` — platform-specific native module requirements

### Trust & Safety Nets
1. **ECDSA P-256 signatures** on both bundle archives and channel pointers (with a baked-in backup public key for rotation). In `zn-updates`, channel pointers are signed in the maintainer's browser so the server never holds the private key.
2. **Staged rollouts & bsdiff patches** (Android; typically 3–93 KB per update; iOS currently downloads full bundles).
3. **Boot watchdog & automatic rollback:** If a newly applied bundle crashes before reporting healthy, the runtime rolls back to the last known-good bundle (or built-in bundle) and marks the bad bundle blocked.
4. **Launch gate & `Updates.holdApply()`:** High- and critical-priority updates can wait briefly at cold start before drawing; sensitive flows (like active payments) call `Updates.holdApply()` to defer any live reload until the flow finishes.

---

## 9. Repository Layout

```
zero-native/
├── Package.swift      # SwiftPM package manifest for iOS
├── packages/
│   ├── core/          # @zeronative/core — signals, nav, fetch, storage, motion, OTA JS API
│   ├── ui/            # @zeronative/ui — JSX types & StyleSheet (stripped at compile time)
│   └── template/      # @zeronative/template — versioned component/prop registry & .zn.ui writer
├── compiler/          # @zeronative/compiler — TSX → .zn.ui + JS/Hermes bytecode Bun plugin
├── core/              # Shared C++ core (Hermes adapter, batch buffer, FlowStore, MMKV)
├── android/           # Android runtime (Compose Foundation) + sample app
├── ios/               # iOS runtime (SwiftUI + UIKit) + sample app
├── plugins/           # 20 official plugins (Android + iOS + JS)
├── server/            # Self-hosted zn-updates OTA server (Bun + Postgres + web dashboard)
├── tools/             # @zeronative/cli (zn new, zn dev, zn build, zn release, etc.)
├── templates/app/     # Starter app template used by `zn new`
├── examples/sample/   # Comprehensive sample app & feature labs
└── experiments/       # Original v0 benchmarks and architecture proofs
```

---

*For the full original v1 specification and decision log, see [docs/architecture-spec.md](docs/architecture-spec.md).*
