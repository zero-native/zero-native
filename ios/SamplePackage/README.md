# The sample from the Swift package

The same sample app as `ios/CMakeLists.txt` builds (the sources in `ios/Sample`, the bundle `bun run sample:js` writes),
but built the way an app that adds zero-native as a Swift package is: `ZnSamplePackage.xcodeproj` depends on the
package at the repo root (`Package.swift`, products `ZnRuntime` and `ZnPlugin<Name>`) and on `ios/packages/firebase`
and `ios/packages/lottie`. A build phase copies the
JS bundle into the app.

```bash
bun run sample:js
```

```bash
bun run tools/fetch-hermes-apple.ts release
```

```bash
xcodebuild -project ios/SamplePackage/ZnSamplePackage.xcodeproj -scheme ZnSamplePackage -destination 'generic/platform=iOS Simulator' build
```

Or open `ZnSamplePackage.xcodeproj` in Xcode. With Hermes fetched, the package uses that local copy; without it, the
zip on the `hermes-<version>` release ([docs/releasing.md](../../docs/releasing.md)). SwiftPM remembers which: after
fetching or removing Hermes, reset the package caches (Xcode: File → Packages → Reset Package Caches). The Firebase and
Lottie plugins come from their own packages, `ios/packages/firebase` and `ios/packages/lottie`, with the real SDKs (the
first build downloads them).
Firebase starts only with `ios/Sample/GoogleService-Info.plist` (not in git).

`NotificationService/` is the sample's notification service extension, from the package: one file that subclasses
zero-native's `ZnNotificationService`, embedded in the app. Seen working on an iPhone 11 on 2026-11-21: a real FCM push with
a picture (`bun run tools/push-send.ts --topic zn-sample-lab --notification "Title|Body" --image <https url>`) showed
with the picture attached. The simulator shows nothing on `simctl push`.

Push needs the app's entitlement (`ios/Sample/ZnSample.entitlements`, `aps-environment`), the two plugins registered
(`NotificationsPlugin`, `FirebaseMessagingPlugin`), the three APNs calls forwarded by the app delegate, and the
Info.plist keys (`FirebaseAppDelegateProxyEnabled` off, `UIBackgroundModes` remote-notification): see
`ios/Sample/ZnSampleApp.swift` and `ios/Sample/Info.plist`. The Firebase project needs an APNs key for the app.

A Release build uploads its dSYM to Crashlytics ("Upload dSYMs to Crashlytics", Firebase's own `Crashlytics/run`
script from the package checkout); it skips itself in Debug builds and when there is no
`ios/Sample/GoogleService-Info.plist`, as on CI.

`ZnSampleUITests/` is the sample's UI tests (XCUITest, in the shared scheme's Test action; a plain build leaves them
out). They launch the app on one route (`ZN_ROUTE`) and find elements by `testID`, the accessibilityIdentifier:

```bash
bun run ios:ui-test --device "iPhone 17"
```

`--only ComponentsTests` (or `Class/testName`, repeatable) runs some; `--dump a11yLab --ready a11y-status` prints a
route's accessibility tree, to write a new test; `--packages <dir>` keeps SwiftPM checkouts between CI runs. The
simulator is booted for the run and shut down after, unless it was already on (or `--keep-booted`).

The test build is not signed (`CODE_SIGNING_ALLOWED=NO`, as CI's builds), so the app has no entitlements: a test of a
Keychain screen (SecureStore) would fail with -34018 until the test build is signed ad hoc (`CODE_SIGN_IDENTITY=-`).
