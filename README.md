# zero-native (`zn`)

A mobile framework built in 2026 from first principles. You write screens in TypeScript and TSX. They are drawn by
native **Jetpack Compose** on Android and **SwiftUI / UIKit** on iOS. Logic runs on **Hermes**, without React or React
Native at runtime. **Over-the-air updates** are part of the design, not an add-on.

It was built for, and is proven in, the ZeroBill app: a payments and cashback app used mostly on low-end Android
phones in India. Why it exists is in [story.md](story.md).

## What you get

- **TSX that compiles to native screens.** The compiler turns each screen into a binary template (drawn before JS
  starts) and Hermes bytecode. Signals update only the text or prop that changed. No virtual DOM, no diffing. See
  [docs/guides/core-concepts.md](docs/guides/core-concepts.md).
- **React Native names where they make sense.** `View`, `Text`, `Pressable`, `FlatList`, `style`, `onPress`, `Modal`,
  `StatusBar`, `Linking`, `fetch`. What is the same, renamed, different or missing is in
  [docs/guides/coming-from-react-native.md](docs/guides/coming-from-react-native.md) (and
  [docs/guides/coming-from-flutter.md](docs/guides/coming-from-flutter.md) if you come from Flutter). Unsupported style
  keys fail the build instead of being silently ignored.
- **OTA updates you can trust.** A bundle says what native code it needs (registry version, Hermes bytecode format,
  host API, native modules and their versions, per OS), and a phone only takes a bundle it can run. Bundles and
  channel pointers are signed (ECDSA P-256, with a backup key). Rollback, kill switch, staged rollout, bsdiff patches
  (Android), a launch gate for critical updates, and updates started by a silent push. See
  [docs/guides/ota-updates.md](docs/guides/ota-updates.md).
- **A self-hosted update server.** `zn-updates`: Bun, Postgres, file or Google Cloud Storage, and a web dashboard.
  Pointers are signed in your browser, so the server never holds the private key.
- **Flows that survive the app being killed.** A multi-step flow, such as a payment that leaves for a UPI app, is
  saved and resumes where it was, without running an unsafe step twice. See
  [docs/guides/data-and-networking.md](docs/guides/data-and-networking.md).
- **Plugins** with native modules, native views and native screens: scanner, document scanner, location, media,
  WebView, PDF, image viewer, Lottie, Markdown, notifications, device info, app updates, and Firebase (Crashlytics,
  Analytics, messaging, Remote Config, Performance). See [docs/guides/plugins.md](docs/guides/plugins.md).
- **Motion and gestures** that run on the UI thread: motion values, gestures, layout animation and shared elements
  (Android today; iOS planned). See [docs/guides/motion-and-gestures.md](docs/guides/motion-and-gestures.md).

## Status (2026-11-20)

- **Android:** in production. The ZeroBill app has run on zero-native on Google Play since 2026-11-10.
- **iOS:** in production. The ZeroBill iOS app is live on the App Store (matching Android for everything ZeroBill uses,
  including full-bundle OTA updates and push). See
  [docs/guides/platform-differences.md](docs/guides/platform-differences.md) for what is still Android-only.
- **Pre-1.0.** APIs can still change. Packages are not on npm, Maven Central or SwiftPM yet: you build from this
  repository. [docs/production-readiness.md](docs/production-readiness.md) lists what is left.

## Numbers we measured

On a Lava Blaze 2 5G (Android 14, MediaTek Dimensity 6020, 4 GB) unless noted. The two apps were not measured side by
side in one script, so read the notes.

| What | React Native | zero-native | Notes |
|---|---|---|---|
| Play download | 14.88 MB | 6.42 MB | zn: the v0 shell (Compose, Hermes, ML Kit, Firebase, no screens). RN with its packaging fixed is about 13.0 MB |
| Cold start of the full app | 1,147 ms | 501-510 ms | `am start` TotalTime, release builds, measured on different days; zn's first frame is at about 345 ms |
| JS in the app | 4.38 MB bundle | 1.63 MB bytecode + 0.19 MB templates | the same app |
| Native libraries | 27, 25.8 MB raw | 9-15, 10-12 MB raw | arm64 part of the APK |
| OTA update size | ~5 MB full, ~100 KB patch | ~824 KB full, 3-93 KB patch | Android; zn patches measured on six real app changes |
| Tap to screen update | not measured | p50 0.97 ms, p95 2.08 ms | v0 renderer experiment, release |

On a slow Android 9 phone (Infinix Hot 8), the 500-row transaction list scrolls smoothly from the first fling when the
app comes from Google Play (the runtime ships a baseline profile).

**iOS (2026-11-19), the sample app on an iPhone 11 (iOS, Release, arm64, release Hermes):**

| What | zero-native | Notes |
|---|---|---|
| App Store size | 4.9 MB download, 13.4 MB installed | Xcode's App Thinning Size Report, with Firebase linked |
| Without Firebase or Lottie | 7.2 MB installed, 2.8 MB zipped | every binary stripped by hand: app 2.8 MB, Hermes 2.9 MB, JS bytecode 1.3 MB. Xcode leaves 1.3 MB of symbols in Hermes |
| Cold start, first frame | 148 ms (Firebase off), 156 ms (on) | median of 10 cold launches, timed from the kernel's process start |
| Cold start, first screens up | 165 ms (off), 178 ms (on) | the screens the JS put up; the OTA check fails fast because the sample's server is localhost |

The first launch after an install takes about 200-600 ms more (iOS sets the app up once); it is left out of the
medians. The sample is small, so a full app starts later.

## Quick start

You need [Bun](https://bun.sh). For Android: Android Studio (its JDK and the Android SDK). For iOS: a Mac with Xcode 26
and CMake (`brew install cmake`).

```bash
bun install
```

```bash
bun run sample:js
```

```bash
bun run test
```

`sample:js` builds the sample app's JS (on a fresh clone it also creates `test-kit/offers-data.json` from the example,
which the type check needs). `bun run test` runs the tests and the type check, as CI does.

To start your own app outside this repo: `bun run tools/zn.ts new ../my-app`, then follow
[docs/guides/getting-started.md](docs/guides/getting-started.md).

### Android

From `android/`:

```bash
./gradlew :sample:installDebug
```

While you work on screens, `bun run dev` sends saved changes to the debug build on the phone in under a second.
Release builds (`:sample:installRelease`) are for measuring.

### iOS (simulator)

Once, download Hermes for Apple platforms (pinned by version and checksum):

```bash
bun run tools/fetch-hermes-apple.ts
```

Start a simulator:

```bash
open -a Simulator
```

Then build the sample, install it on the booted simulator and start it with its console attached:

```bash
bun run tools/ios-sample.ts
```

The first build takes about a minute. `--link zn://sample/dev/rn-props` starts on a screen by its link; the other
options (another simulator, slow animations, touch logging) are listed at the top of `tools/ios-sample.ts`. Lottie and
Firebase are optional:
`bun run tools/fetch-lottie-apple.ts`, `bun run tools/fetch-firebase-apple.ts`, and your own
`ios/Sample/GoogleService-Info.plist` (never committed); without them those plugins answer "unavailable". More in
[docs/milestones-ios.md](docs/milestones-ios.md).

To build the sample for your own iPhone, sign it with your Apple team (`-DZN_TEAM`) and use release Hermes:

```bash
bun run tools/fetch-hermes-apple.ts release
cmake -G Xcode -S ios -B ios/build/device -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos -DZN_TEAM=<your team id> -DZN_HERMES_DIR=$PWD/ios/third_party/hermes/release/destroot
xcodebuild -project ios/build/device/zn_ios.xcodeproj -target ZnSample -sdk iphoneos -configuration Release -allowProvisioningUpdates build
xcrun devicectl device install app --device <device id> ios/build/device/Release-iphoneos/ZnSample.app
```

The console prints `app: first frame … ms after the process started` and `nav: first screens up …` on each launch.

## Read next

| | |
|---|---|
| [docs/guides/getting-started.md](docs/guides/getting-started.md) | create an app and run it on Android and iOS |
| [docs/guides/core-concepts.md](docs/guides/core-concepts.md) | signals, components, JSX rules and events |
| [docs/guides/components.md](docs/guides/components.md) | built-in components and styling |
| [docs/guides/coming-from-react-native.md](docs/guides/coming-from-react-native.md) | coming from React Native |
| [docs/guides/coming-from-flutter.md](docs/guides/coming-from-flutter.md) | coming from Flutter |
| [docs/README.md](docs/README.md) | all guides, deep reference docs, and project history |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the compiler, templates and native renderers work |
| [experiments/](experiments/) | the four v0 experiments that started it |

## How it was made

zero-native was built by one engineer working with AI models, in about three weeks. The idea came from a question to
**Gemini 4 Argon**. **Gemini 3.8 Flash** ran the first experiments and later parity batches. **Claude Opus 5.5** wrote
the spec and most of the code, on Windows for Android and on a Mac for iOS. **Claude Fable** reviewed the design. Each
commit names the models that worked on it. The full story is in [story.md](story.md).

## License

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
