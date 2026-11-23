# @zeronative/firebase-crashlytics

Firebase Crashlytics for zero-native apps, on Android. Most apps need no JS at all. By itself it sends:

- **Kotlin and Java crashes** (Crashlytics' own handler; core's crash mark runs first and hands each crash on).
- **Every JS error as a non-fatal**, with its JS stack: errors in screens, handlers, timers, promises nobody caught,
  JS that hung or didn't start, and what native refused (core's `ZnRuntime.addJsErrorListener`; like RN Firebase's
  global handler, no app code).
- **OTA outcomes**: a rollback, a blocked bundle or a failed install as a non-fatal named after its kind
  (`zn.ota.error_rollback`); the others as log lines.
- **Keys on every report**: `zn_bundle` (`sample_12@1a2b3c4d5e6f`), `zn_bundle_id` (`sample_12`), `zn_built_in`
  (true: the APK's own bundle), `zn_host_api`, `zn_route` (the top screen), `zn_js_kind` (the last JS error's kind).
  Each screen change is a log line too (`nav: home -> pay`): the screens before a crash.

Native crashes (in Hermes or C++) need one more Gradle line: [Native crashes](#native-crashes-opt-in).

## Add it
1. Put your Firebase project's `google-services.json` in the app module. Never commit it if your repo is public.
2. In the root `build.gradle.kts`:
   ```kotlin
   id("com.google.gms.google-services") version "4.5.0" apply false
   id("com.google.firebase.crashlytics") version "3.0.8" apply false
   ```
3. In `settings.gradle.kts`, the base plugin [`@zeronative/firebase-app`](../firebase-app/README.md) (it holds the
   Firebase version) and this one: `:plugin-firebase-app` and `:plugin-firebase-crashlytics`.
4. In the app's `build.gradle.kts`:
   ```kotlin
   implementation(project(":plugin-firebase-crashlytics"))
   // At the end. With no json the app still builds, and Crashlytics is off (the zero-native sample does this):
   apply(from = "../../plugins/firebase-app/firebase.gradle.kts")
   ```
   That file applies the two Gradle plugins only when `google-services.json` is there (README of firebase-app).
5. In `Application.onCreate`, with the other plugins (before `ZnRuntime.start`):
   ```kotlin
   ZnPlugins.register(this, CrashlyticsPlugin())
   ```

With no `google-services.json`, Firebase doesn't start: the plugin logs one line, `status()` says `available: false`,
and every call does nothing. Permissions: `INTERNET` (Firebase adds `ACCESS_NETWORK_STATE`). Nothing else.

**R8 mapping.** A release build with the Crashlytics Gradle plugin uploads its R8 mapping, so Kotlin stacks show real
names. The sample uploads only with `-PznUploadMapping`. JS stacks are not changed by R8. JS source maps never leave
your build machine: Crashlytics shows `main.js` lines. Paste the stack into `bun run ota symbolicate` for the TSX
lines (`docs/guide-notes.md`, "Finding the TSX line of a release crash").

On iOS: as `@zeronative/firebase-app` says, then the product `ZnPluginFirebaseCrashlytics` and
`ZnPlugins.register(CrashlyticsPlugin())`. Upload each build's dSYM so native stacks show names (Crashlytics'
`upload-symbols`; `tools/ios-sample.ts` does it for the sample unless `--no-symbols`). JS errors need none: their
frames are sent as text.

## Use it
```ts
import { Crashlytics } from "@zeronative/firebase-crashlytics"

// After login: your own id (a customer code). On logout: "".
Crashlytics.setUserId(customer.code)
Crashlytics.setAttribute("plan", "free")

// A breadcrumb, shown with the next report of this launch:
Crashlytics.log("checkout: pay tapped")

// An error you caught yourself (errors nobody caught are sent already: don't send them twice):
try { await verify(ztc) } catch (e) { Crashlytics.recordError(e, "Checkout.verify") }

// The user opted out (kept across starts):
await Crashlytics.setCrashlyticsCollectionEnabled(false)
```

## API
Each call answers and never rejects.

| Call | Answers | What it does |
|---|---|---|
| `status()` | `{ available, enabled }` | `available`: Firebase is set up. `enabled`: reports are sent |
| `log(message)` | true / false | A breadcrumb with the next report (Crashlytics keeps 64 KB) |
| `recordError(error, tag?)` | true / false | A non-fatal with the JS stack. `tag` says where (`"Checkout.verify"`) |
| `setAttribute(key, value)` | true / false | A key on later reports: string, number or boolean. Max 64 keys, 1 KB each |
| `setAttributes({ ... })` | true / false | Several at once |
| `setUserId(id)` | true / false | `""` clears it |
| `setCrashlyticsCollectionEnabled(on)` | `{ available, enabled }` | Sending on or off, kept across starts |
| `isCrashlyticsCollectionEnabled` | boolean | The last value `status()` or the call above saw |
| `crash(kind?)` | true | Crashes on purpose to test the setup: `"kotlin"` (default) or `"native"` (needs the NDK line) |

RN Firebase's names work for ported code: `crashlytics().log(...)`, `getCrashlytics()`. Differences: `recordError`'s
second argument is a tag, not the error's name; `setAttribute` also takes numbers and booleans.

**Kotlin options:** `CrashlyticsPlugin(jsErrors = false)` stops the automatic JS non-fatals (the app sends what it
wants with `recordError`). `CrashlyticsPlugin(redact = { text -> ... })` runs on every text from JS before it goes to
Crashlytics (error messages, stacks, logs, string keys): for private data your app knows the shape of. If it throws,
the text is left out.

**Limits:** at most 30 JS non-fatals per launch (an error in a loop would send hundreds; Crashlytics keeps only the
newest 8 of a session anyway). The rest are counted in one log line. Reports go out at the next start.

## Do and don't
- **Know:** error text goes out **unmasked** unless the app passes `redact`. Every JS error message and stack is sent as
  it is, and an error text in a payments app can hold a VPA, a phone number or an amount. Pass `redact` before real users.
- **Do** use your own id in `setUserId` (a customer code). **Don't** use a phone number, an email or a VPA, in the id
  or in a key. **Why:** everyone with console access sees them, and they stay for 90 days.
- **Don't** put private values in your own `throw new Error(...)`: the message goes to Crashlytics as it is (unless
  `redact` cleans it).
- **Do** filter the console by `zn_bundle_id` to see one OTA bundle's crashes. **Why:** Crashlytics groups issues by
  stack, not by key; the key tells which bundles an issue happened in.

## Phone test for OTA errors
`tools/plugin-phone/crashlytics.ts` has one more step, off by default: set `ZN_OTA=1` to run it. It builds a bundle into
a test store of its own (`.zn-ota-test/plugin-phone/ota-store`, signed with the sample's key), serves it on this computer
only (port 8790, over `adb reverse`), and clears the sample's data before and after. It installs that bundle, starts it, records a caught error and
sends it. You then check in the Firebase console, a few minutes later, that the event says `zn_built_in=false` and
`zn_bundle_id=<that bundle>` (the step prints the id). Nothing is published anywhere else. Like the other steps, it needs a sample built
with `google-services.json`; without it the step says SKIP.

## Native crashes (opt-in)
A crash in Hermes or C++ (a SIGSEGV) kills the process with no Java stack. Only `firebase-crashlytics-ndk` sees it.
It is opt-in because of its size. In the app's `build.gradle.kts`:
```kotlin
implementation("com.google.firebase:firebase-crashlytics-ndk") // the version comes from the plugin's Firebase BoM
```
The sample adds it only with `-PznCrashlyticsNdk`. Without it, a native crash is still counted by core's OTA health
check (Android's exit record), just not in Crashlytics.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-bom` | 35.1.0 | Firebase versions (from `@zeronative/firebase-app`) |
| `com.google.firebase:firebase-crashlytics` | from the BoM (21.0.x) | Reports, keys, logs |
| `com.google.firebase:firebase-crashlytics-ndk` | from the BoM, **opt-in** | Native crashes |

Measured on the sample's R8 release APK (arm64), 2026-11-04:
- The plugin adds **about 232 KB** (classes.dex +225 KB compressed, +502 KB raw; a small DataStore .so, resources).
- The NDK line adds **about 1.30 MB** more (4 `.so` files, stored uncompressed in the APK; about 460 KB to download).
