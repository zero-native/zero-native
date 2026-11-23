# __APP_TITLE__

A [zero-native](https://github.com/zero-native/zero-native) app, made by `zn new`. Screens are TSX in `app/src/`.
They are drawn by Jetpack Compose on Android and SwiftUI / UIKit on iOS.

zero-native isn't published yet, so this app builds against a local checkout: `__ZN_DIR__` (from this folder).
<!-- ios:cmake -->
It is named in four places: `package.json`, `android/gradle.properties`, `ios/CMakeLists.txt` and
`tools/ios.ts`. If you move the app or zero-native, change all four.
<!-- /ios:cmake -->
<!-- ios:packages -->
It is named in four places: `package.json`, `android/gradle.properties`, the Swift package reference in
`ios/__APP_CLASS__.xcodeproj` and `tools/ios.ts`. If you move the app or zero-native, change all four.
<!-- /ios:packages -->

## Set up

Once, in zero-native: `bun install`. Then here:

```bash
bun install
```

## iOS (simulator)

<!-- ios:cmake -->
You need a Mac with Xcode 26 and CMake (`brew install cmake`). Start a simulator (`open -a Simulator`), then:
<!-- /ios:cmake -->
<!-- ios:packages -->
You need a Mac with Xcode 26. Start a simulator (`open -a Simulator`), then:
<!-- /ios:packages -->

```bash
bun run ios
```

It builds the JS, builds the app, installs it on the booted simulator and starts it with its console attached. The
first build takes about a minute. The first run also downloads Hermes into zero-native
(`tools/fetch-hermes-apple.ts`). `bun run ios --link __APP_NAME__://app/about?from=link` opens the second screen by
its link.
<!-- ios:packages -->

The iOS host is a plain Xcode project on zero-native's Swift package: you can also open `ios/__APP_CLASS__.xcodeproj` in
Xcode, after `bun run app:js:ios`, and press Run. Its build phase "Copy the JS bundle" puts `ios/bundle` into the app.
<!-- /ios:packages -->

## Android

You need Android Studio (its JDK and the Android SDK) and a phone or emulator on adb. Then:

```bash
bun run android
```

It builds the JS into `android/app/src/main/assets` and installs the debug build. You can also open `android/` in
Android Studio, after `bun run app:js`. `bun run dev` (live reload to the debug build) is
not tried from an app made by `zn new` yet.

## Live reload on a real iPhone

The simulator's debug build finds `bun run dev` by itself (127.0.0.1). A real iPhone reaches the Mac over Wi-Fi:

1. Install the Debug build on the iPhone (same Wi-Fi as the Mac; a guest network that keeps devices apart won't work).
2. On the Mac: `bun run dev --lan`. It advertises itself with Bonjour and prints the Mac's address.
3. Open the app and allow Local Network access when iOS asks. The console says `phone connected: ...`.

Only Debug builds have the Local Network keys (NSLocalNetworkUsageDescription, NSBonjourServices `_zn-dev._tcp`);
<!-- ios:cmake -->
`ios/CMakeLists.txt` adds them (zero-native's `ios/cmake/ZnDev.cmake`), so App Store builds never ask.
<!-- /ios:cmake -->
<!-- ios:packages -->
the build phase "zn dev keys (Debug)" adds them, so App Store builds never ask.
<!-- /ios:packages -->
<!-- ios:cmake -->
Without Bonjour, name the Mac yourself: `ZN_DEV_HOST=<address>` in the Xcode scheme's environment, or
`-DZN_DEV_HOST=<address>` when CMake configures (the `ZN_DEV_HOST` build setting).
<!-- /ios:cmake -->
<!-- ios:packages -->
Without Bonjour, name the Mac yourself: `ZN_DEV_HOST=<address>` in the Xcode scheme's environment, or a
`ZN_DEV_HOST` build setting on the app target.
<!-- /ios:packages -->

## Layout

```
app/src/main.ts      the JS entry: starts the app with its routes
app/src/routes.ts    the screens and their paths ("/" is the first one)
app/src/*.tsx        the screens
app/assets/          the app's images, for `asset:images/x.png` (make the folder when you need it)
android/             the Android host: settings.gradle.kts (zero-native as a composite build), app/
<!-- ios:cmake -->
ios/                 the iOS host: CMakeLists.txt (an Xcode project made by CMake), App/
<!-- /ios:cmake -->
<!-- ios:packages -->
ios/                 the iOS host: __APP_CLASS__.xcodeproj (on zero-native's Swift package), App/
<!-- /ios:packages -->
tools/ios.ts         build and run on the simulator
```

`--name` in the `app:js` scripts is the bundle's app name. Keep it the same as your OTA app name.

## Next

<!-- ios:cmake -->
- Plugins (camera, location, ...): `docs/guides/plugins.md` (reference: `docs/plugins.md`) in zero-native. An official plugin goes in four places:
  `package.json`, `android/settings.gradle.kts` and `android/app/build.gradle.kts`, and `APP_ZN_PLUGINS` in
  `ios/CMakeLists.txt`. Then register it in `MainApplication.kt` and `ios/App/AppDelegate.swift`.
<!-- /ios:cmake -->
<!-- ios:packages -->
- Plugins (camera, location, ...): `docs/guides/plugins.md` (reference: `docs/plugins.md`) in zero-native. An official plugin goes in four places:
  `package.json`, `android/settings.gradle.kts` and `android/app/build.gradle.kts`, and in Xcode the plugin's
  `ZnPlugin<Name>` product on the app target (Firebase and Lottie are separate packages: `ios/packages/firebase`,
  `ios/packages/lottie` in zero-native). Then register it in `MainApplication.kt` and `ios/App/AppDelegate.swift`
  (with `import ZnPlugin<Name>`).
<!-- /ios:packages -->
- OTA updates: `docs/guides/ota-updates.md` (reference: `docs/ota.md`). They are off until the host calls `ZnOta.configure`.
- Guides & reference: `docs/guides/getting-started.md`, `docs/guides/core-concepts.md`, and `docs/guides/components.md`.
