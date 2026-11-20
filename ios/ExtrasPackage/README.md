# The second Swift package: Firebase and Lottie

zero-native's iOS plugins that need Google's or Airbnb's SDKs, kept apart from the main package (`Package.swift` at the
repo root) so an app without them never downloads Firebase or Lottie:

| Product | Plugin | SDK |
|---|---|---|
| `ZnPluginFirebaseApp` | `plugins/firebase-app` | FirebaseCore, FirebaseInstallations |
| `ZnPluginFirebaseAnalytics` | `plugins/firebase-analytics` | FirebaseAnalyticsCore (no IDFA, no on-device ad conversion) |
| `ZnPluginFirebaseCrashlytics` | `plugins/firebase-crashlytics` | FirebaseCrashlytics |
| `ZnPluginFirebaseMessaging` | `plugins/firebase-messaging` | FirebaseMessaging (and the main package's `ZnPluginNotifications`) |
| `ZnPluginLottie` | `plugins/lottie` | Lottie (lottie-spm) |

`Sources/<target>` are symlinks to `plugins/<name>/ios`: the code lives there, where the CMake builds compile it too.
Here the package depends on the main one by path (`../..`). Apps will get a copy in its own repo, made at each release
by `tools/make-extras-package.ts`, that depends on the main package by url and version, with `README.release.md` as its
README (`docs/releasing.md`). Firebase and Lottie are asked for from the CMake build's versions up to the next major.
Lottie comes as a dynamic framework here (lottie-spm); the CMake builds link Lottie-Static.

`ios/SamplePackage` uses it. Firebase starts only when the app has its `GoogleService-Info.plist`, as in the CMake build.
