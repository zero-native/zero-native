# Plugins & Native Modules

`zero-native` keeps the core runtime small by shipping optional native features as **plugins**. If your app doesn't include a plugin, it pays **0 bytes** — and the OTA capability manifest automatically tracks every plugin your bundle uses so older app binaries never crash from a missing native module.

---

## 1. Official Plugins

All 20 official plugins live under `plugins/` with individual READMEs for detailed API docs. (14 have native implementations on both Android and iOS; 6 are Android-only or pure-JS.)

| Plugin | Android | iOS | What it provides |
|---|:---:|:---:|---|
| `@zeronative/scanner` | ✅ | ✅ | QR & barcode scanner (`<QrScanner>`, CameraX + bundled ML Kit / AVFoundation) with stale-frame protection |
| `@zeronative/document-scanner` | ✅ | ✅ | Paper document camera scanner with edge detection & process-kill recovery |
| `@zeronative/pdf` | ✅ | ✅ | Native PDF viewer & downloader (PdfRenderer / PDFKit) |
| `@zeronative/webview` | ✅ | ✅ | Embedded web view (`<WebView>`) with navigation interception & origin-checked JS bridge |
| `@zeronative/image-viewer` | ✅ | ✅ | Full-screen zoomable photo viewer (`ImageViewer.open(...)`) |
| `@zeronative/lottie` | ✅ | ✅ | Lottie animations (`lottie-react-native` API) |
| `@zeronative/markdown` | ✅ (JS) | ✅ (JS) | Pure-JS Markdown rendered as native `<Text>` & layout components |
| `@zeronative/location` | ✅ | ✅ | GPS coordinates & geocoding |
| `@zeronative/media` | ✅ | — | Photo/file picker, camera capture, native resize/compress/crop |
| `@zeronative/notifications` | ✅ | ✅ | Local notifications, scheduling, action buttons, channels/threads (Notifee-like API) |
| `@zeronative/device-info` | ✅ | ✅ | Device model, OS version, app version, build number (`react-native-device-info` style) |
| `@zeronative/app-updates` | ✅ | ✅ | Store update prompts (Google Play In-App Updates on Android; App Store link on iOS) |
| `@zeronative/android-play-auth` | ✅ | stub | Android phone number hint & SMS Retriever autofill (returns unavailable on iOS) |
| `@zeronative/android-ad-id` | ✅ | — | Google Advertising ID for attribution |
| `@zeronative/firebase-app` | ✅ | ✅ | Shared Firebase base required by Firebase plugins |
| `@zeronative/firebase-crashlytics` | ✅ | ✅ | JS & native crash reporting |
| `@zeronative/firebase-analytics` | ✅ | ✅ | Event & user property analytics |
| `@zeronative/firebase-messaging` | ✅ | ✅ | FCM / APNs push tokens, topics, data messages, native OTA-check push |
| `@zeronative/firebase-remote-config` | ✅ | — | Remote Config fetch & activation |
| `@zeronative/firebase-perf` | ✅ | — | Network & custom performance traces |

---

## 2. Adding an Official Plugin to Your App

While building from a local `zero-native` checkout, wire a plugin in four places:

1. **JS (`package.json`):** Add `"@zeronative/<name>": "link:../zero-native/plugins/<name>"` and run `bun install`.
2. **Android (`android/settings.gradle.kts` + `android/app/build.gradle.kts`):** In a `zn new` app, add a `dependencySubstitution` entry in `settings.gradle.kts` mapping `dev.zeronative:plugin-<name>` to `:plugin-<name>`, then add `implementation("dev.zeronative:plugin-<name>")` in `app/build.gradle.kts`.
3. **iOS (`ios/CMakeLists.txt`):** Add the plugin folder name to `APP_ZN_PLUGINS` (or select `ZnPlugin<Name>` when using SwiftPM).
4. **Register at startup:** Register the plugin in Android `MainApplication.kt` and iOS `AppDelegate.swift` (`ZnPlugins.register(...)`).

---

## 3. Core Plumbing Every Plugin Shares

Common OS primitives are built directly into `@zeronative/core`:

- **Permissions:** `Permissions.status(["camera"])` and `Permissions.request(["location"])` (both take arrays of permission names and return a map of `"granted" | "denied" | "blocked"`).
- **Opening external apps for a result:** `launches` (survives Android process death).
- **Links & sharing:** `Linking.openURL(...)`, `Share.share(...)`.
- **Clipboard, haptics, vibration, OS info:** `Clipboard`, `Os`, `Vibration`, `Platform`, `Dimensions`.
- **Background JS tasks:** `defineTask("my.task", async (data) => ...)` runs headless JS in your bundle with a time limit without a screen mounted. *(For FCM push messages, use `Push.onMessage` from `@zeronative/firebase-messaging`, which wires the `push.message` task automatically.)*

---

## 4. Writing Your Own Plugin

A plugin is a package with a `zeroNative` block in `package.json` (declaring `platforms` and `android.plugin`) and native code on Android and/or iOS (views and screens are registered natively inside `register(r)`). Module names should start with the package's first word, and module versions follow **add-only versioning** (increment `version` whenever you add a method; never break existing methods).

### A. Native Modules (JS ↔ Kotlin / Swift)
Declare a typed proxy handle in TypeScript using `nativeModule`:

```ts
import { nativeModule } from "@zeronative/core"

interface MyPaymentsModule {
  startUpi(args: { uri: string }): Promise<{ status: string }>
  events: { statusChanged: { status: string } }
}

// The compiler records "MyPayments" version 1 in zn-bundle.json automatically
export const MyPayments = nativeModule<MyPaymentsModule>("MyPayments", { version: 1 })

// Call methods directly on the proxy:
const res = await MyPayments.startUpi({ uri: "upi://pay?..." })
```

- **Android:** Subclass `ZnModuleBase("MyPayments", version = 1)` and register it from your `ZnPlugin`'s `register(r)` (`r.module(...)`), then register the plugin in `MainApplication.kt`.
- **iOS:** Conform to `ZnPlugin`, implement `register(_ r: ZnPluginRegistry)` calling `r.module(...)` / `r.view(...)` / `r.screen(...)`, and register the plugin via `ZnPlugins.register(...)` in `AppDelegate.swift`.

### B. Native Views (`<NativeView>`)
Plugins can expose custom native views (Compose composables, Android Views, or UIKit/SwiftUI views) via `r.view("plugin.viewName", ...)` and wrap them in a clean TSX component (for example, `@zeronative/scanner` wraps `<NativeView name="scanner.qr" />` in `<QrScanner onScan={...} />`):

```tsx
import { NativeView } from "@zeronative/ui"

<NativeView
  name="scanner.qr"
  style={{ width: "100%", height: 300 }}
  props={{ torch: torchOn() }}
  onEvent={(e) => {
    if (e.name === "scanned") handleQr(e.data.value)
  }}
/>
```

- `name` must be a string literal so the compiler verifies the plugin is installed and records it in the OTA capability manifest. Always give `<NativeView>` an explicit size in `style`.

### C. Native Screens (Routes)
Plugins can register full native screens via `r.screen("myplugin.picker", ...)` and expose them as routes:

```ts
export const routes = defineRoutes({
  picker: { path: "/picker", native: "myplugin.picker" },
})
```

For screens that return a result, use `nav.pushForResult(...)` / `onNavResult(...)`. *(For official plugins with helper APIs — such as `ImageViewer.open({ images, imageIndex })` — use the plugin's API rather than pushing its internal route directly.)*
