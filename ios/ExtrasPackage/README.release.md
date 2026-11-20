# zero-native: Firebase and Lottie plugins for iOS

The iOS plugins of [zero-native](https://github.com/zero-native/zero-native) that need Google's or Airbnb's SDKs. They
are a package of their own, so an app without them never downloads Firebase or Lottie.

| Product | What |
|---|---|
| `ZnPluginFirebaseApp` | the base of the Firebase plugins (FirebaseCore, FirebaseInstallations) |
| `ZnPluginFirebaseAnalytics` | Google Analytics for Firebase (FirebaseAnalyticsCore: no IDFA, no on-device ad conversion) |
| `ZnPluginFirebaseCrashlytics` | Crashlytics, with JS errors |
| `ZnPluginFirebaseMessaging` | push messages (FirebaseMessaging; uses `ZnPluginNotifications` from zero-native) |
| `ZnPluginLottie` | Lottie animations (lottie-spm) |

**Add it together with zero-native, at the same version.** This package depends on
`https://github.com/zero-native/zero-native.git` at exactly its own version, so the two must match:

```swift
.package(url: "https://github.com/zero-native/zero-native.git", exact: "0.1.0"),
.package(url: "https://github.com/zero-native/zero-native-extras.git", exact: "0.1.0"),
```

In Xcode: File → Add Package Dependencies, both urls, "Exact Version", the same number.

Firebase starts only when the app has its `GoogleService-Info.plist`. The code is made in the zero-native repo
(`plugins/<name>/ios`) and copied here at each release: change it there, not here. Apache-2.0 (`LICENSE`, `NOTICE`).
