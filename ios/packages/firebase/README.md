# zero-native's Firebase plugins as a Swift package

| Product | Plugin | Firebase products |
|---|---|---|
| `ZnPluginFirebaseApp` | `plugins/firebase-app` | FirebaseCore, FirebaseInstallations |
| `ZnPluginFirebaseAnalytics` | `plugins/firebase-analytics` | FirebaseAnalyticsCore (no IDFA, no on-device ad conversion) |
| `ZnPluginFirebaseCrashlytics` | `plugins/firebase-crashlytics` | FirebaseCrashlytics |
| `ZnPluginFirebaseMessaging` | `plugins/firebase-messaging` | FirebaseMessaging (and the main package's `ZnPluginNotifications`) |
| `ZnPluginFirebaseRemoteConfig` | `plugins/firebase-remote-config` | FirebaseRemoteConfig |
| `ZnPluginFirebasePerf` | `plugins/firebase-perf` | FirebasePerformance (brings Remote Config and A/B Testing) |

A package of its own so an app without Firebase never downloads it. Firebase is one big package on Google's side:
adding any of these plugins downloads all of `firebase-ios-sdk` (only the products a plugin uses are built into the
app), so splitting them would save no download, and they stay together. `Sources/<target>` are symlinks to `plugins/<name>/ios`,
where the CMake builds compile the same code. Here it depends on the main package by path (`../../..`). Apps get a copy
in its own repo, `zero-native-firebase`, made at each release by `tools/make-plugin-packages.ts`, with
`README.release.md` as its README (`docs/releasing.md`). Firebase starts only when the app has its
`GoogleService-Info.plist`, as in the CMake build.

For apps: `README.release.md` also covers the Crashlytics dSYM upload (Firebase's `Crashlytics/run` script, found at
`SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/run` in a package build) and the notification service extension
(the main package's `ZnNotificationService` product; `ios/SamplePackage/NotificationService` uses it).
