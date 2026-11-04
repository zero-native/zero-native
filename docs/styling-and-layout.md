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
translator (§9) maps `View` + `flex-row` to `Row`.

### 3.2 Drawing
| Key | Notes |
|---|---|
| `backgroundColor` | colour or token (`#hex`, `rgb()`, `rgba()`, `transparent`) |
| `backgroundImage` | `"linear-gradient(<angle>deg \| to <side>, <colour> [N%], ...)"` (RN's CSS form); parsed at build time, drawn over `backgroundColor` in the same shape; build-time only (step 2.4b) |
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
   width (`fillMaxWidth`), **but only when the Column's own width is definite** (set by a width prop, shared out by
   `flex` in a Row, or itself stretched by its parent). A Column that shrinks to its content (for example inside an
   `alignItems: 'center'` parent) doesn't stretch its children, so a stretch never pushes a shrink-wrapped parent wider
   (step 1.3: a cashback badge wrongly went full width). **In `Row`, stretch only applies when the Row has a fixed height**; otherwise it behaves as
   `flex-start`, because stretching to an unknown height needs intrinsic measurement, which is slow. This is a known
   difference from RN, listed in `docs/platform-differences.md`.
5. **Percentages** are of the parent's content box (inside its padding).
6. **Margins never collapse.** `gap` is preferred for space between siblings; margins are allowed for porting.
7. **Text** measures natively (Compose text layout / CoreText). Line height, font metrics and wrapping can differ by a
   pixel or two between platforms; the conformance tests (§9.5 of ARCHITECTURE) set the tolerance.

## 6. Safe areas and the keyboard (decided)
Handled by **native code per route**, never by a JS `SafeAreaView`:
- Route option in `routes.ts`: `safeArea: 'all' | 'none' | { top?: boolean, bottom?: boolean }`, default `'all'`.
  Start / end (landscape cutouts, side navigation bars) are kept clear unless the route says `'none'`.
- Android (built in milestone 2 step 2.3): the Activity calls `enableEdgeToEdge()`; `ZnNavHost` pads each screen with
  `windowInsetsPadding` of **system bars + display cutout** for the chosen edges (Compose foundation; **not**
  material3's `Scaffold`, which we don't ship), and fills behind the bars with the screen root's background colour.
  The keyboard is not part of this (see below). iOS: `.ignoresSafeArea(edges:)`.
- Bar icons: the route option `statusBar: 'dark' | 'light'` sets the **status bar** icons (default dark icons, for
  light screens). The **navigation bar** icons follow the screen root's background (dark icons on a light screen), so
  a full-bleed screen with a dark header doesn't get a grey scrim over a light bottom bar (seen on the Lava).
  Registry 15: a `<StatusBar>` / `<NavigationBar>` in the screen wins over both while the screen is on top (icons,
  `hidden`), and its `backgroundColor` is drawn behind the bar for that screen (guide-notes §43).
- Full-bleed screens (a coloured header behind the status bar) use `safeArea: { top: false }` and read the read-only
  `insets()` signal (`{ top, bottom, start, end }`, dp) to pad their own header: `paddingTop: insets().top + 24`.
  Per-edge padding (`paddingTop/Bottom/Start/End`) may change at runtime for this (registry v4); it is read in the
  **layout phase**, so an inset change re-measures that node and recomposes nothing. Native sends insets only when
  they change. Until the first value arrives they are 0 (only a full-bleed **start** screen could show that for one
  frame).
- The keyboard (IME) inset is applied by native for screens with text input (`keyboard: 'resize' | 'none'` route
  option), so focused fields stay visible.
- Background: v0 bridged insets into JS through a `SafeAreaView`; it caused a blank screen and status-bar /
  nav-bar overlap (`docs/v0-findings.md` §H).

## 7. Animation keys
`animate={{ scale: spring({ stiffness: 400, damping: 30 }), opacity: tween(150) }}`: when the slot behind a style key
changes, native animates to the new value (ARCHITECTURE §10). Only numeric drawing keys (`opacity`, `transform`,
`backgroundColor`, sizes) can animate.

## 8. How a style becomes Compose code (worked example)

**Performance note (2026-10-29):** style props and modifier chains cost the same at runtime. On Android everything
ends up as a Compose `Modifier` chain either way; what costs time is *how often* we build it. v0 rebuilt modifiers
from JSON with an observable per prop; v1 builds each node's chain **once**, at template preparation. The choice of
`style` over chains is about correctness, familiar JSX and porting, not speed.

### 8.1 The path
1. **Build time:** the compiler resolves static styles into the node's entry in `.zn.ui`. Each style key that can
   change becomes a slot (slot → node + style key).
2. **Template preparation (once per template):** each node's static style becomes a pre-built `Modifier` in the fixed
   order (§4). Dynamic keys get small modifier pieces at their fixed position that read the slot's cell.
3. **Composition:** the node's composable uses that chain object as-is. No rebuilding, no parsing.
4. **A slot changes:** only the work tied to that slot runs (§8.3).

### 8.2 Worked example: unusual layering
A Kotlin developer might write:
```kotlin
Box(Modifier
  .background(red)      // red fills the whole box
  .padding(1.dp)        // → a 1 dp red ring stays visible
  .background(blue)     // blue fills what's inside the ring
  .padding(16.dp)       // → a 16 dp blue band
  .clickable { … }      // tap area + ripple = only what's inside the blue band
  .padding(8.dp, 4.dp)  // inside the tap area; blue shows through this band
  .background(green)    // green fills the innermost area
) { Text("Click me!") }
```
(Moving `.clickable` one step earlier silently changes the tap area. This is the class of bug the fixed order removes.)

In zn TSX each layer is a nested node, each with the one fixed order:
```tsx
<Box style={{ backgroundColor: red, padding: 1 }}>                                   {/* red ring */}
  <Box style={{ backgroundColor: blue, padding: 16 }}>                               {/* blue band */}
    <Pressable onPress={…} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>     {/* tap area */}
      <Text style={{ backgroundColor: green }}>Click me!</Text>
    </Pressable>
  </Box>
</Box>
```
Inside `Pressable` the order puts press feedback before padding, which is exactly `.clickable.padding(8, 4)`: the
ripple covers the 8/4 band. Same picture, same tap area.

On iOS, SwiftUI modifiers also depend on order but read the other way (each modifier wraps the view above it), so the
iOS renderer applies the same steps mirrored. Authors never see this.

### 8.3 Two renderer optimisations (planned; build them only if they don't cause real problems)
These are **not required for correctness**. Decided 2026-10-29: implement while building the renderer, and drop or
defer either one if it turns out to cause hard bugs or complexity.

1. **Merge decoration-only boxes.** At template preparation, a `Box` with exactly one child and only drawing and
   padding styles (no size, alignment, events, accessibility role or `heroTag`) can be merged into its child's chain:
   its chain becomes a prefix of the child's. The nested TSX above then emits one flat chain, the same one a Kotlin
   developer would write:
   ```kotlin
   Box(Modifier.background(red).padding(1.dp).background(blue).padding(16.dp)
           .clickable(…).padding(horizontal = 8.dp, vertical = 4.dp)) {
     BasicText("Click me!", Modifier.background(green))
   }
   ```
   Without merging, the extra boxes cost microseconds; this is a small win, not a fix.
2. **Read each slot in the cheapest Compose phase.** Compose has three phases: composition, layout, draw. A dynamic
   style key only wakes the phase it affects. The chain object never changes; it holds the slot cell, and a lambda
   reads the value when its phase runs.

   | Style key changes | Read in | Cost |
   |---|---|---|
   | `backgroundColor`, `borderColor`, `opacity`, `transform` | draw (`drawBehind { }`, `graphicsLayer { }`) | redraw only |
   | `width`, `height`, `padding`, `margin` | layout (`layout { }`, offset lambdas) | relayout of that node |
   | text content, show / hide, structure | composition | recompose that leaf |

   A press colour change or a fade then redraws one node and nothing else.

## 9. Later: NativeWind `className` translator (v1.1, not decided)
ZeroBill's RN app is written with NativeWind classes (`className="flex-row px-[16px] bg-white rounded-xl"`), not
mostly `StyleSheet`. A compile-time translator from a Tailwind subset to the style keys above would make porting
close to mechanical. It is pure build-time work (no runtime cost) and can come after v1.

## 10. What is built (status, 2026-10-29, step 1.4)
Built and checked on the Lava: every layout key in §3.1 except `flexWrap`, `display` and absolute `start`+`end`
together (stretch); drawing: `backgroundColor`, `borderRadius` (one value), `borderWidth` / `borderColor`,
`borderTopWidth` / `borderBottomWidth` (in `borderColor`), `opacity`, `overflow`, `elevation` + `shadowColor`,
`transform` (scale, scaleX/Y, translateX/Y, rotate; build-time only); text: `color`, `fontSize`, `fontWeight`,
`fontStyle`, `textAlign`, `textDecorationLine`, `lineHeight`, `letterSpacing`, `numberOfLines`; `position:
'absolute'` + `top/bottom/start/end` + `zIndex` inside `Stack`. Images clip to their rounded shape by default.
Not yet: per-corner radii, per-side border colours, `shadowOffset/Opacity/Radius`, `textTransform`, `fontFamily`,
dynamic transforms. They are build errors until added.
