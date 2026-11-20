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
zero-native's `ZnNotificationService`, embedded in the app. It builds and is embedded; it has not been seen running
on a real push yet (the simulator showed nothing on `simctl push`).

A Release build uploads its dSYM to Crashlytics ("Upload dSYMs to Crashlytics", Firebase's own `Crashlytics/run`
script from the package checkout); it skips itself in Debug builds and when there is no
`ios/Sample/GoogleService-Info.plist`, as on CI.
