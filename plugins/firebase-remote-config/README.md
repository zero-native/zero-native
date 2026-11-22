# @zeronative/firebase-remote-config

Firebase Remote Config in zero-native apps, on Android and iOS, with RN Firebase's `remoteConfig()` API: values you change in
the Firebase console without a new build (feature switches, limits, texts), with defaults in the app.

- **Reads need no call.** Every answer of `setDefaults`, `fetch`, `activate`, `fetchAndActivate` and
  `ensureInitialized` brings all values to JS, so `getValue("x").asBoolean()` is a plain function call, like RN's.
- **Each value says where it came from:** `remote` (the console), `default` (`setDefaults`), `static` (nothing).
- **Live updates:** `onConfigUpdated` hears the console publish changes, while anyone listens.
- With no `google-services.json` (iOS: `GoogleService-Info.plist`) every value is its default and `available` is false.

## Add it
1. Firebase as for [`@zeronative/firebase-app`](../firebase-app/README.md).
2. In `settings.gradle.kts`: `:plugin-firebase-remote-config` → `../plugins/firebase-remote-config/android`.
3. In the app's `build.gradle.kts`: `implementation(project(":plugin-firebase-remote-config"))`.
4. In `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, RemoteConfigPlugin())`.

Permissions: none of its own (Firebase adds `INTERNET`).

## Add it on iOS
1. Firebase as for [`@zeronative/firebase-app`](../firebase-app/README.md) (`GoogleService-Info.plist` in the app).
2. The Swift package's `ZnPluginFirebaseRemoteConfig` product (`zero-native-firebase`, `ios/packages/firebase`), or in
   a CMake build the Firebase SDK (`bun run tools/fetch-firebase-apple.ts`) and `plugins/firebase-remote-config/ios`.
3. With the other plugins: `ZnPlugins.register(RemoteConfigPlugin(), ...)`.

iOS differences: `reset()` answers false (iOS's Firebase has no reset; JS still forgets the fetched values). Defaults
go to Firebase as text, so a boolean default reads `"true"` as on Android.

## Use it
```ts
import { RemoteConfig } from "@zeronative/firebase-remote-config"

await RemoteConfig.setDefaults({ checkout_v2: false, max_cashback: 50 })   // also loads last session's values
void RemoteConfig.fetchAndActivate()                                       // new values for next time, or now

if (RemoteConfig.getValue("checkout_v2").asBoolean()) showNewCheckout()
const cap = RemoteConfig.getNumber("max_cashback")
```

## API
Each call answers and never rejects. `Outcome` is `{ ok, reason, changed }`; `reason`: `unavailable`, `no_network`,
`throttled`, `failed`.

| Call | Answers | What it does |
|---|---|---|
| `setDefaults({ key: value })` | true / false | Strings, numbers, booleans. Also loads the values Firebase kept |
| `setConfigSettings({ minimumFetchIntervalMillis?, fetchTimeMillis? })` | true / false | Default: fetch at most every 12 hours, 60 s network limit |
| `fetch(expirationSeconds?)` | `Outcome` | New values, kept for `activate` |
| `activate()` | `Outcome` | They come into use. `changed`: they differ |
| `fetchAndActivate()` | `Outcome` | Both |
| `ensureInitialized()` | true / false | Loads the kept values with no fetch |
| `getValue(key)` | `{ asString, asNumber, asBoolean, getSource }` | No call. `asBoolean`: "true", "1", "yes", "y", "on" |
| `getString` / `getNumber` / `getBoolean(key)` | value | No call |
| `getAll()` | `{ key: ConfigValue }` | Every key with a console value or a default |
| `lastFetchStatus` / `fetchTimeMillis` | `success`, `failure`, `throttled`, `no_fetch_yet` / ms | From the last answer |
| `reset()` | true / false | Deletes fetched values and settings |
| `onConfigUpdated(fn)` | unsubscribe function | `{ updatedKeys, error? }` when the console publishes. Call `activate()` after |

RN Firebase's names work for ported code: `remoteConfig().getValue(...)`, `getRemoteConfig()`. Differences: reads work
after the first answer (`setDefaults` or `ensureInitialized`), not before; fetch calls answer an `Outcome` instead of
throwing.

## Do and don't
- **Do** call `setDefaults` first thing, with every key the app reads. **Why:** the app must work the same with no
  network and on the very first start.
- **Do** fetch in the background and use new values from the next start (or at a safe moment), not in the middle of
  a checkout. **Why:** a value that changes under the user (a price, a limit) is a bug report.
- **Don't** set `minimumFetchIntervalMillis: 0` in a release build. **Why:** Firebase throttles the app (`throttled`).
  Use a few hours, or `onConfigUpdated` for fast changes.
- **Don't** put secrets or personal data in Remote Config. **Why:** any user can read every value from the app.
- **Know:** a live update reaches the phone in seconds to a minute or two after the console publishes.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-config` | from the BoM (35.1.0) | Remote Config |

The sample's release APK (R8, arm64, with Crashlytics, FCM and Analytics already in) grew by **0.06 MB** together with
push native version 2 and the lab screen (15.16 → 15.21 MB). Measured 2026-11-04.
