# __APP_TITLE__

A [zero-native](https://github.com/zero-native/zero-native) app, made by `zn new`. Screens are TSX in `app/src/`.
They are drawn by Jetpack Compose on Android and SwiftUI / UIKit on iOS.

zero-native isn't published yet, so this app builds against a local checkout: `__ZN_DIR__` (from this folder).
It is named in four places: `package.json`, `android/gradle.properties`, `ios/CMakeLists.txt` and
`tools/ios.ts`. If you move the app or zero-native, change all four.

## Set up

Once, in zero-native: `bun install`. Then here:

```bash
bun install
```

## iOS (simulator)

You need a Mac with Xcode 26 and CMake (`brew install cmake`). Start a simulator (`open -a Simulator`), then:

```bash
bun run ios
```

It builds the JS, builds the app, installs it on the booted simulator and starts it with its console attached. The
first build takes about a minute. The first run also downloads Hermes into zero-native
(`tools/fetch-hermes-apple.ts`). `bun run ios --link __APP_NAME__://app/about?from=link` opens the second screen by
its link.

## Android

You need Android Studio (its JDK and the Android SDK) and a phone or emulator on adb. Then:

```bash
bun run android
```

It builds the JS into `android/app/src/main/assets` and installs the debug build. You can also open `android/` in
Android Studio, after `bun run app:js`. `bun run dev` (live reload to the debug build) is
not tried from an app made by `zn new` yet.

## Layout

```
app/src/main.ts      the JS entry: starts the app with its routes
app/src/routes.ts    the screens and their paths ("/" is the first one)
app/src/*.tsx        the screens
app/assets/          the app's images, for `asset:images/x.png` (make the folder when you need it)
android/             the Android host: settings.gradle.kts (zero-native as a composite build), app/
ios/                 the iOS host: CMakeLists.txt (an Xcode project made by CMake), App/
tools/ios.ts         build and run on the simulator
```

`--name` in the `app:js` scripts is the bundle's app name. Keep it the same as your OTA app name.

## Next

- Plugins (camera, location, ...): `docs/plugins.md` in zero-native. An official plugin goes in four places:
  `package.json`, `android/settings.gradle.kts` and `android/app/build.gradle.kts`, and `APP_ZN_PLUGINS` in
  `ios/CMakeLists.txt`. Then register it in `MainApplication.kt` and `ios/App/AppDelegate.swift`.
- OTA updates: `docs/ota.md`. They are off until the host calls `ZnOta.configure`.
- How each feature works: `docs/guide-notes.md`. An app outside the repo: its §34.
