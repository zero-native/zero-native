# Coming from Flutter

If you come from Flutter, you already appreciate declarative UI, fast native performance, and predictable layout. `zero-native` shares those goals — with two big differences:

1. **The OS draws the UI, not Impeller/Skia.** Your screens render with real Jetpack Compose (Android) and SwiftUI/UIKit (iOS) widgets — giving you smaller app sizes (measured at 6.42 MB for the Android v0 shell and 4.9 MB for the iOS sample), native text input, native accessibility, and native sheets out of the box.
2. **Over-the-air updates are built in.** Because screens compile to `.zn.ui` templates + Hermes bytecode instead of AOT native machine code, you can ship UI and logic updates over the air in seconds (including 3–93 KB bsdiff patches on Android; full-bundle OTA on iOS) without waiting for store review.

---

## The Mental Shift

| Concept | Flutter | zero-native |
|---|---|---|
| **Language** | Dart | TypeScript + TSX |
| **Rendering** | Own canvas (Impeller / Skia) | Native Jetpack Compose + SwiftUI / UIKit |
| **Rebuilding UI** | `setState()` / `Bloc` / `Riverpod` rebuilds widget subtrees | **No rebuilds.** Component runs once; signals patch leaf native slots directly |
| **Layout** | `Column`, `Row`, `Stack`, `Expanded`, `Padding` | `<Column>`, `<Row>`, `<Stack>`, `flex: 1`, `style={{ padding }}` |
| **OTA Updates** | Not built-in (Shorebird patches Dart AOT) | First-class, contract-checked, ECDSA-signed bundles & bsdiff patches (Android) |

---

## Side-by-Side Mapping

### Widgets → Components (`@zeronative/ui`)
| Flutter | zero-native | Notes |
|---|---|---|
| `Column` / `Row` / `Stack` | `<Column>` / `<Row>` / `<Stack>` | Exact same mental model! |
| `Container` / `DecoratedBox` / `Padding` | `<Box style={{ ... }}>` | Fixed modifier order (`margin → size → ... → padding`) |
| `Expanded(flex: 1)` | `style={{ flex: 1 }}` | Works inside `Column` and `Row` |
| `SizedBox(height: 12)` / `Spacer()` | `gap: 12` on parent, or `<Spacer style={{ flex: 1 }} />` | Prefer `gap` between siblings; `Spacer` needs `flex: 1` |
| `SingleChildScrollView` | `<Scroll>` | `horizontal` for horizontal rails |
| `ListView.builder` / `GridView.builder` | `<List data key row>` | Virtualized (`LazyColumn` / `UICollectionView`); `numColumns` for grids (Android today) |
| `PageView` | `<Carousel>` | Native snapping pager + `autoAdvance` |
| `Text` / `RichText` (`TextSpan`) | `<Text>` with nested `<Text>` spans | Supports inline `onPress` links |
| `GestureDetector` / `InkWell` | `<Pressable>` | Native ripple, highlight, `pressScale`, `haptic` |
| `TextField` / `TextFormField` | `<TextField>` | Native input; controlled via `value` + `onChangeText` |
| `showModalBottomSheet` | `<Sheet visible onDismiss detents="content,half">` | Controlled, native drag & spring |
| `showDialog` / `AlertDialog` | `<Modal>` or `Alert.alert(...)` | Native overlays |
| `ScaffoldMessenger.showSnackBar` | `toast("...")` | Native toast |
| `Image.network` / `Image.asset` | `<Image src="https://..." />` / `src="asset:..."` | Includes shimmer loading & fallback |
| `flutter_svg` | `<Svg>` or `import Logo from "./logo.svg"` | Compiled at build time |
| `CustomPaint` (`CustomPainter`) | `<Canvas commands={[draw.rect(...)]} />` | Native draw-phase 2D commands (Android today; iOS planned) |
| `SafeArea` | Route option `safeArea: "all" \| "none"` | Configured once per route |
| `PopScope` | `useBack(() => boolean)` | Return `true` to prevent pop |

### State Management
If you've used `ValueNotifier`, `ChangeNotifier`, or `Riverpod`, signals will click immediately:

```tsx
// Flutter: ValueNotifier<int>(0) + ValueListenableBuilder
// zero-native: signal(0) — no builder wrapper needed!

import { signal, computed } from "@zeronative/core"
import { Column, Text, Pressable } from "@zeronative/ui"

export function CounterScreen() {
  const count = signal(0)
  const isEven = computed(() => count() % 2 === 0)

  return (
    <Column style={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20 }}>
        {count()} ({isEven() ? "even" : "odd"})
      </Text>
      <Pressable onPress={() => count.set(count() + 1)}>
        <Text>Add 1</Text>
      </Pressable>
    </Column>
  )
}
```

- **`signal(v)`** ≈ `ValueNotifier`
- **`computed(() => ...)`** ≈ derived `Provider`
- **`effect(() => ...)`** ≈ `ref.listen`
- **`persistedSignal(key, v)`** ≈ `SharedPreferences` + reactive notifier (synchronous via MMKV)
- **`restorableSignal(key, v)`** ≈ `RestorationMixin` / `RestorableProperty`

### Navigation
```ts
// Flutter: Navigator.pushNamed(context, '/store/42')
// zero-native (fully typed, no BuildContext needed):
nav.push("store", { storeId: "42" })
nav.replace("checkout", { sessionId: "abc" })
nav.reset([{ name: "home" }])
nav.back()
```

### Platform Channels → Native Modules & Plugins
Instead of untyped `MethodChannel("my_channel").invokeMethod(...)`, declare a versioned `nativeModule("MyChannel", { version: 1 })` in TypeScript. The compiler automatically records the module and version in the OTA capability manifest so older app binaries never receive a bundle that calls a native method they don't have.
