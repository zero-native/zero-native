# Platform Differences & Parity

`zero-native` renders with **Jetpack Compose** on Android and **SwiftUI + UIKit** on iOS. We aim for *"the same design, native on each OS"* rather than forcing artificial pixel identity at the cost of native feel or bundle size.

---

## 1. Intentional Platform Differences

| Area | Android (Compose) | iOS (SwiftUI + UIKit) |
|---|---|---|
| **Shadows** | Uses `elevation` and `shadowColor` (`shadowOffset` / `shadowOpacity` / `shadowRadius` are ignored on both platforms) | Same (`elevation` + `shadowColor`) |
| **Text metrics** | Android text engine; line height and wrapping can differ by 1–2 px | CoreText / UIKit text engine |
| **Back navigation** | Hardware back + Android 13+ predictive back gesture | Edge swipe-back gesture |
| **Failed start recovery** | Error screen offers "Restart app" | iOS apps cannot relaunch themselves; prompts user to reopen |
| **External app results (e.g., UPI)** | Activity result callback (`launches`) | URL scheme app switch + return link; always verify with your server |
| **OTP autofill** | SMS Retriever (`@zeronative/android-play-auth`) + `autoComplete="sms-otp"` | Native iOS `.oneTimeCode` keyboard autofill |
| **Screenshot blocking (`secure: true`)** | `FLAG_SECURE` hides screenshots & recents | **Ignored today:** screenshots, screen recording and the app switcher show the screen (see §3) |
| **Minimum OS** | Android 7.0 (API 24) | iOS 17.0 |

---

## 2. Current Feature Parity Status (Pre-1.0)

Android is the reference implementation and is in production. iOS supports everything needed for core production apps (navigation, layouts, lists, sheets, modals, SVG, deep links, state restoration, push notifications, full-bundle OTA updates, and 14+ plugins), while several newer Android features are still being ported to iOS:

| Feature | Android | iOS | Notes |
|---|:---:|:---:|---|
| Core layout (`Column`, `Row`, `Stack`, `Scroll`, `flexWrap`, safe areas) | ✅ | ✅ | Verified against the LayoutLab conformance suite |
| Signals, compiled templates, Hermes bytecode, MMKV, `FlowStore`, `SecureStore` | ✅ | ✅ | Shared C++ core |
| Navigation, tabs, deep links, back handling, process-death restore | ✅ | ✅ | Nav3 (Android) / `UINavigationController` (iOS) |
| `fetch` (timeouts, `FormData`, error codes) | ✅ | ✅ | `onUploadProgress` / `onDownloadProgress` and network-change pool flush are Android-only today; iOS `FormData` supports `file://` only |
| `<List>` (virtualized, sticky headers, inverted, pull-to-refresh) | ✅ | ✅ | `numColumns`, `ListHeader/Footer/Empty`, `scrollCommand`, impressions pending on iOS |
| `<Sheet>`, `<Modal>`, `Alert`, `toast`, `<OtpInput>`, `<Svg>`, `<Carousel>` | ✅ | ✅ | `Sheet` `onDetentChange` & custom sheet background/radius, and `Carousel` `"%"` `itemWidth` pending on iOS |
| `<Scroll>` pull-to-refresh | ✅ | ✅ | Implemented on both Android and iOS (`ZnScrollRefresh`) |
| Declarative `animate`, `enter`, `exit` | ✅ | ✅ | — |
| OTA updates (signed bundles, rollback, launch gate, `zn-updates`) | ✅ | ✅ | bsdiff patches are Android-only today (iOS downloads full bundles) |
| Live reload (`zn dev`) | ✅ | 🚧 | iOS currently rebuilds via `bun run ios` |
| UI-thread motion & gestures (`useMotion`, `derive()`, `usePan`, `sharedTag`, `animateLayout`) | ✅ | 🚧 | iOS registers a stub `Motion` module only — **do not ship a bundle using UI-thread motion to iOS yet** |
| Runtime layout slots (`width`, `height`, `min/max`, `flex`, `gap`, `aspectRatio`, radii, `top/bottom/start/end`, `fontSize`, `lineHeight`, `letterSpacing`) & `display: "none"` (even build-time) | ✅ | 🚧 | Not yet wired in `ZnTemplate.swift` on iOS (padding & margin *are* drawn) |
| `<Canvas>` (2D draw commands) | ✅ | 🚧 | Core Graphics port planned |
| `WebSocket` | ✅ | 🚧 | `URLSessionWebSocketTask` port planned |
| Custom `fontFamily`, `Text` `selectable` / `adjustsFontSizeToFit` / `minimumFontScale` | ✅ | 🚧 | Planned for iOS |
| `accessibility*` props, Dynamic Type font scaling, `testID` | ✅ | 🚧 | Planned for iOS |
| `TextField` `editable`, `placeholderColor`, `selectionColor` | ✅ | 🚧 | Planned for iOS |

*(Plugin-by-plugin Android/iOS support is listed in [Plugins](plugins.md#1-official-plugins).)*

---

## 3. iOS Gaps in Detail

The full list from a sweep of the iOS code on 2026-11-20 (release gate item 8). "Ignored" means the app builds and
runs, and iOS draws the element as if the prop were not there. Nothing here crashes. Check this list before you ship a
screen to iOS.

### Before you ship to iOS: the ones that matter most
- **`secure: true` on a route is ignored.** Screenshots, screen recording and the app switcher show the screen. Don't
  rely on it for payment or account screens on iOS yet.
- **UI-thread motion is a stub.** iOS registers the `Motion` module (version 1) so bundles that only import it still
  run, but every call answers "unavailable". A bundle that *uses* motion (`useMotion`, `derive()`, `usePan`, gestures)
  passes the OTA check on iOS and then doesn't move. Don't ship such a bundle to iOS yet.
- **Layout values from a signal don't update.** See "Components and props" below. The value the screen started with
  stays.
- **`WebSocket` is missing.** `new WebSocket(...)` fires `error`, then `close` with code 1006.

### Components and props
- **`<Canvas>`:** not drawn (release builds draw nothing; debug builds show a red label).
- **Values from a signal:** `width`, `height`, `min*` / `max*`, `flex`, `aspectRatio`, `gap` / cross gap, border
  radii, `top` / `bottom` / `start` / `end`, `fontSize`, `lineHeight` and `letterSpacing` keep their first value.
  Padding, margin, colours, opacity, border width and colour, and transforms *do* update.
- **Ignored even when fixed at build time:** `display: "none"` (the element stays and takes space), `pointerEvents`
  (taps still reach children), `fontFamily` (system font only). Text doesn't follow the user's text size (Dynamic
  Type) or `maxFontScale`.
- **Accessibility:** `accessibilityHint`, `accessibilityRole`, `accessibilityHidden` and `testID` are ignored.
  `accessibilityLabel` works on `<OtpInput>` only.
- **`<Text>`:** `onPress` / `onLongPress` on a top-level `<Text>` do nothing (on a nested span they work).
  `selectable`, `adjustsFontSizeToFit` and `minimumFontScale` are ignored.
- **`<TextField>`:** `editable={false}` is ignored (the user can still type). `autoCapitalize`, `autoCorrect`,
  `placeholderColor` (multiline: fixed grey) and `selectionColor` are ignored.
- **`<List>`:** `ListHeaderComponent`, `ListFooterComponent` and `ListEmptyComponent` are not drawn. `horizontal` is
  drawn vertical. `numColumns` / `columnWrapperStyle` give one column. The ref's `scrollToIndex`, `scrollToOffset`
  and `scrollToEnd` do nothing. `itemAnimation` and `reorderable` / `onReorder` are missing. Images are not preloaded.
- **`<Scroll>`:** the ref's `scrollTo` / `scrollToEnd` do nothing. `onScroll`, `onScrollBeginDrag`,
  `onScrollEndDrag` and `onMomentumScrollBegin` / `End` never fire. `pagingEnabled`, `snapToInterval`,
  `snapToOffsets`, `decelerationRate`, `keyboardDismissMode` and `refreshBackground` are ignored.
- **`<Carousel>`:** a `"%"` `itemWidth` is ignored.
- **`<Sheet>`:** `onDetentChange` never fires. The card is always white with 10 pt corners (Android uses the Sheet's
  `backgroundColor` and `borderRadius`).
- **Motion props:** `gesture`, `motion`, `rotateX` / `rotateY`, `cameraDistance`, `blurRadius`, `animateLayout` and
  `sharedTag` are ignored.
- **`<Svg>` filters:** only a plain drop shadow.
- **Impressions:** `impressionKey` / `useImpressions` report nothing.
- **Routes:** `secure: true` and `transparent: true` are ignored.

### Built-in modules and the runtime
- **`WebSocket`:** missing (see above).
- **`Motion`:** a stub (see above).
- **`fetch`:** `onUploadProgress` / `onDownloadProgress` never fire. `FormData` file parts take `file://` only, and
  are read whole into memory.
- **OTA:** no bsdiff patches; iOS always downloads full bundles.
- **Background tasks:** JS starts only with the app's window, so a task that arrives while JS isn't running waits for
  the next start.
- **`Dimensions` / `PixelRatio`:** sent once at start; no update on rotation or a text size change.
- **Native storage for Swift code (`ZNStorage`):** strings only (`set`, `get`, `remove`, `flush`).
- **Live reload (`zn dev`):** not on iOS (it uses `adb reverse`). Rebuild with `bun run ios`.

### Plugins
- **Android only (no iOS side):** `media`, `firebase-remote-config`, `firebase-perf`, `android-ad-id`.
- **`android-play-auth`:** an iOS stub (`phoneHint` / `listenOtp` answer "unavailable", `appHash` is `""`). Use
  `autoComplete="sms-otp"` on iOS.
- **`app-updates`:** `isUpdateAvailable` is always false, `start` / `complete` answer "unavailable", there is no
  `state` event. Only `openStore` works.
- **`image-viewer`:** only the native full-screen viewer (`imageviewer.full`). The TSX viewer (`ImageViewerScreen`,
  which needs Motion) is not drawn, and `content://` images are refused.
- **`webview`:** `onPause`, `onResume` and `onUpload` never fire.
- **`document-scanner`:** `galleryImport` and `mode` are ignored. If iOS ends the app while the camera is open, the
  scan is lost. There is no download status event.
- **`firebase-analytics`, `firebase-crashlytics`:** report the bundle as "built-in" even when an OTA bundle runs.
- **`firebase-messaging`:** data-only messages arrive only while the app runs, or as an occasional background wake
  that iOS limits.

### Different by design (not planned to change)
These follow what iOS allows. They are not gaps:
- `Modal`'s `onRequestClose` never fires (iOS has no system Back). `Alert`'s `cancelable` is Android only.
- `toast` is zero-native's own pill. `Vibration` has no length. `exitApp` isn't possible.
- `Os.info` gives `android: ""` and `sdk: 0`, plus an `ios` field. `Os.openUrl` refuses `intent:`, `file:` and
  `javascript:` links.
- `android.permission.*` names answer "denied". The contacts permission needs `ZN_CONTACTS`.
- `NetInfo`'s `isInternetReachable` means "has a route out". SecureStore items are cleared on the first start after a
  reinstall.
- `fetch` joins repeated headers with `", "`, except `Set-Cookie`.
- Ignored on iOS because there is nothing to map them to: `Text` `includeFontPadding`, `NavigationBar` `barStyle`,
  Location `turnOn` (answers "unavailable"), Scanner `autoZoom`, Lottie `mergePaths` / `opacityToLayers` /
  `safeMode`, WebView `thirdPartyCookies` (can't be turned on), notification channels and exact alarms.
- `device-info` values that exist only on Android answer `"unknown"`, `-1` or `false`.
