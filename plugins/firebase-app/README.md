# @zeronative/firebase-app

The base of every zero-native Firebase plugin, like RN Firebase's `app` module. It holds:

- **The one Firebase version** (the Firebase BoM, 35.1.0). `@zeronative/firebase-crashlytics`, `@zeronative/firebase-messaging` and the
  next Firebase plugins depend on this Gradle project and take their versions from it. To move Firebase, change one
  line here.
- **One Gradle file for the app** (`firebase.gradle.kts`): Firebase on when `google-services.json` is there, off
  when it isn't.
- **`Firebase.app()`**: the project the app talks to, and Firebase's data collection switch.
- **Installations**: the id Firebase knows this install by (RN Firebase's `installations()`).

## Add it
1. Put your Firebase project's `google-services.json` in the app module. Never commit it if your repo is public.
2. In the root `build.gradle.kts`:
   ```kotlin
   id("com.google.gms.google-services") version "4.5.0" apply false
   id("com.google.firebase.crashlytics") version "3.0.8" apply false   // only if you use @zeronative/firebase-crashlytics
   ```
3. In `settings.gradle.kts`:
   ```kotlin
   include(":plugin-firebase-app")
   project(":plugin-firebase-app").projectDir = file("../plugins/firebase-app/android")
   ```
4. In the app's `build.gradle.kts`:
   ```kotlin
   implementation(project(":plugin-firebase-app"))   // only for the JS below; other Firebase plugins bring it anyway
   // At the end, after dependencies { }:
   apply(from = "../../plugins/firebase-app/firebase.gradle.kts")
   ```
5. In `Application.onCreate`, with the other plugins, only if JS calls `Firebase` or `Installations`:
   ```kotlin
   ZnPlugins.register(this, FirebaseAppPlugin())
   ```

What `firebase.gradle.kts` does:
- **json there:** applies the google-services Gradle plugin, and Crashlytics' Gradle plugin when the app has
  `:plugin-firebase-crashlytics`. A release build uploads its R8 mapping to Crashlytics only with `-PznUploadMapping`.
- **No json:** applies nothing and logs one line: `zero-native: no android/sample/google-services.json, so Firebase
  is off in this build`. The app builds and runs; every Firebase plugin answers `available: false`. This is how CI
  and other machines build the sample.

Permissions: none of its own (Firebase's libraries add `INTERNET` and `ACCESS_NETWORK_STATE`).

On iOS: `GoogleService-Info.plist` in the app (never commit it if your repo is public), the Swift package in
`ios/packages/firebase` (product `ZnPluginFirebaseApp`; a CMake build gets the SDK with
`bun run tools/fetch-firebase-apple.ts`), then `ZnPlugins.register(FirebaseAppPlugin())`. The first Firebase plugin to
register calls `FirebaseApp.configure()` before JS runs (Android's google-services plugin does it by itself). With no
SDK or no plist every Firebase plugin answers `available: false`, as on Android.

## Use it
```ts
import { Firebase, installations } from "@zeronative/firebase-app"

const app = await Firebase.app()          // { available: true, name: "[DEFAULT]", projectId, appId, ... }
await Firebase.setDataCollectionDefault(false)
const id = await installations().getId()
```

## API
Each call answers and never rejects.

| Call | Answers | What it does |
|---|---|---|
| `Firebase.app()` | `{ available, name, projectId, appId, senderId, storageBucket, dataCollectionDefault }` | `available: false` and nothing else when Firebase is off |
| `Firebase.setDataCollectionDefault(on)` | the same | Firebase's default for every library that collects by itself, kept across starts |
| `Installations.getId()` | string / null | The install id. Null with no Firebase |
| `Installations.getToken(forceRefresh?)` | `{ token, expiresAt }` / null | A short-lived token your server can check with Firebase. `expiresAt` in ms |
| `Installations.delete()` | true / false | Deletes the id and its data at Firebase. A new id comes on next use |

RN Firebase's names work for ported code: `firebase.app()`, `installations().getId()`, `getInstallations()`.
Differences: `firebase.app()` is a promise here (zero-native reads it from native), and it has no `options.apiKey`.

## Do and don't
- **Do** start with data collection off when you need the user's consent first: in the app's manifest,
  `<meta-data android:name="firebase_data_collection_default_enabled" android:value="false" />`, then
  `Firebase.setDataCollectionDefault(true)` after they agree. **Why:** Firebase starts before any JS runs, so a JS call
  alone comes too late for the first launch.
- **Don't** use the install id as your user id. **Why:** it changes on a reinstall or after `delete()`.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-bom` | 35.1.0 | Firebase versions |
| `com.google.firebase:firebase-common` | from the BoM | `FirebaseApp` |
| `com.google.firebase:firebase-installations` | from the BoM | Installations |

Both libraries come with Crashlytics and FCM already, so with either of those this plugin adds only its own few
classes.
