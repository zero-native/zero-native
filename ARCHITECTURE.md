# zero-native (`zn`): architecture

**Status:** v1 target design. Written by Claude (Opus) with Pavan, 2026-10-27, after two review rounds with Gemini 4 Argon.
**v0 experiments and spikes done (2026-10-27 to 10-29):** all passed on the Lava Blaze 2 5G. Lessons are folded in
below (marked "v0 lesson"); the full list is in `docs/v0-findings.md`.
**Updated 2026-10-29:** styling, lists, startup, safe areas, controlled components, native resource handles.
**Updated 2026-10-31:** "Where things stand" below; "as built" notes where the build differs from the first plan
(§4, §6, §8.1, §15, §16, §17, §21); decision log to 2026-10-31; plugins proposal (`docs/plugins.md`).
**Detailed spec files live in `docs/`** (start with `docs/README.md`). This file stays the summary and the decision log.

**Where things stand (2026-10-31, Android only).** Milestones 1–4 are built and checked on a real low-end phone
(Lava Blaze 2 5G, Android 14): compiler and templates, signals, the batch, the Compose renderer and component set,
navigation (deep links, back, safe areas, restore after process death, `restorableSignal`), lists / feeds / sheets,
native modules (calls, events, cancellation, binary data), `fetch`, storage (MMKV) and SecureStore, FlowStore, text
input, animation, resilience (error screens, time limits), the `zn dev` hot reload, and OTA (signed bundles,
compatibility check, store + CLI + reference server, apply in place, safety nets, crash traces mapped to TSX; 38 / 38
phone test cases). Release cold start of the sample app: ~180 ms median. The plugin base and its plumbing are built (P.1, P.2, 2026-11-02): permissions, "open another app for a
result" that survives a kill, `Os`, `detached`, `zn://app-icon` handles. An app outside this repo builds and runs with its own plugin (P.3).
**Updated 2026-11-04:** the plugins are built (P.1 to P.6: `auth`, `scanner`, `media`, `webview`, then `pdf`, `location`
and the Firebase plugins `firebase-app`, `crashlytics`, `push`, `analytics`, `remote-config`, `perf`; `docs/plugins.md`),
and so are `<NativeView>`, native screens and background JS tasks. Also built since: bottom tabs, pull to refresh, SVG,
RN-style handlers and props (registry 15, host API 8).
**Not built:** iOS (no host yet) and the flow engine (parked, §12). Progress log: `docs/milestones.md`.
Judgment calls waiting for a second opinion: `docs/second-opinions.md`.
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
7. **React Native names, not React's runtime** (Pavan, 2026-11-04). We keep React Native's names for APIs and props, so
   ported code reads the same. We don't add what needs React's runtime model (re-rendering, hooks rules, element
   objects) or a second styling system (`className`). A port helper is only a build-time change, and only after a real
   port measured what it costs. If zero-native's design doesn't allow something, we don't chase it.

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

**As built (2026-10-31):** the compiler is a Bun build plugin using the TypeScript compiler API (`compiler/src/`),
not SWC / OXC. A bundle is **one** `main.zn.ui` (all templates, our own binary format, §6.1) + **one** `main.hbc`
(all JS) + `main.zn.ui.json` (routes, components) + `zn-bundle.json` (id, SHA-256, requirements) + images. The
template reader lives in Kotlin today (`TemplateReader.kt`), not C++; the OTA bundle loader and signature check are
Kotlin too (`ZnBundles`, `ZnOtaSignature`). The C++ core holds the engine adapter, batch buffer, FlowStore and MMKV
storage. Navigation 3 (1.2.0) hosts the screens on Android.

## 5. Authoring model

### 5.1 Files and naming
- Screens and components: `*.zn.tsx`. Plain logic: `*.ts`.
- Packages: `@zero-native/core` (signals, flows), `@zero-native/ui` (components, styles),
  `@zero-native/nav`, `@zero-native/net`, `@zero-native/storage`, `@zero-native/os` (platform APIs).
  **As built:** three packages: `@zero-native/core` (signals, navigation, `fetch`, storage, FlowStore, native
  modules, updates, errors), `@zero-native/ui` (components) and `@zero-native/template` (registry + template writer,
  used by the compiler). Platform APIs and optional features become plugins (`docs/plugins.md`).
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
- **Built variants:** `persistedSignal(key, initial)` (kept in `storage`, survives everything; §13.4) and
  `restorableSignal(key, initial)` (inside a screen; comes back only when Android restores the app after killing it
  in the background; §11, guide notes §26.1).

### 5.3 Screens and components
```tsx
// Registered in routes.ts as { checkout: { path: '/checkout/:sessionId', screen: Checkout } } (§11)
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
  A handler that is not written in place (a name, `props.onPress`) is read when the event comes, and an undefined one
  does nothing (d4f97f1). A handler written as a call, like `once(pay)`, is made once when the element appears
  (5301225; `docs/guide-notes.md` §5; `docs/second-opinions.md` entry 104).
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

**As built (2026-10-31):** not per screen yet. A bundle is one `main.hbc` + one `main.zn.ui` (all screens) +
`main.zn.ui.json` + `zn-bundle.json` (id, SHA-256, requirements; signed by the OTA store) + images; source maps stay
on the build machine / OTA store (`docs/ota.md` §3.7). OTA ships the **whole bundle**, compressed (~115 KB for the
15-route sample), which made per-screen files and patches unnecessary for now (decision D5, `docs/ota.md` §2). The
cold start still evaluates all JS (~70 ms in a debug build for the sample); per-screen bytecode stays the plan if
real apps make that slow.

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

**As built (2026-10-31):** step 1 is `ZnBundles` choosing the APK's bundle or a downloaded one, after the OTA
safety-net checks (`docs/ota.md` §3.6). Step 2 reads the **Activity's saved state**, not FlowStore (changed in step
3.9, §11). Step 4 evaluates the whole `main.hbc` (§6 as built). Measured: release cold start of the 15-route sample
**~195 ms median** (n=10, speed-profile, built-in or downloaded bundle), within budget.

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
- `NAV(kind, entryId, routeIndex, paramsJson)`: back-stack change (section 11). For `PUSH`, `entryId` is the new
  screen's root instance id. Built in milestone 2 step 2.2 with five kinds: `PUSH`, `REMOVE`, `CLEAR`, `EXIT`,
  `BACK_ANSWERED`; since then `IMPRESSIONS` (6), `FAILED` (7, step 3.9), `STARTED` (8, step 4.7), `RESTORE` (9,
  `restorableSignal`). `FAILED`, `STARTED` and `RESTORE` each raised the host API version (now 8; `packages/core/src/host-api.ts` says what each version added). Replace = `REMOVE` + `PUSH` and reset = `CLEAR` + `PUSH`es in one batch: native applies a batch
  at once and picks the transition from the resulting stack. Byte layout: `core/include/zn/batch.h`.
- Native → JS app-level events (start stack, back press, forced back, deep link while running) use instance id 0.

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
| pull to refresh (`refreshing`, `onRefresh` on `Scroll` / `List`) | our own: nested scroll + a disc drawn on the list (`ZnPullRefresh.kt`) | `.refreshable` [check] |
| `For` (short lists) | keyed children inside `Column` / `Row` / `Scroll` | keyed children (`ForEach`) |
| `List` (virtualized, 9.3) | `LazyColumn` / `LazyRow` / `LazyVerticalGrid` with keys | `LazyVStack` / `LazyHStack` / `LazyVGrid` with ids |
| `Text` | `Text` | `Text` |
| `Image` | Coil `AsyncImage` / painter | `AsyncImage` + our image cache [check cache choice] |
| `Icon` | SVG path data drawn with a Compose `Path` (folded into the template at build time) | the same path data in a SwiftUI `Path` |
| `Svg` (`.svg` files, inline `<Svg>`; registry 11–13, `docs/svg.md`) | draw data compiled at build time, drawn in `drawBehind` (paths, strokes, gradient shaders, clips, layers; registry 13: masks, pattern shaders, filters as `RenderEffect`, text); runtime `color` and part overrides (paint, opacity, transforms, trims) read in the draw phase | the same draw data with Core Graphics (`CGPath`, `CGGradient`) |
| `Pressable` / `Button` | `clickable` with indication, haptics | `Button` with custom style |
| `TextField` | `BasicTextField` (state-based) | `TextField` |
| `<>...</>` (Fragment) | children laid out in the parent | children in the parent stack |
| `Switch`, `Checkbox`, `Slider`, `Progress`, `Spinner` | foundation-based components | native controls |
| `Sheet` (with detents) | our own foundation-based sheet: native drag, velocity, rubber-band and spring (v0 Frontier 1: 0 bridge events during a drag) | `.sheet` + `presentationDetents` |
| `Dialog`, `Toast` | `Dialog`, custom toast host | `.alert` / custom overlay |
| `Lottie` | Lottie Compose | lottie-ios |
| `NativeView` | `AndroidView` / registered composable | `UIViewRepresentable` / registered view |
| `Tabs` (tab panels, §11) | `Box` with the selected child only + `SaveableStateHolder` | `ZStack` with the selected child [check state keeping] |
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
- **`<List data key row>`** is for long lists (built in milestone 2 step 2.4a). Each JSX leaf of `row`
  (`cond ? <A/> : <B/>` picks a row **kind**) is compiled once into a row template. Native gets every row's key and
  kind (`LIST_SET` / `LIST_SPLICE`); **rows are ordinary template instances that JS mounts only near the visible
  range** (`MOUNT` + `LIST_ROW`) and removes after they leave a wider band, so a row can hold anything a screen can
  (taps, conditionals, rails, components) while a long list costs one key + kind per row. Native draws rows with
  `LazyColumn` (`contentType` = kind) / `LazyVStack`. Full protocol: `docs/lists.md` §3.
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

**Built (milestone 3 step 3.3):** `<TextField>` on Compose's state-based `BasicTextField` (`ZnTextField.kt`; IME
composition, paste and emoji are Compose's own handling). Controlled fields work as in React Native: native numbers
each change ("ntext"), JS answers every change with what `value` says now ("nvalue", `textInput()` in
`packages/core/src/view.ts`), and native ignores an answer to an older change or one that arrives while a newer
change is still unsent. So fast typing never jumps back, and a rejected or reformatted change comes back correctly
(Lava: typing "123456789" fast into a field limited to 7 digits and formatted as rupees gave "12,34,567" in 3 of 3
runs). Selection from JS is not supported yet. The keyboard: route option `keyboard: "resize" | "none"` (default
resize, `imePadding` under the route's safe-area padding), `Keyboard.dismiss()` (built-in module `ZnKeyboard`).

**Focus from JS (RN basics pack, registry 10):** `<TextField ref={r}>` with `r = createRef()`. The compiler gives `ref` an
event id (`EventKind.ref`); `ZnTextField` registers its `FocusRequester` with `ZnKeyboard` (v2) under (instance, id)
while composed, so `r.current.focus()` / `blur()` / `clear()` are `Keyboard` calls, and focus changes come back on the
same id for `isFocused()`. Keyboard shown / hidden and its height reach JS as app event KEYBOARD (host API 7), from
`WindowInsets.imeAnimationTarget`: one event per show or hide.

### 9.5 Cross-platform layout rules and conformance tests
- zn defines its own small layout rules (alignment defaults, how `weight` / `fill` resolve, text line height), and
  each renderer maps them explicitly, never relying on toolkit defaults.
- Conformance tests: a set of test screens rendered on both platforms with screenshot comparison and tolerance.
  Known, accepted differences are listed in `docs/platform-differences.md`.

### 9.6 Accessibility and text
- Every component maps `accessibilityLabel`, `accessibilityHint`, `accessibilityRole`, `accessibilityHidden` to
  native accessibility (TalkBack / VoiceOver). React Native's names for the first three, so RN code ports as it is;
  RN splits "hidden" per platform, so we have one `accessibilityHidden` (decided 2026-10-30).
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

**Built (step 3.6), the shape it took:** `animate={250}` or `animate={{ opacity: 200, translateY: "spring" }}` on any
element (opacity, background colour and transforms; transforms can now change at runtime), and `enter` / `exit` on
the root of a `&&` / `? :` branch or a `.map` row (presets `fade`, `fade-up`, `fade-down`, `scale`, `pop`, or
`{ opacity, translateX, translateY, scale, duration | spring }`). All encoded at build time; native animates with
`Animatable` values read in the draw phase (no recomposition per frame). On REMOVE, an instance with `exit` stays in
its parent (marked exiting) until its animation ends; JS indexes skip exiting children. Guide: `docs/guide-notes.md`
§22.

### 10.3 Gestures (deferred to v2)
Gesture-driven values (drag offsets, swipe-to-pay) must update on the UI thread every frame. v2 adds a tiny,
**explicitly marked** expression language (`'main thread'` directive, like Lynx), compiled into the `gestures` section
of `.zn.ui` and run natively. No automatic splitting of arbitrary TS. Until then: native sheets with detents, native
scroll behaviours, and `NativeView` cover the common cases. v0 Frontier 1 confirmed the pattern: a fully native
draggable sheet ran at 2.8–4.2 ms frames with 0 bridge events during the drag and one event when it settled.

## 11. Navigation (decided)

- **Routes are declared in one typed file (changed 2026-10-29):**
  ```ts
  // routes.ts
  export const routes = defineRoutes({
    home:     { path: '/', screen: HomeScreen },
    amount:   { path: '/pay/:merchantId', screen: AmountScreen, transition: 'push', deepLink: true },
    receipt:  { path: '/receipt/:ztc', screen: ReceiptScreen, transition: 'modal', safeArea: { top: false } },
  })
  nav.push('amount', { merchantId: 'm1' })   // name and params are type-checked
  ```
  (Earlier drafts used `@route(path, options)` on the screen function. TypeScript allows decorators only on classes
  and class members, so editors would mark it as an error.) The compiler reads `routes.ts` at build time and writes a
  **route manifest** (in `manifest.json`): route name → path pattern, screen template, transition, presentation
  (push / modal / full-screen), safe-area option, deep-link rules. The compiler reads the call without running it;
  route order in the file = route index at runtime. Every `:param` must be a string prop of the screen (type-checked).
  **Deep links are opt-in per route (`deepLink: true`)**: a link is an outside entry point, so a route is reachable
  from one only when its author says so (built in milestone 2 step 2.1).
- **The back stack is plain data:** a list of `{ routeId, params, instanceKey }`. JS changes it with
  `nav.push / back / replace / reset / sheet / closeSheet`, sent as `NAV` ops in the batch.
- **Android:** Jetpack Navigation 3 (a back stack you own as a list), one generic destination that renders a zn
  screen. Predictive back comes from the platform. (Checked: Navigation 3 1.2.0, stable, in use.)
- **iOS:** `NavigationStack(path:)` with our path array; sheets via `.sheet`.
- **Transitions are native**, declared per route. JS never animates a page change.
- **Deep links:** native matches the URL against the route manifest **before JS starts**, so the target screen's
  skeleton draws first. A cold link opens the start route with the link's route on top (back goes to the start
  screen, not out of the app). A link while the app runs is sent to JS, which pushes it.
- **Back button / gesture:** a screen registers `useBack(() => boolean)` (for example "Discard amount?"); it returns
  `true` when it handled the press, like React Native's `BackHandler`. Native sends the press to JS; JS always answers
  (`BACK_ANSWERED`, then pops or not). If JS doesn't answer in 300 ms, native pops by itself and tells JS. On the last
  screen the system handles back (the app goes to the background); a last screen's `useBack` is not asked yet.
- **Screen lifetime:** closing a screen disposes it in JS at once (effects, events, **timers**); native keeps its
  instances until the exit animation ends, and ignores patches for instances it doesn't know.
- **The back stack comes back after process death** (built in step 3.9): when the app goes to the background, the
  stack (route names + params) goes into the Activity's saved state (`ZnNav.saveState`). Android hands it back only
  when it restores the app after killing it, so a normal launch still starts on the start screen. Routes with
  `restore: false` (and the screens above them) are left out; screens' JS state starts fresh. (Changed from "saved in
  FlowStore on every change": the saved state gives exactly Android's rule for when to restore, and no writes per
  navigation.) Except `restorableSignal(key, initial)` values (host API 4): each change goes to native (NAV
  RESTORE), which keeps them per entry, saves them with the stack, and hands them back in START's `values`, only into
  the same bundle (`id@sha12`) that saved them (docs/second-opinions.md entry 7).
- **A new Activity without saved state starts fresh** (2026-10-31): the stack lives in the process, so on phones
  that keep the process after a swipe from recents (the Lava) the old screens used to come back. Now `ZnNav.start`
  with no saved state while screens are up replaces the JS runtime (the in-place update path) and opens the start
  screen, like a new launch. Links while running go through `ZnNav.openLink` (`onNewIntent`).
- **A second Activity never restarts JS** (2026-11-02): hosts use `singleTop`, so a link while another app is on top
  makes a second Activity. It is not its task's root, so `ZnNav.handleExtraActivity` forwards the link and closes it. Only
  a task root with no saved state starts fresh. Query values reach the route as params, and `startApp(routes, { onLink })`
  lets the app refuse a link while it runs.
- Native screens are routes too (section 15.3).
- **Tabs live inside one screen (built 2026-11-03, host API 8, registry 11):** route option `tabs: [...]`, `useTabs(route)`,
  and a native `<Tabs selected>` container that draws only the selected tab (the others keep their state; a
  `SaveableStateHolder` keeps their scroll). The bar is the app's JSX. Back on a later tab goes to the first tab; on the
  only screen native asks JS then (NAV BACK_WANTED). The selected tab is a `restorableSignal`. A link to `<path>/<tab>`
  selects the tab, going back to the tabs screen if it is in the stack. `useFocus` / `tabs.onFocus`: focus = on top of
  the stack (and the tab selected), computed in JS. Guide notes §40, docs/second-opinions.md 44–48.
- **Safe areas and the keyboard are route options, handled natively (decided 2026-10-29):**
  `@route(path, { safeArea: 'all' | 'none' | { top?, bottom? }, keyboard: 'resize' | 'none' })`, default `'all'` /
  `'resize'`. Android: edge-to-edge on, the screen host applies `windowInsetsPadding` (Compose foundation, not
  material3 `Scaffold`). Full-bleed screens read a read-only `insets()` signal. There is no JS `SafeAreaView`
  (v0's JS version caused a blank screen and status-bar / nav-bar overlap). Details: `docs/styling-and-layout.md` §6.
- **Shared-element transitions (v1, optional; decided 2026-10-29):** a node with `heroTag="tx-123"` on two screens
  morphs between them during navigation (Compose `SharedTransitionLayout`, SwiftUI zoom transition on iOS 18+). v0
  Frontier 4 ran a list-row → detail-header morph at 90 fps. Screens without `heroTag` are unaffected.
  - **Rule: one `heroTag` per navigation transition, and it means "this card/container on screen A becomes screen
    B"** (example: a transaction row opens the transaction detail). Not several independent elements morphing at once
    (an avatar and a title separately). Reason: iOS 18's native zoom transition (`.matchedTransitionSource(id:in:)` on
    the source + `.navigationTransition(.zoom(sourceID:in:))` on the destination) morphs one source view into the
    **whole** incoming screen. Compose can do more (`Modifier.sharedElement` per element), but we only expose what
    both platforms do natively, so iOS needs no custom overlay renderer. (Argon review, 2026-10-29.)
  - Compose wiring: `SharedTransitionLayout` wraps the navigation host (`NavDisplay`); the host passes the
    `SharedTransitionScope` and each screen's `AnimatedVisibilityScope` down through `CompositionLocal`s, so any node
    with `heroTag` adds `Modifier.sharedElement(rememberSharedContentState(heroTag), animatedVisibilityScope)` without
    changing the node tree. Not built in milestone 2; the milestone 2 host must leave room for it.
  - **Navigation 3 status (checked 2026-10-29 on Google Maven):** `androidx.navigation3` 1.2.0 is the latest stable
    (1.3.0 is alpha). 1.2.0 needs Compose runtime 1.11.2, Compose UI / animation 1.10.0 and activity-compose 1.12.0.
    We are on Compose BOM 2024.09.00 (Compose 1.7) and activity-compose 1.9.3, so **Navigation 3 needs a Compose
    upgrade first** (milestone 2 step 2.0b).

## 12. Flows and effects (`@flow`)

> **Parked (Pavan, 2026-10-30): not part of v1.** Until then, apps keep payments safe by hand: save a record to
> FlowStore before acting, check with the backend on start, never repeat `/pay` (`docs/guide-notes.md` §16). The
> design below stays as the plan for later (`docs/after-foundations.md`, "Flows"). Parts of other sections that wait
> for flows: "never while a flow is active" (16.1), flows kept across `zn dev` reloads and the `reconcile` lint (17).

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
| For | a few records that must never be lost (a pending payment); later flows, effect records, back stack | app data: settings, caches, drafts, local tables |
| Timing | **written before the next action**, in order | may be delayed and batched |
| Guarantee | survives process kill; checksum; never half-written | normal key-value guarantees |
| Implementation | two-slot mmap file in the C++ core, no dependencies | MMKV (Android + iOS) called **synchronously** from JS through JSI host functions (no Promises; reads are a memory lookup); swappable |

Secrets (tokens, keys) go in **SecureStore** (Android Keystore-backed / iOS Keychain), never in FlowStore or Storage.
**Built (step 3.5):** Storage and SecureStore, `docs/storage.md`. Storage is MMKV built from source into `libzn.so`;
a store damaged by a kill or power loss opens empty (measured: MMKV's "recover" mode returns garbage).

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
  4. **Disk space is reserved when a file is made or grown** (`posix_fallocate`, 2026-11-04). A file sized with
     `ftruncate` alone has holes, and a store into a hole on a full disk is a SIGBUS (a crash), not an error. So a full
     disk can fail only the first write of a key or a write that grows the file, cleanly; a write that fits the
     reserved file can't fail. Older files with holes are filled on their first write. `docs/second-opinions.md` 106.

### 13.3 Thread
FlowStore writes happen on the JS thread (the caller of `go()` / `effect()`), synchronously. They are memory copies,
so they never block the UI thread.

**Built (milestone 2 step 2.7):** `core/include/zn/flowstore.h` / `core/src/flowstore.cpp` exactly as in 13.2 (one
`<key>.znfs` file per key, default 32 KB slots, growth to 256 KB, CRC-32 over length + payload). Android folder:
`noBackupFilesDir/zn`. JS: `flowStore.write / read / list / remove` (`packages/core/src/flowstore.ts`, public: for a
few must-not-lose records; each key is its own file of at least 64 KB, so it is not a settings store). Measured on the Lava: an 800-byte write takes **4.5–6 µs**; a child process killed
mid-write at random **200 / 200** times always left a complete, valid value; a damaged newest slot falls back to the
previous one; both damaged reads as "broken".

### 13.4 Persisted signals
`persisted(signal, { key, store: 'storage' })` saves a signal to Storage (debounced). For drafts and preferences only;
never for anything a flow needs.

## 14. Host APIs for plain TypeScript (decided list)
- `appState()` and `onAppState()` (H.7, host API 5): `"active"` or `"background"`, following the Activity's resume and
  pause, so a see-through payment window counts. Details: guide-notes §29.
- `fetch` (subset: method, headers, body as string / bytes / form, JSON helpers, timeouts, abort). Native HTTP stack:
  OkHttp on Android, URLSession on iOS. Cookies off by default. Cronet / HTTP/3 is an optional later backend.
  **Built (step 3.4):** design, defaults and the production problems it handles are in `docs/fetch.md`.
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
- **Built (RN basics pack, host API 7):** React Native's small APIs with their RN names, exported from
  `@zero-native/core`: `Alert`, `Clipboard`, `Share`, `Linking`, `Platform`, `Dimensions`, `PixelRatio`, `Keyboard`
  listeners, `AppState`, `Vibration`, `ToastAndroid`, `NetInfo`, `URL` / `URLSearchParams` (a JS polyfill, `url.ts`),
  `requestAnimationFrame` (a 16 ms timer). `atob` / `btoa` are Hermes'. Device facts and the window size come as app
  events DEVICE and WINDOW right after the main script, so they are not ready at a file's top level. Status per API:
  `docs/rn-compatibility.md`; author rules: guide-notes §39.

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
  posted back to the JS thread. **Foundations built** (milestone 2 steps 2.5–2.6a): typed `nativeModule<T>`,
  cancellation, error codes, events with listener counts, versions (`docs/native-modules.md`); binary arguments
  built in step 3.4. Codegen is not built. Built-in modules (old step 2.6b) are now part of the plugin proposal
  (`docs/plugins.md`: permissions and "open another app for a result" in core, UPI as a plugin).
- Each module and its version is a **capability** listed in the app binary (section 16.2).

### 15.2 Native views
`<NativeView name="camera.qrScanner" props={...} onEvent={...} />`. Native registers a factory for the name. Props
and events go through slots and events like any component. **Built (2026-11-03):** registry 9 adds component
`NativeView` with one JSON prop and one event; a plugin registers `r.view(name) { scope -> ... }` (`ZnNativeViews.kt`).
The compiler needs a literal `name` and fails the build if no `nativeModule` in that package has the name's prefix (D3).
An unknown name draws an empty box and reports one error. Details: `docs/plugins.md` §4, `docs/guide-notes.md` §35.

### 15.3 Native screens
A route can point to a native screen (Kotlin composable / SwiftUI view) instead of a zn screen. It takes part in the
same back stack and can return a result to JS. **Built (2026-11-03):** route field `native: "<plugin>.<name>"`,
`nav.pushForResult(name)` (refuses a zn route), `onNavResult` after a kill. The result is saved through `ZnLaunch`'s store
(key `nav.<route>`) before JS hears it, and stays until JS acks it. Details: `docs/plugins.md` §5, `docs/guide-notes.md` §35.

### 15.4 Native resource handles: `zn://` (decided 2026-10-29; `zn://app-icon` and the table of kinds built in P.2, `ZnHandles.kt`; `zn://file` built 2026-11-03, only for files in `cacheDir/zn-files`; `mem` not built)
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
- Bundles are **signed** (ECDSA P-256, a main and a backup public key in the app binary; changed from Ed25519 on
  2026-10-30 because Android has Ed25519 natively only from API 33). Unsigned or wrongly signed = never loaded.
- Download in the background; verify hashes and signature; store in a bundle pool with the last known good bundle.
- **A new bundle is applied at the next cold start**, or earlier at a moment the app chooses with
  `Updates.applyNow()` (a JS restart in place; changed 2026-10-30, `docs/ota.md` §3.5). Never while the app holds it
  (`Updates.holdApply()`, e.g. during a checkout) or while a flow is active. Flows then go through migration (12.5).
- **Boot guard:** if the app crashes twice within N seconds of starting a new bundle, roll back to the previous good
  bundle and report it. **As built (steps 4.7–4.8, `docs/ota.md` §3.6):** a downloaded bundle is on trial until
  *healthy* (screens up 4 s in the foreground, or `Updates.markHealthy()`). During the trial, an error screen, a hang,
  a start failure or no first screen in 10 s blocks it on this phone and goes back to the last good bundle in place.
  A launch that Android records as a crash blocks a never-healthy bundle at once (2 in a row for an ANR, Android < 11,
  or the phone's last good bundle). The last good bundle's errors are only reported. A startup guard, a kill switch,
  `no_space` and every outcome reported to the server complete it.
- Server side: channels, staged rollout percentage, kill switch, rollback. (ZeroBill's OTA v2 already does most of
  this; the zn version reuses its design.) **As built:** the framework defines its own check protocol, with a
  reference Bun server and a release CLI (`tools/ota/`), so it doesn't depend on ZeroBill's backend; ZeroBill's
  backend can serve the same protocol later.
- **Crash traces (step 4.8):** every report names the bundle as `id@sha12`; each bundle's source map is kept in the
  store by SHA; `ota symbolicate` turns a release stack (logcat, Crashlytics, telemetry) into TSX lines.
- **A swipe from recents** starts the app fresh even if the phone kept the process (§11), but keeps the running
  bundle: an update downloaded meanwhile waits for a real process start.

### 16.2 Compatibility (decided)
The app binary carries a **capability manifest**:
- framework ABI version, Hermes bytecode version,
- component registry version (component ids, prop ids, value types),
- native modules and their versions, native views, native screens. (As built: registry version, bytecode format,
  host API range and modules. Native views and screens are built since 2026-11-03 (P.3b to P.4b); the plugin design ties them to their
  module's version so `requires` keeps its signed format, `docs/plugins.md` D3.)

Each bundle's `zn-bundle.json` lists what it **requires** (the lowest registry version that has what it uses, the
bytecode format, the host API of its core, its native modules). The server only offers a bundle to app versions
whose capabilities cover it, and the phone checks again before loading, including every id in the templates. Test
that must always pass: **an older installed app is offered a newer bundle and safely ignores it** (passing since
step 4.2; details in `docs/ota.md` §3.2).

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

  **Built (milestone 3 step 3.1, 2026-10-30):** `bun run dev` (`tools/zn-dev.ts`) watches the app's `src/` and the
  framework packages, rebuilds (`buildApp` in `compiler/src/build-app.ts`, then `hermesc -g1` for line numbers) and
  sends templates + manifest + bytecode over a plain TCP socket (`adb reverse tcp:8082`; plain TCP needs no
  cleartext-HTTP setting in the app). On the phone, `ZnDev.kt` (behind `BuildConfig.DEBUG`; R8 removes it from
  release, checked in the release dex) swaps the runtime (`ZnRuntime.reload`), clears instances, and opens the same
  back stack again by route name and params. Running native calls are cancelled and event sources told they have no
  listeners. JS errors (uncaught, or caught by the runtime in handlers / timers / effects / listeners,
  `packages/core/src/errors.ts` → `__zn_error`) show on a dev error screen; the server maps the stack to TSX file and
  line (`compiler/src/sourcemap.ts`: Bun's bundle map + the compiler's own map per `.tsx`). Measured on the Lava:
  save → built 140–210 ms (bundle 30–70 ms, `hermesc` 105–170 ms); phone reload 17–50 ms when idle.
  Not done yet: in-place reload keeps no screen state (signals start fresh; FlowStore data stays).
- **Debugging:** Hermes Chrome DevTools debugging (breakpoints, profiler, heap snapshots) over the dev server.
  **Not built, not planned yet** (milestones).
- **Errors:** JS errors show a dev overlay with the TSX file and line (source maps). In release, JS stack traces are
  sent to the crash reporter and mapped back on the server with the bundle's source maps. **Built** (dev: step 3.1;
  release: step 4.8, `ZnRuntime.onJsError` + `asThrowable()` for Crashlytics, `bun run ota symbolicate`).
- **Tests:** logic and flows run under `bun test` with a fake host (no device needed). Renderer conformance screenshot
  tests run on emulators / simulators. **As built:** `bun test` with a fake host (~200 JS tests), Kotlin unit tests
  (~75), C++ core tests run on the phone, and an OTA phone test matrix (`bun run ota:phone`, 38 cases). No screenshot
  conformance tests yet.
- **Lint:** the compiler reports destructured props, effects missing `reconcile`, flow schema changes without a version
  bump, and unknown components or props. **As built:** unknown components, props and style keys are build errors;
  the other checks are not built (flows are parked).

## 18. Security and privacy
- Only signed bundles run. No `eval` of downloaded text; Hermes runs our compiled bytecode only.
- Flows hold plain JSON with **no secrets**; files are app-private and excluded from backups.
- For regulated apps (for example payments in India), check what flow data is allowed at rest under RBI rules.
- Native modules are the only way to reach platform APIs; permissions are requested through `os.permissions`
  (built in P.2 as core `Permissions`, `docs/plugins.md` §6, `docs/guide-notes.md` §32).
- **As built:** OTA bundles are signed with ECDSA P-256 (main + backup public key in the APK; the private key never
  in the repo); a replayed old answer is refused (signed, increasing `seq`); `SecureStore` uses the Android Keystore;
  storage and FlowStore are excluded from backups. Telemetry carries the first line of JS error messages (privacy
  question in `docs/second-opinions.md` entry 4).

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

**v1 numbers so far (release, Lava, 2026-10-29 to 10-31):** cold start of the 15-route sample ~195 ms median
(n=10; same with a downloaded OTA bundle); `<List>` fling of 10,100 rows p95 11 ms per frame; an OTA update applied
in place in 37–50 ms; hot reload save → phone 140–210 ms build + 17–50 ms reload (debug).

Every number, with how it was measured: `docs/startup-and-performance.md` §4.

Comparisons with the RN app in `RESULTS.md` are directional only: cold start and memory compare a prototype with the
full app, and the RN tap-latency figures are estimates (the RN app has no tap instrumentation).

## 20. iOS notes (design is checked against these from day one)
**Renderer: SwiftUI and UIKit mixed (decided 2026-11-08, Pavan).** "SwiftUI on iOS" (§1) now means SwiftUI by
default, with UIKit wherever SwiftUI can't be driven the way the templates need. Templates don't depend on the
toolkit, so the choice is made per component, from the i.1 spike (`docs/milestones.md`), not up front. Expected:
- **UIKit:** the back stack (`UINavigationController`, because JS owns the stack: §11), controlled text input
  (`UITextField` / `UITextView`, OtpInput), possibly long lists (`UICollectionView`).
- **SwiftUI:** what is inside a screen: text, stacks, images, small components, through one `Layout` of our own for
  Column / Row so flex and the fixed style order match Compose (`docs/styling-and-layout.md`).
- Why: SwiftUI decides more on its own than Compose does (navigation path changes from outside, cursor in a
  controlled field, list cells). React Native, Lynx and Valdi all draw with UIKit for the same reasons.
- **Why iOS at all:** zn's first reason, download size on low-end Android phones, matters little on iOS. On iOS the
  win is one codebase, OTA and native UI. Judge the iOS track on those, not on size.

- Hermes runs on iOS as an interpreter; no JIT is needed (and Apple forbids it). Meta publishes it as
  `com.facebook.hermes:hermes-ios` on Maven Central at the same version as `hermes-android`, so the same `hermesc`
  bytecode can run on both [check in i.1].
- One `SlotCell` object per slot (9.1). Changes only on the main actor.
- `NavigationStack(path:)` for the back stack; sheets with `presentationDetents`.
- Process death on iOS (jetsam) follows the same FlowStore and restore rules.
- UPI on iOS has no activity result: results come from app switching (resume) and callback URLs. The flow model is
  the same; `launchActivity` is replaced by `openURL` + resume handling, still a `once` effect.

## 21. Repository layout (planned)
**As built (2026-10-31):** `compiler/` (Bun plugin + TS compiler API), `core/` (C++: Hermes adapter, batch,
FlowStore, MMKV storage; tests run on the phone), `android/` (`runtime` library + `sample` app), `packages/` (`core`,
`ui`, `template`), `tools/` (`zn-dev.ts` hot reload, `ota/` store + CLI + reference server + phone matrix, `hermesc`,
measuring scripts), `examples/sample` (the sample app's TSX), `docs/`, `experiments/` (v0, reference only). No
`ios/`, `cli/` or `conformance/` yet. `plugins/` holds the test plugin (`docs/plugins.md` D5).
The first plan:
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
- The flow engine (12): parked 2026-10-30; apps use FlowStore + the save-then-verify pattern.
- Gesture expressions on the UI thread (10.3).
- Native list data source for very large lists (v1.1; designed in `docs/lists.md` §6).
- NativeWind `className` → style translator for porting RN code (v1.1 option; `docs/styling-and-layout.md` §9).
- A general mmap data arena.
- Cronet / HTTP/3 backend.
- Web or desktop renderers (non-goal).
- Not deferred on purpose but not started yet (2026-10-31): the iOS host, the Hermes debugger, screenshot
  conformance tests, per-screen bytecode, binary OTA patches.

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
| 2026-10-29 | `heroTag`: one per navigation transition, a card/container becoming the next screen | Section 11. Matches iOS 18 zoom transitions, so both platforms stay native (Argon review). |
| 2026-10-29 | Routes live in one typed `routes.ts` (`defineRoutes`), not `@route` decorators | Section 11. Decorators on functions are not valid TypeScript; one file also gives typed `nav.push(name, params)`. |
| 2026-10-29 | `<Sheet>` draws in its own full-screen window; a user close only asks (`onDismiss`), JS owns `visible` | Section 9.7. Scrim over the status bar and back-before-screen for free; v0's sheet wrote JS-owned state from native. |
| 2026-10-29 | Module calls and event listeners belong to the screen that made them (dropped / ended when it closes); native gets listener counts; fast events can be `latestOnly` | `docs/native-modules.md`. No "update after unmount" bugs, no sources running for nobody, no backlog when JS is busy. |
| 2026-10-29 | Native calls are async only (JS never waits for native); transport = `__zn_call` + app event 7 | Section 15.1, `docs/native-modules.md`. One slow sync call would stall all JS (TurboModules allow sync; we don't). |
| 2026-10-29 | `<Carousel>` is native (pager, auto-advance only while on screen and resumed); impressions are native-measured (`impressionKey` + `useImpressions`, threshold default 35 %, batched) | Feeds proposal (approved). The RN Offers tab lagged from JS carousel timers and JS `measureInWindow` impression passes during scroll. |
| 2026-10-29 | `<List>` rows are template instances mounted only near the visible range, with row kinds (one template per `row` leaf) and no version numbers | Section 9.3, `docs/lists.md`. Feeds need rows that hold rails, conditionals and components; ops arrive in order so nothing is stale. Measured: p95 11 ms/frame flinging 10,100 rows on the Lava (release). |
| 2026-10-29 | Per-edge padding may change at runtime (registry v4), read in the layout phase | Section 11 / `docs/styling-and-layout.md` §6. Full-bleed headers pad by `insets()`; a change re-measures one node and recomposes nothing. Shorthands stay build-time. |
| 2026-10-29 | `statusBar` sets status bar icons only; navigation bar icons follow the screen background | `docs/styling-and-layout.md` §6. One option for both put a grey scrim over the bottom bar of a full-bleed screen (Lava). |
| 2026-10-29 | The back stack is owned by JS; a system back press is an event to JS (JS pops, or its `onBack` blocks) | Sections 9.7, 11. One owner, same rule as controlled components; native pops by itself only after the 300 ms timeout and then tells JS. |
| 2026-10-29 | FlowStore is our own two-copy memory-mapped file in C++ (one file per key, CRC-32, sequence written last), not MMKV, and is framework internal | Section 13. Flows need "saved before I act" on every crash, checked by test (200 / 200 SIGKILL rounds, ~5 µs per write); the same C++ runs on iOS. App data (settings, caches) is a separate, later store. |
| 2026-10-30 | A component's children and JSX props are functions that make a View, shown where the component writes `{props.children}` (`insert`); fragments are a Fragment node whose children join the parent's layout | Section 5.3. The parent's JSX keeps its own templates and closures; the child only places it. Compose lays several children out in the parent with no wrapper, so a fragment costs no extra layout node. |
| 2026-10-30 | Nested `<Text>` is one native text with spans: span styles are build-time JSON, span texts joined by U+001F in the one text slot | Section 9.2. One slot and one AnnotatedString, no per-span nodes. Runtime span styles and tappable spans later. |
| 2026-10-30 | Controlled `<TextField>`: numbered changes and answers, as React Native's event count | Section 9.4. Comparing text values alone lost a digit when the user typed while JS formatted (seen on the Lava). |
| 2026-10-30 | Route option `keyboard: "resize"` (default) / `"none"` instead of a global soft-input mode | Section 11. Per screen, like `safeArea`; a payment screen keeps its Pay button above the keyboard by default. |
| 2026-10-30 | `zn dev` sends whole builds (templates + bytecode) over plain TCP and restarts the JS runtime; the back stack is reopened by route name | Section 17. Bytecode compiled on the computer loads in ~15–50 ms on the Lava; a fresh runtime has no stale closures or listeners (RN Fast Refresh's common bugs). Plain TCP avoids a cleartext-HTTP exception in every app's manifest. |
| 2026-10-30 | `storage` (MMKV) is synchronous JSI, not an async native module | Section 13.1. MMKV reads and writes are memory operations (microseconds); a Promise per read would make simple code (`if (storage.get("onboarded"))`) awkward for no gain. Same reason as FlowStore. |
| 2026-10-30 | `fetch` defaults: 30 s limit on the whole request, 10 MB body limit, not tied to the screen, non-idempotent bodies one-shot (OkHttp never resends a POST), no HTTPS → HTTP redirects, cookies and cache off | `docs/fetch.md`. Each one answers a production problem RN / Flutter apps had; the double-POST one was reproduced and stopped on the Lava. |
| 2026-10-30 | Binary data crosses the bridge as raw bytes: `bytes` in, `resolveBytes` out (one ArrayBuffer, app event 9) | Section 15.1, `docs/fetch.md` §4. No base64 or JSON escaping for bodies and files; one copy on the way to JS. |
| 2026-10-30 | Storage = MMKV's C++ core vendored and built into `libzn.so`; values tagged with their type; damaged stores are dropped, never "recovered"; not in backups. SecureStore = Android Keystore AES-256-GCM, one file per key | `docs/storage.md`. ~87 KB download instead of ~372 KB for the MMKV AAR; the kill test showed MMKV's recover mode returning value bytes as keys. |
| 2026-10-30 | Animation is declared at build time (`animate`, `enter`, `exit` props) and run natively from target values; `exit` delays the native REMOVE, not JS | Section 10. JS stays simple (it sets values and removes elements as usual); every frame is native and draw-phase only. |
| 2026-10-30 | OTA (`docs/ota.md`): capability manifest decides where a bundle may run (no exact native hash); the framework defines a check protocol + reference Bun server + release CLI (ZeroBill's backend serves the same protocol in milestone 5); ECDSA P-256 with a backup key; apply at cold start or `Updates.applyNow()`, blocked by `holdApply()`; full compressed bundles first | Pavan's decisions D1–D5. One fix reaches every compatible install; the framework doesn't depend on ZeroBill's backend; P-256 is native on Android 7; RN showed customers open the app 1–2× a month, so cold start alone is too slow; bundles are ~115 KB compressed, so patches can wait. |
| 2026-10-30 | Resilience (step 3.9): a screen that throws stays on the stack and native draws a built-in error screen (Try again / Go back; Restart app if JS didn't start); a failing part stays empty; unhandled Promise rejections are reported; each JS entry has a time limit (5 s release / 30 s debug, configurable; a hang shows the error screen); `onError` (JS) and `ZnRuntime.onJsError` (Kotlin, with the bundle id); bad ops are skipped, not fatal; back stack via the Activity's saved state; cached `toLocaleString` | Flutter-like: one broken screen never takes the app down, and Back always works. The framework only reports and shows the fallback; anything more (restarts, reporting) is the app's choice. |
| 2026-10-30 | OTA compatibility: a bundle asks for the **lowest registry version that has what it uses** (`Added` table + `registry.lock.json` checked by a test), plus bytecode format, host API, native modules read from the source; the phone checks them and every template id | Pavan chose approach A over one framework version: a fix built with newer tools still reaches older installs when it uses nothing new. The id check means a mistake costs one refused update, never a wrong screen. |
| 2026-10-30 | Builds are byte-for-byte repeatable: template ids are given by file path after all files are compiled; Bun's random `debugId` line is dropped. One place (`ZnBundles`) picks the running bundle (APK or a downloaded folder) for bytecode, templates and images | `docs/ota.md` §3.1. Ids followed Bun's file load order, so the same source gave a new SHA each build; one SHA = one serial and small patches need repeatable output. |
| 2026-10-30 | Flow engine parked (not in v1); `flowStore` is public and payments use the save-then-verify pattern | Section 12 note, `docs/guide-notes.md` §16. For one or two money journeys, ~30 lines of app code plus the backend's `/verify` give the same safety; the engine pays off with many journeys and teams. |
| 2026-10-31 | OTA safety nets (step 4.7): healthy mark after 4 s in front; before it, an error screen / hang / start failure / no first screen in 10 s blocks the bundle and goes back to the last good one in place; a startup guard; outcomes always reported | `docs/ota.md` §3.6. Every lesson from ZeroBill's RN OTA v2; a bad update must cost a user one bad launch at most. |
| 2026-10-31 | Watchdog: a launch Android records as a crash blocks a never-healthy bundle at once; ANR / no exit record / the phone's last good bundle need 2 in a row; errors of the last good bundle are only reported (Pavan chose option (a)) | `docs/ota.md` §3.6, `docs/second-opinions.md` entries 1–3. A bundle proven for weeks shouldn't be lost to one native-SDK crash; kept for expert review. |
| 2026-10-31 | Crash traces: bundle label `id@sha12` everywhere; source maps kept in the store by SHA; `ota symbolicate`; bundle bytes made independent of the build folder | `docs/ota.md` §3.7. A release crash must map to a TSX line for the exact bundle that ran. |
| 2026-10-31 | Download only with free space ≥ rest of the zip + 4× the zip + 50 MB (`no_space` otherwise); a full disk mid-download removes the half files | `docs/ota.md` §3.6, `docs/second-opinions.md` entry 5. An update must never fill a low-end phone. |
| 2026-10-31 | `restorableSignal(key, initial)`: values sent to native per change (NAV RESTORE, host API 4), saved with the back stack, handed back on restore only into the same bundle (`id@sha12`) | §11, `docs/second-opinions.md` entry 7. The amount typed before going to the UPI app must survive a process kill; a newer bundle might read an old value wrong. |
| 2026-10-31 | A new Activity without saved state while the process lives (a swipe from recents on ROMs that keep the process) starts fresh: new JS runtime, start screen; links while running go through `ZnNav.openLink` | §11. Same behaviour on every phone, like RN and Flutter apps on the same Lava; Android's own rule: saved state = restore, none = fresh. |
| 2026-10-31 | **Proposed, not decided:** a plugin system (package = TS + Android library, `ZnPlugin` entry point, `<NativeView>`, native screens, core permissions / activity results / `zn://` handles); decisions D1–D7 open | `docs/plugins.md`. QR, WebView, UPI, media and push all need it; one system before five ad-hoc ones. Updated: D1–D7 decided 2026-11-02 (next row) and built (P.1 to P.6, 2026-11-02 to 11-03). |
| 2026-11-02 | Plugin decisions D1–D7 taken as recommended, with the review's additions (by-hand registration first, `ZnModuleBase` + typed helpers, views on their module's version with a compiler check, `pushForResult` + kept results, plugins in this repo, `peerDependencies` + `requireHostApi`, UPI as a plugin) | `docs/plugins.md` §8; reviewed against the code in `docs/cross-communication/2026-11-02-fable-review-response.md`. Not built yet. Built 2026-11-02 to 11-03 (P.1 to P.6; rows below). |
| 2026-11-02 | Crash count for downloaded bundles changes (**decided, not built**): every foreground period is watched; the last 3 counted deaths are kept with their times for 24 h; the background and the healthy mark no longer clear them; limits 1 sure / 2 unsure before healthy, 3 for the last good bundle | A crash on return from a UPI app was always "1 of N". `docs/hardening-plan.md` H.3, `docs/second-opinions.md` entry 1. Built 2026-11-02 (H.3). |
| 2026-11-02 | The sample and pilot app use `singleTop`; a new Activity starts fresh only if it is the task root, else it forwards its link and finishes (**decided, not built**) | `singleTask` can close the UPI app (RN found this); `singleTop` alone could restart JS during a payment. `docs/hardening-plan.md` H.1. Built 2026-11-02 (H.1). |
| 2026-11-02 | Order: hardening (H.1–H.7), then P.1, P.2, `upi`, `auth`, `scanner` as a native screen, then pilot screens, with the checkout rules port alongside. `<NativeView>` after the pilot | The first app pilot is login, scan, UPI transaction; its details live in the app's own private repo. |
| 2026-11-02 | Plugin base built (P.1): `ZnPlugins.register(context, ...)`, a plugin adds whole or not at all, a taken module name fails, typed arg helpers reject with `invalid_args`. A failed plugin stops a debug build; a release build skips it and starts | `docs/plugins.md`, `docs/guide-notes.md` §30, `docs/second-opinions.md` entry 10. |
| 2026-11-02 | Plumbing built (P.2): only Kotlin opens another app; a launch's record is on disk before it opens, and its result stays until `ack`; START waits for Android's answer after a kill, so a sync `pending()` is right on the first screen; a new launch is refused while a result isn't acked | `docs/plugins.md` §6, `docs/guide-notes.md` §31, `docs/second-opinions.md` entries 11 to 15. |
| 2026-11-02 | UPI is a plugin the app owns, not `@zero-native/upi`. An outside app uses a Gradle composite build and `bun link` until packages exist | `docs/plugins.md` D7, `docs/guide-notes.md` §34, `docs/second-opinions.md` entries 16, 17. |
| 2026-11-03 | Plugins P.3b–P.6 built: native screens and `<NativeView>` (registry 9), `zn://file`, background JS tasks, secure screens, dark mode, low memory, right to left (host API 6); official opt-in plugins `auth`, `scanner`, `media`, `webview`. Out: push / Firebase, certificate pinning | `docs/plugins.md` §9, `docs/guide-notes.md` §35–38, `docs/second-opinions.md` entries 18–36. Updated: push and the Firebase plugins were built on 2026-11-04 (rows below); certificate pinning is still out. |
| 2026-11-03 | RN basics pack: React Native's small APIs with RN names exported from `@zero-native/core` (no separate entry point); `TextField` `ref` (registry 10); app events DEVICE, WINDOW, KEYBOARD (host API 7); `Alert`, `Clipboard`, `Vibration`, `NetInfo` built-in modules; `URL` polyfill | §9.4, §14, `docs/guide-notes.md` §39, `docs/second-opinions.md` entries 38–43. Porting an RN screen should be mostly copy and paste for these. |
| 2026-11-03 | SVG phase 1 built (registry 10, host API and template format unchanged): `.svg` files as components and inline `<Svg>` are compiled at bundle build time into draw data (a string prop, so OTA can ship SVGs); a fixed subset, everything else is a build error with a hint; runtime `color` and `parts` (fill, stroke, opacity). Phase 2 (animated parts) waits for a check-in | `docs/svg.md`, `docs/guide-notes.md` §42, `docs/second-opinions.md` entries 50–53 |
| 2026-11-03 | SVG phase 2 and motion built (registry 11; SVG moved there from 10, which main took): loops, keyframes, delays and bezier easing on every element's `animate`, native clock, no per-frame JS; `paused` / `replay` element props; SVG parts move around their own centre and trim ("draw the line"). New registry kind `format` for new forms inside a string value. Host API and template format unchanged | `docs/svg.md` §9, §15, `docs/guide-notes.md` §22, §42, `docs/second-opinions.md` entries 55–58 |
| 2026-11-03 | Animated `.svg` files import (S.14): SMIL and CSS `@keyframes` compile at build time into part animations (no SMIL or CSS engine on the phone); geometry of filled shapes becomes scale + move; new timing option `z` and a step easing (registry 11, not shipped). 104 MIT loaders kept as test fixtures, 95 compile | `docs/svg.md` §15, `docs/guide-notes.md` §42, `docs/second-opinions.md` entries 59–62 |
| 2026-11-03 | SVG phase 3 (registry 12): stroked shapes that grow keep their stroke width (the part scales the outline), `strokeWidth` / `dashOffset` on parts, one animated dash as exact trims, path morphing in one cubic form mixed on the phone, `non-scaling-stroke` as a negative width (format "svg.nonScaling"), part-name types written next to each `.svg`. 100 of 104 corpus files | `docs/svg.md` §16, `docs/guide-notes.md` §42, `docs/second-opinions.md` entries 63–67 |
| 2026-11-03 | SVG phase 4 (registry 13, host API and template format unchanged): draw data v1 gains tokens for filters (Android `RenderEffect` on 12+, a plain shadow below), masks, patterns, focal gradients, blend modes, text and animated stops (format "svg.effects"); markers, `paint-order`, nested `<svg>` and `<switch>` are flattened at build time. Parts gain `motionPath` / `motionAt`, `skewX` / `skewY`, `frame` and `trimCaps`; timing option `~w` starts on a tap (format "timing.tap"). Big draw data is read in the background after the first frame. 104 of 104 loaders, 75 of 78 feature files | `docs/svg.md` §17, `docs/guide-notes.md` §42, `docs/second-opinions.md` entries 68–72 |
| 2026-11-03 | All SVG moved to registry 13 after merging main (11 = Tabs, 12 = pull to refresh). SVG phases 1–4 had not shipped, so every SVG entry has since 13; ids unchanged. Older SVG rows above that say 11 or 12 mean 13 | `docs/svg.md` §7, `docs/second-opinions.md` entry 73 |
| 2026-11-03 | Bottom tabs (4cd56c5; host API 8, registry 11): tabs live inside one screen, not as stack entries. Route option `tabs`, `useTabs(route)`, the native `<Tabs selected>` container draws only the selected tab (the bar is the app's JSX); lazy by default, a hidden tab keeps its state; Back on a later tab goes to the first tab; the selected tab survives a kill; a link to a tabs route that is already in the stack goes back to it and closes the screens above it. `useFocus` and `tabs.onFocus` | `docs/guide-notes.md` §40, `docs/second-opinions.md` entries 44–48. The pilot's home has 4 tabs. The app's `onLink` must refuse links while a payment is open. |
| 2026-11-03 | Pull to refresh (bac6d1c; registry 12): drawn on the `<Scroll>` or `<List>` itself, Android's look, controlled like RN (`refreshing`, `onRefresh`, or RN's `refreshControl`); a 1 second wait for JS. Host API unchanged | `docs/guide-notes.md` §41, `docs/second-opinions.md` entry 49. All four ZeroBill home tabs use it. |
| 2026-11-03 | RN-style event handlers (d4f97f1; no registry or host API change): a handler that is not written in place (a name, `props.onPress`) is read when the event comes, and an undefined one does nothing, as in RN. Before, a `Pressable` with `onPress={undefined}` threw on tap. Later (5301225, audit fix): a handler written as a call, `once(pay)` or `debounce(submit)`, is made once when the element appears, so such guards work | `docs/guide-notes.md` §5, `docs/second-opinions.md` entry 104, `docs/milestones.md` (2026-11-04 audit entry). |
| 2026-11-03 | PDF plugin `@zero-native/pdf` (e0ef6fd): on Android's own `PdfRenderer`, no PDF library (about 15 KB). `Pdf.download` to a `zn://file` handle, `<PdfView>` with zoom, `<PdfPreview>` card. Module `Pdf` v1; no registry or host API change | `docs/guide-notes.md` §44, `docs/second-opinions.md` entries 80–84, `plugins/pdf/README.md`. |
| 2026-11-03 | Location plugin `@zero-native/location` (0958d4e): Android's `LocationManager` and `Geocoder`, no Play services for fixes; every call answers a reason and never rejects; a hidden app gets no fix. On 2026-11-04 it gained Google's "Turn on location" dialog (`Location.turnOn()`, module v2, Play's `SettingsClient`). No registry or host API change | `docs/guide-notes.md` §45, `docs/second-opinions.md` entries 85–89, `plugins/location/README.md`. |
| 2026-11-04 | RN props pack 2 (registry 14-15, host API unchanged): RN names for props, styles and components so ported screens keep their code: `Modal` (its own window, app-drawn content), `StatusBar` / `NavigationBar` (per screen; colours drawn by zn behind the bars, as Android 15+ has none), `pointerEvents`, `hitSlop` (the minimum touch size), `onLayout`, `testID`, `Image` events and tint, per-corner radius, runtime borders, `absoluteFill`, `textTransform`, `stickyHeaderIndices`. An element without handlers lets taps through (RN stops them), except an absolute layer with a background or children, which stops them as in RN | `docs/guide-notes.md` §43, `docs/components.md` §13, `docs/second-opinions.md` entries 74–79. |
| 2026-11-04 | Compiler pack (no registry, host API or template format change; the sample's bundle is byte for byte the same): JSX in variables (`const x = <A/>`, `const x = c ? <A/> : null`, a `let` never assigned again), each use compiled as its own copy and the declaration removed from the JS; `return c ? <A/> : <B/>` is a Fragment root with one anchor. Build-time values gain component-body consts, `? :`, `??`, `\|\|`, `&&`, `!`, comparisons, `+ - * / %` and template strings; a name is looked up by JavaScript's scope rules, so a parameter or `let` hides a const. Build errors with hints: a JSX `let` assigned again, `push(<X/>)`, a JSX const used as a value, JSX that would read a different name where it lands, JSX in a lowercase helper. Not built: one template per call-site size for atoms (G3; use named sizes, guide notes §47) and the NativeWind `className` translator (G5, dropped for good). New principle 7 (§3) | `docs/guide-notes.md` §47, `docs/second-opinions.md` entries 100–103. |
| 2026-11-04 | Core `Permissions` "location" asks for precise and approximate together (8f76d29; no host API change). It is `granted` if the user gave either, and the answer has `"location.precise"`. A manifest with only the precise line gets `not_declared`. Before, core asked for precise alone, which Android 12+ may ignore. Pavan's call; it changes `second-opinions.md` entry 88 ("core stays precise alone") | `docs/guide-notes.md` §32 and §45, `docs/milestones.md` (location entry). The app's manifest needs the coarse line too (the location plugin brings both). |
| 2026-11-04 | Crashlytics and push plugins (445f08e): `@zero-native/crashlytics` sends every JS error as a non-fatal, OTA outcomes and bundle / route keys; `@zero-native/push` runs every FCM data message as a JS task and shows notifications natively. Core change, add-only: `ZnRuntime.addJsErrorListener` and `ZnOta.addReportListener`, next to the single `onJsError` / `onReport` hooks, so a plugin and the app can both listen. Nothing is masked unless the app passes `redact` (Pavan). Modules `Crashlytics` v1, `Push` v1, `Notifications` v1; no registry or host API change | `docs/guide-notes.md` §46, §48, `docs/second-opinions.md` entries 90–95, `plugins/crashlytics/README.md`, `plugins/push/README.md`. |
| 2026-11-04 | Firebase base plugin `@zero-native/firebase-app` (7bd50f1): the one Firebase BoM for every Firebase plugin, one Gradle file (`firebase.gradle.kts`) that turns Firebase off when `google-services.json` is missing, `Firebase.app()`, Installations. The R8 mapping uploads only with `-PznUploadMapping` | `docs/guide-notes.md` §49, `docs/second-opinions.md` entry 95, `plugins/firebase-app/README.md`. An app must not add a Firebase BoM of its own. |
| 2026-11-04 | Analytics plugin `@zero-native/analytics` (cc8853b): RN Firebase's API, a `screen_view` per top route by itself, event names checked, booleans sent as 1 or 0. The app removes the ad id permissions, not the plugin | `docs/guide-notes.md` §50, `docs/second-opinions.md` entries 96–99, `plugins/analytics/README.md`. First built "off until consent"; see the d2911e4 row below. |
| 2026-11-04 | Push v2 (edd378b; `Notifications` native version 2): a tap on FCM's own notification gives its data to JS (`getInitialNotification`, `onNotificationOpenedApp`); notification buttons (a button with a link opens the app, one without runs a JS task), progress, lists; the lock screen default is "private"; scheduled notifications by an alarm with a 10 minute window, the boot receiver is opt-in; the data message `zn_ota=check` runs `ZnOta.check` natively and never reaches JS | `docs/guide-notes.md` §51–53, `docs/second-opinions.md` entries 120–124. A topic message makes every phone ask the OTA server at once: send it to a small topic or in waves. |
| 2026-11-04 | Remote Config plugin `@zero-native/remote-config` (16f0b56): RN Firebase's API. Every answer carries all values with their source, so reads are plain calls with no promise. `onConfigUpdated` for live updates | `docs/guide-notes.md` §54, `docs/second-opinions.md` entry 125, `plugins/remote-config/README.md`. |
| 2026-11-04 | Performance plugin `@zero-native/perf` (eae7b49): app start, a network trace per `fetch`, a trace per screen with slow and frozen frames, custom traces. Core change, add-only: `ZnFetch.addClientSetup`, which adds to core's OkHttp client after the app's `configure`. URLs go without the query. On by default, like Crashlytics | `docs/guide-notes.md` §55, `docs/second-opinions.md` entry 126 (its "off until consent like Analytics" option is out of date since d2911e4), `plugins/perf/README.md`. |
| 2026-11-04 | Crashlytics phone step for an OTA bundle's error (690f5bd; test tool only, no product code): `ZN_OTA=1 bun run tools/plugin-phone.ts crashlytics` builds a bundle into a test store of its own, serves it on this computer only, and checks that a report says `zn_built_in=false` and the bundle id | `tools/plugin-phone/crashlytics.ts`, `docs/milestones.md`. |
| 2026-11-04 | Analytics is on from the first start (d2911e4; Pavan's call, changed from "off until consent" the same day): as in RN Firebase and like Crashlytics and Perf. Collection starts before any consent, so DPDP must be checked before real users. A consent-first app sets `firebase_analytics_collection_enabled=false` in its manifest. Docs say it plainly (480dc3d) | `docs/guide-notes.md` §50, `docs/second-opinions.md` entry 96. |
| 2026-11-04 | Plugins add only an interceptor to core's fetch client: `ZnFetch.addInterceptor` replaces `addClientSetup { builder -> }`, so a plugin can't undo the app's pins, redirects or retries. A plugin interceptor's runtime error fails only that fetch (`connection_lost`) instead of crashing the app; the request is not sent again. Kotlin API only | `docs/fetch.md` §5, `docs/guide-notes.md` §30, `docs/second-opinions.md` entry 105. |
| 2026-11-08 | iOS starts now, before Android is proven in the field (Pavan; changes `docs/production-readiness.md` D, which said "start only after"). The iOS renderer mixes SwiftUI and UIKit, chosen per component by the i.1 spike; minimum iOS version still open (17 suggested, for `@Observable`) | §20. SwiftUI is less controllable than Compose for a JS-owned back stack, controlled text input and long lists. Fixes the iOS port shows on Android are made as it goes. |
| 2026-11-04 | FlowStore reserves the disk space of a file when it is made or grown (`posix_fallocate`; rewrite-in-place fallback). A full disk now fails only the first write of a key or a growing write, cleanly, never with a SIGBUS crash; a write that fits can't fail. The write-ahead rule stays: never open the UPI app after a failed save. Core C++ only: no API or host API change | §13.2 item 4, `docs/guide-notes.md` §16, `docs/second-opinions.md` entry 106. |

## 25. Open items (to decide while building, not blockers)
- Public name, npm scope, license (MIT suggested, same as React Native and Hermes).
- iOS image cache choice.
- ~~Exact FlatBuffers schema for `.zn.ui` and the batch byte layout~~ (done in milestone 1: own binary format,
  `packages/template/src/writer.ts`; batch layout in `core/include/zn/batch.h`).
- ~~The plugin system's decisions D1–D7 (`docs/plugins.md`).~~ Taken 2026-11-02 (§24).
- Judgment calls kept for a second opinion (watchdog limits, error text in telemetry, free-space numbers, fallback
  for an unusable bundle, `restorableSignal` across bundles): `docs/second-opinions.md`.
- How computed row expressions work with a native list data source (`docs/lists.md` §6, v1.1).
- ~~Whether to build the NativeWind `className` translator (v1.1).~~ Decided 2026-11-04: no (§3 principle 7,
  `docs/second-opinions.md` entry 103).
- Flow tests the framework must pass that v0 left open: restored flows must reach a final state with `/verify`
  actually called; a `/pay` that died mid-call (no `ztc`) means "payment not started" (`docs/v0-findings.md` §D).
- ~~Nav3 version and stability at build time~~: checked 2026-10-29, 1.2.0 stable, needs Compose 1.10+ (§11); in use.

## 26. Glossary
- **Template:** the compiled, static shape of a screen or part of a screen.
- **Instance:** one mounted copy of a template (one screen, one list row, one `<If>` branch).
- **Slot:** one changeable value inside an instance (a text, a colour, a visibility flag).
- **Batch:** the list of slot changes and structure changes JS sends to native once per tick.
- **Tick:** one JS task plus the microtasks it queued.
- **Flow:** a saved state machine for a multi-step process.
- **Effect:** a side effect inside a flow (network call, launching another app) that must be recorded before it runs.
- **Reconcile step:** the flow step that finds out what really happened after an uncertain effect.
- **FlowStore:** the crash-safe file where flows (later) and pending payment records are saved. (The back stack is
  saved in the Activity's saved state since step 3.9.)
- **Bundle label:** `<bundle id>@<first 12 hex of its SHA-256>`, e.g. `sample_5@447185f3dbdd`: names the exact code
  in every log, report and crash.
- **Healthy / last good bundle:** a downloaded bundle is *healthy* once its screens were up 4 s in front; the phone's
  *last good* bundle is the newest one that became healthy there, and safety nets go back to it.
- **Host API:** the version of the JS ↔ native contract (host functions, batch ops, event numbers); now 8.
- **Capability manifest:** the list of what an installed app can run (engine, components, modules), used to decide
  which OTA bundles it may load.
- **Style:** the `style` prop; React Native style names that the renderer applies in one fixed order.
- **Row template / window:** a `<List>` row compiled once; the window is the range of rows whose values JS has sent.
- **Placeholder:** what a slot shows before its value arrives (same template, same size).
- **Resource handle:** a `zn://` string that names a native object (icon, photo) without copying its bytes into JS.
