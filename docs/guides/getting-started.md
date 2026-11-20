# Getting Started

This guide takes you from zero to a running `zero-native` app on Android and iOS.

> **Pre-1.0 note:** `@zeronative/*` packages are being prepared for `0.1.0` on npm, Maven Central, and SwiftPM. Right now, new apps link directly to a local clone of the `zero-native` repository. Core screens, navigation, plugins, and OTA work on both Android and iOS; see [Platform Differences & Parity](platform-differences.md) for features that are Android-first today (such as `zn dev`, UI-thread gestures/motion, `<Canvas>`, `WebSocket`, and bsdiff OTA patches).

---

## 1. Prerequisites

| Tool | Required for | Notes |
|---|---|---|
| **[Bun](https://bun.sh) 1.3+** | Everyone | Runs the compiler, CLI (`zn`), tests, and update server |
| **Android Studio** (JDK 21 + Android SDK) | Android | Compiles the Kotlin/Compose runtime (AGP 9.2, Kotlin 2.4, minSdk 24) |
| **macOS + Xcode 26 + CMake** | iOS | `brew install cmake`; targets iOS 17+ |

---

## 2. Clone `zero-native` once

```bash
git clone https://github.com/zero-native/zero-native.git
cd zero-native
bun install
```

Optionally, verify everything is healthy by building the sample app and running the test suite:

```bash
bun run sample:js
bun run test
```

---

## 3. Create your app with `zn new`

From inside the `zero-native` folder, scaffold a new app outside the repo (`--name` must be lowercase letters, digits, or hyphens, starting with a letter):

```bash
bun run tools/zn.ts new ../my-app --name my-app --id com.example.myapp
cd ../my-app
bun install
```

*(Tip: you can run `bun link && bun link zero-native -g` once in the `zero-native` root so `zn` is available globally from any folder.)*

### Project structure

```
my-app/
├── app/
│   ├── src/
│   │   ├── main.ts          # Entry point: installRuntime() + startApp(routes)
│   │   ├── routes.ts        # Typed screen registry ("/" is the start screen)
│   │   ├── HomeScreen.tsx   # Example screen
│   │   └── AboutScreen.tsx  # Second screen (with deepLink: true)
│   └── assets/              # App images & fonts (create as needed)
├── android/                 # Android host (Gradle composite build → zero-native)
├── ios/                     # iOS host (CMake-generated Xcode project → zero-native)
├── tools/ios.ts             # Helper to build & launch on the iOS Simulator
└── package.json
```

Because the app references your local `zero-native` checkout by relative path in `package.json`, `android/gradle.properties`, `ios/CMakeLists.txt`, and `tools/ios.ts`, update those four if you move either folder.

---

## 4. Run on Android

Connect an Android phone (USB debugging on) or start an Android emulator, then run:

```bash
bun run android
```

This compiles your TSX into `main.zn.ui` + `main.hbc`, copies the bundle into `android/app/src/main/assets/`, and installs the debug APK. You can also open `android/` directly in Android Studio after running `bun run app:js`.

### Live reload (`zn dev`)
In the `zero-native` repo's sample app, `bun run dev` pushes saved `.tsx` edits to a debug build on Android in under a second without a Gradle rebuild. *(Note: `zn dev` has not been verified end-to-end on apps scaffolded by `zn new` yet, and is Android-only for now.)*

> **Release builds for performance testing:** Always measure cold start and scrolling on a release build (`./gradlew :app:installRelease`), never debug.

---

## 5. Run on iOS (Simulator)

On macOS, boot a simulator and run:

```bash
open -a Simulator
bun run ios
```

On the first run, this automatically downloads the pinned Hermes XCFramework for Apple platforms (`tools/fetch-hermes-apple.ts`), generates the Xcode project with CMake, builds the app, installs it on the booted simulator, and streams the console logs. The first build takes about a minute; incremental builds are much faster.

### Useful flags for `bun run ios`
- `--link my-app://app/about?from=link` — cold-start directly into a deep link
- `--device "iPhone 16"` — choose a specific booted simulator
- `--build-only` — compile without launching

### Running on a physical iPhone
First download release Hermes once inside `zero-native`:

```bash
bun run tools/fetch-hermes-apple.ts release
```

Then from **your `zn new` app folder** (replace `<AppClass>` with the Swift target name in `ios/CMakeLists.txt`, e.g., `MyApp`):

```bash
bun run app:js:ios
cmake -G Xcode -S ios -B ios/build/device \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_SYSROOT=iphoneos \
  -DAPP_TEAM=<YOUR_APPLE_TEAM_ID> \
  -DZN_HERMES_FLAVOR=release

xcodebuild -project ios/build/device/<AppClass>.xcodeproj \
  -target <AppClass> -sdk iphoneos -configuration Release \
  -allowProvisioningUpdates build

xcrun devicectl device install app --device <DEVICE_ID> \
  ios/build/device/Release-iphoneos/<AppClass>.app
```

*(For building the `zero-native` sample app itself on a physical iPhone, pass `-DZN_TEAM=<TEAM_ID>` and `-DZN_HERMES_DIR=$PWD/ios/third_party/hermes/release/destroot` against `ios/CMakeLists.txt`.)*

---

## 6. Your first screen

Here's what a real `zero-native` screen looks like:

```tsx
import { signal, computed, nav } from "@zeronative/core"
import { Column, Text, Pressable, StyleSheet } from "@zeronative/ui"

export function HomeScreen() {
  const count = signal(0)
  const label = computed(() =>
    count() === 0 ? "Tap to start" : `Tapped ${count()} times`
  )

  return (
    <Column style={s.page}>
      <Text style={s.title}>{label()}</Text>
      <Pressable style={s.button} onPress={() => count.set(count() + 1)}>
        <Text style={s.buttonText}>Increment</Text>
      </Pressable>
      <Pressable onPress={() => nav.push("about", { from: "home" })}>
        <Text style={s.link}>Go to About →</Text>
      </Pressable>
    </Column>
  )
}

const s = StyleSheet.create({
  page: { flex: 1, justifyContent: "center", alignItems: "center", gap: 16, padding: 24 },
  title: { fontSize: 22, fontWeight: 700, color: "#111827" },
  button: { backgroundColor: "#111827", paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: "#FFFFFF", fontWeight: 600 },
  link: { color: "#2563EB", fontSize: 15 },
})
```

Notice there's no `useState`, no dependency arrays, and no re-rendering. `HomeScreen` runs **once**; when `count.set(...)` is called, only the `<Text>` slot updates on the native UI thread.

---

## 7. CLI cheat sheet (`zn`)

| Command | What it does |
|---|---|
| `zn new <dir> [--name N] [--id ID]` | Scaffold a new Android + iOS app |
| `zn dev [appDir]` | Watch & live-reload JS/templates to Android debug builds |
| `zn build <appDir> --assets <dir> --name <app>` | Compile TSX + bytecode into a bundle |
| `zn release` / `zn publish` / `zn rollout` | Release & manage OTA updates via `zn-updates` |
| `zn server [--demo]` | Run a local `zn-updates` server |
| `zn where` | Print the `zero-native` checkout path |

---

## Next steps

- Read **[Core Concepts](core-concepts.md)** to master signals, JSX rules, and the gotchas that trip up React developers.
- Check **[Styling & Layout](styling-and-layout.md)** and **[Components](components.md)** to build real screens.
- Coming from another framework? Jump to **[Coming from React Native](coming-from-react-native.md)** or **[Coming from Flutter](coming-from-flutter.md)**.
