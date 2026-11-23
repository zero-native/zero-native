# Platform differences

Known, accepted differences between zero-native on Android (Compose) and iOS (SwiftUI), and between zero-native
and React Native semantics. The renderer conformance tests (ARCHITECTURE §9.5) check everything **not** listed here.
Add a row whenever a test needs a tolerance or a rule differs by platform.

| Area | Difference | Why | Status |
|---|---|---|---|
| `alignItems: 'stretch'` in `Row` | Only applies when the Row has a fixed height and `alignItems: 'stretch'` is written; unset acts as `flex-start` even with a height (RN stretches always). Checked by the layout conformance screen (case 26) | Stretching to an unknown height needs intrinsic measurement, which is slow | decided |
| `flexShrink`, `flexBasis` | Only `flexShrink` 0 or 1 and `flexBasis` 0 or `"auto"`, and only at build time; all are dropped (zero-native never shrinks a child; give it a width or a flex). Other values are a build error | No cheap mapping to Compose / SwiftUI layout | decided |
| `alignContent` | Works on a wrapped Row (`flexWrap: "wrap"`), both platforms; `"stretch"` is a build error (lines keep their own height) | Same as `flexShrink` | decided |
| Shadows | Android uses elevation shadows: `shadowColor` / `shadowOffset` are approximated | Compose `shadow()` is elevation-based | decided |
| Text metrics | Line height, font metrics and wrapping may differ by 1–2 px | Different native text engines | tolerance set by conformance tests |
| Per-side borders | Drawn with `drawBehind` on Android | Compose `border()` is uniform | [check cost] |
| Shared elements | Android: Compose's shared transitions; iOS: the element flies in UIKit (ZnShared.swift, iOS 17+), not inside Sheets / Modals or with ZN_IOS_NAV=swiftui | Platform API maturity | built on both (iOS on the simulator, 2026-11-23) |
| UPI result delivery | Android: activity result; iOS: app switch + callback URL | OS design | handled by flows (ARCHITECTURE §20) |
