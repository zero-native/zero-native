# zero-native (`zn`): architecture

**Status:** v1 target design. Written by Claude (Opus) with Pavan, 2026-10-27, after two review rounds with Gemini 4 Argon.
**v0 experiments and spikes done (2026-10-27 to 10-29):** all passed on the Lava Blaze 2 5G. Lessons are folded in
below (marked "v0 lesson"); the full list is in `docs/v0-findings.md`.
**Updated 2026-10-29:** styling, lists, startup, safe areas, controlled components, native resource handles.
**Detailed spec files live in `docs/`** (start with `docs/README.md`). This file stays the summary and the decision log.
**This file replaces `intro.md` and `intro2.md` as the source of truth.** Those two files are Gemini's first brainstorm;
section 22 lists what we kept, changed and dropped from them, and why.

How to read this file:
- **Decided** means locked. Change it only with a new measurement or a written reason in section 24 (decision log).
- **Target** means a number we aim for. It is not measured yet.
- **[check]** means a fact we believe but must confirm while building.
- The experiments that test this design are in `GEMINI_BRIEF.md`. Experiments may take shortcuts; each shortcut is
  labelled there. The final framework takes none of them.

---

## 1. What zero-native is

zero-native is a mobile UI framework:
- You write screens in **TypeScript + TSX**.
- The screens are drawn by the **operating system's own UI toolkit**: Jetpack Compose on Android, SwiftUI on iOS.
- Your logic runs in **Hermes**, a small JavaScript engine, **without React and without React Native**.
- Screens and logic can be **updated over the air (OTA)**.
- Multi-step flows (payments, KYC, redirects) are **saved state machines** that survive the app being killed.

ZeroBill's customer app is the first user. zero-native is a **long-term, parallel, community project**: ZeroBill
must never depend on it until it is proven.

## 2. Goals and non-goals

**Goals (in priority order)**
1. **Small.** The framework itself should add well under 3 MB of download on Android (target), so apps for low-end
   phones stay small.
2. **Correct under process death.** Payment and redirect flows never lose their place and never repeat an unsafe action.
3. **Truly native UI.** Native text input, scrolling, accessibility, back gestures, sheets and transitions, for free.
4. **Fast.** Native-speed cold start; a tap updates the screen within one frame (target: p95 ≤ 16 ms on a budget phone).
5. **OTA-friendly.** Small, signed, per-screen updates with a strict compatibility check.
6. **Simple for screen authors.** A small set of components, signals and flows. No hooks rules, no reconciler.

**Non-goals**
- Pixel-identical UI on Android and iOS. We aim for "the same design, native on each". Known differences are
  documented and tested (section 9.5).
- Web or desktop targets.
- Running React components or the npm React ecosystem.
- Replacing native code. Native screens and views stay first-class (section 15).

## 3. Core principles

1. **The OS does the UI.** We never lay out, draw or animate pixels ourselves.
2. **Structure is compiled; values are live.** The static shape of a screen is compiled ahead of time. At runtime only
   values (slots) and a few structural changes (lists, conditions) move between JS and native.
3. **Logic never runs on the UI thread.** JS runs on its own thread. The UI thread never waits for JS.
4. **Every unsafe action is written down before it happens** (section 12).
5. **Only measured numbers count.** No performance claim goes into docs without a measurement and the device it ran on.
6. **Small and boring beats clever.** Prefer a proven library or a simple file format over a custom engine.

## 4. The big picture

```
BUILD TIME (zn build)
  Checkout.zn.tsx ──► zn compiler (SWC/OXC + zn transforms)
                        ├─► Checkout.zn.ui   template: static UI tree, slots, sub-templates (FlatBuffers)
                        └─► Checkout.js ──► hermesc ──► Checkout.hbc   logic bytecode
  + core.hbc (framework JS + shared app modules)
  + manifest.json (routes, capabilities, versions, hashes) ──► signed bundle

RUN TIME (one app process)
  ┌──────────── main / UI thread ────────────┐        ┌──────────── JS thread ─────────────┐
  │ Compose / SwiftUI                         │ events │ Hermes runtime                     │
  │ Template inflater (reads .zn.ui)          │◄──────►│ signals, flows, screen logic       │
  │ Slot cells (one observable per slot)      │ batch  │ zn host API (fetch, timers, ...)   │
  │ Navigation (Nav3 / NavigationStack)       │◄───────│ batch buffer (C++), flushed / tick │
  └───────────────────────────────────────────┘        └────────────────────────────────────┘
            ▲                                                     │
            │            C++ core (shared by Android and iOS)     │
            └── FlowStore (mmap) · bundle loader · engine adapter ┘
```

The **C++ core** is shared by both platforms: engine adapter, batch buffer, `.zn.ui` reader, FlowStore, bundle
loader and signature check. Kotlin and Swift code is only the renderer, navigation and platform modules.

## 5. Authoring model

### 5.1 Files and naming
- Screens and components: `*.zn.tsx`. Plain logic: `*.ts`.
- Packages: `@zero-native/core` (signals, flows), `@zero-native/ui` (components, styles),
  `@zero-native/nav`, `@zero-native/net`, `@zero-native/storage`, `@zero-native/os` (platform APIs).
- CLI: `zn` (`zn dev`, `zn build`, `zn ota ...`).
- `zero-native` is the **working name**. Check name, npm scope and trademark before going public (the name was used by
  `vercel-labs/native`, a TypeScript desktop toolkit, before its rename).

### 5.2 Signals (decided)
```ts
const amount = signal(0)                     // read: amount(), write: amount.set(5)
const toPay  = computed(() => Math.max(0, amount() - cashback()))
effect(() => log(toPay()))                   // runs when what it reads changes
batch(() => { a.set(1); b.set(2) })          // one update
untrack(() => amount())                      // read without subscribing
```
- **`set()` with an equal value does nothing** (`Object.is(prev, next)`): no subscriber runs, nothing is batched.
  A signal may pass its own `equals` function for objects. (v0 lesson: repeated "0" → "0" writes kept work alive.)
Signals live in JS memory. They are not persisted unless they are part of a flow (section 12) or stored on purpose
(section 13.4).

### 5.3 Screens and components
```tsx
@route('/checkout/:sessionId', { transition: 'push' })
export function Checkout(props: { sessionId: string }) {
  const amount = signal(0)
  return (
    <Column gap={12} style={{ padding: 16, backgroundColor: c.surface }}>
      <Text style={t.amount}>{formatInr(amount())}</Text>
      <Keypad onKey={(k) => amount.set(applyKey(amount(), k))} />
      <If when={amount() > 0}>
        <Button onPress={() => pay(amount())}>Pay Now →</Button>
      </If>
    </Column>
  )
}
```
- A component function **runs once** when its instance is created. There is no re-render.
- **The compiler makes JSX expressions reactive.** `{formatInr(amount())}` becomes a slot whose value is a computed.
  Authors do not write `() =>` by hand.
- A JSX expression that only reads constants becomes a **static value** baked into the template.
- Component props are passed as getters by the compiler, so a child reading `props.x` stays reactive. Authors must not
  destructure props (the compiler warns, the same rule as SolidJS).
- **Control flow is plain JS (decided 2026-10-29):** `{cond && <X/>}`, `{cond ? <A/> : <B/>}` and
  `{items.map(item => <Row key={item.id}/>)}`. The compiler turns each into an **Anchor** node in the template plus the
  code that mounts branches or rows there; branches and rows get their own templates. No `<If>` / `<For>` components
  to learn. Rows need a `key`. Anything else in a child position is a build error with a file:line:col.
- Event props (`onPress`, `onChange`, ...) are plain JS functions. Native only learns "this node has a handler".
- **One way to handle taps (decided):** tap events (`onPress`, `onLongPress`) exist only on `Pressable` and `Button`.
  Input components have their own events (`TextField.onChange`, `Switch.onChange`, ...). Layout nodes (`Column`,
  `Row`, `Text`, ...) take no tap handlers, and **styles never carry handlers** (there is no `clickable` style).
  This gives every tappable thing a proper accessibility role and press feedback, and the template has one event
  table (`events` in 6.1). Nested `Pressable`s: the innermost one gets the tap, as on both platforms natively.
  Each component's events and their payload types are listed in the component registry (16.2).
- **Press lifecycle (v0 lesson):** `Pressable` has `onPressIn`, `onPressOut`, `onPress`, `onLongPress`.
  `onPressOut` **always** fires once after `onPressIn`, whether the finger is lifted or the touch is **cancelled**
  (finger dragged off, scroll takes over, `ACTION_CANCEL`); its payload is `true` when cancelled, `false` when lifted.
  `onPress` fires only for a completed tap that didn't long-press or repeat. (Built and verified in step 1.4.)
- **Key repeat is native (v0 lesson):** `onPressRepeat={handler}` with `repeatDelay` (default 400 ms) and
  `repeatInterval` (default 100 ms) makes native send repeated events while the finger is down and stop the moment it
  isn't. JS never runs a timer for press-and-hold (keypad backspace, steppers). This removes the whole "zombie timer"
  class of bugs. `haptic` adds a press-in tick that respects the system haptics setting.
- **Custom component events** (like `<Keypad onKey>`) are plain JS callbacks between components. They don't exist in
  the template: `Keypad` itself is built from `Pressable`s, whose native events call into it.

### 5.4 Styling and layout (decided 2026-10-29; full rules in `docs/styling-and-layout.md`)
- A **`style` prop with React Native style names** (a supported subset), as an object or an array.
  `StyleSheet.create` exists for typing only.
- **The framework decides the order.** The renderer turns a style into one fixed chain: margin → size → transform →
  shadow → background → border → clip → press feedback → padding → content. Authors never order anything; for an
  unusual layering they nest a `Box`.
- React Native sizing: `width` includes padding and border, not margin; a border pushes content inward.
- **Layout is done by Compose and SwiftUI. No Yoga.** `flex`, `justifyContent`, `alignItems`, `gap`, `flexWrap`,
  percentages and absolute positioning inside `Stack` map to native layout under **our own documented flex rules**
  (for example: `stretch` is the default in `Column`; in `Row` only with a fixed height).
- **Margins are allowed** (outer spacing); `gap` is preferred between siblings.
- **Static styles are folded into the template** at build time; only style values that change become slots.
- **Unsupported keys are build errors**, never silently ignored (`flexDirection`, `flexShrink`, negative margins, ...).
- **Design tokens** (`c.*` colours, `t.*` text styles, spacing) are a typed TS module, compiled in as constants.
  Dark mode is a token set chosen by native at runtime, not a JS re-render.
- Sizes are in dp/pt. Text sizes respect the user's font-scale setting by default.
- **Safe areas** are handled natively per route (§11).
- Why not modifier chains: order-dependent bugs, foreign in JSX, and porting RN code would be a rewrite.

## 6. Build outputs (decided)

A **bundle** is one signed archive:

| File | What it is |
|---|---|
| `manifest.json` | Bundle id, framework ABI version, Hermes bytecode version, required capabilities (section 16.2), routes, file hashes |
| `core.hbc` | Framework JS + app modules shared by many screens |
| `<Screen>.hbc` | One screen's logic (Hermes bytecode) |
| `<Screen>.zn.ui` | One screen's template (FlatBuffers) |
| `assets/` | Images, fonts, Lottie files, each referenced by hash |
| `*.map` | Source maps (kept on the build server, not shipped to phones) |

- Each screen is a separate pair of files, so an OTA update can replace one screen (tens of KB, target).
- JS modules use a small registry inside `core.hbc` (`__zn_define(id, factory)` / `__zn_require(id)`), so several
  `.hbc` files share one module graph in one runtime.
- Bytecode is produced by the `hermesc` that matches the engine inside the app (section 7.3).

### 6.1 `.zn.ui` template format
**Changed 2026-10-29 (step 1.2): our own small, versioned binary format instead of FlatBuffers.** The byte layout is
documented at the top of `packages/template/src/writer.ts` (writer) and read by `TemplateReader.kt`. Reasons:
FlatBuffers would add the `flatc` generator and generated code in TS, Kotlin and Swift, and its main benefit (reading
without parsing) doesn't matter here: each template is read **once** and prepared into flat arrays (§9.1), never
parsed again (measured: 1.8 ms to read and prepare the sample template in a release build). Component, prop, event
and enum ids come from one registry (`packages/template/src/registry.ts`, Kotlin copy generated). The outline below
still describes the content:
```
Template file
  header:     magic "ZNUI", formatVersion, frameworkAbi, screenId
  strings:    string table (text, token names)
  templates:  [Template]            // index 0 = screen root; others = If branches, For rows, components
Template
  nodes:      [Node]                // flat array in tree order
  slots:      [Slot]                // slotId → (node index, property id, value type)
  events:     [EventBinding]        // (node index, event id) → handler id
  children:   [ChildTemplateRef]    // where sub-templates mount (anchor node + kind: If / For / Component)
  gestures:   reserved for v2 (main-thread gesture expressions, section 10.3)
Node
  type: u16 (component id)          parent: u32          staticProps: [PropValue]
  style: [StyleValue]               // static style keys, folded at build time (applied in the fixed order, 5.4)
// List row templates are ordinary templates; a <List> node refers to one by template index (docs/lists.md).
```
- Component ids and property ids are **numbers from a versioned registry** (section 16.2). Unknown ids = bundle is
  incompatible, so it is never loaded.
- The template alone is enough for native to **draw the static skeleton of a screen before JS has started**
  (section 8.1). Slots show their declared default until JS sends a value.

## 7. JS engine

### 7.1 Decision: Hermes V1, on Android and iOS (decided, final for v1)
We considered Hermes V1, PrimJS (ByteDance's QuickJS fork used by Lynx) and QuickJS-ng.

| | Hermes V1 | PrimJS | QuickJS-ng |
|---|---|---|---|
| Download cost on Android | ≈0.83 MB measured in a real app build (v0 exp 1: native split with vs without hermesvm + fbjni + bridge; `libc++_shared` is needed by other libraries anyway). The four libraries alone are ≈1.27 MB. | unmeasured, likely smaller | unmeasured, smallest |
| Debugger (Chrome DevTools) | yes, mature | yes | no |
| Bytecode compiled ahead of time | yes (`hermesc`) | yes | yes |
| Language level | modern ES + what we transpile | ES2019 | modern ES |
| GC | generational, concurrent | tracing GC **only on arm64** builds, else ref counting | ref counting + cycle collector |
| Build and embedding | Maven / CocoaPods prefab, used by RN on both platforms | gn + ninja + habitat; its N-API is non-standard | small C library |
| Maintenance | Meta, default engine of React Native since 0.84 | ByteDance / Lynx | community |

**Why Hermes:** a community framework lives or dies on its debugger, profiler and source maps; Hermes has all of
them and is maintained as React Native's default engine on both platforms. It compiles bytecode ahead of time, so
there is no parsing on the phone. Its size cost (≈0.83 MB in a real build, see the table) is fully paid back by removing React Native itself
(`libreactnative.so` alone is 1.61 MB of download). PrimJS's smaller size comes with a non-standard API, an
arm64-only GC and a heavy build; QuickJS-ng has no debugger. We do not run an engine benchmark: the decision does
not depend on it.

**Insurance:** the engine stays behind the narrow interface in 7.2, so if Hermes ever becomes a problem, swapping it is
one adapter, not a rewrite. This is insurance, not a plan to support several engines.

### 7.2 The engine interface (decided)
The rest of the framework never sees engine types. The C++ interface is:
```cpp
struct ZnValue { enum Kind { Null, Bool, Number, String, Bytes } kind; /* ... */ };   // small typed values only

class ZnEngine {
public:
  virtual void evalBytecode(const uint8_t* data, size_t len, std::string_view url) = 0;
  virtual void dispatchEvent(uint32_t instanceId, uint16_t eventId, const ZnValue& payload) = 0;
  virtual void callGlobal(std::string_view fn, std::span<const ZnValue> args) = 0;   // timers, results, lifecycle
  virtual void drainMicrotasks() = 0;
};
// Host functions the engine exposes to JS (installed by the adapter):
//   __zn_patch(instanceId, slotId, value)       append a slot patch to the batch buffer
//   __zn_struct(opsBytes)                        append structural ops (mount, move, remove)
//   __zn_call(moduleId, methodId, argsBytes, callbackId)   call a native module (section 15)
//   __zn_timer(id, ms) / __zn_clearTimer(id) / __zn_now() / __zn_log(level, msg)
```
- The Hermes adapter uses JSI internally. JSI comes from the same release as Hermes (on Android: `libjsi.so` and
  headers from the matching `react-android` AAR, or built from the matching Hermes source) [check per release].
- Engine calls only happen on the JS thread.
- **Hermes configuration (v0 lesson):** the runtime is created with `withMicrotaskQueue(true)` (it is **off** by default
  in `hermes/Public/RuntimeConfig.h`), and the adapter calls `drainMicrotasks()` after **every** entry into JS
  (bytecode evaluation, event, timer, module result). Otherwise Promise callbacks run late or never.

### 7.3 Versions
- App binary records: framework ABI version, Hermes bytecode version (from `hermes.h` / `hermesc --version`).
- **Bytecode is always compiled with `hermesc -O -Xes6-block-scoping`** (decided 2026-10-29). Without the second
  flag, `let` / `const` behave like `var` in this Hermes release (v0 lesson, `docs/v0-findings.md` §P).
- Every bundle states both. A bundle with a different bytecode version is never loaded (section 16.2).

## 8. Runtime and threads

### 8.1 Startup sequence
1. Process starts. Native loads the newest **valid** bundle (signature + hashes checked, section 16).
2. Native reads **FlowStore** (section 13) and decides the first screen: restored back stack, or a deep link, or the
   home route. Safe mode applies here (section 12.7).
3. Native inflates the first screen's `.zn.ui` and **draws the static skeleton immediately** (first frame without JS).
4. In parallel, the JS thread starts Hermes, evaluates `core.hbc` and the screen's `.hbc`, runs the screen function
   and restores any flow state.
5. JS flushes the first batch. The skeleton fills in. `reportFullyDrawn()` fires after the first batch is applied.

**Startup rules (decided 2026-10-29; details and measurements in `docs/startup-and-performance.md`):**
- No work at module load time (a module's top level only declares things).
- No main-thread work in `onCreate` beyond creating the view host: package-manager queries, icons, disk reads and
  parsing go to the I/O pool or happen on demand.
- Per-screen bytecode, evaluated on demand; cold start runs `core.hbc` + the first screen only.
- The first frame is the native skeleton, never a "Loading…" screen.
- Baseline Profiles on by default (framework profiles shipped; apps add their own).
- Performance numbers come only from release builds.
- **Budget: ≤ 250 ms `am start` TotalTime on the Lava Blaze 2 5G** for a release sample app (Flutter 1.6.0 measures
  ~300–330 ms there). v0 lesson: exp4-flow broke these rules and measured ~400–420 ms in release.

### 8.2 Threads (decided)
| Thread | Owns | Never does |
|---|---|---|
| Main / UI | Compose or SwiftUI, slot cells, navigation | run JS, wait for JS, disk I/O |
| JS (one, dedicated) | Hermes runtime, all app logic | touch UI state directly |
| I/O pool | network, file reads, image decoding (Coil / native) | run JS |

- **The JS thread does not pause when the activity pauses.** Only the OS can stop it (for example, by killing the process).
- **One JS runtime per process (decided, v0 lesson).** The JS thread and the Hermes runtime are created once per
  app process (Android: from the `Application`, lazily; iOS: app-level singleton) and live until the process dies.
  An Activity / scene is only a **view host**: when it is destroyed and recreated (rotation, "Don't keep activities",
  dark-mode switch, low memory) **while the process lives**, the new Activity re-attaches to the same runtime, the
  same instances and the same slot values. JS state is never lost and JS never restarts because of an Activity.
  Never call `quit()` on the JS thread from Activity callbacks. Instances whose screen has no host keep plain value
  arrays (9.3) until a host attaches again.
- The UI thread **never blocks** on the JS thread. No synchronous calls from UI to JS.

### 8.3 The batch (decided)
JS → native updates go into a **C++ batch buffer** owned by the JS thread:
- `PATCH(instanceId u32, slotId u16, value)`: change one slot value.
- `MOUNT(templateId u16, parentInstance u32, anchor u16, newInstanceId u32, index u32, initialValues)`: create an
  instance of a sub-template (an `<If>` branch, a `<For>` row, a component). The slot values come inside the op, so
  a new row needs one op, not one op plus K patches.
- `REMOVE(instanceId)`, `MOVE(instanceId, toIndex)`: for keyed lists and conditions.
- `NAV(op, routeId, entryId, paramsBytes)`: back-stack change (section 11). For `push`, `entryId` is the new
  screen's root instance id.

Rules:
- **Instance ids are allocated by JS**, so JS never waits for native to answer. One exception, the **screen root**:
  - Every back-stack entry has an `entryId`. **The screen's root instance id is its `entryId`**, and the root
    instance is always created by **native** from the template (that's how the skeleton can draw before JS runs).
    **JS never sends `MOUNT` for a screen root.**
  - Entry ids for screens opened before JS runs (cold start, deep link, restore) are allocated by native; entry ids
    for `nav.push` are allocated by JS and sent in the `NAV` op. The two use separate number ranges (native: top
    bit set), so they never collide.
  - When JS runs a screen function, it receives the root instance id. It sends only `PATCH` ops for the root's slots
    and `MOUNT` ops for children (`<If>`, `<For>`, components).
  - Until the first patch arrives, a dynamic slot shows the default the compiler wrote into the template (or a
    placeholder, if the author marked the slot `placeholder`), never an empty or wrong value.
- **One flush per tick:** after each JS task and its microtasks, the buffer is handed to the main thread
  (one `post`), and a new buffer starts.
- **Coalescing:** if the main thread has not applied the previous batch yet, the next batch is merged into it: later
  patches to the same `(instanceId, slotId)` replace earlier ones; structural ops keep their order.
- **Atomic apply:** on Android the main thread applies a whole batch inside one `Snapshot.withMutableSnapshot`; on
  iOS inside one main-actor transaction. A user never sees half of a batch.

Native → JS: events (`dispatchEvent`), module results, timer fires and lifecycle changes are posted to the JS thread
as tasks.

## 9. Renderers

### 9.1 Instances and slot cells (decided)
- An **instance** is one mounted template: it owns an array of **slot cells**, one per slot.
- **Android:** each cell is a `MutableState<Any?>`. The composable for a node reads only its own cells, so a patch
  recomposes only the leaf that shows that value.
- **iOS:** each cell is its own small `@Observable` object (`final class SlotCell { var value }`). One observable
  array would invalidate every reader of the array, so cells must be separate objects. [check with Instruments that
  only the leaf view's body re-runs]
- **The template interpreter must be fast (decided 2026-10-29, v0 lesson).** Each template is prepared once into flat
  arrays (node types, child ranges, pre-built static modifiers, static text, slot → node/property table). Static props
  are constants, not state; only slots are observed. No per-row node allocation, no hash-map lookups or string
  matching while drawing. v0 measured a generic node tree per list row at 18–25 ms per frame, and one shared template
  at 2.8–4 ms (as fast as hand-written Kotlin). **We do not generate Kotlin/Swift from TSX**: compiled code can't be
  updated over the air.
- **Planned renderer optimisations (build only if they don't cause real problems; `docs/styling-and-layout.md` §8.3):**
  merge decoration-only boxes into their single child's modifier chain, and read each dynamic style slot in the
  cheapest Compose phase (draw for colours / opacity / transforms, layout for sizes / padding, composition only for
  content and structure).

### 9.2 Component set v1 (decided list; props are in the registry)
| zn | Compose | SwiftUI |
|---|---|---|
| `Column` / `Row` / `Stack` | `Column` / `Row` / `Box` | `VStack` / `HStack` / `ZStack` |
| `Spacer` | `Spacer` (+ weight) | `Spacer` |
| `Scroll` | `verticalScroll` / `horizontalScroll` | `ScrollView` |
| `For` (short lists) | keyed children inside `Column` / `Row` / `Scroll` | keyed children (`ForEach`) |
| `List` (virtualized, 9.3) | `LazyColumn` / `LazyRow` / `LazyVerticalGrid` with keys | `LazyVStack` / `LazyHStack` / `LazyVGrid` with ids |
| `Text` | `Text` | `Text` |
| `Image` | Coil `AsyncImage` / painter | `AsyncImage` + our image cache [check cache choice] |
| `Icon` | SVG path data drawn with a Compose `Path` (folded into the template at build time) | the same path data in a SwiftUI `Path` |
| `Pressable` / `Button` | `clickable` with indication, haptics | `Button` with custom style |
| `TextField` | `BasicTextField` | `TextField` |
| `Switch`, `Checkbox`, `Slider`, `Progress`, `Spinner` | foundation-based components | native controls |
| `Sheet` (with detents) | our own foundation-based sheet: native drag, velocity, rubber-band and spring (v0 Frontier 1: 0 bridge events during a drag) | `.sheet` + `presentationDetents` |
| `Dialog`, `Toast` | `Dialog`, custom toast host | `.alert` / custom overlay |
| `Lottie` | Lottie Compose | lottie-ios |
| `NativeView` | `AndroidView` / registered composable | `UIViewRepresentable` / registered view |
| (safe areas, keyboard) | not components: per-route options handled natively (§11) | same |

- We build on **Compose foundation, not material3**, so apps carry only their own design system. (Exp 1 measures
  what material3 would cost.)
- Every component is specified once (props, events, behaviour) and implemented twice. A component is "done" only
  when both renderers pass its conformance tests (9.5). Until iOS starts, components are written for Android with the
  SwiftUI mapping reviewed on paper.

### 9.3 Lists (decided 2026-10-29; full rules in `docs/lists.md`)
- **`items.map(item => <X key={...}/>)`** is for short lists inside a layout (guideline: up to ~100 items). Every
  item is a real instance; JS emits `MOUNT` / `MOVE` / `REMOVE` only for items that changed. (Called `<For>` in earlier
  drafts; plain `.map` replaced it, 2026-10-29.)
- **`<List data key rowHeight row>`** is for long lists. The `row` function is compiled **once** into a row template.
  JS sends the row count and the row **values** for a window around the visible range (`LIST_SET`, `LIST_ROWS`,
  `LIST_SPLICE` ops with stable keys). Native draws rows with `LazyColumn` / `LazyVStack`.
- Native asks for new ranges asynchronously (`onRange`). **The UI thread never calls into JS or waits for row data**
  (a synchronous pull from the UI thread was tried and rejected: Hermes is single-threaded).
- Rows whose values haven't arrived show **the same row template with placeholder values**: same height, no jump, and
  **never raw template syntax** (v0 leaked `{{slot:merchant}}`).
- Very large data (10 lakh rows) can't live in the JS heap (~400 MB). A **native data source** that reads rows on an
  I/O thread straight into the native row cache is designed in `docs/lists.md` §6 and built in v1.1.
- **Native keeps row values cheap until a row is shown.** A row instance stores its slot values in a plain array.
  Observable cells (`MutableState` / `SlotCell`) are created only when the row enters composition, and dropped when
  it leaves. A patch to an off-screen row only updates the plain array. So 2,000 rows cost 2,000 small arrays, not
  2,000 × K observable objects. (The same rule applies to any instance that is not on screen.)

### 9.4 Text input
- The native field owns the text while the user types (no JS round trip per key, so no lag).
- `onChange` events go to JS; JS may set a new value (for formatting). A controlled value from JS replaces the field
  text only if it differs, keeping the cursor at the end unless JS gives a selection. [check edge cases: IME
  composition, emoji, paste]

### 9.5 Cross-platform layout rules and conformance tests
- zn defines its own small layout rules (alignment defaults, how `weight` / `fill` resolve, text line height), and
  each renderer maps them explicitly, never relying on toolkit defaults.
- Conformance tests: a set of test screens rendered on both platforms with screenshot comparison and tolerance.
  Known, accepted differences are listed in `docs/platform-differences.md`.

### 9.6 Accessibility and text
- Every component maps `label`, `hint`, `role`, `hidden` to native accessibility (TalkBack / VoiceOver).
- Font scaling on by default; `maxFontScale` per text style.
- RTL: `start` / `end` everywhere instead of left / right.

### 9.7 Controlled components (decided 2026-10-29)
- **Native never writes a value that JS owns.** When the user changes something natively (drags a sheet closed,
  flips a switch, types), native sends an **event**, and JS sets the prop.
- While waiting for JS, native may show its own **local visual state** (the sheet keeps animating down, the switch
  thumb moves), and then follows whatever JS sets. If JS keeps the old value (for example, refuses to close the sheet),
  native animates back.
- Text fields are the one allowed exception in the other direction: the native field owns the text while typing (9.4).
- v0 lesson: the prototype sheet wrote `visible = false` straight into JS-owned state, so native and JS could disagree.

## 10. Animation

### 10.1 State-driven animation (decided)
`animate={{ scale: spring({ stiffness, damping }) }}` on a node, or `transition={fade()}` on `<If>`. When a slot value changes,
native animates to it with **its own** spring / tween (Compose `animate*AsState` / `Animatable`, SwiftUI
`.animation(.spring(...), value:)`). JS sends only the target value, never per-frame values.

### 10.2 Enter / exit
`<If>` and `<For>` rows accept `enter` / `exit` transitions, mapped to `AnimatedVisibility` / `.transition`.

### 10.3 Gestures (deferred to v2)
Gesture-driven values (drag offsets, swipe-to-pay) must update on the UI thread every frame. v2 adds a tiny,
**explicitly marked** expression language (`'main thread'` directive, like Lynx), compiled into the `gestures` section
of `.zn.ui` and run natively. No automatic splitting of arbitrary TS. Until then: native sheets with detents, native
scroll behaviours, and `NativeView` cover the common cases. v0 Frontier 1 confirmed the pattern: a fully native
draggable sheet ran at 2.8–4.2 ms frames with 0 bridge events during the drag and one event when it settled.

## 11. Navigation (decided)

- Routes are declared with `@route(path, options)`. The compiler writes a **route manifest** (in `manifest.json`):
  path pattern → screen id, transition, presentation (push / modal / sheet / full-screen), deep-link rules.
- **The back stack is plain data:** a list of `{ routeId, params, instanceKey }`. JS changes it with
  `nav.push / back / replace / reset / sheet / closeSheet`, sent as `NAV` ops in the batch.
- **Android:** Jetpack Navigation 3 (a back stack you own as a list), one generic destination that renders a zn
  screen. Predictive back comes from the platform. [check Nav3 stable status and version]
- **iOS:** `NavigationStack(path:)` with our path array; sheets via `.sheet`.
- **Transitions are native**, declared per route. JS never animates a page change.
- **Deep links:** native matches the URL against the route manifest **before JS starts**, so the target screen's
  skeleton draws first.
- **Back button / gesture:** a screen can register `onBack` (for example "Exit transaction?"). Native asks JS
  asynchronously; until JS answers, the back action is held. Timeout = default back. [target 300 ms]
- **The back stack is saved in FlowStore** on every change (section 13), so after process death the app reopens on
  the same screen.
- Native screens are routes too (section 15.3).
- **Safe areas and the keyboard are route options, handled natively (decided 2026-10-29):**
  `@route(path, { safeArea: 'all' | 'none' | { top?, bottom? }, keyboard: 'resize' | 'none' })`, default `'all'` /
  `'resize'`. Android: edge-to-edge on, the screen host applies `windowInsetsPadding` (Compose foundation, not
  material3 `Scaffold`). Full-bleed screens read a read-only `insets()` signal. There is no JS `SafeAreaView`
  (v0's JS version caused a blank screen and status-bar / nav-bar overlap). Details: `docs/styling-and-layout.md` §6.
- **Shared-element transitions (v1, optional; decided 2026-10-29):** a node with `heroTag="tx-123"` on two screens
  morphs between them during navigation (Compose `SharedTransitionLayout`, SwiftUI zoom transition on iOS 18+). v0
  Frontier 4 ran a list-row → detail-header morph at 90 fps. The Compose API is still experimental and must be
  re-checked with Navigation 3 [check]; screens without `heroTag` are unaffected.

## 12. Flows and effects (`@flow`)

### 12.1 What a flow is
A flow is a **named state machine whose state is saved before anything else happens**. Use it for anything that must
survive the app being killed: checkout and UPI, KYC with camera, DigiLocker and 3DS redirects, sign-in, onboarding,
multi-step forms.

```ts
export const checkout = defineFlow({
  name: 'checkout',
  schemaVersion: 2,
  expiresAfter: { minutes: 15, sliding: true },
  initial: 'enteringAmount',
  data: { sessionId: '', amountPaise: 0, ztc: '' },        // plain JSON only, no secrets
  steps: {
    enteringAmount: { on: { pay: (d, amount) => go('paying', { amountPaise: amount }) } },
    paying: {
      enter: effect('postPay', { kind: 'keyed', reconcile: 'verifying' },
                    (d, key) => api.pay(d.sessionId, d.amountPaise, { idempotencyKey: key })),
      on: { payDone: (d, r) => go('launchingUpi', { ztc: r.ztc, upiLink: r.upiLink }) },
    },
    launchingUpi: {
      enter: effect('launchUpi', { kind: 'once', reconcile: 'verifying' },
                    (d) => os.launchActivity({ uri: d.upiLink, package: d.app })),
      on: { result: (d, r) => go('verifying', { upiResult: r }) },
    },
    verifying: { enter: effect('verify', { kind: 'safe' }, (d) => api.verify(d.ztc, d.upiResult)) /* ... */ },
    success: {}, failed: {}, cancelled: {},
  },
  migrate: { 1: (old) => ({ ...old, amountPaise: Math.round(old.amount * 100) }) },
})
```

### 12.2 Effects: the general rule (decided)
Saving state is not enough. The danger is a **side effect** that already happened (or maybe happened) before the app
died. Restoring the state and running the step again could do it twice. So every side effect inside a flow is
declared as an **effect** with a kind:

| Kind | Meaning | On restore, if it was started but has no result |
|---|---|---|
| `safe` | Repeating it is harmless (reads, status checks, `verify`) | run it again |
| `keyed` | The server removes duplicates by an idempotency key (`/pay` with a key, uploads with a content hash) | run it again **with the same saved key** |
| `once` | Must never run twice automatically (launch the UPI app, launch 3DS, send OTP if not keyed, submit KYC if not keyed, anything that moves money without a key) | **never run again**; go to its `reconcile` step |

- `once` and `keyed` effects **must** declare a `reconcile` step. The compiler rejects them otherwise.
- The §12.1 example shows `/pay` as `keyed`, which needs backend support. **ZeroBill's `/transactions/pay` today is
  `once`**: every call creates a new payment (v0 G2, `exp-notes/5-pay-idempotency.md`).
- The reconcile step asks the source of truth (usually the backend) what happened. Example: "Checking your payment…".

**Where this matters beyond UPI** (the same rule covers all of them):
- **Money:** create payment, 3DS / bank redirect, payouts, redeeming cashback or coupons, refunds.
- **Messages and costs:** sending OTP or SMS, invites, push opt-ins.
- **Irreversible user actions:** place order, submit KYC or documents, submit review, delete account.
- **External apps and system screens:** UPI apps, camera capture, document scanner, DigiLocker, Google sign-in,
  Truecaller verification, file picker, share sheet, permission prompts. Their results come back through
  `onActivityResult` (Android) or URL callbacks (iOS) and are captured by the runtime (12.4).
- **Uploads:** receipts, KYC photos (make them `keyed` by content hash).

Ordinary reads (`GET`), local-only changes and UI state are not effects.

### 12.3 The write-ahead rule (decided)
Running an effect is always:
1. Write the effect record `{ id, kind, status: 'started', key?, at }` to FlowStore.
2. **Only then** do the action.
3. When the result arrives, write `{ status: 'done', result }`, then move the flow on.

In dev builds, a POST / PUT / DELETE request or `os.launchActivity` made from inside a flow step **without** an
effect wrapper throws an error. In release builds it is logged as a non-fatal.

### 12.4 Results from other apps
- The native runtime registers for activity results **before** any JS runs.
- A result for a known effect is written into that effect's record in FlowStore **first**, whether or not JS is alive.
  Then JS is told.
- On iOS, URL callbacks (`app://callback?...`) are handled the same way.
- **Testing note (v0 lesson):** while another app shows a **translucent** window (a UPI app's launch spinner), our
  activity is only paused and stays "visible" to Android, so it is not killed. Process-death tests must wait until
  the other app shows an **opaque** screen. The v0 mock UPI app (`P2pUPIapp`) does exactly this and should be part of
  the framework's test kit.

### 12.5 Restore (decided)
At startup, before the first screen is chosen:
1. Read all flows. A record that fails its checksum in both slots is moved to quarantine (12.7) and logged.
2. **Expired** flows: if no `keyed` / `once` effect was ever started, drop the flow. If one was started, **do not drop
   it**: open the flow in its reconcile step. (Money may have moved. The app's product rules decide what the user sees
   after reconciling.)
3. **Schema version:** run `migrate` steps in order up to the bundle's version. If there is no path, or a migration
   throws: reconcile step if a `keyed` / `once` effect was started, else drop the flow.
4. For each effect in `started` without a result: apply the table in 12.2.
5. Rebuild the back stack saved with the flow, open the current step.

**Payment rule (decided, also a ZeroBill product rule):** once a payment request (`/pay`) has been started, a
restored flow **never launches the UPI app or any payment screen by itself**. It always verifies with the backend
first. Only a new, explicit tap by the user can start a new attempt.

### 12.6 Expiry
Each flow declares `expiresAfter` (sliding by default: refreshed on every save). Expired flows follow 12.5 step 2.

### 12.7 Safe mode (crash-loop guard)
- Before restoring, the runtime writes a restore marker `{ flowId, attempts, at }`.
- It is cleared 10 s after the restored screen is shown without a crash.
- At start, if `attempts >= 2`: do not restore. Move the flow to quarantine, log it, open the home route. If the flow
  had a started `keyed` / `once` effect, open a minimal built-in "checking your last payment" screen that only uses the
  fields the flow declared as `reconcileFields` (for example `ztc`), read defensively.

### 12.8 Versioning rules for authors
- Changing a flow's `data` shape or step names **requires** a `schemaVersion` bump and a `migrate` entry. The compiler
  compares against the previous published schema and fails the build otherwise.
- Never reuse a removed step name for a different meaning.

## 13. Persistence

### 13.1 Two kinds of saved data (decided)
| | FlowStore (core) | Storage (module) |
|---|---|---|
| For | flows, effect records, back stack | app data: settings, caches, drafts, local tables |
| Timing | **written before the next action**, in order | may be delayed and batched |
| Guarantee | survives process kill; checksum; never half-written | normal key-value guarantees |
| Implementation | two-slot mmap file in the C++ core, no dependencies | MMKV by default (Android + iOS); swappable |

Secrets (tokens, keys) go in **SecureStore** (Android Keystore-backed / iOS Keychain), never in FlowStore or Storage.

### 13.2 FlowStore file format (decided)
One file per flow plus one for navigation, in app-private storage, **excluded from backups**.
```
file = header (64 B) + slot A + slot B           slot size fixed per file (default 32 KB, configurable)
header: magic "ZNFS", formatVersion, slotSize
slot:   seq u64 | length u32 | crc32 u32 | payload (JSON, UTF-8)
```
**Write:** copy the payload into the slot that is **not** current → write `length` and `crc32` → then write the new
`seq` (current + 1) as one aligned 8-byte store with a release barrier. The other slot still holds the previous good
state the whole time.
**Read:** check both slots; use the valid one (crc matches) with the higher `seq`.

**Durability (honest version):**
- **App killed (SIGKILL, low-memory killer, crash):** safe. mmap writes are in the kernel's page cache the moment they
  are made; the kernel writes them to flash later even though our process is gone. No `fsync` needed, so a write
  costs microseconds.
- **Power loss / phone crash:** not guaranteed (no `fsync` / `msync`). The checksum detects a torn slot and we fall
  back to the previous one. This is safe because of the restore rules: after a payment started, we only ever
  *verify*, we never *repeat*.
- **Payload bigger than the slot.** Flows must stay small (big data goes in Storage, referenced by id), so in dev
  builds this is an error. In release builds:
  1. FlowStore **grows the file**: it writes a new file with double the slot size (holding the current good state),
     then atomically renames it over the old one, and maps it again. Growth is rare, so the rename cost is fine.
     (Android could use `mremap`; iOS has none, so both use this one method.)
  2. Hard ceiling: 256 KB per slot. A non-fatal is logged every time a file grows.
  3. If the payload is over the ceiling, or growing fails (disk full), **the write fails, and the step's effect does
     not run.** The flow moves to its error handling (for an effect: its reconcile step, or the step's `onError`).
     The write-ahead rule (12.3) is never broken: no record, no action.

### 13.3 Thread
FlowStore writes happen on the JS thread (the caller of `go()` / `effect()`), synchronously. They are memory copies,
so they never block the UI thread.

### 13.4 Persisted signals
`persisted(signal, { key, store: 'storage' })` saves a signal to Storage (debounced). For drafts and preferences only;
never for anything a flow needs.

## 14. Host APIs for plain TypeScript (decided list)
- `fetch` (subset: method, headers, body as string / bytes / form, JSON helpers, timeouts, abort). Native HTTP stack:
  OkHttp on Android, URLSession on iOS. Cookies off by default. Cronet / HTTP/3 is an optional later backend.
- Timers: `setTimeout`, `setInterval`, `queueMicrotask`. **Rules (v0 lesson):**
  - A timer id returned to JS is a **logical handle** that never changes for the life of the timer.
    `setInterval` keeps one handle even though each tick schedules a new native callback.
  - `clearTimeout` / `clearInterval` with that handle **always** stops the timer, including a tick that is already
    queued (a cancelled flag is checked before the callback runs).
  - Native keeps the map handle → current native callback; JS never sees native ids.
  - All timers of a screen are cleared when its root instance is removed.
- `console`, `performance.now()`, `crypto.getRandomValues`, `TextEncoder` / `TextDecoder`, `URL`, `Intl` [check Hermes Intl
  support per platform; add a small formatter for INR if needed].
- `@zero-native/storage` (13.4), `SecureStore`, `os.*` (app info, device info, haptics, clipboard, share, open URL,
  launch activity, permissions, app lifecycle events).
- Zustand-style stores and plain TS libraries run unchanged (they need no React).

## 15. Native modules and native screens

### 15.1 Native modules (decided)
A module is declared once in TypeScript:
```ts
export interface UpiModule extends NativeModule {
  listApps(): Promise<UpiApp[]>
  launch(uri: string, pkg: string): Promise<boolean>
}
export const Upi = nativeModule<UpiModule>('Upi', { version: 1 })
```
- `zn codegen` generates Kotlin and Swift interfaces plus the argument encoding. The native side implements them.
- Calls are asynchronous: JS → `__zn_call` → native runs on the module's own thread (or main if it says so) → result
  posted back to the JS thread.
- Each module and its version is a **capability** listed in the app binary (section 16.2).

### 15.2 Native views
`<NativeView name="camera.qrScanner" props={...} onEvent={...} />`. Native registers a factory for the name. Props
and events go through slots and events like any component.

### 15.3 Native screens
A route can point to a native screen (Kotlin composable / SwiftUI view) instead of a zn screen. It takes part in the
same back stack and can return a result to JS.

### 15.4 Native resource handles: `zn://` (decided 2026-10-29)
Heavy native objects (app icons, camera photos, generated QR images, contact photos, PDF thumbnails) **never go
through JS as bytes**. A native module keeps the object and returns a short string handle; JS passes the string
around; native resolves it when drawing or uploading.
- Examples: `zn://app-icon/com.phonepe.app`, `zn://file/kyc/front-01.jpg`, `zn://mem/qr/order-998`.
- `Image src` and upload effects accept handles. On Android a Coil mapper resolves them.
- `zn://mem/...` handles live only in memory and **die with the process**. `zn://file/...` handles point to
  app-private files and survive it. **Flows may only store `zn://file/...` handles** (a KYC photo must survive process
  death); the dev build throws if a flow saves a memory handle.
- Native owns cleanup: memory handles are dropped when no screen uses them; file handles when their flow ends (or
  by an explicit `release`).
- v0 lesson: Base64 icons cost 40–100 KB of JS heap each and copied pixels three times. With handles, 9 real UPI app
  icons rendered with zero pixel data in JS.

## 16. OTA updates

### 16.1 Bundle lifecycle (decided)
- Bundles are **signed** (Ed25519). The public key is in the app binary. Unsigned or wrongly signed = never loaded.
- Download in the background; verify hashes and signature; store in a bundle pool with the last known good bundle.
- **A new bundle is applied only at cold start**, and never while a flow is active (it waits for the next cold start
  with no active flow, or a flow's natural end). Flows then go through migration (12.5).
- **Boot guard:** if the app crashes twice within N seconds of starting a new bundle, roll back to the previous good
  bundle and report it.
- Server side: channels, staged rollout percentage, kill switch, rollback. (ZeroBill's OTA v2 already does most of
  this; the zn version reuses its design.)

### 16.2 Compatibility (decided)
The app binary carries a **capability manifest**:
- framework ABI version, Hermes bytecode version,
- component registry version (component ids, prop ids, value types),
- native modules and their versions, native views, native screens.

Each bundle's `manifest.json` lists what it **requires**. The server only offers a bundle to app versions whose
capabilities cover it, and the phone checks again before loading. Test that must always pass: **an older installed app
is offered a newer bundle and safely ignores it.**

### 16.3 Store policy
- Apple App Store guideline 2.5.2 and Google Play's rules allow interpreted code updates for fixes and small changes;
  shipping **new features** over the air is a gray zone (the same as CodePush / Expo Updates). zn makes OTA easy; the
  app team decides what to ship through it.

## 17. Tooling (v1 scope)
- `zn dev`: dev server, builds on save, pushes the changed screen to the device; the screen reloads in place, flows
  and back stack are kept (they are saved data).
  v0 Dish B measured save → screen in **127 ms** (Bun build 5 ms + `hermesc` 74 ms + device ~48 ms) by dropping and
  recreating the Hermes runtime in the same process. Restarting the runtime is allowed **in dev builds only** (it is
  an exception to the one-runtime-per-process rule, §8.2); after a reload the runtime re-reads FlowStore and stays on
  the current route. Release builds never contain the dev client.
- **Debugging:** Hermes Chrome DevTools debugging (breakpoints, profiler, heap snapshots) over the dev server.
- **Errors:** JS errors show a dev overlay with the TSX file and line (source maps). In release, JS stack traces are
  sent to the crash reporter and mapped back on the server with the bundle's source maps.
- **Tests:** logic and flows run under `bun test` with a fake host (no device needed). Renderer conformance screenshot
  tests run on emulators / simulators.
- **Lint:** the compiler reports destructured props, effects missing `reconcile`, flow schema changes without a version
  bump, and unknown components or props.

## 18. Security and privacy
- Only signed bundles run. No `eval` of downloaded text; Hermes runs our compiled bytecode only.
- Flows hold plain JSON with **no secrets**; files are app-private and excluded from backups.
- For regulated apps (for example payments in India), check what flow data is allowed at rest under RBI rules.
- Native modules are the only way to reach platform APIs; permissions are requested through `os.permissions`.

## 19. Performance targets
| What | Target | v0 measured (Lava Blaze 2 5G, prototype, 2026-10-28) |
|---|---|---|
| Whole-app shell download (Compose + Hermes + ML Kit + Firebase + Play services, no screens) | ≤ 10 MB | **6.42 MB** (RN + packaging fix ≈ 13.0 MB). A full app with screens, assets and its JS bundle is estimated at 8–9 MB, not measured. |
| Hermes share of that | — | ≈ 0.83 MB |
| Cold start (`am start` TotalTime, release) | **≤ 250 ms** (Flutter 1.6.0: ~300–330 ms) | exp 2 (one screen): 222 ms; exp4-flow (5 screens, broke the startup rules): ~400–420 ms, measured 2026-10-29 |
| Tap → screen updated | p95 ≤ 16 ms | **p50 0.97 ms, p95 2.08 ms** (only the changed `Text` recomposed) |
| Apply one batch on the main thread | ≤ 4 ms for a normal update; **≤ 8 ms for building a whole screen** | normal update 0.38 ms; building a screen through ops 17 ms (v0 had no template; v1 inflates the template natively instead) |
| Restore after process death to the right screen | ≈ native cold start | 91 ms reported (debug build; re-measure in release) |
| Screen bytecode size | tens of KB | 19.7 KB (one screen), 64 KB (three screens + flow) |
| Animations behind a translucent UPI window | 60 fps, no workaround | p50 16.6 ms frames, 0 `onStop`, no frame pump or overlay |
| List fling (90 Hz phone) | ≤ 11 ms per frame | one shared row template 2.8–4 ms; generic node tree per row 18–25 ms (rejected) |
| Hot reload, save → screen | ≤ 300 ms | 127 ms (dev build) |

Every number, with how it was measured: `docs/startup-and-performance.md` §4.

Comparisons with the RN app in `RESULTS.md` are directional only: cold start and memory compare a prototype with the
full app, and the RN tap-latency figures are estimates (the RN app has no tap instrumentation).

## 20. iOS notes (design is checked against these from day one)
- Hermes runs on iOS as an interpreter; no JIT is needed (and Apple forbids it).
- One `SlotCell` object per slot (9.1). Changes only on the main actor.
- `NavigationStack(path:)` for the back stack; sheets with `presentationDetents`.
- Process death on iOS (jetsam) follows the same FlowStore and restore rules.
- UPI on iOS has no activity result: results come from app switching (resume) and callback URLs. The flow model is
  the same; `launchActivity` is replaced by `openURL` + resume handling, still a `once` effect.

## 21. Repository layout (planned)
```
zero-native/
  compiler/        TS: JSX transform, template writer (.zn.ui), flow schema checks, codegen
  core/            C++: engine adapter (Hermes), batch buffer, .zn.ui reader, FlowStore, bundle loader
  android/         Kotlin: Compose renderer, navigation, modules, AAR packaging
  ios/             Swift: SwiftUI renderer, navigation, modules, XCFramework
  packages/        TS: @zero-native/core, ui, nav, net, storage, os
  cli/             zn CLI
  conformance/     test screens + screenshot tests
  examples/        sample apps (ZeroBill-like checkout)
```

## 22. What we kept, changed and dropped from Gemini's first spec (`intro.md`, `intro2.md`)

| Gemini idea | Decision | Why |
|---|---|---|
| `.zn.ui` FlatBuffer UI template with folded modifiers | **Kept** (section 6.1) | Native can draw the static skeleton before JS starts; no parsing. The exact "64-byte struct" is not a promise. |
| Dynamic values as offsets / slots | **Kept as slots** `(instanceId, slotId)` | Slots must belong to template instances because `<If>` / `<For>` create sub-instances. |
| "Zero bridge serialization" | **Changed** | Small typed values cross the boundary in a binary batch; no JSON in v1. We don't claim "zero" until measured. |
| `.zn.anim` SIMD spring bytecode on a render thread | **Replaced** by native springs (10.1) | Compose and SwiftUI already have springs; they don't give us a render thread to run our own math. |
| 120 Hz gesture math | **Deferred to v2**, explicitly marked (10.3) | Automatic splitting of arbitrary TS is research; explicit marking (as in Lynx) is proven. |
| `.zn.wasm` logic actor (TS → WebAssembly) | **Replaced** by Hermes bytecode (section 7) | iOS forbids JIT, so OTA Wasm would be interpreted anyway; TS → Wasm needs a GC inside the module; years of compiler work. The **background-thread actor idea is kept** (8.2). |
| Trifurcating compiler (automatic 3-way split) | **Changed to two outputs per screen** (template + bytecode) | The split comes from JSX structure, not from analysing closures. |
| `state.zn.arena` mmap shared memory for all state | **Narrowed** to FlowStore (13.2) | Process-death safety only needs flows + back stack. A general arena needs an allocator, has torn-write and crash-loop problems, and adds a third copy of data next to the JS heap and native state. |
| `@schema` byte offsets, socket → arena zero-copy, simdjson | **Dropped** | JSON parsing is not the bottleneck; plain JS objects are simpler and debuggable. |
| Custom Rust/C++ HTTP/3 QUIC stack | **Dropped** | OkHttp / URLSession (Cronet later if needed). A custom network stack is pure risk. |
| Rust SIMD flexbox layout | **Dropped** | Compose and SwiftUI do layout; a second layout pass contradicts "native". |
| `@resumable` generator continuations (saved instruction pointer) | **Replaced** by `@flow` (section 12) | A saved instruction pointer breaks when an OTA update lands mid-flow. Named steps + versioned data + effect kinds survive it. |
| `routes.zn.bin` radix-trie router | **Simplified** to a route manifest (11) | Same benefit (route before JS starts) without a custom binary trie for a few dozen routes. |
| Shared-element transitions via hashed keys | **v1, optional** (`heroTag`, §11) | Compose `SharedTransitionLayout` and SwiftUI zoom transitions do the work; v0 Frontier 4 showed it at 90 fps. Plain string keys, no hashing needed. |
| 64-byte folded modifier structs | **Changed** to static styles folded into the template (5.4) | Authors write RN-style `style`; the renderer owns the order. |
| `<ShaderCanvas>` (WGPU) | **Deferred / likely never** | Adds megabytes; conflicts with goal 1. |
| `<HardwareSurface>` (camera etc.) | **Kept as `NativeView`** (15.2) | Native views are first-class. |
| Strict TS subset (no `any`, no dynamic shapes) | **Dropped as a language rule** | Not needed for Hermes. Lint rules cover the cases that matter. |
| Performance numbers (0.4 ms restore, 0.2 ms deep link, <8 ms first frame, 15–40 KB OTA) | **Dropped** | Not physically possible (Android process start alone takes hundreds of ms) or unmeasured. Section 19 has honest targets. |
| "100% compliant with App Store 2.5.2" | **Corrected** (16.3) | It's a gray zone for new features. |
| "Agentic AI makes compilers nearly free" | **Rejected as a planning assumption** | AI speeds up code; tooling, debugging and ecosystem still take years. |
| `zn` CLI, `@zero-native/*`, `*.zn.tsx` | **Kept** (working name) | Check the name before going public. |

## 23. Deferred (not in v1)
- Gesture expressions on the UI thread (10.3).
- Native list data source for very large lists (v1.1; designed in `docs/lists.md` §6).
- NativeWind `className` → style translator for porting RN code (v1.1 option; `docs/styling-and-layout.md` §9).
- A general mmap data arena.
- Cronet / HTTP/3 backend.
- Web or desktop renderers (non-goal).

## 24. Decision log
| Date | Decision | Reason |
|---|---|---|
| 2026-10-27 | Hermes V1 on both platforms; no engine benchmark | Section 7.1. Debugger + maintenance outweigh ~0.5–1 MB; measured cost already offset by removing RN. |
| 2026-10-27 | 3-function engine interface + host functions (7.2) | Keeps the engine swappable; no engine types leak into renderers. |
| 2026-10-27 | `(instanceId, slotId)` patches + binary structural ops, one flush per tick, coalescing | Section 8.3. Needed for `<If>` / `<For>`, SwiftUI main-thread rule, and tear-free frames. |
| 2026-10-27 | FlowStore = two-slot mmap file, no fsync; Storage = MMKV module | Section 13. Microsecond writes, safe under process kill; restore rules make power loss safe. |
| 2026-10-27 | Effect kinds `safe` / `keyed` / `once` with mandatory `reconcile` | Section 12.2. Generalises the "never launch UPI twice" rule to every unsafe action. |
| 2026-10-27 | Compose foundation, not material3 | Size; apps bring their own design system. |
| 2026-10-27 | Screen root instance id = back-stack `entryId`; native creates roots, JS never mounts them | Section 8.3. Lets the skeleton draw before JS without a double mount (Argon review 3). |
| 2026-10-27 | Off-screen instances keep plain value arrays; observable cells only while composed | Section 9.3. Big lists don't allocate thousands of observable objects (Argon review 3). |
| 2026-10-27 | FlowStore grows by copy + rename up to 256 KB/slot; over that, the write fails and the effect does not run | Section 13.2. Release behaviour for oversize state, write-ahead rule kept (Argon review 3). |
| 2026-10-27 | Taps only on `Pressable` / `Button`; no handlers in modifiers | Section 5.3. One event system, proper accessibility roles (Argon review 3). |
| 2026-10-28 | v0 experiments passed; keep Hermes (real share ≈0.83 MB, not 0.39 as first reported) | Section 19. Variant D of exp 1 was a bad build (bigger dex). |
| 2026-10-28 | One JS runtime per process; Activities are only view hosts | Section 8.2. v0 restarted JS on Activity recreation, which loses state. |
| 2026-10-28 | Timers use logical handles; `clear*` always wins | Section 14. v0 "zombie timer" bug. |
| 2026-10-28 | `signal.set()` ignores equal values | Section 5.2. v0 keypad bug. |
| 2026-10-28 | `onPressOut` fires on cancel too; key repeat is native (`onPressRepeat`) | Section 5.3. v0 keypad bug; JS should not time press-and-hold. |
| 2026-10-28 | Hermes `withMicrotaskQueue(true)` + drain after every entry | Section 7.2. Off by default in Hermes. |
| 2026-10-28 | Batch-apply budget: ≤ 8 ms to build a screen | Section 19. v0 took 17 ms building a screen through ops; v1 uses native template inflation. |
| 2026-10-29 | `style` props with RN names, fixed order owned by the renderer, our own flex rules, **no Yoga**; margins allowed; unsupported keys are build errors | Section 5.4, `docs/styling-and-layout.md`. Modifier chains are order-dependent and foreign in JSX (modifier report). |
| 2026-10-29 | `<For>` for short lists, `<List>` with data windows, stable keys and same-height placeholders; native data source in v1.1 | Section 9.3, `docs/lists.md`. v0 eager list ran out of memory; windowed list ran at 90 fps. |
| 2026-10-29 | Fast template interpreter; no Kotlin/Swift code generation | Section 9.1. Shared template 2.8–4 ms vs node tree per row 18–25 ms; code generation would break OTA. |
| 2026-10-29 | Safe areas and keyboard as native route options; no JS `SafeAreaView` | Section 11. v0 JS insets caused a blank screen and bar overlap. |
| 2026-10-29 | Controlled components: native sends events, JS owns values | Section 9.7. v0 sheet wrote JS-owned state from native. |
| 2026-10-29 | `zn://` native resource handles; flows store only file-backed handles | Section 15.4. No pixels in JS; handles must survive process death when a flow needs them. |
| 2026-10-29 | Startup rules + ≤ 250 ms budget; release-only numbers | Section 8.1. exp4-flow measured ~400–420 ms release because it broke these rules. |
| 2026-10-29 | Shared elements move into v1 as optional (`heroTag`) | Section 11. Cheap with Compose; v0 Frontier 4 at 90 fps. |
| 2026-10-29 | Hot reload may restart the runtime in dev builds only | Section 17. 127 ms save → screen. |
| 2026-10-29 | `.zn.ui` uses our own versioned binary format, not FlatBuffers | Section 6.1. No code generator or generated code in 3 languages; templates are parsed once and prepared, so zero-parse reading buys nothing. |
| 2026-10-29 | Registry is one TS file; the Kotlin copy is generated and checked by a test | Section 6.1. Ids can't drift between the writer and the renderer. |
| 2026-10-29 | Colours are ARGB numbers at runtime (parsed at build time); JS sends colours as numbers | Section 9. v0 parsed "#hex" strings while drawing. |
| 2026-10-29 | Control flow is plain JS (`&&`, `? :`, `.map` with `key`), compiled to Anchor nodes; no `<If>` / `<For>` | Section 5.3. Familiar to React/RN developers; same template mechanics underneath. |
| 2026-10-29 | Build-time constants: literals, module `const`s, `StyleSheet.create`, and named imports from side-effect-free `.ts` modules (tokens) loaded by the compiler | Section 5.4. Tokens cost nothing at runtime; anything else is a slot or a build error. |
| 2026-10-29 | Signals are push-pull and glitch-free, with owners for cleanup | Section 5.2. v0's signals ran subscribers immediately (diamond glitches) and never cleaned up branches. |
| 2026-10-29 | A Column only stretches children when its own width is definite | `docs/styling-and-layout.md` §5 rule 4. Matches RN; found as a full-width badge on the phone. |
| 2026-10-29 | Press feedback is clipped to the node's rounded shape | `docs/styling-and-layout.md` §4 step 8. Found on the phone: square highlight on a rounded button. |
| 2026-10-29 | Press repeat is an event + two props (`onPressRepeat`, `repeatDelay`, `repeatInterval`), not an object prop | Section 5.3. Events stay plain functions; config stays build-time props. |
| 2026-10-29 | Icons are SVG path data ("minX minY w h\|d") folded at build time and drawn natively | Section 9.2. No icon font or SVG library; one string per icon. Fill paths only for now. |
| 2026-10-29 | Images load with Coil (http(s), `asset:`) and clip to their rounded shape by default | Section 9.2. Same as React Native; Coil was already in the v0 size check. |

## 25. Open items (to decide while building, not blockers)
- Public name, npm scope, license (MIT suggested, same as React Native and Hermes).
- iOS image cache choice.
- Exact FlatBuffers schema for `.zn.ui` and the batch byte layout (written in milestone 1).
- How computed row expressions work with a native list data source (`docs/lists.md` §6, v1.1).
- Whether to build the NativeWind `className` translator (v1.1).
- Flow tests the framework must pass that v0 left open: restored flows must reach a final state with `/verify`
  actually called; a `/pay` that died mid-call (no `ztc`) means "payment not started" (`docs/v0-findings.md` §D).
- Nav3 version and stability at build time [check].

## 26. Glossary
- **Template:** the compiled, static shape of a screen or part of a screen.
- **Instance:** one mounted copy of a template (one screen, one list row, one `<If>` branch).
- **Slot:** one changeable value inside an instance (a text, a colour, a visibility flag).
- **Batch:** the list of slot changes and structure changes JS sends to native once per tick.
- **Tick:** one JS task plus the microtasks it queued.
- **Flow:** a saved state machine for a multi-step process.
- **Effect:** a side effect inside a flow (network call, launching another app) that must be recorded before it runs.
- **Reconcile step:** the flow step that finds out what really happened after an uncertain effect.
- **FlowStore:** the crash-safe file where flows and the back stack are saved.
- **Capability manifest:** the list of what an installed app can run (engine, components, modules), used to decide
  which OTA bundles it may load.
- **Style:** the `style` prop; React Native style names that the renderer applies in one fixed order.
- **Row template / window:** a `<List>` row compiled once; the window is the range of rows whose values JS has sent.
- **Placeholder:** what a slot shows before its value arrives (same template, same size).
- **Resource handle:** a `zn://` string that names a native object (icon, photo) without copying its bytes into JS.
