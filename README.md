# zero-native (`zn`)

A mobile framework built in 2026 from first principles. You write screens in TypeScript and TSX. They are drawn by
native **Jetpack Compose** on Android and **SwiftUI / UIKit** on iOS. Logic runs on **Hermes**, without React or React
Native at runtime. **Over-the-air updates** are part of the design, not an add-on.

It was built for, and is proven in, the ZeroBill app: a payments and cashback app used mostly on low-end Android
phones in India. Why it exists is in [story.md](story.md).

## What you get

- **TSX that compiles to native screens.** The compiler turns each screen into a binary template (drawn before JS
  starts) and Hermes bytecode. Signals update only the text or prop that changed. No virtual DOM, no diffing.
- **React Native names where they make sense.** `View`, `Text`, `Pressable`, `FlatList`, `style`, `onPress`, `Modal`,
  `StatusBar`, `Linking`, `fetch`. What is the same, renamed, different or missing is listed in
  [docs/rn-compatibility.md](docs/rn-compatibility.md). An unsupported style key is a build error, not a silent no-op.
- **OTA updates you can trust.** A bundle says what native code it needs (registry version, Hermes bytecode format,
  host API, native modules and their versions, per OS), and a phone only takes a bundle it can run. Bundles and
  channel pointers are signed (ECDSA P-256, with a backup key). Rollback, kill switch, staged rollout, bsdiff patches,
  a launch gate for critical updates, and updates started by a silent push. See [docs/ota.md](docs/ota.md).
- **A self-hosted update server.** `zn-updates`: Bun, Postgres, file or Google Cloud Storage, and a web dashboard.
  Pointers are signed in your browser, so the server never holds the private key. See
  [docs/zn-updates-server.md](docs/zn-updates-server.md).
- **Flows that survive the app being killed.** A multi-step flow, such as a payment that leaves for a UPI app, is
  saved and resumes where it was, without running an unsafe step twice.
- **Plugins** with native modules, native views and native screens: scanner, document scanner, location, media,
  WebView, PDF, image viewer, Lottie, Markdown, notifications, device info, app updates, and Firebase (Crashlytics,
  Analytics, messaging, Remote Config, Performance). See [docs/plugins.md](docs/plugins.md).
- **Motion and gestures** that run on the UI thread: motion values, gestures, layout animation and shared elements.
  See [docs/motion.md](docs/motion.md).

## Status (2026-11-18)

- **Android:** in production. The ZeroBill app has run on zero-native on Google Play since 2026-11-10.
- **iOS:** the runtime matches Android for everything the ZeroBill app uses, including OTA updates and push. The
  ZeroBill iOS app was in App Store review when this was written.
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
| OTA update size | ~5 MB full, ~100 KB patch | ~824 KB full, 3-93 KB patch | zn patches measured on six real app changes |
| Tap to screen update | not measured | p50 0.97 ms, p95 2.08 ms | v0 renderer experiment, release |

On a slow Android 9 phone (Infinix Hot 8), the 500-row transaction list scrolls smoothly from the first fling when the
app comes from Google Play (the runtime ships a baseline profile).

**iOS (2026-11-19):** the sample app built for a device (Release, arm64, release Hermes, no Firebase or Lottie,
stripped as an App Store build would be) is **7.2 MB installed, 2.8 MB zipped**: the app binary (runtime, plugins, C++
core) 2.8 MB, Hermes 2.9 MB, the sample's JS bytecode 1.3 MB. No App Store download size or cold start has been
measured on an iPhone yet.

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

## Read next

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | the spec and the decision log |
| [docs/README.md](docs/README.md) | all docs, in reading order |
| [docs/guide-notes.md](docs/guide-notes.md) | how to use each feature: do, don't, why |
| [docs/rn-compatibility.md](docs/rn-compatibility.md) | coming from React Native |
| [docs/milestones.md](docs/milestones.md) | how it was built, step by step, with every measurement |
| [docs/second-opinions.md](docs/second-opinions.md) | the judgment calls, written up for review |
| [experiments/](experiments/) | the four v0 experiments that started it |

## How it was made

zero-native was built by one engineer working with AI models, in about three weeks. The idea came from a question to
**Gemini 4 Argon**. **Gemini 3.8 Flash** ran the first experiments and later parity batches. **Claude Opus 5.5** wrote
the spec and most of the code, on Windows for Android and on a Mac for iOS. **Claude Fable** reviewed the design. Each
commit names the models that worked on it. The full story is in [story.md](story.md).

## License

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
