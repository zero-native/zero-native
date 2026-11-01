# Plugins: adding native features to zero-native (design, for review)

**Status: proposal (2026-10-31).** Nothing here is built yet. Decisions D1–D7 are open for Pavan; section 9 has
questions for reviewers. Android only for now; every choice must also work for iOS later.

**Why now.** The next features (QR scan, WebView, UPI apps, photos, push) each need native code, a native view or
another app's result. If each one invents its own way to plug in, apps get five different patterns and OTA safety
breaks somewhere. So first one plugin system, then the features as plugins on top of it.

**Words used here.**
- *Plugin*: a package that adds a native feature: a TS API plus native code (an Android library).
- *Native module*: native functions JS can call, with events back (built: `docs/native-modules.md`).
- *Native view*: a native UI piece placed inside a zn screen (a camera preview, a WebView, a map).
- *Native screen*: a whole screen written natively (Compose), opened like any route.
- *Core*: `@zero-native/core` + `@zero-native/ui` + the Android runtime. *App*: e.g. ZeroBill.

---

## 1. What is built today

| Piece | State | Where |
|---|---|---|
| Native modules: typed `nativeModule<T>("Name", { version })`, async calls, cancellation, events with listener counts, error codes, binary data | **built** (2.6a, 3.4) | `docs/native-modules.md`, `ZnModules.kt` |
| Module versions in every bundle's `requires.modules`; an app without the module (or with an older version) ignores the bundle | **built** (4.x) | `compiler/src/plugin.ts`, `ZnCapabilities.kt` |
| The compiler finds `nativeModule("X", { version })` in any imported file, packages included | **built** | `compiler/src/modules.ts` |
| `zn://` handles: native resources (images, files) reach JS as a short string, never as bytes | **decided, not built** (the renderer takes bundle assets and http(s) URLs today) | ARCHITECTURE §15.4 |
| Android merges a library's `AndroidManifest.xml` (permissions, providers, activities) into the app | Android does it | — |
| `<NativeView>` | **designed, not built** | ARCHITECTURE §15.2 |
| Native screens as routes | **designed, not built** | ARCHITECTURE §15.3 |
| Permissions, "open another app and get its result" | **not built** (was step 2.6b) | — |
| Codegen (Kotlin interface from the TS interface) | **not built** | ARCHITECTURE §15.1 |

So the call path, versions and OTA safety exist. What is missing is the *package* around them, a way for native
code to put **views** and **screens** into the UI, and the shared Android plumbing (permissions, results).

## 2. How others do it (short)

- **React Native.** A library is an npm package with `android/` and `ios/` folders. *Autolinking* (the CLI reads the
  app's `package.json` dependencies) adds the Gradle project and registers the package; no app code. Native modules
  (TurboModules) and native views (Fabric components) get typed glue from *codegen* (a TS / Flow spec).
- **Expo Modules API.** Same package idea, plus a small Kotlin / Swift DSL (`Module { Name(...); Function(...);
  View(...) }`) that makes modules and views short to write. *Config plugins* edit the native project at build time
  (needed because Expo apps often have no native folder checked in).
- **Flutter.** Plugins are declared in `pubspec.yaml`; a generated `GeneratedPluginRegistrant` registers them. Calls
  go over *platform channels* (Pigeon generates typed glue). Native views are *platform views*, which cost extra
  because Flutter draws its own UI and must mix in Android views. "Federated" plugins split the API package from
  each platform's implementation.

What we take: **one package with TS + native folders** (all three), **generated registration** (RN autolinking,
Flutter's registrant), **a short Kotlin DSL** (Expo). What we skip for now: config plugins (we always have a native
project and Android merges manifests), federated packages (one team, one platform today).

Our advantage: zero-native screens are Compose already, so a native view is just another composable in the same tree.
No texture copies or separate layers like Flutter's platform views.

## 3. What a plugin is

```
@zero-native/scanner/
  package.json          "zeroNative": { "android": { "plugin": "dev.zeronative.scanner.ScannerPlugin" } }
  src/index.ts          the TS API: nativeModule<ScannerModule>("Scanner", { version: 1 }), <QrScanner /> component
  android/              an Android library: Kotlin code, AndroidManifest.xml (CAMERA permission), R8 keep rules
  test/                 JS tests with the core's fake host
  README.md             what it needs (permissions, size it adds, Android versions)
```

**The native entry point.** Each plugin has one class the app (or the generated file, D1) calls once at start:

```kotlin
class ScannerPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(ScannerModule())                          // native module "Scanner" v1 (ZnModuleBase, as today)
        r.view("scanner.qr") { ctx -> QrScannerView(ctx) } // a native view (section 4)
        r.screen("scanner.full") { ScannerScreen(it) }     // a native screen (section 5)
    }
}
```

**JS-only plugins** (a date picker built from zn components, a formatting library) are plain TS packages that import
`@zero-native/core` / `ui`. Nothing special; they go through OTA like app code.

**OTA rule for plugins** (same as for any native module today). The plugin's **TS ships in the bundle** (OTA can change
it); its **native code ships in the APK** (only a store release changes it). The TS says which module version it
needs; an app whose APK has an older plugin ignores the bundle. So plugin authors:
- **Do:** raise the module version when the TS starts using a new native function, view or event.
- **Don't:** remove or change a native function's meaning in a newer plugin version: older bundles still call it
  (add-only, like saved data formats).

## 4. Native views: `<NativeView>`

```tsx
// Inside the plugin's TS (apps use the friendly wrapper, not NativeView directly):
export function QrScanner(p: { onCode: (code: string) => void; torch?: boolean; style?: Style }) {
  return <NativeView name="scanner.qr" props={{ torch: p.torch ?? false }}
                     onEvent={(e) => e.name === "code" && p.onCode(e.data as string)} style={p.style} />
}
```

- **Native side:** a factory per name returns a Compose composable (or a classic Android View, wrapped with
  `AndroidView`). It gets the current props, sends events with `emit(name, data)`, and hears lifecycle: on screen /
  off screen, app in front / in back (a camera must stop when the screen is covered).
- **Props** go through the normal slot path as one JSON value (changes coalesce per tick like any prop). **Events**
  go through the normal event path. **Size** comes from `style` like any zn node (Compose measures it).
- **Unknown name** (an older APK, a missing plugin): native draws an empty box of the given size and reports one error.
  This should not happen in practice: the wrapper uses the plugin's `nativeModule`, so the bundle requires the module
  and an app without it never runs the bundle. **Views belong to their module's version** (D3): no new field in
  `requires`, no change to the signed format.
- **Registry:** `NativeView` is one new registry component (`REGISTRY_VERSION` 9). After that, new plugin views need
  no registry change.
- **Imperative calls** (start / stop the camera, `webview.reload()`): through the plugin's native module with the
  view's handle (`Scanner.setTorch({ view, on })`), not new view APIs. Keeps one call path.

## 5. Native screens as routes

```ts
// routes.ts
scan: { path: "/scan", native: "scanner.full" },
// a screen: open it and wait for its answer
const result = await nav.pushForResult("scan")        // { code: "upi://pay?..." } or null if the user went back
```

- It joins the same back stack, transitions, Back handling and `restore` rules as zn screens. Its result comes back
  as a promise; Back gives `null`.
- **After the process is killed while it is open:** the screen comes back (it is a route), but the JS that awaited it
  is gone. Rule: a result after a restore arrives as an event the app subscribes to at start
  (`onNavResult("scan", ...)`), like Android's own Activity Result API. Apps that move money keep using save-then-verify
  (guide notes §16): the result is never the only record.

## 6. Shared plumbing every plugin needs (core, not a plugin)

| Piece | What | Why in core |
|---|---|---|
| **Permissions** | `Permissions.request(["camera"])` → `granted` / `denied` / `blocked` ("don't ask again": open settings) + `status()` | Every camera / location / contacts plugin needs the same flow; Android's API is tied to the Activity |
| **Open another app and get its result** | `launchForResult({ action, uri, package })` → `{ resultCode, data }`, also after a process kill (delivered at start, see 5) | UPI, document pickers, KYC SDKs. The hard part (the process dying while the other app is open) must be solved once |
| **Activity events for plugins** | `onActivityResult`, `onNewIntent`, front / back, low memory | Plugins must not ask the app's Activity for hooks one by one |
| **`zn://` handles for media** | Photos, PDFs, video stay native; JS gets a handle; `<Image src="zn://...">` shows it | Decided (§15.4), not built; plugins hand out handles, so the handle table belongs in core (built with P.2) |
| **Background JS** | Run a registered JS task without a screen (FCM message, WorkManager job), with a time limit | Push and sync need it; it changes how the runtime starts, so core |

The old step 2.6b splits along this line: `launchActivity` with results and permissions → **core** (above); `Os`
small methods (app version, share sheet, open settings) → **core**; `Os.upiApps` + launching a UPI app → the **`upi`
plugin**.

## 7. Official plugins and other production items

| Item | Core or plugin | Notes |
|---|---|---|
| UPI apps: list installed UPI apps (with icons), launch one with a `upi://pay` link, get the result | plugin `@zero-native/upi` | First plugin: proves modules + results + `zn://` icons; checkout needs it |
| QR scan / camera | plugin `@zero-native/scanner` | Native view + native screen. ML Kit **bundled**, not downloaded from Play (fails on low-storage phones) |
| WebView | plugin `@zero-native/webview` | Native view; cookies per app, file upload, `postMessage` both ways, which links leave the app |
| Photos / files / PDF | plugin `@zero-native/media` | Pick, compress, crop, rotate natively; JS sees `zn://` handles |
| Push (FCM) | plugin `@zero-native/push` on top of core background JS | Token, messages in front / back, tap to open a route |
| Screenshot blocking | core: route option `secure: true` | `FLAG_SECURE` while that screen is on top |
| Certificate pinning | core: `fetch` option / app config | OkHttp `CertificatePinner`; needs a pin-rotation plan |
| Dark mode, low memory, right-to-left | core | Colour tokens with light / dark values; `onTrimMemory` clears caches; `start` / `end` already exist |
| Maps, video, charts | plugins, later | When an app needs them |

## 8. Decisions

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How does the app pick up a plugin's native side? | (a) by hand: Gradle dependency + `ZnPlugins.register(ScannerPlugin())` in Application; (b) a Gradle plugin reads the app's `package.json`, adds the libraries and generates `ZnPluginsGenerated.kt` (autolinking); (c) (a) now, (b) later | **(c)**: by hand while there are 1–3 plugins and one app; autolinking once a second app or an outside author shows up. The `ZnPlugin` interface is the same either way |
| D2 | How are plugin modules written in Kotlin? | (a) today's `ZnModuleBase` with `function("x") { call -> }`; (b) codegen from the TS interface (typed Kotlin args); (c) an Expo-style DSL | **(a) now**, plus small typed helpers for args. Codegen when the first plugin has >10 functions or an outside author |
| D3 | How are native views versioned for OTA? | (a) each view belongs to its plugin's module version; (b) a new `requires.views` field | **(a)**: no change to the signed `requires` format; a view's props / events change ⇒ raise the module version |
| D4 | Native screens: API for results | (a) `nav.pushForResult(route)` promise + `onNavResult` after restore; (b) only events | **(a)**: the promise is what authors expect; the event covers the process-kill case |
| D5 | Where do official plugins live? | (a) this repo, `plugins/<name>/`, released with core; (b) separate repos | **(a)**: one version line with core, one CI, the sample app uses them. Split later if outsiders contribute |
| D6 | How does a plugin say which core it needs? | (a) `peerDependencies` on `@zero-native/core` + a Gradle dependency on the runtime with a version range; (b) a host API number in `package.json` | **(a)** for both sides; core's host API check already guards the JS ↔ native contract at run time |
| D7 | UPI: core or plugin? | (a) plugin; (b) core | **(a)**: only payment apps need it; it is also the best first test of the plugin system |

## 9. Proposed steps (after the decisions)

| Step | What | Done when |
|---|---|---|
| P.1 | `ZnPlugin` + `ZnPluginRegistry`, `plugins/` folder, D1 (a); the sample's `DeviceModule` moved into a test plugin | The sample works with the module registered through a plugin; guide notes "writing a plugin" |
| P.2 | Core plumbing: permissions, `launchForResult` (with the process-kill case), Activity events for plugins, `zn://` handles | Phone tests: grant / deny / "don't ask again"; a result delivered after the process was killed in the other app; an app icon shown from a `zn://` handle |
| P.3 | `@zero-native/upi` | Lists UPI apps with icons, launches the mock UPI app, result back; also after a kill |
| P.4 | `<NativeView>` (registry 9) + `@zero-native/scanner` (view + native screen, `pushForResult`) | QR scan on the Lava; camera stops when covered; release build size measured |
| P.5 | Background JS + `@zero-native/push` | A push in background runs a JS task; tap opens a route |
| P.6 | `webview`, `media`, and core items (secure screens, pinning, dark mode, low memory, RTL) | As ZeroBill needs them |

P.3 unblocks the ZeroBill checkout pilot (old 2.8 + milestone 5), planned separately.

## 10. Questions for reviewers

1. Is "views belong to their module's version" (D3) safe enough, or will plugin authors forget to raise the version
   when only a view's props change? Would a build-time check (compare the plugin's view prop types against the last
   release) be worth it?
2. `launchForResult` after a process kill: is delivering the result as an event at the next start (plus
   save-then-verify for money) the right model, or should the framework keep a pending-results queue in FlowStore?
3. Manual registration first (D1 (c)): any reason to build autolinking before the second app?
4. Is anything missing from the core plumbing list (section 6) that most plugins end up needing (foreground services,
   app links, biometrics, the SMS retriever)?
5. For a payments app: which plugins must be reviewed or pinned harder (WebView loading third-party pages, scanner
   parsing untrusted QR text)?
