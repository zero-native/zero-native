# Platform differences

Known, accepted differences between zero-native on Android (Compose) and iOS (SwiftUI), and between zero-native
and React Native semantics. The renderer conformance tests (ARCHITECTURE §9.5) check everything **not** listed here.
Add a row whenever a test needs a tolerance or a rule differs by platform.

| Area | Difference | Why | Status |
|---|---|---|---|
| `alignItems: 'stretch'` in `Row` | Only applies when the Row has a fixed height and `alignItems: 'stretch'` is written; unset acts as `flex-start` even with a height (RN stretches always). Checked by the layout conformance screen (case 26) | Stretching to an unknown height needs intrinsic measurement, which is slow | decided |
| `flexShrink`, `flexBasis`, `alignContent` | Not supported (build error) | No cheap mapping to Compose / SwiftUI layout | decided |
| Shadows | Android uses elevation shadows: `shadowColor` / `shadowOffset` are approximated | Compose `shadow()` is elevation-based | decided |
| Text metrics | Line height, font metrics and wrapping may differ by 1–2 px | Different native text engines | tolerance set by conformance tests |
| Per-side borders | Drawn with `drawBehind` on Android | Compose `border()` is uniform | [check cost] |
| Shared elements | Compose API still experimental; SwiftUI zoom transition needs iOS 18 | Platform API maturity | v1 optional |
| UPI result delivery | Android: activity result; iOS: app switch + callback URL | OS design | handled by flows (ARCHITECTURE §20) |
