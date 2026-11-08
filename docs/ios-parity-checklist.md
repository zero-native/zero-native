Made 2026-11-08.
Checked against the code on the `ios` branch at commit be2ccc7; the four controls updated for 2f1d6d3.

# iOS parity checklist

Everything Android has, item by item, and whether iOS has it. Android (`android/runtime`, `plugins/*/android`) is
the reference. Status words:
- **done**: iOS has it and covers what Android does.
- **partial**: iOS has it, but something is missing (said in the note).
- **missing**: nothing on iOS.
- **n/a**: an Android idea with no iOS meaning. Nothing to do.

Sizes: **S** under 2 hours, **M** half a day, **L** a day or more (days in brackets when more than one). For the totals,
S = 0.25 d, M = 0.5 d, L = 1 d unless brackets say otherwise. One size per item. A row that points to another section
has its size there, so nothing is counted twice.

How it was checked: every Registry component against `case Registry.Component.x` in `ios/ZnRuntime/Swift/ZnRenderer.swift`
(anything else falls to `ZnMissing`, which draws a red name in debug and **nothing in release**); every
`Registry.Prop.X` the Kotlin reads against the Swift that reads it (`P.x` in ZnTemplate.swift) and then against the
code that uses the value; every `ZnModuleBase(...)` and `function("...")` on both sides; every app event in
ZnAppEvent.kt and NAV kind in ZnNav.kt against ZnApp.swift.

---

## 1. Components

| # | Component | iOS | Size | Note |
|---|---|---|---|---|
| 1 | Column | done | | Layout conformance 46/46. |
| 2 | Row | done | | |
| 3 | Stack | done | | Absolute children, stretch between insets (R44). |
| 4 | Box | done | | |
| 5 | Text | partial | §2 | No font scaling (Dynamic Type), no maxFontScale, no accessibility. |
| 6 | Image | partial | §4 | No `zn://` handles. asset / http / file, fallback, tint, events done. |
| 7 | Pressable | partial | §2 | No pressFeedback (ripple / highlight), no hitSlop (runtime `disabled` fixed in 774308f), no accessibility. |
| 8 | Spacer | done | | |
| 9 | Icon | done | | |
| 10 | Anchor | done | | |
| 11 | List | partial | §2 | No impressions. Window, sticky, inverted, pull to refresh done. |
| 12 | Scroll | done | | Padding inside the scroll (774308f), pull to refresh. |
| 13 | Carousel | done | | |
| 14 | Sheet | partial | §2 | No onDetentChange, no animateIn, sheet colour and radius fixed. |
| 15 | Fragment | done | | |
| 16 | TextField | partial | §2 | 8 props missing (autoComplete, editable, placeholderColor, ...). |
| 17 | NativeView | missing | M | Needs plugin loading (§4) first. viewName, viewProps, onNativeEvent, ref. ZnNativeViews.kt. |
| 18 | Svg | done | | Filters draw only a drop shadow (§2). |
| 19 | SvgPart | done | | |
| 20 | Switch | done | | ZnSwitch.kt → ZnControls.swift (2f1d6d3). |
| 21 | Checkbox | done | | ZnCheckbox.kt → ZnControls.swift (2f1d6d3). |
| 22 | Spinner | done | | ZnSpinner.kt → ZnControls.swift (2f1d6d3). |
| 23 | Progress | done | | ZnProgress.kt → ZnControls.swift (2f1d6d3). |
| 24 | Shimmer | done | | |
| 30 | Tabs | done | | ZnTabsRefresh.swift: only the selected child shows; hidden tabs keep their views and state. |
| 31 | Modal | done | | onRequestClose is never sent: no system Back on iOS (same as RN on iOS). |
| 32 | StatusBar | missing | M | Drawn as nothing. barStyle, hidden, backgroundColor (all can change), per screen, newest element wins. ZnSystemBars.kt. Only the route's `statusBar` option works now. |
| 33 | NavigationBar | missing | S | iOS has no navigation bar. Decide: backgroundColor behind the home indicator, or ignore. ZnSystemBars.kt. |
| 34 | OtpInput | done | | ZnOtpInput.kt → ZnOtpInput.swift: boxes over one hidden field, caret, `.oneTimeCode` autofill, otpTheme, otpType, blurOnFilled, invalid, onFilled, ref setValue / focus / blur / clear. |

Totals: 29 components. Done 17, partial 7 (sized in §2 and §4), missing 5.
Missing work: 1 L, 2 M, 2 S = **2.5 days**.

---

## 2. Props and events where iOS is missing or partial

Only props whose iOS support is missing or partial. Everything else in the registry is read and used on iOS.

### On every component
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| accessibilityLabel (also at runtime), accessibilityHint, accessibilityRole, accessibilityHidden | missing | L | Nothing on iOS reads them. Android merges labels, sets roles (button, header, image, link, switch, checkbox) and hides nodes. The UIKit press view over a Pressable must become the VoiceOver element. Check with VoiceOver on a device. |
| Font scaling + maxFontScale | missing | M | Text and fields use fixed point sizes (`UIFont.systemFont(ofSize:)`), so Dynamic Type does nothing. Yet WINDOW sends JS the real fontScale, so JS and the screen disagree. Android scales by fontScale and caps it with maxFontScale. |
| testID | missing | S | Android: Compose test tag, shown to UI tests as a resource id. iOS: `accessibilityIdentifier`. |
| pointerEvents (none, box-none, box-only; can change at runtime) | missing | M | ZnTouch.kt. SwiftUI `allowsHitTesting` plus the UIKit press view's hit test. |
| impressionKey | missing | §4 | See Impressions. |
| includeFontPadding | n/a | | Android-only (font padding). |

### Pressable
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| pressFeedback (ripple is the default, highlight, none) + highlightColor | missing | M | Android shows a ripple on every Pressable by default. iOS shows no feedback unless pressScale or pressOpacity is set, so every button in the app looks dead when pressed. highlightColor is read only for Shimmer. |
| rippleColor, rippleOpacity, rippleBorderless, rippleRadius | missing | S | After the above: draw a ripple, or map it to a highlight on iOS. |
| disabled at runtime (slot) | partial | S | Bug. `disabledSlot` is read in ZnTemplate.swift but ZnPress.swift uses only the static `s.disabled`. So `disabled={!active()}` (the sample's Pay button, AmountScreen.tsx:288) still sends onPress on iOS. |
| hitSlop | missing | S | Grow the press view's hit test (`point(inside:)`). |

### TextField
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| autoCapitalize, autoCorrect | missing | S | `autocapitalizationType`, `autocorrectionType`. |
| autoComplete | missing | S | Android maps it to autofill hints (ZnAutofill.kt). iOS: `textContentType` (sms-otp → `.oneTimeCode`, tel → `.telephoneNumber`, ...). |
| editable (also at runtime), placeholder at runtime, color at runtime | missing | S | A read-only field can be typed in on iOS. |
| placeholderColor, selectionColor | missing | S | Placeholder colour is fixed grey; selection uses the system tint. |

### List and Scroll
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| List onRefresh, refreshing, refreshColor, refreshBackground | done | | Pull to refresh, controlled by JS (ZnPullRefresh.kt: a release past the line sends onRefresh, the spinner goes if JS doesn't set refreshing within PENDING_MS). UIRefreshControl on the collection view. |
| Scroll onRefresh, refreshing, refreshColor, refreshBackground | missing | S | Same, on a vertical Scroll, after the List one. |
| Scroll padding | done | | Fixed in 774308f: the padding is inside the scrolling content, as Android. |

### Sheet
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| onDetentChange | missing | S | `sheetPresentationControllerDidChangeSelectedDetentIdentifier`. |
| animateIn (also at runtime) | missing | S | Open already at rest (a payment restored after a kill). |
| backgroundColor, borderRadius of the sheet | partial | S | The sheet view is always white (the 20 pt grabber strip shows white under a dark sheet) and uses the system corner radius. |

### Modal
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| onRequestClose | n/a | | No system Back on a full-screen presentation. Same as RN on iOS. |

### Svg
| Prop / event | iOS | Size | Note |
|---|---|---|---|
| Filters other than a drop shadow | partial | M | Written down as an iOS difference (ZnSvgDraw.swift). Only needed if an app's SVGs use blur, colour matrix, ... |
| autoMirror in RTL | not checked | S | Code is there (ZnSvgView.swift), never run in an RTL locale. |

### Events no iOS code sends yet
onDetentChange (Sheet, above), onRefresh (above), onFilled (OtpInput, §1), onNativeEvent (NativeView, §1),
onValueChange (Switch / Checkbox, done in 2f1d6d3), onRequestClose (n/a).

Totals: 20 sized rows: 15 missing, 4 partial, 1 not checked. 1 L, 5 M, 14 S = **7 days**.

---

## 3. Native modules

Android's built-in modules (ZnModules.kt `init`) plus storage. iOS registers them in ZnModules.swift.

| Module (version) | Functions / events | iOS | Size | Note |
|---|---|---|---|---|
| Keyboard (2) | dismiss, focus, blur, clear | done | | |
| Fetch (1) | send | done | | URLSession; fetch checks 27/27. |
| SecureStore (1) | get, set, delete | done | | Keychain. |
| Toast (1) | show | done | | |
| Permissions (1) | status, request | done | | camera, microphone, contacts, notifications, location (+ location.precise). |
| Os (2) | info, haptic, openSettings, share, openUrl, canOpenUrl | done | | |
| Alert (1) | show | done | | |
| Clipboard (1) | setString, getString, hasString | done | | |
| Vibration (1) | vibrate, cancel | done | | |
| NetInfo (1) | fetch, event `change` | done | | |
| Splash (1) | hold, release | partial | M | Both answer `false` (no splash to hold). iOS shows the skeleton at once instead. So `Splash.holdUntil` (ZeroBill's QR cold start: wait for /init, lift straight onto checkout) does nothing: Home shows, then checkout slides in. Fix: keep a launch-screen view over the window until ready or maxMs. |
| Storage | JS `storage` / `createStorage` | partial | S | JS storage works (C++ core + MMKV, `storageDir` in ZNHost.mm). The native API for app and plugin code (ZnStorage.kt: `store(id).get/set/keys/...`) has no Swift version. |
| Updates (3) | status, markHealthy, check, applyNow, hold, event `Updates` | missing | §4 | OTA. |
| Launches (1) | ack, event `result` | missing | §4 | Launches. |
| Tasks (1) | done, app event TASK | missing | §4 | Background tasks. |
| Platform (iOS only) | constants | iOS extra | | Tells JS it runs on iOS before any code runs (A9). |

Plugin modules (Auth, Scanner, Push, ...) are in §5.

Totals: 15 modules. Done 10, partial 2, missing 3 (sized in §4). Sized here: 1 M, 1 S = **0.75 days**.

---

## 4. Runtime features

| Feature | Android files | iOS | Size | Note |
|---|---|---|---|---|
| OTA rules in C++ (A1) | ZnBundles.kt, ZnOtaHealth.kt, ZnOtaSignature.kt, ZnOta.kt (~2.1k lines) | missing | L (2 d) | Do first, or the rules exist twice. Step i.0. Android must still pass the 38-case phone matrix after. |
| Bundle pool, bundle choice, capability manifest | ZnBundles.kt, ZnCapabilities.kt | missing | L | Registry, bytecode, host API and module versions checked against a bundle's `requires`. |
| Download, verify (ECDSA P-256 / SHA-256), install | ZnOtaInstall.kt, ZnOtaSignature.kt | missing | L | CryptoKit P256 can check the DER signatures. |
| Health facts and boot guard (launch watchdog) | ZnOtaHealth.kt | missing | M | Android reads ApplicationExitInfo. iOS: MetricKit on the next launch, or core's crash mark. |
| Updates module + apply in place behind a cover | ZnOta.kt (Module, `cover`) | missing | M | |
| Restore after kill: saved back stack, NAV RESTORE values (restorableSignal), START payload | ZnNav.kt (saveState, readSavedStack), ZnNavSavedTest.kt | missing | L (1.5 d) | iOS has no saved-state bundle: write the stack to a file (step i.3). NAV RESTORE is ignored today. Route option `restore` too. |
| Background tasks (`defineTask`) | ZnBackground.kt | missing | L | Queue until JS loads, time limit, one answer per task, TASK event. iOS: BGTaskScheduler and push-triggered runs. |
| Launches (launchForResult, saved results, ack, wait ≤1 s after a kill) | ZnLaunch.kt | missing | L (1.5 d) | iOS has no Intents. UPI on iOS: open by URL scheme, come back by link, verify on the server (step i.4). Keep the JS API. |
| Deep links / onLink | ZnNav.kt (openLink, OPEN event), ZnRoutes.kt (match, tab paths), route `path` / `deepLink` / `tabs` options | missing | M | No OPEN event, no route matching, no onUnmatchedLink, no link at cold start. iOS: scene `openURLContexts`, URL types, universal links. |
| zn dev (live reload, dev error overlay) | ZnDev.kt, ZnRuntime.kt (reload, restart, generations) | missing | L | Simulator reaches the Mac on localhost; a device needs the Mac's address. Answers from the old runtime must be dropped after reload. |
| Error screen (NAV FAILED, RETRY, hung JS, "Restart app", custom texts and colours) | ZnErrorScreen.kt, ZnNav.kt | partial | M | iOS shows a red text only when the app fails to start. A screen whose JS threw shows nothing special; NAV FAILED and RETRY are not handled. |
| Secure screens (route `secure`) | ZnNavHost.kt (FLAG_SECURE) | missing | M | iOS has no flag. Options: blank the app-switcher snapshot, the secure text field layer trick for screenshots. Decide what "secure" means on iOS. |
| Impressions (impressionKey, NAV IMPRESSIONS, event 6) | ZnImpressions.kt | missing | M | Visible fraction per key, threshold / minMs, top screen and app in front only, batched. |
| Accessibility semantics | ZnTemplate.kt `accessibilitySemantics`, ZnPress.kt | missing | §2 | |
| Autofill | ZnAutofill.kt | missing | §2 | TextField autoComplete. |
| `zn://` handles | ZnHandles.kt | missing | M | Loader per kind, off the main thread. Android's `app-icon` kind (installed apps' icons) can't exist on iOS. |
| Native views | ZnNativeViews.kt | missing | §1 | NativeView. |
| Native screens (route `native`, NAV_RESULT event 12, answer saved before JS hears it) | ZnNativeScreens.kt, ZnNavHost.kt NativeScreen, ZnNav.kt answer | missing | M | Needed for scanner.full and imageviewer.full. |
| Plugins loading (modules, views, screens, activity events, host call, JS error and batch listeners, register before bundle choice) | ZnPlugins.kt, ZnActivity.kt, ZnRuntime.kt (addJsErrorListener, addBatchListener) | missing | L (1.5 d) | Also how an iOS plugin is packaged and linked into the CMake build. |
| Registry claim vs what iOS draws | Registry.swift, Readers.swift | partial | S | iOS says it knows registry 22 and accepts Tabs, OtpInput, NativeView, StatusBar templates, then draws them as nothing in release. Fine while bundles ship inside the app; once iOS has OTA its capability manifest must not claim what it can't draw. |
| A push before NAV STARTED comes in with no slide (`openedAtStart`, also while the splash is held) | ZnNav.kt, ZnNavHost.kt | missing | S | iOS animates any push once a screen is there. NAV STARTED is ignored. |
| Screens kept until their exit transition ends | ZnNavHost.kt | partial | S | iOS frees a removed screen after a fixed 0.6 s ("spike" in ZnApp.swift). |
| RTL layout | Compose follows the locale | not checked | S | `Os.info` reports rtl; layout never run in Arabic / Hebrew. |
| App state, colour scheme, low memory, insets, DEVICE / WINDOW / KEYBOARD events | ZnAppState.kt, ZnWindow.kt, ZnNavHost.kt | done | | ZnSystemEvents.swift, ZnApp.swift. |
| Back stack, transitions, safeArea, keyboard option, route statusBar option, BACK / FORCED_BACK, BACK_WANTED (A8), app layers | ZnNav.kt, ZnNavHost.kt | done | | |
| System bars per route | ZnNavHost.kt BarIcons | done | | StatusBar element: §1. |
| Splash hold | ZnSplash.kt | partial | §3 | |
| Storage native API | ZnStorage.kt | partial | §3 | |
| NAV EXIT (leave the app) | ZnNav.kt | n/a | | iOS apps don't exit themselves. |
| Predictive back, BACK_ANSWERED fallback timer | ZnNav.kt, ZnNavHost.kt | n/a | | iOS back is the swipe (A8). |
| Main-process check | ZnProcess.kt | n/a | | One process on iOS. App extensions would need a shared container, not this. |

Totals: 20 sized rows: 16 missing, 3 partial, 1 not checked. 8 L (10.5 days with the brackets), 8 M (4 days),
4 S (1 day) = **15.5 days**. OTA alone (first five rows) is 5 days.

---

## 5. Plugins

None has an iOS side yet. All wait for plugin loading (§4). Android files are under `plugins/<name>/android/src/main/java/...`.

| Plugin | What it does | iOS side | Android files | Size | Note |
|---|---|---|---|---|---|
| ad-id | Google advertising id (module AdId) | no | AdIdPlugin.kt, AdIdRules.kt | M | IDFA needs the App Tracking Transparency prompt. |
| analytics | Firebase Analytics, RN Firebase API (Analytics) | no | AnalyticsPlugin.kt, AnalyticsRules.kt | M | After firebase-app. |
| auth | Phone number hint sheet, SMS Retriever (Auth) | no | AuthPlugin.kt, AuthModule.kt, AuthRules.kt | S | iOS has neither. Answer "unavailable" so the app falls back to typing; the OTP fills from the keyboard via OtpInput's `.oneTimeCode`. |
| crashlytics | Firebase Crashlytics, JS errors (Crashlytics) | no | CrashlyticsPlugin.kt, CrashlyticsModule.kt, CrashlyticsRules.kt | M | dSYM upload; needs the JS error listener (§4). |
| device-info | react-native-device-info values (DeviceInfo) | no | DeviceInfoPlugin.kt, DeviceInfoRules.kt | M | |
| device-test | Test plugin for the sample (Device) | no | DeviceTestPlugin.kt, DeviceModule.kt, FakeNative.kt | S | Port it first: the template for every iOS plugin. |
| document-scanner | ML Kit document scanner, pages and PDF as handles (DocumentScanner) | no | DocumentScannerPlugin.kt, DocScanModule.kt, DocScanRules.kt | L | VisionKit `VNDocumentCameraViewController`, PDFKit for the PDF. |
| firebase-app | Firebase base, one Firebase version (Firebase, Installations) | no | FirebaseAppPlugin.kt, firebase.gradle.kts | L | Getting the Firebase iOS SDK into the CMake build, GoogleService-Info.plist. |
| image-viewer | Full-screen photo viewer, pinch zoom (ImageViewer, screen imageviewer.full) | no | ImageViewerPlugin.kt, ImageViewerScreen.kt, ViewerParts.kt, ZoomState.kt, SharpSource.kt, ViewerSpec.kt, ViewerHeld.kt, ViewerRules.kt, DebugGestures.kt | L (1.5 d) | Needs native screens. |
| location | Location and geocoding (Location) | no | LocationPlugin.kt, LocationModule.kt, LocationRules.kt | L | CoreLocation, CLGeocoder. |
| lottie | Lottie view, lottie-react-native names (Lottie, view lottie.view) | no | LottiePlugin.kt, LottieView.kt, LottieModule.kt, LottieFiles.kt, LottieRules.kt | M | lottie-ios. Needs NativeView. |
| markdown | Markdown drawn as Text with spans | JS only | none | 0 | Should work: Text spans and onSpanPress are on iOS. Not run on iOS yet. |
| media | Pick photos / files, camera, compress, edit, as handles (Media) | no | MediaPlugin.kt, MediaModule.kt, MediaImage.kt, MediaFileProvider.kt, MediaRules.kt | L (1.5 d) | PHPicker, UIImagePickerController, UIDocumentPicker. |
| pdf | Download, keep and show PDFs (Pdf, views pdf.preview, pdf.view) | no | PdfPlugin.kt, PdfModule.kt, PdfDoc.kt, PdfPreview.kt, PdfViewer.kt, PdfViews.kt, PdfRules.kt | L | PDFKit. Needs NativeView. |
| perf | Firebase Performance (Perf) | no | PerfPlugin.kt | M | Needs batch listeners (§4). |
| push | FCM token, topics, data messages as JS tasks; local notifications (Push, Notifications) | no | PushPlugin.kt, PushModule.kt, NotificationsModule.kt, ZnMessagingService.kt, Opens.kt, Schedule.kt, Actions.kt, Groups.kt, PushRules.kt | L (2.5 d) | APNs through FCM, UNUserNotificationCenter, actions, groups, schedules, background runs. Needs background tasks. |
| remote-config | Firebase Remote Config (RemoteConfig) | no | RemoteConfigPlugin.kt | M | |
| scanner | QR / barcode scan, full screen and a view (Scanner, screen scanner.full, view scanner.qr) | no | ScannerPlugin.kt, ScannerModule.kt, ScannerScreen.kt, ScannerView.kt, ScannerParts.kt, ScannerCamera.kt, CameraSession.kt, ScannerTexts.kt, ScannerRules.kt | L (1.5 d) | AVFoundation metadata output. Needs native screens (and NativeView for the view). |
| webview | Web page in a screen, host allow-list, messages both ways (WebView, view webview.page) | no | WebViewPlugin.kt, WebViewModule.kt, WebViewPage.kt, WebViewRules.kt | L (1.5 d) | WKWebView. Needs NativeView. |

Each plugin also has a Kotlin `*RulesTest.kt` (17 in all); the iOS side needs the same checks.

Totals: 19 plugins. 1 JS-only (likely works), 18 with no iOS side. 9 L (12.5 days with the brackets), 7 M, 2 S
= **16.5 days**.

---

## 6. Tools and tests

| Item | Android / Windows only | Mac / iOS | Size | Note |
|---|---|---|---|---|
| tools/run-core-tests.ps1 | yes | done | | tools/run-core-tests-apple.ts (simulator). |
| tools/measure-startup.ps1 | yes (PowerShell, adb) | missing | M | Cold-start timing. On iOS: `simctl launch` timings, xctrace on a device. |
| tools/measure-frames.ps1 | yes (PowerShell, adb) | missing | M | Frame timing. On iOS: Instruments hitches. |
| tools/measure-tabs.ts | yes (adb, `am start -W`) | missing | M | Tabs lab startup cost. |
| tools/ota/phone-matrix.ts (`bun run ota:phone`, 38 cases) | yes (adb) | missing | L (1.5 d) | After iOS OTA. |
| tools/ota/cli.ts | partly (prints `adb reverse`, copies to the phone) | missing | S | Server part is platform-free. |
| tools/plugin-phone.ts + tools/plugin-phone/*.ts | yes (adb, uiautomator) | missing | L (2 d) | Phone checks for core and plugins. Grows with each iOS plugin. |
| tools/zn-dev.ts | yes (`adb reverse`) | missing | S | The server side of zn dev; skip adb for the simulator, give a device the Mac's address. |
| tools/push-send.ts | FCM tokens only | missing | S | Works for iOS if push goes through FCM. |
| tools/fetch-test-server.ts | prints adb steps | done | | The simulator reaches localhost (handoff). |
| Kotlin unit tests (android/runtime/src/test, 31 files: bundles, OTA health / install / signature, nav saved state, routes, readers, fetch, animation, ...) | yes | missing | L | No XCTest target exists in `ios/`. Set one up and port the reader, routes and animation ones; the OTA ones come with OTA. |
| Macrobenchmarks (android/baselineprofile: StartupBenchmark, TypingBenchmark, SampleJourney) | yes | missing | M | XCTest metrics on a device. |
| Golden `.zn.ui` and batch files read by both test suites | not started | missing | M | Step i.0. |
| Docs' `.\gradlew.bat` commands (A2) | yes | missing | S | Add Mac / Linux forms. |
| Real iPhone builds | | missing | S | Xcode on this Mac has no iOS device platform; nothing has run on a device. Blocks every measurement above. |
| Layout conformance screen (route layoutLab) | | done | | Both platforms; Android hasn't run it yet (A11). |

Totals: 16 rows. Done 3, sized 13: 3 L (4.5 days with the brackets), 5 M, 5 S = **8.25 days**.

---

## Totals

| Section | Done | Partial | Missing | Other | Days |
|---|---|---|---|---|---|
| 1. Components (29) | 17 | 7 | 5 | | 2.5 |
| 2. Props and events (20 sized rows) | | 4 | 15 | 1 not checked | 7 |
| 3. Native modules (15) | 10 | 2 | 3 | | 0.75 |
| 4. Runtime features (20 sized rows) | 3 rows | 3 | 16 | 1 not checked | 15.5 |
| 5. Plugins (19) | 1 (JS only) | | 18 | | 16.5 |
| 6. Tools and tests (16 rows) | 3 | | 13 | | 8.25 |
| **All** | | | | | **about 50.5** |

**Overall: about 50 focused working days** (10 weeks), not counting device
checks of each piece, or fixes the device finds. Of that, about 11 days is what the ZeroBill checkout needs (below);
the rest is OTA, the Firebase plugins, the other plugins and the tools.

## What ZeroBill's checkout needs first

The pilot is login, scan and a UPI transaction (milestones.md: P.4a, i.4), opened from a QR link, and it must survive
being killed while the UPI app is open. The five to do first:

1. **OtpInput, with TextField autoComplete and runtime `disabled`** (L + S + S, ~1.5 d). Login: phone number field,
   then the OTP boxes; iOS fills the code from the SMS via `.oneTimeCode`. Fix `disabled` now: every "Continue" /
   "Pay" button that is disabled until the form is valid still fires on iOS. The auth plugin's iOS side is only
   "unavailable" answers (S).
2. **Plugin loading and native screens** (L 1.5 d + M). Nothing in `plugins/` can run on iOS without them; port
   device-test first as the pattern.
3. **Scanner plugin, full-screen form** (L 1.5 d). AVFoundation QR reading behind `scanner.full`.
4. **UPI on iOS: Launches by URL scheme, deep links back** (L 1.5 d + M). Open the UPI app by its scheme, come back by
   link (OPEN / onLink, also at cold start: the QR link), verify on the server. Keep the `launches` JS API so the
   app's UPI plugin code stays the same shape.
5. **Restore after kill** (L 1.5 d). Saved back stack in a file plus restorableSignal values, so a payment in flight
   comes back on checkout, not on Home.

Next after those, all small: Tabs (S, the home tabs), Pressable press feedback (M; every button looks dead on iOS),
Splash hold (M, the QR cold start), Sheet `animateIn` (S, the restored processing sheet), the error screen (M).
