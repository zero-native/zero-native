# Styling and layout

Part of the zero-native spec. The summary is in `ARCHITECTURE.md` §5.4; this file has the full rules.
**Status: decided (2026-10-29).**

## 1. The decision in one paragraph
Authors style nodes with a **`style` prop** using **React Native style names** (a supported subset). The framework,
not the author, turns a style into native layout and drawing, in **one fixed order** (§4). Layout is done by
**Compose** (Android) and **SwiftUI** (iOS). There is **no Yoga** and no second layout engine. Static styles are
**folded into the compiled `.zn.ui` template** at build time; only values that change at runtime become slots.
Unsupported keys are **build errors**.

Why not Compose-style modifier chains (`ui.padding(16).background(...)`): chains are order-dependent (padding then
background is a different picture from background then padding), they feel foreign in JSX, and they make porting RN
code a full rewrite. A fixed order covers almost every design; the rare exception is handled by nesting a `Box`.
(Background: `argon_opus_architecture_report_modifiers_vs_props.md`. Its four visual bugs were not caused by chaining
itself; see `docs/v0-findings.md` §G. But the conclusion holds for the reasons above.)

## 2. Authoring
```tsx
const s = StyleSheet.create({          // only for typing and reuse; the compiler folds it into the template
  card: {
    marginHorizontal: 16,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: c.line,
  },
  cardSelected: { borderColor: c.primary },
})

<Row style={[s.card, selected() && s.cardSelected]} justifyContent="space-between" alignItems="center">
  <Text style={t.title}>{merchant()}</Text>
  <Text style={[t.amount, { color: isCredit() ? c.credit : c.text }]}>{amount()}</Text>
</Row>
```
- `style` takes an object or an array. Falsy array entries are skipped. Later entries win.
- **Static parts** (constants, tokens, `StyleSheet` entries) are resolved by the compiler and stored in the template.
- **Dynamic parts** (anything reading a signal or a prop) become **slots**: one slot per style key that can change.
  A conditional array entry (`selected() && s.cardSelected`) becomes slots for the keys that entry can change.
- Layout props that are usually set per node (`justifyContent`, `alignItems`, `gap`) may be written either as props or
  inside `style`. Both compile to the same thing.
- Design tokens (`c.*` colours, `t.*` text styles, spacing scale) are a typed TS module, compiled in as constants.
  Dark mode: native picks the token set at runtime; JS does not re-render.
- Units: numbers are dp (Android) / pt (iOS). Strings ending in `%` are percentages of the parent's content box.

## 3. Supported keys (v1)

### 3.1 Layout
| Key | Values | Compose | SwiftUI |
|---|---|---|---|
| `flex` | number ≥ 0 | `Modifier.weight(n)` in Row/Column | layout priority + `.frame(maxWidth/maxHeight: .infinity)` |
| `justifyContent` | `flex-start` `center` `flex-end` `space-between` `space-around` `space-evenly` | `Arrangement.*` | `Spacer`s / alignment |
| `alignItems` | `flex-start` `center` `flex-end` `stretch` | `Alignment.*` (+ stretch rule §5) | `alignment:` |
| `alignSelf` | same as alignItems | `Modifier.align(...)` | `.frame(alignment:)` |
| `gap`, `rowGap`, `columnGap` | number | `Arrangement.spacedBy` | `spacing:` |
| `flexWrap` | `wrap` (Row only) | renders as `FlowRow` | custom wrapping `Layout` |
| `width`, `height` | number, `'N%'`, `'auto'` | `width/height`, `fillMaxWidth(f)` | `.frame` / `containerRelativeFrame` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | number | `widthIn / heightIn` | `.frame(min:max:)` |
| `aspectRatio` | number | `aspectRatio` | `.aspectRatio` |
| `margin`, `marginHorizontal`, `marginVertical`, `marginTop/Bottom/Start/End` | number ≥ 0 | outer `padding` (§4 step 1) | outer `.padding` |
| `padding` + same variants | number ≥ 0 | inner `padding` (§4 step 9) | inner `.padding` |
| `position: 'absolute'` + `top/bottom/start/end` | only for children of `Stack` | `Box` + `align` + `offset` | `ZStack` + `.offset` / alignment |
| `zIndex` | number, only inside `Stack` | `zIndex` | `.zIndex` |
| `overflow` | `visible` (default), `hidden` | `clip(shape)` | `.clipShape` |
| `display` | `none` only | not composed | not rendered |

There is no `flexDirection`: direction comes from the component (`Row`, `Column`, `Stack`). The future NativeWind
translator (§8) maps `View` + `flex-row` to `Row`.

### 3.2 Drawing
| Key | Notes |
|---|---|
| `backgroundColor` | colour or token |
| `borderRadius`, `borderTopStartRadius`, ... | one shape is built from all corner values and shared by background, border, clip, press feedback and shadow |
| `borderWidth`, `borderColor` | uniform border |
| `borderTopWidth`, `borderBottomWidth`, ... (+ colours) | per-side borders (dividers are common in RN code); drawn with `drawBehind` on Android [check cost] |
| `opacity` | `graphicsLayer(alpha)` |
| `transform` | `[{ scale }, { scaleX }, { scaleY }, { translateX }, { translateY }, { rotate: '45deg' }]` → `graphicsLayer` |
| `elevation`, `shadowColor`, `shadowOpacity`, `shadowRadius`, `shadowOffset` | mapped to one platform shadow; Android uses `shadow(elevation, shape)`, so shadow colour/offset are approximations (documented in `docs/platform-differences.md`) |

### 3.3 Text (only on `Text` and `TextField`)
`color`, `fontSize`, `fontWeight`, `fontFamily`, `fontStyle`, `lineHeight`, `letterSpacing`, `textAlign`,
`textDecorationLine`, `textTransform`. Line limits are props: `numberOfLines`, `ellipsize`. `autoShrink` (shrink the
font to fit, needed for 7-digit amounts) is a prop.

### 3.4 Not supported (build errors with a hint)
`flexDirection`, `flexShrink`, `flexBasis`, `alignContent`, `position: 'relative'` with offsets, negative margins
(Compose padding can't be negative; use `transform: translate`), `display: 'flex'|'contents'`, web-only keys.
A key we don't support is **never silently ignored**.

## 4. The fixed order (decided)
The renderer builds every node's modifier chain in this order, outer to inner. Authors can't change it.

| Step | Style keys | Compose |
|---|---|---|
| 1. Outer spacing | `margin*` | `padding(...)` |
| 2. Size | `width`, `height`, `min*/max*`, `aspectRatio`, `flex`, `alignSelf` | `size / widthIn / weight / aspectRatio / align` |
| 3. Transform | `opacity`, `transform` | `graphicsLayer` |
| 4. Shadow | `elevation`, `shadow*` | `shadow(shape)` |
| 5. Background | `backgroundColor`, `borderRadius` | `background(color, shape)` |
| 6. Border | `border*` | `border(width, color, shape)` / `drawBehind` |
| 7. Clip | `overflow: 'hidden'` | `clip(shape)` |
| 8. Press feedback | (only `Pressable` / `Button`) | `indication` (stays inside the shape) |
| 9. Inner spacing | `padding*` + border width | `padding(...)` |
| 10. Content | children / text | — |

SwiftUI applies the same steps in the same order (modifiers there are also outer-to-inner).
If a design needs another layering (two borders, a background outside a border), the author nests a `Box`.

## 5. zn flex rules (our documented semantics, not CSS)
These follow React Native wherever Compose and SwiftUI make it cheap, and say so where they don't.
1. **Sizing box:** `width` / `height` include padding and border, not margin (React Native behaviour).
2. **Borders take space:** a border pushes content inward. Compose doesn't do this by itself, so the renderer adds
   the border width to the inner padding (step 9).
3. **`flex: n`** shares the space left after the children without `flex`, in proportion to `n`. Children without
   `flex` take their natural size. (`flexShrink` doesn't exist; a too-wide row of fixed children overflows, as in RN
   with its default `flexShrink: 0`.)
4. **`alignItems: 'stretch'` is the default in `Column`** (as in RN): children without an explicit width fill the
   width (`fillMaxWidth`). **In `Row`, stretch only applies when the Row has a fixed height**; otherwise it behaves as
   `flex-start`, because stretching to an unknown height needs intrinsic measurement, which is slow. This is a known
   difference from RN, listed in `docs/platform-differences.md`.
5. **Percentages** are of the parent's content box (inside its padding).
6. **Margins never collapse.** `gap` is preferred for space between siblings; margins are allowed for porting.
7. **Text** measures natively (Compose text layout / CoreText). Line height, font metrics and wrapping can differ by a
   pixel or two between platforms; the conformance tests (§9.5 of ARCHITECTURE) set the tolerance.

## 6. Safe areas and the keyboard (decided)
Handled by **native code per route**, never by a JS `SafeAreaView`:
- `@route(path, { safeArea: 'all' | 'none' | { top?: boolean, bottom?: boolean } })`, default `'all'`.
- Android: edge-to-edge is on; the screen host applies `windowInsetsPadding(WindowInsets.safeDrawing)` for the chosen
  edges (Compose foundation; **not** material3's `Scaffold`, which we don't ship). iOS: `.ignoresSafeArea(edges:)`.
- Full-bleed screens (a coloured header behind the status bar) use `safeArea: { top: false }` and read the read-only
  `insets()` signal (`{ top, bottom, start, end, ime }`) to pad their own header.
- The keyboard (IME) inset is applied by native for screens with text input (`keyboard: 'resize' | 'none'` route
  option), so focused fields stay visible.
- Background: v0 bridged insets into JS through a `SafeAreaView`; it caused a blank screen and status-bar /
  nav-bar overlap (`docs/v0-findings.md` §H).

## 7. Animation keys
`animate={{ scale: spring({ stiffness: 400, damping: 30 }), opacity: tween(150) }}`: when the slot behind a style key
changes, native animates to the new value (ARCHITECTURE §10). Only numeric drawing keys (`opacity`, `transform`,
`backgroundColor`, sizes) can animate.

## 8. Later: NativeWind `className` translator (v1.1, not decided)
ZeroBill's RN app is written with NativeWind classes (`className="flex-row px-[16px] bg-white rounded-xl"`), not
mostly `StyleSheet`. A compile-time translator from a Tailwind subset to the style keys above would make porting
close to mechanical. It is pure build-time work (no runtime cost) and can come after v1.
