# The sample from the Swift package

The same sample app as `ios/CMakeLists.txt` builds (the sources in `ios/Sample`, the bundle `bun run sample:js` writes),
but built the way an app that adds zero-native as a Swift package is: `ZnSamplePackage.xcodeproj` depends on the
package at the repo root (`Package.swift`) and its products `ZnRuntime` and `ZnPlugin<Name>`. A build phase copies the
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

Or open `ZnSamplePackage.xcodeproj` in Xcode. Hermes is the local release one until the Hermes zip is on a GitHub
Release (`docs/publishing-plan.md` §2.3). The Firebase and Lottie plugins build without their SDKs and say so at start
(the package doesn't depend on Google's or Airbnb's packages yet: §9).
