# Native modules: calling native code from JS and back

Part of the zero-native spec (ARCHITECTURE §15). **Status (2026-10-29): the foundations are built (step 2.6a, approved
by Pavan: async only, cancellation, events, error codes, versions). Built-in modules are briefed to Gemini
(`docs/cross-communication/2026-10-29-native-modules-brief.md`); `fetch` and codegen are later, only when Pavan
asks.** This is zero-native's answer to React Native's NativeModules / TurboModules and Flutter's MethodChannel /
EventChannel / Pigeon.

## 1. What is built (steps 2.5 + 2.6a)
**JS (`packages/core/src/calls.ts`, `abort.ts`):**
- `nativeModule<T>("Name", { version })`: a typed handle (a `Proxy`): every method of the interface becomes
  `(args?, { signal }?) => Promise`, plus `on(event, handler)`. Declare the module once as a TS interface (methods take
  one plain args object; `events` lists what native can send). The version the code needs travels with each call
  (`__v`); an older app answers `unavailable`.
- `callNative(module, method, args, { signal })`: the untyped form. `NativeError { code, message, module, method }`.
- **Cancellation:** an `AbortSignal` (Hermes has none; `abort.ts` adds the standard shape) rejects at once with
  `cancelled` and tells native (`__zn_cancel`). Calls made by a screen are **dropped** (never settle; native told to
  stop) when the screen closes, like its timers.
- **Events:** `onNativeEvent` / `Module.on(...)` → unsubscribe function; ended by the screen closing. Every listener
  change sends the count to native (`__listeners`, no reply), so a module starts / stops its source.

**Native (`android/runtime/.../ZnModules.kt`):**
- `ZnModuleBase("Name", version)` with `function("x", onMain = false) { call -> ... }`; or implement `ZnModule`.
- `ZnCall`: `args`, `bytes` (binary input or null), `resolve(value)`, `resolveBytes(value, bytes)`,
  `reject(code, message)`, `isCancelled`, `onCancel { }`. Answer exactly once; a cancelled call's answer is dropped;
  an exception rejects with `failed`. (`bytes` / `resolveBytes`: step 3.4, see `docs/fetch.md` §4.)
- Calls run on a 2-thread I/O pool, or the main thread per function. `emit(event, payload, latestOnly)`:
  `latestOnly` keeps one delivery queued per event and it reads the newest value when the JS thread runs it.
- Path: `__zn_call` / `__zn_cancel` → C++ `Platform::callNative` / `cancelNative` → JNI (args as UTF-8 bytes) →
  `ZnModules`; answers = app event 7, module events = app event 8 (instance 0).

**Proof:** the sample's `DeviceModule` (`android/sample/.../DeviceModule.kt`, `examples/sample/src/device.ts`,
screen `/dev/modules`). On the Lava (debug + release): info call; ticks every 50 ms only while the screen is open
("tick source started" / "stopped (no listeners)"); a 3 s call answers; cancelled after 1 s → JS `cancelled` at once
and native "stopped early"; `fail()` → `NativeError` with code `no_luck`. Tests: JS `calls.test.ts` (typed calls,
version marker, error codes, abort, screen-close drop, events + listener counts), C++ `testNativeCall`.

**Not built:** codegen (Kotlin interface from the TS interface, capability-manifest entries), built-in modules
(Gemini, see the brief). Binary arguments and `fetch` were built in step 3.4.

## 2. How others do it
| | Declaration | Calls | Native → JS | Types |
|---|---|---|---|---|
| RN legacy NativeModules | `@ReactMethod` in Kotlin/ObjC | async over a JSON bridge (batched) | `RCTEventEmitter` | none (runtime checks) |
| RN TurboModules | TS spec file → codegen | **sync or async** over JSI (direct C++ calls) | event emitters | codegen from TS |
| Flutter MethodChannel / EventChannel | string channel names | async, binary codec | EventChannel streams | none |
| Flutter Pigeon | Dart spec → codegen | async (sync optional) | `@FlutterApi` callbacks | codegen |
| Expo Modules API | Kotlin/Swift DSL (`Function("x") { }`, `Events("y")`) | sync or async over JSI | `sendEvent` | inferred from native signatures |

## 3. Proposal for zero-native
### 3.1 Declare once, in TypeScript (the source of truth)
```ts
// modules/upi.ts
export interface UpiModule {
  listApps(): Promise<UpiApp[]>
  launch(args: { uri: string; package: string }): Promise<{ resultCode: number; response?: string }>
  events: { appsChanged: UpiApp[] }                 // native → JS stream
}
export const Upi = nativeModule<UpiModule>("Upi", { version: 1 })

// usage
const apps = await Upi.listApps()
Upi.on("appsChanged", (apps) => list.set(apps))     // unsubscribed automatically when the screen closes
```
- **Codegen** (`zn codegen`, part of the compiler) reads these interfaces and writes:
  - a Kotlin interface + argument / result encoding (and a Swift protocol later), so the native side is type-checked
    against the same declaration;
  - the module's entry in the app's **capability manifest** (name, version, methods), so an OTA bundle that calls a
    method the installed binary doesn't have is rejected **at load time**, not at the call (ARCHITECTURE §16.2).
- Types allowed across: string, number, boolean, null, arrays, plain objects, string-literal unions, and `zn://`
  handles for heavy objects (photos, icons, files: never bytes in JSON, ARCHITECTURE §15.4). Binary data (`Uint8Array`)
  later, as a separate path (not base64 in JSON).

### 3.2 Calls are async only (decided unless Pavan disagrees)
- The JS thread never waits for native and the UI thread never waits for JS (ARCHITECTURE §8.2). TurboModules allow
  sync calls; we don't, because one slow sync call stalls all JS (taps, animations' JS side, flows).
- Each module picks where it runs: the I/O pool (default), the main thread (UI things: launching an activity), or its
  own serial thread (SDKs that aren't thread-safe).
- **Cancellation:** pass an `AbortSignal` (`Upi.listApps({ signal })`); JS sends `__zn_cancel(callbackId)`, native gets
  `reply.isCancelled` / an interrupt. A screen closing aborts its owned calls (like timers today).
- **Errors** are `{ code, message }` (`code` from a small fixed set + module-specific codes), so JS can branch on them.

### 3.3 Native → JS events (the "2-way" part)
- `Module.on(event, handler)` / returned `off()`. Native calls `emit(event, payload)` from any thread; it reaches JS as
  an app event (instance 0) and is dispatched to subscribers.
- A subscription made in a screen or component **ends when it is disposed** (same owner rule as timers), so no leaks.
- High-frequency streams (location, sensors, download progress) declare `coalesce: "latest"`: if JS is busy, native
  keeps only the newest value per event instead of queueing hundreds.
- Native also learns when nobody listens (`onFirstListener` / `onLastListener`), so a module can stop GPS or a
  broadcast receiver when no screen needs it.

### 3.4 Platform plumbing modules need
- **Activity results** (UPI apps, camera, DigiLocker, Google sign-in): a module starts an activity through the runtime,
  which registers for results before JS runs and, inside a flow, writes the result to FlowStore **before** JS hears it
  (ARCHITECTURE §12.4). Modules never use `onActivityResult` directly.
- **Permissions:** `os.permissions.request("camera")` through the same path.
- **Lifecycle:** modules can observe app foreground / background.

### 3.5 Built-in modules (first users of the system)
`os.upiApps()` (the parked code: intent query for `upi://pay` + known-package fallback, icons as `zn://app-icon/...`
loaded by a Coil fetcher, `<queries>` in the runtime manifest), `os.launchActivity`, `os.openUrl`, `os.share`,
`os.clipboard`, `os.haptics`, `os.appInfo`, `fetch` (ARCHITECTURE §14).

### 3.6 Testing
- JS: the fake host records calls (`host.calls`) and replies by hand; a typed `mockModule<UpiModule>(...)` helper.
- Kotlin: modules are plain classes; test them with a fake `ZnReply`.

## 4. Proposed plan
Make it milestone 2 **step 2.6 "Native modules v1"** (it was "native calls"): `nativeModule<T>` + `on()`, codegen of
the Kotlin side + capability manifest entries, events with owner cleanup and coalescing, cancellation, error codes,
then the built-in `os` modules and `fetch` on top. Flows (2.7–2.8) then use `os.launchActivity` for UPI.
