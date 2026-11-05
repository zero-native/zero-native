# Plugins: adding native features to zero-native (design, for review; built)

**Status (2026-11-04): P.1 to P.6 are built** (tables in sections 1 and 9): the plugin entry point and typed arg helpers
(P.1), the plumbing (P.2: permissions, results from other apps), an app outside this repo with its own plugin (P.3),
native screens and `<NativeView>` (P.3b to P.4b), background JS tasks and the core items (P.5, P.6), and the official
plugins `auth`, `scanner`, `media`, `webview`, `pdf`, `location`, `firebase-app`, `crashlytics`, `push`, `analytics`,
`remote-config`, `perf`, `lottie`, `document-scanner` and `image-viewer` (2026-11-05). Not built: codegen, `zn://mem`, certificate pinning, iOS. Parts below that are written as
design keep their original wording; the tables say what is built. Decisions D1–D7 were taken on 2026-11-02 (section 8);
section 10 has the questions for reviewers. Android only for now; every choice must also work for iOS later.

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
| Plugin entry point: `ZnPlugin`, `ZnPluginRegistry` (`module`, `requireHostApi`), `ZnPlugins.register`; typed arg helpers | **built** (P.1); `view` and `screen` built 2026-11-03 | `ZnPlugins.kt`, `ZnModules.kt`, `docs/guide-notes.md` §30 |
| `zn://` handles: native resources (images, files) reach JS as a short string, never as bytes | **built** (P.2): `zn://app-icon/<package>` and a table of kinds, loaded off the main thread. `zn://file` built 2026-11-03 (only `cacheDir/zn-files`); `zn://mem` not built | `ZnHandles.kt`, ARCHITECTURE §15.4 |
| Android merges a library's `AndroidManifest.xml` (permissions, providers, activities) into the app | Android does it | — |
| `<NativeView>` | **built** 2026-11-03 (registry 9) | `ZnNativeViews.kt`, ARCHITECTURE §15.2, `docs/guide-notes.md` §35 |
| Native screens as routes | **built** 2026-11-03 | `ZnNavHost.kt`, `nav.ts`, ARCHITECTURE §15.3, `docs/guide-notes.md` §35 |
| Background JS tasks, secure screens, dark mode, low memory, right to left | **built** 2026-11-03 (host API 6); push uses the tasks since 2026-11-04 | `ZnBackground.kt`, `tasks.ts`, `appearance.ts`, `docs/guide-notes.md` §36–37 |
| Official plugins `auth`, `scanner`, `media`, `webview` | **built** 2026-11-03, opt-in | `plugins/<name>/README.md`, `docs/guide-notes.md` §38 |
| Official plugin `pdf`: download and cache, a card preview, a viewer with zoom, on Android's own PdfRenderer | **built** 2026-11-03, opt-in | `plugins/pdf/README.md`, `docs/guide-notes.md` §44 |
| Official plugin `location` (Android's `LocationManager` and `Geocoder`; Play services only for the turn-on dialog) | **built** 2026-11-03, opt-in | `plugins/location/README.md`, `docs/guide-notes.md` §45 |
| Official plugins `crashlytics` and `push` (Firebase; FCM messages as JS tasks, notifications shown natively), on the base `firebase-app`; `analytics`, `remote-config`, `perf` | **built** 2026-11-04, opt-in; the sample turns Firebase on only when its `google-services.json` is there | `plugins/crashlytics/README.md`, `plugins/push/README.md`, `plugins/firebase-app/README.md`, `plugins/analytics/README.md`, `docs/guide-notes.md` §46, §48–§55 |
| Official plugin `lottie`: `<LottieView>` with lottie-react-native's names, `.json` and `.lottie` files from the app's assets, on Airbnb's lottie-compose | **built** 2026-11-05, opt-in | `plugins/lottie/README.md`, `docs/guide-notes.md` §57 |
| Official plugin `document-scanner`: Google ML Kit's document scanner (pages and / or a PDF), the Play module's state and download, results through `ZnLaunch` that survive a kill | **built** 2026-11-05, opt-in | `plugins/document-scanner/README.md`, `docs/guide-notes.md` §60 |
| Official plugin `image-viewer`: a full-screen photo viewer (native screen `imageviewer.full`, `ImageViewer.open`) | **built** 2026-11-05, opt-in | `plugins/image-viewer/README.md`, `docs/guide-notes.md` §59 |
| Permissions, "open another app and get its result" | **built** (P.2) | `ZnPermissions.kt`, `ZnLaunch.kt`, `docs/guide-notes.md` §31–32 |
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
                     onEvent={(e) => e.name === "code" && p.onCode(e.data as string)} style={{ flex: 1 }} />
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
| **Open another app and get its result** | Takes an `Intent` or an `IntentSender` (the phone number hint gives one). Native saves a "pending" record before the launch, and saves the result to disk **before** JS hears it. JS gets it as a promise when alive, and as an event after NAV STARTED otherwise; it is sent again at every start until JS calls `ack(key)`, after its own `flowStore` write. Never read-and-clear: a rollback between the two would lose it | UPI, the phone hint, document pickers, KYC SDKs. The hard part (the process dying while the other app is open) must be solved once |
| **Current Activity + one host call** | Core holds the current Activity; the host makes one call in `onCreate`, so result launchers are always registered before `onStart` (Android drops a result otherwise) | Permissions, launches and `FLAG_SECURE` all need an Activity |
| **App state to JS** | **Built (H.7).** `onAppState("active" \| "background")` and `appState()` (`docs/hardening-plan.md` H.7) | A payment screen must verify on return from a UPI app, whatever the result says |
| **Activity events for plugins** | `onNewIntent`, front / back, low memory, runtime replaced | Plugins must not ask the app's Activity for hooks one by one |
| **`zn://` handles for media** | Photos, PDFs, video, app icons stay native; JS gets a handle; `<Image src="zn://...">` shows it | Decided (§15.4); plugins hand out handles, so the handle table belongs in core (built with P.2, ported from the exp4 prototype, §1) |
| **A detached helper** | `detached(fn)` runs code with no screen as its owner | A verify loop must outlive any one screen on purpose, not by luck after an `await` |
| **Background JS** | Run a registered JS task without a screen (FCM message, WorkManager job), with a time limit | Push and sync need it; it changes how the runtime starts, so core |

The old step 2.6b splits along this line: `launchActivity` with results and permissions → **core** (above); `Os`
small methods (app version, share sheet, open settings) → **core**; `Os.upiApps` + launching a UPI app → **a plugin the
app owns** (D7).

## 7. Official plugins and other production items

| Item | Core or plugin | Notes |
|---|---|---|
| UPI apps: list installed UPI apps (with icons), launch one with a `upi://pay` link, get the result | **The app's own plugin**, not official (D7) | First real plugin: proved modules, results and `zn://` icons from an app outside this repo (`docs/guide-notes.md` §34) |
| Phone number hint, OTP auto-read (SMS Retriever) | plugin `@zero-native/auth` | Pilot login needs it. Any Play services failure means "type it by hand", |
| QR scan / camera | plugin `@zero-native/scanner` | Native screen first, native view later. ML Kit **bundled**, not downloaded from Play (fails on low-storage phones) |
| WebView | plugin `@zero-native/webview` | Native view; cookies per app, file upload, `postMessage` both ways, which links leave the app |
| Photos / files / PDF | plugin `@zero-native/media` | Pick, compress, crop, rotate natively; JS sees `zn://` handles |
| Show a PDF | plugin `@zero-native/pdf` (**built** 2026-11-03) | `<PdfView>`, `<PdfPreview>`, `Pdf.download` to `zn://file`. Android's PdfRenderer: no library, ~15 KB |
| Push (FCM) | plugin `@zero-native/push` on top of core background JS | **Built 2026-11-04.** Token and topics; every data message runs the task `push.message` (front, back, closed); `Notifications`: channels, pictures, groups with a summary, a tap opens `link` through `onLink`. Second-opinions 93–94. **Native version 2 (2026-11-04):** `getInitialNotification`, `onNotificationOpenedApp`, auto-init, permission helpers, the `zn_ota=check` push (guide §51, second-opinions 120–121). **Notifications native version 2:** buttons with inline reply (`onAction`), inbox lines, progress, badge number, lock screen visibility, channel groups, `getChannels`, `getDisplayed` (guide §52, second-opinions 122–123); scheduled notifications with repeats, the opt-in boot receiver, power checks (guide §53, second-opinions 124) |
| Firebase base | plugin `@zero-native/firebase-app` | **Built 2026-11-04.** RN Firebase's `app` module: the one Firebase BoM every Firebase plugin uses, `firebase.gradle.kts` (Firebase off with no json), `Firebase.app()`, `setDataCollectionDefault`, Installations `getId` / `getToken` / `delete` |
| Crash reports | plugin `@zero-native/crashlytics` | **Built 2026-11-04.** JS errors, OTA outcomes, bundle and route keys by themselves (core's add-only `addJsErrorListener` / `addReportListener`). NDK opt-in (+1.30 MB). Second-opinions 90–92, 95 |
| Remote Config | plugin `@zero-native/remote-config` | **Built 2026-11-04.** RN Firebase's API, reads with no call (values come with each answer), sources, live updates (`onConfigUpdated`). Guide §54, second-opinions 125 |
| Performance | plugin `@zero-native/perf` | **Built 2026-11-04.** App start, every `fetch` (through core's `ZnFetch.addInterceptor`; it was `addClientSetup` until 2026-11-04), a trace per screen with slow / frozen frames, custom traces. Guide §55, second-opinions 126 |
| Analytics | plugin `@zero-native/analytics` | **Built 2026-11-04.** RN Firebase's API. On from the first start (Firebase's default; opt-out kept across starts, ad id off), consent mode. A `screen_view` per route by itself. `logEvent` (names checked), recommended events (`logPurchase`, ...), user id and properties, `zn_bundle` on every event. +0.44 MB. Guide §50, second-opinions 96–99 |
| Photo viewer | plugin `@zero-native/image-viewer` | **Built 2026-11-05** (ZeroBill ask R15). `ImageViewer.open({ images, imageIndex })` opens the native screen `imageviewer.full` (the app adds one route). Pinch 1x–5x (0.8x springs back), pan, double tap 2.5x, swipe between pictures and to close, Back. Coil's screen-size copy plus a sharp part read from the original when zoomed (region decoder, EXIF turns). Links: https with headers, `asset:`, `zn://file`, `content://`, `data:` up to 5 MB, `file://` in the app's own folders (module v2 `hold` keeps headers and `data:` in memory). react-native-image-viewing's names. Guide §59, second-opinions 136–138, 143 |
| SQL database | plugin `@zero-native/sqlite` | **Proposed 2026-11-04, not built.** Android's own SQLite (0 bytes added), expo-style API, live queries (`watch`), add-only migrations with an opt-in reset, 100,000-row tables. `docs/sqlite-plugin-proposal.md`, second-opinions 107 |
| Markdown from the server | package `@zero-native/markdown` (JS only) | **Built 2026-11-05.** `<Markdown>` (blocks: headings, lists, quotes, code, lines) and `<MarkdownText>` (inline, 1–3 lines). Each block is one native `<Text>` with spans (registry 16); links only through the app's `onLinkPress`; no HTML, no images. Own parser, ~10 KB minified. `plugins/markdown/README.md`, guide §58, second-opinions 133–135 |
| Screenshot blocking | core: route option `secure: true` | `FLAG_SECURE` while that screen is on top |
| Certificate pinning | core: `fetch` option / app config | OkHttp `CertificatePinner`; needs a pin-rotation plan. **Not built:** RN has none today, so the pilot doesn't need it |
| Dark mode, low memory, right-to-left | core | Colour tokens with light / dark values; `onTrimMemory` clears caches; `start` / `end` already exist |
| Location: one fix, updates, permission, location off, geocoder | plugin `@zero-native/location` | **Built 2026-11-03.** Fixes from `LocationManager`; Google's "Turn on location" dialog from Play's `SettingsClient` (added 2026-11-04, module v2). A swap to Play's fused provider for fixes is written up in `docs/second-opinions.md` entry 85, not built |
| Lottie animations | plugin `@zero-native/lottie` | **Built 2026-11-05.** `<LottieView>` with lottie-react-native's props and `ref` methods (`play`, `pause`, `resume`, `reset`), `.json` and `.lottie` from `asset:` paths (in the bundle, so OTA can change them), "Remove animations" shows the last frame, `Lottie.preload`. lottie-compose 6.7.1 bundled, +85 KB, no R8 rule. Guide §57, second-opinions 130–132 |
| Document scanner | plugin `@zero-native/document-scanner` | **Built 2026-11-05.** ML Kit's scanner with react-native-document-scanner-plugin's names (`scanDocument`, `maxNumDocuments`, `scannedImages`). **Not bundled:** ML Kit has no bundled document scanner, so Play downloads it; the one exception to the "bundle" rule (Pavan). `getStatus`, `download`, `onStatus`; every Play failure is `unavailable` / `failed` with a reason. Results on `ZnLaunch`: on disk first, one handler per run, until `ack`; a `tag` per scan. Guide §60, second-opinions 139–141 |
| Maps, video, charts | plugins, later | When an app needs them |

## 8. Decisions (taken 2026-11-02)

Pavan accepted every recommendation below, with the additions after the table. Claude Fable 5.1 reviewed them against
the code (`docs/cross-communication/2026-11-02-fable-review-response.md`).

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How does the app pick up a plugin's native side? | (a) by hand: Gradle dependency + `ZnPlugins.register(ScannerPlugin())` in Application; (b) a Gradle plugin reads the app's `package.json`, adds the libraries and generates `ZnPluginsGenerated.kt` (autolinking); (c) (a) now, (b) later | **(c)**: by hand while there are 1–3 plugins and one app; autolinking once a second app or an outside author shows up. The `ZnPlugin` interface is the same either way |
| D2 | How are plugin modules written in Kotlin? | (a) today's `ZnModuleBase` with `function("x") { call -> }`; (b) codegen from the TS interface (typed Kotlin args); (c) an Expo-style DSL | **(a) now**, plus small typed helpers for args. Codegen when the first plugin has >10 functions or an outside author |
| D3 | How are native views versioned for OTA? | (a) each view belongs to its plugin's module version; (b) a new `requires.views` field | **(a)**: no change to the signed `requires` format; a view's props / events change ⇒ raise the module version |
| D4 | Native screens: API for results | (a) `nav.pushForResult(route)` promise + `onNavResult` after restore; (b) only events | **(a)**: the promise is what authors expect; the event covers the process-kill case |
| D5 | Where do official plugins live? | (a) this repo, `plugins/<name>/`, released with core; (b) separate repos | **(a)**: one version line with core, one CI, the sample app uses them. Split later if outsiders contribute |
| D6 | How does a plugin say which core it needs? | (a) `peerDependencies` on `@zero-native/core` + a Gradle dependency on the runtime with a version range; (b) a host API number in `package.json` | **(a)** for both sides; core's host API check already guards the JS ↔ native contract at run time |
| D7 | UPI: core or plugin? | (a) plugin; (b) core | **(a)**: only payment apps need it; it is also the best first test of the plugin system. **Changed 2026-11-02:** the plugin belongs to the app, not this repo (`docs/second-opinions.md` entry 16) |

**Additions from the review:**
- **D1:** plugins register first in `Application.onCreate`, before the bundle is chosen: the capability check reads the
  module list once at that point. A late plugin would make every bundle that needs it look incompatible.
- **D1 as built:** the call is `ZnPlugins.register(this, ScannerPlugin())`. It takes the app's context because modules
  need one. `r.context` gives it to a plugin.
- **P.2 as built:** only Kotlin starts a launch (`ZnLaunch.start`, so no generic launch from JS); the caller gives the id; `pending(key)`
  is a sync read, because START waits for Android's answer; a late result wins over `lost`. No raw `onActivityResult` for
  plugins yet: `ZnLaunch` covers what P.3 to P.4 need.
- **D2:** add the typed arg helpers now (`call.string("uri")`, `call.int(...)`), each rejecting with `invalid_args`.
- **D3:** the compiler fails the build if a `NativeView` name's prefix has no matching `nativeModule` in the same package,
  so the "empty box" case can't happen. A props snapshot test per plugin catches a view change with no version raise.
- **D4:** a result after a restore is kept until the app confirms it, the same as `launchForResult` (section 6).
- **D6:** `ZnPluginRegistry` lets a plugin say `r.requireHostApi(4)`; it fails at once in debug builds.
- **D7:** the UPI plugin also needs an app-state event to JS (not in section 6 yet) and `<queries>` for `upi://pay`. Its
  test partner is the mock UPI app.

## 9. Steps

**Order (agreed 2026-11-02):** `docs/hardening-plan.md` first, then the steps below. The port of the checkout rules to
TS runs alongside from the start, in the app's private repo.

| Step | What | Done when |
|---|---|---|
| P.1 **built 2026-11-02** | `ZnPlugin` + `ZnPluginRegistry`, `plugins/` folder, D1 (a); the sample's `DeviceModule` moved into a test plugin | The sample works with the module registered through a plugin; guide notes "writing a plugin" (§30) |
| P.2 **built 2026-11-02** | Core plumbing (section 6): permissions, `launchForResult` with saved results and `ack`, current Activity + host call, Activity events, `Os` info / haptics / open URL, `detached`, `zn://` handles (ported from exp4). Also: never start fresh or bring the task forward while a launch waits for its result | Phone tests **with the mock UPI app**: grant / deny / "don't ask again"; a result delivered after the process was killed in the other app; a rollback between delivery and `ack`; an app icon shown from a `zn://` handle |
| P.3 **built 2026-11-02** | **Changed:** UPI is a plugin the app owns, in its private repo. This repo gains what any outside app needs: `tools/zn-build.ts`, and the guide for an app outside this repo (`docs/guide-notes.md` §34) | An app outside this repo builds, with its own plugin, in debug and in R8 release. It lists UPI apps with icons, launches the mock UPI app and gets the result back, also after a kill; a loading look keeps drawing behind the mock's see-through window with no native pump |
| P.3b **built 2026-11-03** | `@zero-native/auth`: phone number hint, SMS Retriever | Both work on the Lava; each failure falls back to typing |
| P.4a **built 2026-11-03** | `@zero-native/scanner` as a native screen (`pushForResult`, route `native:` field). No `<NativeView>` | QR scan on the Lava; camera stops when covered; stale frames ignored; release build size measured |
| P.4b **built 2026-11-03** (moved before the pilot) | `<NativeView>` (registry 9); the scanner gains a view form | A view draws, sends events, stops when covered; the compiler refuses a name with no module |
| P.5 **built** (background JS 2026-11-03, push 2026-11-04) | Background JS + `@zero-native/push` | A task runs with no screen, with a time limit (built). Push: a push in background runs a JS task; tap opens a route (built) |
| P.6 **built 2026-11-03**, no pinning | `webview`, `media`, and core items (secure screens, pinning, dark mode, low memory, RTL) | Webview loads, talks both ways, keeps links in or out; media picks, shrinks and uploads by handle; a secure screen blanks screenshots; dark mode follows the phone |

P.4a unblocks the ZeroBill pilot's screens: login, scan, UPI transaction (details in the app's private repo).

## 10. Questions for reviewers (answered 2026-11-02: review response, question 1, and §5)

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
