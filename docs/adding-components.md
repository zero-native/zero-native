# Adding a component, prop, event or enum value (framework developers)

For anyone changing the framework itself (Claude, Gemini, contributors). App authors read `docs/components.md` and
`docs/guide-notes.md` instead.

The registry (`packages/template/src/registry.ts`) is the list of numbers templates use for components, props, events
and enum values. Templates store numbers, not names, and the renderer on the phone has its own copy of the list. Old
apps stay installed for months, and OTA bundles must keep working on them, so the registry follows strict rules.

## 1. The rules (checked by tests)
1. **Never remove, rename, renumber or retype** an entry. Bundles built earlier use it. Mark an entry as unused in a
   comment if it is no longer wanted.
2. **Adding something** (a component, prop, event, enum value, or making a prop dynamic):
   - raise `REGISTRY_VERSION` by one for the whole change (once per step, not once per entry);
   - list each new thing in `Added` at the end of `registry.ts` with that new version.
3. **Changing how an existing entry looks or behaves** (a default colour, a different animation, a new meaning):
   avoid it. Add a new prop or enum value instead, so existing screens keep their look. If it can't be avoided, raise
   `REGISTRY_VERSION` and set the entry's version in `Added` to the new number. Bundles that use it then need the new
   app; older apps keep the bundle they have, which matches how they draw it. **No test can detect this case**; the
   reviewer checks it.
4. **Ids come from your range**, so two people never pick the same number:
   | Who | Components | Props | Events |
   |---|---|---|---|
   | Claude | 15–19 | 122–199 | 11–29 |
   | Gemini | 20–29 | 200–249 | 30–39 |
5. Run **`bun run gen:registry`**. It checks the rules against `packages/template/registry.lock.json` (the last
   accepted registry) and only then writes the Kotlin copy (`Registry.kt`) and the new lock. If a rule is broken it
   writes nothing and says what to fix.

**Why:** a bundle asks for the lowest registry version that has everything it really uses (`docs/ota.md` §3.2). That
only works if every entry's version is right. The rules above keep it right without anyone having to remember.

## 2. What fails, and what the message means
| Message | Fix |
|---|---|
| `X is new: raise REGISTRY_VERSION ... and list it in Added` | Raise the version, add `X` to `Added` with it |
| `X is new: list it in Added with N` | Add `X` to `Added` with the new version `N` |
| `X was removed` / `id changed` / `type changed` | Put it back as it was; add a new entry instead |
| `since went down` / `a changed entry must say since N` | An `Added` version can only go up, to the current version |
| `the Kotlin registry is generated ...` / `the lock is up to date` (registry test) | Run `bun run gen:registry` |

## 3. Adding a component, step by step
Follow `Carousel` / `Sheet` / `Switch` as examples.
1. **Registry:** component id, props, events from your range; `REGISTRY_VERSION` + `Added` (section 1); run
   `bun run gen:registry`.
2. **Types:** `packages/ui/src/index.ts`.
3. **Compiler:** `compiler/src/compile.ts` only if the component needs special handling (most don't).
4. **Kotlin:** a `Zn<Name>.kt` file in `android/runtime/.../runtime/`, one line in the `when` in `ZnRenderer.kt`, prop
   fields in `ZnTemplate.kt`. Props that change at runtime must be in `DynamicProps` and read from slot cells.
   Colours and sizes come from props with sensible defaults; Compose **foundation** only (no `material3`).
5. **Native modules** (if the component needs one): `ZnModuleBase("Name", version = N)`; JS calls it with a string
   literal name (`nativeModule("Name", { version: N })`); raise `version` on both sides when JS starts using a new
   method. Built-in modules are listed in `ZnModules`' `init`.
6. **Sample:** a dev screen, with a row in `examples/sample/src/DevScreen.tsx`.
7. **Docs:** `docs/components.md` (props, defaults, what can change at runtime) and `docs/guide-notes.md`
   (do / don't / why).
8. **Checks:** `bun run test`, `.\gradlew.bat :runtime:testDebugUnitTest :runtime:lintDebug :sample:lintDebug`, then
   the phone.

## 4. Host functions and the bridge
Adding a `__zn_*` host function, an app event number, or changing the batch / value formats changes the **host API**.
Raise `kHostApiVersion` in `core/include/zn/engine.h` and `HOST_API_VERSION` in `packages/core/src/host-api.ts`
together (a test checks they are equal). Removing one, or changing its meaning, also raises `kHostApiOldest`: every
bundle built before then stops running on the new app, so this needs Pavan's approval.
