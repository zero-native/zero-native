# zero-native: Firebase plugins for iOS

The Firebase plugins of [zero-native](https://github.com/zero-native/zero-native), as a Swift package of their own so
an app without Firebase never downloads it.

| Product | What |
|---|---|
| `ZnPluginFirebaseApp` | the base of the Firebase plugins (FirebaseCore, FirebaseInstallations) |
| `ZnPluginFirebaseAnalytics` | Google Analytics for Firebase (FirebaseAnalyticsCore: no IDFA, no on-device ad conversion) |
| `ZnPluginFirebaseCrashlytics` | Crashlytics, with JS errors |
| `ZnPluginFirebaseMessaging` | push messages (FirebaseMessaging; uses `ZnPluginNotifications` from zero-native) |
| `ZnPluginFirebaseRemoteConfig` | Remote Config (FirebaseRemoteConfig) |
| `ZnPluginFirebasePerf` | Performance Monitoring (FirebasePerformance: it hooks URLSession for its automatic network traces; register it before the other Firebase plugins) |

**Add it together with zero-native, at the same version.** It depends on `https://github.com/zero-native/zero-native.git`
at exactly its own version:

```swift
.package(url: "https://github.com/zero-native/zero-native.git", exact: "0.1.0"),
.package(url: "https://github.com/zero-native/zero-native-firebase.git", exact: "0.1.0"),
```

In Xcode: File → Add Package Dependencies, both urls, "Exact Version", the same number. Firebase starts only when the
app has its `GoogleService-Info.plist`.

## Crashlytics: upload the dSYMs

Crashlytics names the frames of a native crash only with that build's dSYM (JS errors don't need it: their frames are
sent as text). Firebase ships the upload script inside its package. In the app target:

1. Build Settings: **Debug Information Format** = **DWARF with dSYM File** (at least for Release), and **User Script
   Sandboxing** = **No**.
2. Build Phases → **+** → **New Run Script Phase**, after "Embed Frameworks", with this script:
   ```sh
   "${BUILD_DIR%/Build/*}/SourcePackages/checkouts/firebase-ios-sdk/Crashlytics/run"
   ```
   and these **Input Files**:
   ```
   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}
   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${PRODUCT_NAME}
   ${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Info.plist
   $(TARGET_BUILD_DIR)/$(UNLOCALIZED_RESOURCES_FOLDER_PATH)/GoogleService-Info.plist
   $(TARGET_BUILD_DIR)/$(EXECUTABLE_PATH)
   ```

Hermes (`hermesvm.framework`) comes without a dSYM, so frames inside Hermes keep their addresses.

## Messaging: pictures in pushes (a notification service extension)

For pushes iOS shows itself (`"mutable-content": 1`), zero-native's `ZnNotificationService` removes HTML tags from the
title and body and attaches the push's picture. It is a product of the **zero-native** package (it needs no Firebase).
Add a Notification Service Extension target to the app, link `ZnNotificationService` to it, and make its one file:

```swift
import ZnNotificationService

final class NotificationService: ZnNotificationService {}
```

with `NSExtensionPrincipalClass` = `$(PRODUCT_MODULE_NAME).NotificationService` in the extension's Info.plist. Its
options (`ZnNotificationImageKeys`, `ZnNotificationDefaultCategory`, `ZnAppGroup`) are listed at the top of
`plugins/firebase-messaging/ios-service/ZnNotificationService.swift` in the zero-native repo.

The code is made in the zero-native repo (`plugins/<name>/ios`) and copied here at each release: change it there, not
here. Apache-2.0 (`LICENSE`, `NOTICE`).
