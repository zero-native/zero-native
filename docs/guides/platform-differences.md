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
| **Screenshot blocking (`secure: true`)** | `FLAG_SECURE` hides screenshots & recents | Not enforced at OS window level |
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
