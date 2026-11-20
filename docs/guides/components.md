# Components Reference

All UI components are imported from `@zeronative/ui`. The compiler strips `@zeronative/ui` imports and compiles them straight into binary templates rendered by Jetpack Compose (Android) and SwiftUI/UIKit (iOS).

---

## 1. Layout Containers

| Component | Native mapping | Purpose |
|---|---|---|
| `<Column>` | Compose `Column` / SwiftUI `VStack` | Vertical layout |
| `<Row>` | Compose `Row` / SwiftUI `HStack` | Horizontal layout (supports `flexWrap: "wrap"`) |
| `<Stack>` | Compose `Box` / SwiftUI `ZStack` | Layered children & `position: "absolute"` |
| `<Box>` | Compose `Box` / SwiftUI container | Generic styled wrapper |
| `<View>` | Compiles to `<Column>` or `<Row>` | React Native alias (`flexDirection: "row"` → `Row`) |
| `<Spacer>` | Flexible gap | Add `style={{ flex: 1 }}` to fill remaining space in a `Row` or `Column` |

### `<Scroll>`
Scrollable container for short-to-medium content or horizontal rails.
- `horizontal?: boolean` — makes a lazy horizontal rail.
- `refreshing`, `onRefresh`, `refreshColor`, `refreshBackground` (or RN's `refreshControl={<RefreshControl ... />}`) — controlled pull-to-refresh on vertical `Scroll`.
- `keyboardDismissMode?: "none" | "on-drag" | "interactive"`
- Snapping (UI thread): `pagingEnabled`, `snapToInterval`, `snapToOffsets`, `snapToAlignment`, `disableIntervalMomentum`, `decelerationRate`.
- Scroll events: `onScroll`, `onScrollBeginDrag`, `onScrollEndDrag`, `onMomentumScrollBegin`, `onMomentumScrollEnd`, `scrollEventThrottle`.
- Programmatic scrolling via `ref` (`scrollTo({ x, y, animated })`, `scrollToEnd({ animated })`).

---

## 2. Text & Nested Spans

```tsx
<Text style={{ fontSize: 15, color: "#374151" }} numberOfLines={2}>
  By continuing you agree to our{" "}
  <Text style={{ color: "#2563EB", fontWeight: 600 }} onPress={openTerms}>
    Terms of Service
  </Text>
  .
</Text>
```

- **Key props:** `numberOfLines`, `allowFontScaling` (`false` = `maxFontScale={1}`), `selectable` (Android), `adjustsFontSizeToFit` (Android), `minimumFontScale` (Android), `onPress`, `onLongPress`.
- **Nested `<Text>` spans:** Support build-time and runtime styles plus `onPress` for inline links.

---

## 3. Buttons & Tappable Areas

### `<Pressable>`
The primary tappable component.
- **Events:** `onPress`, `onPressIn`, `onPressOut(cancelled?)`, `onLongPress`, `onPressRepeat` (with `repeatDelay` & `repeatInterval`).
- **Feedback:** `pressFeedback` (`"ripple"` | `"highlight"` | `"none"`), `rippleColor`, `rippleOpacity`, `rippleBorderless`, `rippleRadius`, `highlightColor`, `pressScale` (e.g. `0.96`), `pressOpacity` (e.g. `0.7`), `haptic` (respects system haptics), `hitSlop`, `disabled`.
- **React Native aliases:** `<TouchableOpacity activeOpacity={0.6}>`, `<TouchableHighlight underlayColor="...">`, `<TouchableWithoutFeedback>`.

---

## 4. Text Input & OTP

### `<TextField>`
Native text input (`BasicTextField` on Android, `UITextField`/`UITextView` on iOS). Native owns typing so there is zero per-keystroke lag.

```tsx
import { signal, createRef, type TextFieldHandle } from "@zeronative/core"
import { TextField } from "@zeronative/ui"

const phone = signal("")
const inputRef = createRef<TextFieldHandle>()

<TextField
  ref={inputRef}
  value={phone()}
  onChangeText={(t) => phone.set(t.replace(/\D/g, "").slice(0, 10))}
  placeholder="Mobile number"
  keyboardType="phone-pad"
  autoComplete="tel-national"
  returnKeyType="done"
  onSubmitEditing={submit}
/>
```

- **Props:** `value`, `onChangeText`, `placeholder`, `placeholderColor` / `placeholderTextColor`, `keyboardType`, `secureTextEntry`, `maxLength`, `multiline`, `autoFocus`, `editable`, `autoCapitalize`, `autoCorrect`, `selectionColor`, `autoComplete`, `returnKeyType`, `onSubmitEditing`, `onFocus`, `onBlur`.
- **Ref handle:** `focus()`, `blur()`, `clear()`, `isFocused()`.
- **Keyboard API:** `Keyboard.dismiss()` and keyboard show/hide height events from `@zeronative/core`.

### `<OtpInput>`
First-class native OTP boxes (compatible with `react-native-otp-entry` props):
- One hidden native input drives the boxes — typing, paste, OS `sms-otp` / `one-time-code` autofill, and programmatic `ref.current.setValue(code)` all work seamlessly.
- Props: `numberOfDigits`, `type` (`"numeric"` | `"alpha"` | `"alphanumeric"`), `autoFocus`, `blurOnFilled`, `secureTextEntry`, `disabled`, `error`, `onTextChange`, `onFilled`, `theme` (box, focused, filled, disabled, error, and text styles), `ref` (`createRef<OtpInputHandle>()`).

---

## 5. Virtualized Lists

Use `<List>` (or its RN alias `<FlatList>`) for long or growing datasets. Native tracks every row's key and kind while JS only mounts rows near the viewport (removing rows outside a wider buffer band), and off-screen instances drop observable cells to stay lightweight.

```tsx
import { listController } from "@zeronative/core"
import { List, Row, Text } from "@zeronative/ui"

const ctrl = listController()

<List
  controller={ctrl}
  data={transactions()}
  key={(item) => item.id}
  row={(item) =>
    item.kind === "header" ? (
      <Text style={s.section}>{item.title}</Text>
    ) : (
      <Row style={s.row}>
        <Text>{item.merchant}</Text>
        <Text>₹{item.amount}</Text>
      </Row>
    )
  }
  onEndReached={loadMore}
  refreshing={refreshing()}
  onRefresh={reload}
/>
```

- **Row kinds:** A ternary (`cond ? <A /> : <B />`) inside `row` compiles into separate typed native row templates (`contentType` in Compose).
- **RN FlatList syntax works too:** `renderItem={({ item, index }) => ...}` and `keyExtractor={(item) => item.id}` are supported.
- **Features:**
  - `horizontal` (lazy horizontal list)
  - `numColumns` (2–12 column grid) + `columnWrapperStyle`
  - `inverted` (chat lists: newest item at index 0 at the bottom)
  - `stickyHeaderIndices` (pinned section headers)
  - `ListHeaderComponent`, `ListFooterComponent`, `ListEmptyComponent`
  - `itemAnimation?: "fade" | "move"`
  - `reorderable` + `onReorder(from, to)` (native drag-to-reorder)
  - `controller` / `ref` with `scrollToIndex`, `scrollToEnd`, `scrollToOffset`
  - `impressionKey` on rows paired with `useImpressions(...)` for native viewport impression tracking

### `<Carousel>`
Native snapping pager for banners and hero cards:
- `itemWidth` / `pageWidth` (dp; `"%"` widths are Android-only today)
- `autoAdvance` (ms, runs natively without JS timers; pauses for `pauseAfterTouch` ms — default `3000` — after the user touches it, and pauses when off-screen)
- `dots`, `dotColor`, `activeDotColor`, `onPageChange(index)`

---

## 6. Overlays: `<Sheet>`, `<Modal>`, `Alert`, `toast`

### `<Sheet>`
Native draggable bottom sheet with velocity, rubber-banding, and spring settling (zero bridge events during drags):

```tsx
<Sheet
  visible={sheetOpen()}
  onDismiss={() => sheetOpen.set(false)}
  detents="content,half"
>
  <Column style={{ padding: 20, gap: 12 }}>
    <Text style={s.title}>Confirm Payment</Text>
    {/* ... */}
  </Column>
</Sheet>
```

- **Controlled:** `onDismiss` asks you to set `visible` to `false`; if you keep it `true`, the sheet springs back.
- `detents`: comma-separated `"content"`, `"half"`, `"full"` (first is initial).
- `dismissible?: boolean`, `animateIn?: boolean` (set `false` when restoring a sheet immediately after process death), `onDetentChange`.

### `<Modal>`
Full-screen overlay matching React Native's `<Modal>`:
- `visible`, `transparent`, `animationType` (`"none"` | `"fade"` | `"slide"`), `statusBarTranslucent`, `navigationBarTranslucent`, `onRequestClose`, `onShow`.

### `Alert` & `toast` (from `@zeronative/core`)
- `Alert.alert(title, message?, buttons?, options?)` — native OS alert dialog.
- `toast("Saved!", { duration: "short" })` (and RN's `ToastAndroid`) — lightweight native toast.

---

## 7. Images, SVG & Canvas

### `<Image>`
Loads remote URLs (`"https://..."`), bundled assets (`"asset:images/logo.png"`), or native file handles (`zn://...`).
- Props: `src` (or RN `source={{ uri }}`), `fallbackSrc`, `loading` (`"none"` | `"shimmer"`), `contentScale` (`"cover"` | `"contain"` | `"fill"`, or RN `resizeMode`), `tintColor`, `onLoad`, `onError`, `onLoadEnd`.
- List rows automatically preload upcoming images into the disk cache on a dedicated connection pool.

### `<Svg>` & `.svg` Imports
First-class compiled SVG — no runtime XML parser:
- **Import `.svg` files as components:**
  ```tsx
  import Logo from "./logo.svg"
  <Logo size={28} color="#111827" parts={{ badge: { fill: active() ? "#10B981" : "#9CA3AF" } }} />
  ```
- **Inline `<Svg>`** with `react-native-svg` elements: `G`, `Path`, `Rect`, `Circle`, `Ellipse`, `Line`, `Polyline`, `Polygon`, `Defs`, `LinearGradient`, `RadialGradient`, `Stop`, `ClipPath`, `Mask`, `Use`.
- Named parts (`id="..."`) support runtime paint, opacity, transforms, `trimStart` / `trimEnd` / `trimOffset` line drawing, `animate`, and UI-thread motion values.

### `<Canvas>`
Native 2D drawing canvas (draw phase only, no Skia required):
- Pass `commands` built with `draw.*` helpers from `@zeronative/core` (`rect`, `roundRect`, `circle`, `oval`, `line`, `arc`, `path`, `text`, `paragraph`, `image`, `save`/`restore`, `translate`/`scale`/`rotate`, `clipRect`/`clipPath`).
- Supports gradients, shadows, blur, blend modes, and UI-thread motion values. *(Android today; iOS coming soon.)*

---

## 8. Controls, Indicators & Tabs

- **`<Switch>`** — controlled toggle (`value`, `onValueChange`, `disabled`, `trackColor`, `activeTrackColor`, `thumbColor`).
- **`<Checkbox>`** — controlled checkbox (`value`, `onValueChange`, `disabled`, `color`, `activeColor`).
- **`<Spinner>`** (RN alias `<ActivityIndicator>`) — draw-phase circular spinner (`size`, `color`).
- **`<Progress>`** — determinate (`value` 0–1) or indeterminate progress bar (`color`, `trackColor`).
- **`<Shimmer>`** — skeleton placeholder synced to a shared frame clock (`baseColor`, `highlightColor`, `period`).
- **`<Tabs selected={tabs.index()}>`** — keeps each tab's JS state and native scroll position alive while only drawing the active tab (see [Navigation](navigation.md#4-bottom-tabs)).
- **`<StatusBar>` / `<NavigationBar>`** — declarative system bar styling per screen.
- **`<NativeView name="..." props={...} onEvent={...} />`** — embeds a native plugin view directly inside TSX.

---

## 9. Accessibility & Testing

Standard layout, text, media, and input components support:
- `accessibilityLabel` (or `"aria-label"`), `accessibilityHint`, `accessibilityRole` (or `role`), `accessibilityHidden` (or `"aria-hidden"` / `accessibilityElementsHidden` / `importantForAccessibility`).
- `testID` — maps to native UI test resource IDs on Android (`uiautomator` / Espresso; not yet wired on iOS).
- `onLayout` — reports `{ nativeEvent: { layout: { x, y, width, height } } }` in dp after layout changes.
- `pointerEvents` — `"auto"` | `"none"` | `"box-none"` | `"box-only"`.
