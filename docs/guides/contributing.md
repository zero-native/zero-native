# Contributing to zero-native

Thanks for your interest in contributing! This guide covers building the framework from source, running the test suites, and the strict compatibility rules that keep OTA updates safe for apps already in the wild.

---

## 1. Local Development Setup

```bash
git clone https://github.com/zero-native/zero-native.git
cd zero-native
bun install
```

### Run all JS & type tests
```bash
bun run sample:js   # compiles examples/sample (also seeds test-kit fixture data on fresh clone)
bun run test        # runs bun test across packages, plugins, compiler, tools, server + tsc
```

### Android runtime tests & lint
From `android/`:
```bash
./gradlew :runtime:testDebugUnitTest :runtime:lintDebug :sample:lintDebug
./gradlew :sample:installDebug
```

### iOS runtime & C++ core tests (macOS)
```bash
bun run tools/fetch-hermes-apple.ts
bun run tools/run-core-tests-apple.ts --sim
bun run tools/ios-sample.ts
```

### Code generators
- `bun run gen:registry` — validates `packages/template/src/registry.ts` against `registry.lock.json` and regenerates Kotlin/Swift registry files.
- `bun run gen:tag-props` — regenerates `compiler/src/tag-props.ts` from `packages/ui/src/index.ts`.

CI runs JS tests, type checks, C++ core tests, `ios:ota-test`, `tools/pack.ts`, Android lint (`:runtime` and `:sample`) + unit tests across every module + R8 release build, iOS simulator + Release + SwiftPM (`SamplePackage`) builds, and a fresh `zn new` app build on every PR.

---

## 2. The Registry Rules (Keeping OTA Backward-Compatible)

Compiled `.zn.ui` templates store **numeric IDs** (for components, props, events, and enums) from `packages/template/src/registry.ts`, not string names. Because older app binaries stay installed on users' phones for months, **every change to the registry must obey these rules** (enforced automatically by `bun run gen:registry` and tests):

1. **Never remove, rename, renumber, or retype an existing entry.** Old bundles depend on those IDs. If something is deprecated, mark it unused in a comment.
2. **When adding a component, prop, event, or enum value** (or making a static prop dynamic):
   - Increment `REGISTRY_VERSION` by 1 (once per PR/feature, not once per entry).
   - Add each new entry to `Added` at the bottom of `registry.ts` with the new version number.
3. **Never silently change the behavior of an existing entry.** Add a new prop or enum value instead so older screens don't change unexpectedly.
4. **Run both generators:**
   ```bash
   bun run gen:registry
   bun run gen:tag-props
   ```
   The compiler uses `Added` to compute the **minimum** `registryVersion` each bundle requires — so apps that don't use a new feature can still deliver OTA updates to older store builds!

---

## 3. Adding a New Component (Checklist)

1. **Registry (`packages/template/src/registry.ts`):** Add component, prop, and event IDs, bump `REGISTRY_VERSION`, list them in `Added`, and run `bun run gen:registry`.
2. **Types (`packages/ui/src/index.ts`):** Add the JSX component & prop types with clear JSDoc, then run `bun run gen:tag-props`.
3. **Compiler (`compiler/src/compile.ts`):** Only touch if the component needs special compile-time handling.
4. **Android (`android/runtime/`):** Implement `Zn<Name>.kt` using Compose **Foundation only** (no Material 3), wire it in `ZnRenderer.kt` and `ZnTemplate.kt`. Dynamic props must read from `DynamicProps` slot cells.
5. **iOS (`ios/ZnRuntime/Swift/`):** Implement the matching SwiftUI/UIKit view and wire it in the renderer.
6. **Sample & Docs:** Add a test lab in `examples/sample/src/`, document the component in `docs/components.md` (and note any platform differences in `docs/platform-differences.md`).
7. **Verify:** Run `bun run sample:js && bun run test`, Android tests/lint, and iOS build.

---

## 4. Changing the Host API / Bridge

- **App event IDs** (native → JS events on instance `0`) must match exactly between `packages/core/src/app-events.ts` and native (`ZnAppEvent.kt` / Swift). Tests enforce equality.
- Adding a `__zn_*` host function, app event, or batch op requires bumping `kHostApiVersion` in `core/include/zn/engine.h` and `HOST_API_VERSION` in `packages/core/src/host-api.ts` together.
- Breaking/removing an existing host function requires bumping `kHostApiOldest`, which drops compatibility with older bundles — discuss in an issue first.
