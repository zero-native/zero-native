# zero-native (`zn`)

A mobile app framework built from first principles for **speed, small binary size, and safe over-the-air updates**.

You write screens in **TypeScript and TSX**. The compiler turns each screen into a **binary UI template** (drawn natively before JavaScript even starts) and **Hermes bytecode**. On Android, screens are rendered by **Jetpack Compose**; on iOS, by **SwiftUI and UIKit**. There is **no React, no virtual DOM, and no Yoga** at runtime.

Proven in production in the ZeroBill payments app (Google Play; iOS submitted for App Store review as of 2026-11-18). Read the origin story in [story.md](story.md).

---

## Why zero-native?

- **Compiled templates + fine-grained signals.** Components run once. Reactive expressions compile into integer slot IDs that update only the exact leaf text or style that changed — no tree diffing, no re-renders.
- **Native UI all the way down.** Compose on Android, SwiftUI + UIKit on iOS. Native text input, scrolling, sheets, safe areas, back gestures, and haptics come from the OS itself.
- **Familiar React Native names.** `View`, `Text`, `Pressable`, `FlatList`, `Modal`, `StatusBar`, `StyleSheet`, `Linking`, `fetch` — with loud build-time errors whenever a prop or style key isn't supported.
- **Contract-based OTA updates.** Every bundle declares the exact native capabilities it needs (`requires.registry`, `requires.hostApi`, `requires.bytecode`, and per-OS plugin versions). Phones refuse incompatible bundles automatically. Signed with ECDSA P-256, with bsdiff patches (Android), staged rollouts, automatic crash rollback, a launch gate for critical updates, and a self-hosted dashboard (`zn-updates`) where channel pointers are signed in your browser.
- **Crash-safe flows.** `FlowStore` (memory-mapped two-slot storage) and `restorableSignal` keep multi-step journeys (like payments that jump to another app) safe when the OS kills your app in the background.
- **UI-thread motion & gestures.** Declarative `animate` / `enter` / `exit` transitions plus UI-thread motion values, gestures, shared elements, and compile-time `derive()` formulas (no JS on the UI thread).
- **20 official plugins.** QR/barcode scanner, document scanner, PDF, WebView, image viewer, Lottie, Markdown, location, media, local notifications, device info, store updates, and Firebase (Crashlytics, Analytics, Messaging, Remote Config, Performance).

---

## Measured performance

### Android — Lava Blaze 2 5G (Android 14, MediaTek Dimensity 6020, 4 GB RAM)

*The two apps were not measured side by side in one script; read the notes column for context.*

| Metric | React Native | zero-native | Notes |
|---|---:|---:|---|
| Google Play download | 14.88 MB | **6.42 MB** | zn: v0 shell (Compose, Hermes, ML Kit, Firebase, no screens). Optimized RN is ~13.0 MB |
| Cold start (full app) | 1,147 ms | **501–510 ms** | `am start` TotalTime, release builds, measured on different days; zn first frame at ~345 ms |
| JS shipped in app | 4.38 MB bundle | **1.63 MB** bytecode + **0.19 MB** templates | Same production app |
| Native `.so` libraries | 27 (25.8 MB raw) | **9–15** (10–12 MB raw) | `arm64-v8a` slice of APK |
| OTA update size | ~5 MB full, ~100 KB patch | **~824 KB** full, **3–93 KB** patch | Android; zn patches measured across six real app changes on one app |
| Tap → screen update | — | **p50 0.97 ms**, p95 2.08 ms | v0 renderer experiment, release build |

### iOS — iPhone 11 (Release, arm64, release Hermes, sample app)

| Metric | zero-native | Notes |
|---|---:|---|
| App Store size | **4.9 MB** download (13.4 MB installed) | Xcode App Thinning report, with Firebase linked |
| Core size (no Firebase/Lottie) | **2.8 MB** zipped (7.2 MB installed) | Stripped binaries: app 2.8 MB, Hermes 2.9 MB, bytecode 1.3 MB |
| Cold start (first frame) | **148–156 ms** | Median of 10 cold launches from kernel process start (Firebase off / on) |
| Cold start (first screens up) | **165–178 ms** | Includes JS boot and initial screen mount |

---

## Status

- **Pre-1.0.** APIs may still evolve before `1.0.0`.
- **Android:** Production-ready and live on Google Play.
- **iOS:** Matches Android for core screens, navigation, push, full-bundle OTA updates, and 14 of 20 plugins. Some newer Android features (`zn dev`, UI-thread gestures/motion, `<Canvas>`, `WebSocket`, bsdiff patches, custom fonts, and runtime layout slots) are still being ported — see [Platform Differences & Parity](docs/guides/platform-differences.md).
- **Packages:** `@zeronative/*` packages are being prepared for `0.1.0` on npm, Maven Central, and SwiftPM. Today, apps build directly against a local checkout of this repository.

---

## Quick start

**Prerequisites:** [Bun](https://bun.sh) (1.3+). For Android: Android Studio (JDK 21 + Android SDK). For iOS: macOS with Xcode 26 and CMake (`brew install cmake`).

```bash
# 1. Clone and install dependencies
git clone https://github.com/zero-native/zero-native.git
cd zero-native
bun install

# 2. Build the sample app's JS bundle and run tests
bun run sample:js
bun run test
```

### Run the sample on Android
```bash
cd android
./gradlew :sample:installDebug
```
In another terminal from the repo root, start live reload (pushes saved edits to the phone in under a second):
```bash
bun run dev
```

### Run the sample on iOS (Simulator)
```bash
# One-time: download Hermes for Apple platforms
bun run tools/fetch-hermes-apple.ts

# Boot a simulator, then build and launch the sample
open -a Simulator
bun run tools/ios-sample.ts
```

### Create your own app
```bash
bun run tools/zn.ts new ../my-app
cd ../my-app
bun install
bun run android   # or: bun run ios
```

For full setup instructions (including physical iPhones and `zn` CLI commands), see **[Getting Started](docs/guides/getting-started.md)**.

---

## Documentation

| Guide | What you'll learn |
|---|---|
| **[Docs Home](docs/README.md)** | Full documentation index (guides, deep reference, and project history) |
| **[Getting Started](docs/guides/getting-started.md)** | Install, create an app, run on Android & iOS, live reload |
| **[Core Concepts](docs/guides/core-concepts.md)** | Signals, once-run components, JSX rules, control flow, events |
| **[Styling & Layout](docs/guides/styling-and-layout.md)** | `style` props, fixed modifier order, flex rules, safe areas, dark mode |
| **[Components](docs/guides/components.md)** | `View`, `Text`, `Pressable`, `TextField`, `OtpInput`, `List`, `Sheet`, `Svg`, `Canvas`, and more |
| **[Navigation](docs/guides/navigation.md)** | Typed routes, stack actions, tabs, deep links, back handling, process restoration |
| **[Data & Networking](docs/guides/data-and-networking.md)** | `fetch`, `WebSocket`, `storage` (MMKV), `SecureStore`, crash-safe `FlowStore` |
| **[Motion & Gestures](docs/guides/motion-and-gestures.md)** | `animate`, `enter`/`exit`, UI-thread motion values, `derive()`, gestures, shared elements |
| **[OTA Updates](docs/guides/ota-updates.md)** | Contract-based bundles, ECDSA signing, rollouts, rollback, `zn-updates` server |
| **[Plugins](docs/guides/plugins.md)** | 20 official plugins + writing custom native modules, views, and screens |
| **[Coming from React Native](docs/guides/coming-from-react-native.md)** | What matches, what's renamed, and the four mental shifts |
| **[Coming from Flutter](docs/guides/coming-from-flutter.md)** | Mapping widgets, state, lists, navigation, and native OTA |
| **[Platform Differences](docs/guides/platform-differences.md)** | Honest Android vs. iOS parity matrix and behavior differences |
| **[Architecture](ARCHITECTURE.md)** | How the compiler, binary templates, C++ core, and native renderers fit together |
| **[Contributing](docs/guides/contributing.md)** | Working on the framework, tests, and OTA-safe registry rules |

---

## How it was built

zero-native was built by Pavan collaborating with AI models (**Gemini 4 Argon**, **Gemini 3.8 Flash**, **Claude Opus 5.5**, and **Claude Fable**). The origin story and early experiments live in [story.md](story.md) and [experiments/](experiments/).

## License

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
