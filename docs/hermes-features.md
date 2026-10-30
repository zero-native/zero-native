# Hermes 260318099: what's new and what we could use

We moved to Hermes `260318099.0.5` on 2026-10-30 (`docs/milestones.md`). Sources (Hermes blog, `static_h` branch):
the 260318099.0.0 release notes (2026-06-05), "JSI Runtime Data APIs" (2025-06-09), "ISerialization" (2025-12-02),
"JSON parsing performance" (2025-11-24), "Memory modes" (2025-11-06), "Compilation and runtime modes" (2025-11-02).
Nothing here is built yet; this is a list for later, with a suggested priority.

## 1. The two JSI additions for native code

### 1.1 Runtime data: `setRuntimeData(uuid, shared_ptr)` / `getRuntimeData(uuid)`
**What:** a native library can store its own data inside a `jsi::Runtime`, keyed by a UUID. The runtime owns it and
frees it when the runtime is destroyed. It replaces the "map from `Runtime*` to my data" that RN libraries kept, with
unclear lifetimes. The blog's main example: caching `jsi::PropNameID`s per runtime.
**For us:** little need today. Our engine owns its runtime and keeps everything as members, so we never had that map.
It becomes useful when **other people's C++ code** plugs into our runtime (a JSI library, a C++ module from a
partner): they get per-runtime storage that is cleaned up correctly on a `zn dev` reload (a new runtime) with no
help from us.
**Related idea we can do without the new API (small, worth it):** `callGlobal` looks up `__zn_onEvent` /
`__zn_onTimer` by name on **every** event and timer (`rt.global().getProperty(rt, "...")`, a string → property-id
lookup each time). Cache the two `jsi::Function`s once after the bundle has run; every tap, text change, native
answer and timer gets a little cheaper. Measure before / after with the tap → apply timing (`docs/v0-findings.md`).
**Priority:** the caching: low effort, do it with the next core change. Runtime data: when we accept third-party C++.

### 1.2 `ISerialization`: copy JS values between runtimes in a binary form
**What:** `serialize(value)` turns any JS value (objects, arrays, ArrayBuffers, ...) into an opaque binary blob;
`deserialize(blob)` rebuilds it (a deep copy) in the same or **another** Hermes runtime. `serializeWithTransfer`
**moves** ArrayBuffers instead of copying them (zero-copy; the sender loses them). It is the base of Hermes' coming
Web Workers. Available through `jsi::ISerialization` (`jsi.h` line ~280) via `castInterface` on the runtime.
**What it is not:** a way to talk to Kotlin / Swift. The format is opaque and Hermes-only, so native module calls
still need JSON or our raw bytes (step 3.4). Also **never store it** (FlowStore, MMKV, disk, OTA): the format can
change with the Hermes version, like the bytecode did (98 → 99).
**Where it could help us:**
| Idea | Gain | Cost / risk |
|---|---|---|
| **Keep app state across `zn dev` reloads.** Before the old runtime is destroyed, serialize the values of stores / signals that ask for it; deserialize them into the new runtime. Today a reload restarts state (only the back stack is reopened). | Big for daily work: edit a screen deep in a flow without redoing the steps. | Needs a way to mark what to keep (`persistOnReload(signal, key)`) and a rule when the shape changed (drop it). Debug builds only. |
| **A worker runtime** for heavy JS: big JSON responses, filtering 10 000-row lists, crypto in JS. Work runs on a second Hermes runtime on its own thread; results come back with `serializeWithTransfer` (ArrayBuffers move, no copy). | The main JS thread stays free for taps and UI updates on slow phones. | A second runtime costs memory (~1–2 MB) and start time; message passing API to design; wait for Hermes' own Web Worker work to settle first. |
| **Hand a parsed fetch body to the app without parsing on the JS thread**: parse in the worker, transfer the result. | Only matters for very big responses. | Deserialize is still work on the JS thread; JSON.parse is now 2.7–3.4× faster (§2), so measure first. Probably not worth it. |
**Priority:** `zn dev` state keeping: medium (after milestone 3). Worker runtime: later, only with a real slow case.

## 2. Language and engine changes in the release
| Change | What it means for us | Action |
|---|---|---|
| **`JSON.parse` 2.7–3.4× faster**, `JSON.stringify` faster | `res.json()`, native call results (event 7 is JSON), FlowStore reads and every `callNative` argument got cheaper for free | Measure `json()` on a 1 MB body on the Lava and update `docs/fetch.md` (we told authors big JSON blocks the JS thread). |
| **`Map` / `Set` faster** (new hash table, index off the GC heap) | Our runtime is full of Maps (event handlers, pending calls, owners, list rows) | None; free. |
| **`FinalizationRegistry`** (+ `WeakRef` etc. with symbols) | We can now free **native** resources when a JS object is garbage-collected: a streamed fetch body kept in Kotlin, `zn://` handles, native list data sources, image buffers. This removes the main reason `fetch` reads the whole body before resolving (an unread native body would leak). Also a dev-build leak check (warn when an AbortController / listener is collected while still active). | Use when we build streaming bodies / downloads (`docs/fetch.md` §7). GC timing is not guaranteed, so it is a safety net, never the only way to free something. |
| **`TextDecoder` ships with the engine** | Our `installText()` only fills in what is missing, so the global `TextDecoder` is now Hermes' own; `fetch` still uses our C++ decoder directly. The `/dev/fetch` TextEncoder / TextDecoder check passed on the new Hermes. | Check Hermes' `TextDecoder` against ours (`fatal`, `ignoreBOM`, labels, speed) and drop ours if it is as good. Also list which other globals Hermes now has (`TextEncoder`? `structuredClone`? `URL`?) with a one-time `typeof` log on the phone. |
| `Promise.withResolvers`, iterator helpers (`.map`, `.filter`, `.take` on iterators), `Object.groupBy` / `Map.groupBy`, Set operations (`union`, `difference`, ...), `Error.isError`, `Math.sumPrecise`, `String.isWellFormed` | Usable in app code and our runtime. `Math.sumPrecise` is handy for adding money amounts in floats (still prefer integer paise). | Raise the TS `lib` for app code so these type-check (today the sample's TS config uses `ES2022` defaults). Add to `docs/guide-notes.md` what is safe to use. |
| **Async iteration (`for await`, async generators): "not tested in production, don't use"** | Authors must not use them yet; streaming bodies (later) must not depend on them. | Add a "Don't" to guide-notes; later a compiler warning. |
| `ArrayBuffer.prototype.detached`, fixes for TypedArray / DataView on detached buffers | Safer binary code (our fetch bytes path) | None. |
| Unicode 17 | Newer emoji and scripts in strings and RegExp | None. |
| `hermesc --transform-ts` (strips TypeScript types) | Hermes can compile `.ts` without Babel / Bun | Little gain: our compiler handles TSX and Bun bundles; Bun's step is not the slow part of `zn dev`. Skip. |
| **Bytecode version 98 → 99** | Bytecode only runs on the Hermes it was built for. Already true for us (we rebuilt everything). | **Milestone 4 (OTA):** every bundle must record its bytecode version, and the app must refuse a bundle built for another version *before* running it (Hermes' root API has `getBytecodeVersion`). The same rule covers a future Hermes upgrade in an app update: the bundle pool needs bundles for the new version before the app update ships. |

## 3. Memory and compilation modes
- **HV32 is the default on Android with Hermes V1:** JS values and pointers are 32 bits inside a reserved block
  (compressed pointers). Less memory and better cache use on low-end phones, which is our target. Nothing to do; worth
  one JS heap measurement on the Lava to have a baseline.
- **Mixed modes:** Static Hermes can compile JS ahead of time to **native code**, mixed with bytecode in one runtime,
  and has a baseline JIT. An idea for much later: compile our own runtime package (`packages/core`: signals, views,
  lists), which changes rarely, to native code inside `libzn.so`, and keep app code as bytecode (bytecode is what OTA
  can replace). Costs: bigger `.so`, a more complex build, and a framework fix would then need an app release instead
  of OTA. Only if profiling shows our runtime JS is the slow part. Also check whether the JIT is on in the Android build
  we use (and its size / memory cost).

## 4. Suggested order
1. Now-ish, small: cache `__zn_onEvent` / `__zn_onTimer` (§1.1); measure `json()` on 1 MB (§2); log which globals
   Hermes now has and decide whether to keep our `TextDecoder` (§2); guide-notes "don't use `for await`".
2. Milestone 4 (OTA): the bytecode-version check (§2, last row).
3. After milestone 3: keep state across `zn dev` reloads with `ISerialization` (§1.2).
4. With streaming fetch / downloads: `FinalizationRegistry` as the safety net for native resources (§2).
5. Only with a measured need: worker runtime (§1.2), native-compiled runtime package (§3).
