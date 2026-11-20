# The sample from the Swift package

The same sample app as `ios/CMakeLists.txt` builds (the sources in `ios/Sample`, the bundle `bun run sample:js` writes),
but built the way an app that adds zero-native as a Swift package is: `ZnSamplePackage.xcodeproj` depends on the
package at the repo root (`Package.swift`, products `ZnRuntime` and `ZnPlugin<Name>`) and on `ios/ExtrasPackage`
(Firebase and Lottie). A build phase copies the
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
Lottie plugins come from the second package, `ios/ExtrasPackage`, with the real SDKs (the first build downloads them).
Firebase starts only with `ios/Sample/GoogleService-Info.plist` (not in git).
