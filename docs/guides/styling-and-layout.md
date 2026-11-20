# Styling & Layout

`zero-native` uses React Native's `style` prop and familiar CSS-like property names — **without Yoga**. At build time, static styles are folded directly into the binary `.zn.ui` template; at runtime, Compose (Android) and SwiftUI/UIKit (iOS) lay out and draw everything natively.

> **Build-time checks:** Unsupported style keys and invalid values fail the build with the exact file, line, and column. (A few React Native compatibility keys — `shadowOffset`, `shadowOpacity`, `shadowRadius`, and `flexShrink: 0 | 1` — are accepted and ignored so ported code compiles cleanly.)

---

## 1. Authoring Styles

Pass a style object, an array of styles, or `StyleSheet.create(...)`:

```tsx
import { Column, Text, StyleSheet } from "@zeronative/ui"

export function Card(props: { active: boolean }) {
  return (
    <Column style={[s.card, { borderColor: props.active ? "#2563EB" : "#E5E7EB" }]}>
      <Text style={s.title}>Hello</Text>
    </Column>
  )
}

const s = StyleSheet.create({
  card: { padding: 16, borderRadius: 12, borderWidth: 1, backgroundColor: "#FFFFFF" },
  title: { fontSize: 16, fontWeight: 600, color: "#111827" },
})
```

- `StyleSheet.create`, `StyleSheet.absoluteFill`, `StyleSheet.absoluteFillObject`, `StyleSheet.hairlineWidth` (`0.4`), and `StyleSheet.flatten` all work.
- **Conditional style arrays** like `[s.a, active() && s.b]` are a **build error** — use a ternary inside a style object (`{ backgroundColor: active() ? "#000" : "#FFF" }`) for dynamic keys so the compiler knows the exact slot.
- **Units:** All lengths are in `dp` (Android) / `pt` (iOS). Text sizes respect the user's system font-scale setting on Android (cap with `maxFontScale` or disable with `allowFontScaling={false}`).

---

## 2. The Fixed Modifier Order

In Jetpack Compose and SwiftUI, modifier order changes how a view looks (e.g., padding before vs. after background). To eliminate order-dependent bugs, `zero-native` always applies style properties in **one fixed, predictable order**:

```
margin → size → transform → shadow → background → border → clip → press feedback → padding → content
```

- **Box model (same as React Native):** `width` and `height` include `padding` and `borderWidth`, and exclude `margin`. Borders push inner content inward.
- If you ever need custom layering (such as a background *inside* a padding), wrap the inner content in a `<Box>` or `<Column>`.

---

## 3. Supported Style Keys

### Layout & Sizing
- **Size:** `width`, `height` (numbers, `"%"`, `"auto"`, or motion values), `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `aspectRatio` (number or `"16/9"`)
- **Flex:** `flex` (or `flexGrow`), `justifyContent`, `alignItems`, `alignSelf`, `flexWrap` (`"wrap"` / `"nowrap"` on `Row`), `alignContent` (on wrapped `Row`), `gap`, `rowGap`, `columnGap`
- **Spacing:** `margin`, `marginHorizontal`, `marginVertical`, `marginTop`, `marginBottom`, `marginStart`, `marginEnd` (plus `marginLeft` / `marginRight` aliases), and matching `padding*` keys
- **Positioning:** `position` (`"relative"` | `"absolute"` — **`position: "absolute"` is a build error outside `<Stack>`**), `top`, `bottom`, `start`, `end` (plus `left` / `right` aliases), `zIndex`, `display` (`"flex"` | `"none"`)
- **Direction:** `flexDirection` (`"row"` | `"column"`) works on `<View>`, `<Pressable>`, and the `<Touchable*>` aliases. Elsewhere, pick `<Row>` or `<Column>` directly.

### Drawing & Effects
- **Background:** `backgroundColor` (`#hex`, `rgb()`, `rgba()`, `"transparent"`, CSS named colors, or motion color), `backgroundImage` (`"linear-gradient(...)"`, build-time)
- **Borders:** `borderWidth`, `borderTopWidth`, `borderBottomWidth`, `borderColor`, `borderStyle` (`"solid"` | `"dashed"` | `"dotted"`), `borderRadius`, and per-corner radii (`borderTopStartRadius`, `borderTopLeftRadius`, etc.)
- **Shadows:** `elevation` and `shadowColor` draw shadows on both platforms (`shadowOffset`, `shadowOpacity`, and `shadowRadius` are accepted for RN compatibility and ignored on both platforms).
- **Visual:** `opacity`, `overflow` (`"visible"` | `"hidden"`), `blurRadius` (Android 12+), `cameraDistance`
- **Transforms:** `transform: [{ scale, scaleX, scaleY, translateX, translateY, rotate, rotateX, rotateY }]`, `transformOrigin` (keywords or percents like `"top left"`, `"50% 100%"`)

### Text (on `<Text>` and `<TextField>`)
- `color`, `fontSize`, `fontWeight` (`"normal"`, `"bold"`, or numeric `100`–`900`), `fontStyle` (`"normal"` | `"italic"`), `fontFamily` (Android today)
- `lineHeight`, `letterSpacing`, `textAlign` (`"start"` | `"center"` | `"end"` | `"left"` | `"right"` | `"auto"`), `numberOfLines`
- `textDecorationLine` (`"none"` | `"underline"` | `"line-through"`), `textDecorationStyle` (`"solid"` | `"dashed"` | `"dotted"`)
- `textTransform` (`"none"` | `"uppercase"` | `"lowercase"` | `"capitalize"`), `includeFontPadding` (default `false`), `maxFontScale`

---

## 4. Layout Rules (`zn` Flex)

1. **Choose your container explicitly:**
   - `<Column>` stacks children vertically (default `alignItems: "stretch"`).
   - `<Row>` lays children out horizontally.
   - `<Stack>` layers children on top of each other (required for `position: "absolute"`).
   - `<Box>` is a single-child / simple wrapper container.
   - `<View>` compiles to `<Column>` (or `<Row>` if `style={{ flexDirection: "row" }}`).
2. **`alignItems: "stretch"` in a `<Row>`:** Only stretches children when the `Row` has an explicit height **and** `alignItems: "stretch"` is written. Otherwise it acts like `"flex-start"`.
3. **Scrollable containers:** On `<Scroll>` and `<List>`, padding in `style` (or `contentContainerStyle`) scrolls **with** the content. Set padding in one place only (setting both is a build error).
4. **RTL support:** Use `start` / `end` (`paddingStart`, `marginEnd`, `textAlign: "start"`). `left` / `right` aliases map to `start` / `end` so they flip automatically in right-to-left locales.
5. **Dynamic vs. build-time style keys:** Any style key not supported as a dynamic slot (`DynamicProps`) with a runtime value is a **build error** — that includes structural keys (`alignItems`, `justifyContent`, `alignSelf`, `position`, `flexDirection`, `flexWrap`, `backgroundImage`, `fontFamily`, `transformOrigin`) as well as `fontWeight`, `textAlign`, `overflow`, `zIndex`, `elevation`, `shadowColor`, and `borderStyle`.
   - Colors, opacity, transforms, `borderWidth`, `borderColor`, padding, and margin update dynamically on **both** platforms.
   - Runtime `width`, `height`, `min`/`max`, `flex`, `gap`, `aspectRatio`, corner radii, `top`/`bottom`/`start`/`end`, `fontSize`, `lineHeight`, `letterSpacing`, and `display` are **Android-only** today (see [Platform Differences](platform-differences.md)).

---

## 5. Safe Areas, Status Bar & Keyboard

Safe areas and keyboard avoidance are configured **per route** in `routes.ts` — no `<SafeAreaView>` wrapper needed:

```ts
export const routes = defineRoutes({
  home: {
    path: "/",
    screen: HomeScreen,
    safeArea: "all",       // "all" (default) | "none" | { top?: boolean; bottom?: boolean }
    keyboard: "resize",    // "resize" (default) | "none"
  },
})
```

- For full-bleed screens (`safeArea: "none"`), read live insets with `insets()` from `@zeronative/core` (`insets().top`, `insets().bottom`).
- Control status bar and navigation bar colors/icons declaratively inside any screen with `<StatusBar barStyle="light-content" backgroundColor="#111827" />` and `<NavigationBar barStyle="dark-content" />`.

---

## 6. Dark Mode & Custom Fonts

### Dark mode
Read the OS theme reactively with `colorScheme()` (or RN's `useColorScheme()` / `Appearance`) from `@zeronative/core`:

```tsx
import { colorScheme } from "@zeronative/core"

const bg = () => (colorScheme() === "dark" ? "#0B0F19" : "#FFFFFF")
```

### Custom fonts (Android today; iOS planned)
Place `.ttf` / `.otf` files in `app/assets/fonts/` and reference them by file name (without extension) or shared family name:

```tsx
<Text style={{ fontFamily: "Poppins-SemiBold", fontSize: 18 }}>Welcome</Text>
// Or by family + weight:
<Text style={{ fontFamily: "Poppins", fontWeight: 600, fontSize: 18 }}>Welcome</Text>
```

If you reference a font name that isn't present in `app/assets/fonts/` (and isn't a system font like `"System"`, `"sans-serif"`, `"serif"`, `"monospace"`), the build fails immediately.
