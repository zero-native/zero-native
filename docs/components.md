# Small Components & Accessibility Reference

This document covers the small UI components and accessibility primitives of Milestone 3 (Steps 3.7 and 3.8), and the
components and props added after them: `<NativeView>` (§9), `<Tabs>` (§10), pull to refresh (§11), SVG (§12), and
`Modal`, `StatusBar` and props on every element (§13, registry 15). *(This intro used to say it covered only steps
3.7-3.8; it is longer now.)* The main components (`Column`, `Row`, `Text`, `Image`, `List`, ...) are in
`packages/ui/src/index.ts` and the guide notes.

`StyleSheet` (`create`, `absoluteFill`) is exported from `@zero-native/ui`, as in RN. The compiler folds it at build
time. `StyleSheet.flatten` and `hairlineWidth` do not exist.

---

## 1. `<Switch>`

A native controlled toggle switch adhering to Android Material guidelines with a minimum 48 × 48 dp touch target.

### Props & Types
| Prop | Type | Dynamic Slot | Default | Description |
|---|---|---|---|---|
| `value` | `boolean` | Yes | `false` | Current state of the switch (strictly controlled). |
| `onValueChange` | `(val: boolean) => void` | Event (30) | — | Emitted when user taps the switch with `!currentValue`. |
| `disabled` | `boolean` | Yes | `false` | Disables interaction and reduces opacity to 38%. |
| `trackColor` | `string \| number` | No | `#D1D5DB` | Track color when switch is OFF. |
| `activeTrackColor` | `string \| number` | No | `#10B981` | Track color when switch is ON. |
| `thumbColor` | `string \| number` | No | `#FFFFFF` | Thumb circle color. |
| `style` | `Style` | No | — | Margins and positioning. (Minimum layout bounds are 48 × 48 dp). |

### Strict Controlled Principle (Rule 10 & 11)
- **Native never changes the shown value on its own.** Tapping emits `onValueChange(!shownValue)` to JS. If your JS handler ignores the event or does not set the signal, the thumb does not slide and no animation starts.
- **Fast double tap:** Two rapid taps evaluate against the current shown value, sending `true, true` (never a pending intermediate state).
- **Snap on mount / reuse:** The switch animates (~150 ms) only when `value` changes while remaining on screen. It snaps instantly when mounting or when a list row is reused.
- **Zero recompositions per frame:** Thumb motion is drawn entirely in Compose's draw phase without triggering recompositions.

### Example
```tsx
const notificationsEnabled = signal(false)

<Switch
  value={notificationsEnabled()}
  onValueChange={(next) => notificationsEnabled.set(next)}
/>
```

---

## 2. `<Checkbox>`

A native controlled checkbox with 48 × 48 dp touch area and rounded corners.

### Props & Types
| Prop | Type | Dynamic Slot | Default | Description |
|---|---|---|---|---|
| `value` | `boolean` | Yes | `false` | Checked state (strictly controlled). |
| `onValueChange` | `(val: boolean) => void` | Event (30) | — | Emitted with `!currentValue` on tap. |
| `disabled` | `boolean` | Yes | `false` | Disables touch and renders at 38% alpha. |
| `color` | `string \| number` | No | `#6B7280` | Border color when unchecked. |
| `activeColor` | `string \| number` | No | `#10B981` | Fill and border color when checked. |
| `style` | `Style` | No | — | Margins and positioning. |

### Example
```tsx
const acceptedTerms = signal(false)

<Checkbox
  value={acceptedTerms()}
  onValueChange={(next) => acceptedTerms.set(next)}
/>
```

---

## 3. `<Spinner>`

An endless circular loading spinner rendered continuously in the draw phase.

### Props & Types
| Prop | Type | Dynamic Slot | Default | Description |
|---|---|---|---|---|
| `size` | `number` | No | `24` | Diameter in dp. Stroke thickness scales proportionally. |
| `color` | `string \| number` | Yes | `#10B981` | Stroke color. |
| `style` | `Style` | No | — | Outer layout styling. |

### Performance
- **Zero recompositions per frame:** Driven by infinite animation evaluated strictly inside `drawBehind`. Safe for list rows and heavy screens.
- **Proportional stroke:** Scales nicely down to `size={16}` without turning into an indistinguishable blob.

### Example
```tsx
<Spinner size={16} />
<Spinner size={24} color="#2563EB" />
```

---

## 4. `<Progress>`

A horizontal progress bar supporting both determinate (fraction 0–1) and indeterminate endless modes.

### Props & Types
| Prop | Type | Dynamic Slot | Default | Description |
|---|---|---|---|---|
| `value` | `number` | Yes | `undefined` | Progress fraction between `0` and `1`. Omit for indeterminate mode. |
| `color` | `string \| number` | Yes | `#10B981` | Active progress bar fill color. |
| `trackColor` | `string \| number` | No | `#E5E7EB` | Background track color. |
| `style` | `Style` | No | `{ height: 4 }` | Styling (default height: 4 dp). |

### Behavior
- Clamped between `0.0` and `1.0`. `NaN` falls back safely to `0`.
- Determinate bars animate smoothly to target values (~150 ms) while snapping on initial show and list reuse.
- Omission of `value` automatically triggers an indeterminate endless sweep.

### Example
```tsx
// Determinate
<Progress value={progressSignal()} />

// Indeterminate endless bar
<Progress />
```

---

## 5. `<Shimmer>`

A standalone rectangular or rounded skeleton placeholder component.

### Props & Types
| Prop | Type | Dynamic Slot | Default | Description |
|---|---|---|---|---|
| `baseColor` | `string \| number` | No | `#E5E7EB` | Base background color of the placeholder. |
| `highlightColor` | `string \| number` | No | white at 55 % | Colour of the moving band. For a brand-tinted sweep, give both colours the brand with their own alpha (`rgba(52,29,236,0.12)` → `rgba(52,29,236,0.28)`). |
| `period` | `number` | No | `1200` | Sweep period in milliseconds. |
| `style` | `Style` | No | — | Dimensions (`width`, `height`, `borderRadius`). |

### Performance & Synchronization
- **Screen-wide synchronization:** All shimmers on screen share the exact same time base (`SystemClock.uptimeMillis() % period`). Placeholders entering composition at different times move in identical phase.
- **Draw phase only:** Zero recompositions per frame.

### Example
```tsx
<Row style={{ gap: 12, alignItems: "center" }}>
  <Shimmer style={{ width: 48, height: 48, borderRadius: 24 }} />
  <Column style={{ flex: 1, gap: 8 }}>
    <Shimmer style={{ width: "80%", height: 14, borderRadius: 6 }} />
    <Shimmer style={{ width: "50%", height: 12, borderRadius: 6 }} />
  </Column>
</Row>
```

---

## 6. Image Fallback & Loading Shimmer

`<Image>` supports synchronized loading shimmers and automatic error fallbacks.

### Props & Types
| Prop | Type | Dynamic Slot | Default | Description |
|---|---|---|---|---|
| `src` | `string \| null` | Yes | `null` | Main image URL or `asset:` path. |
| `fallbackSrc` | `string \| null` | No | `null` | Image URL or `asset:` path to display on error. |
| `loading` | `"none" \| "shimmer"` | No | `"none"` | When `"shimmer"`, renders synchronized shimmer while loading. |

### Rules & Guarantees
- The fallback displays **on error only**, never while loading.
- A new `src` resets the state to loading, preventing recycled list rows from showing stale error images.
- One way only, per `src`: `src` → `fallbackSrc` → an empty box. Each is requested once; a loaded fallback never
  retries the broken `src`.
- No `src` (null) with a `fallbackSrc`: the fallback shows straight away.
- With `accessibilityLabel`, TalkBack reads the image once, as an image. Without it the image is decorative.
- All image models pass through `imageModel()` in `ZnRenderer.kt`, preserving OTA update assets.

### Example
```tsx
<Image
  src={offer.imageUrl}
  fallbackSrc="asset:images/offer-placeholder.png" // the app's own image: assets/images/ next to src/
  loading="shimmer"
  style={{ width: "100%", height: 160, borderRadius: 12 }}
/>
```

---

## 7. `toast()` API

A global native toast module designed for transient non-critical feedback.

### Signature
```ts
import { toast } from "@zero-native/core"

toast(message: string, options?: { duration?: "short" | "long" }): void
```

### Characteristics
- **Unowned native call (`owned: false`):** Survives navigation and screen disposal (e.g. `toast("Saved"); nav.back()`).
- **Layout & Insets:** Anchored above bottom navigation bar and above the on-screen keyboard (IME).
- **Polite TalkBack live region:** Read once by screen readers without interrupting current speech.
- **Max 2 lines:** Wraps cleanly with text ellipsis.
- **No queue:** A new toast immediately replaces any currently visible toast.
- **Over sheets too:** a toast shown while a `<Sheet>` is open draws in the sheet's window, on top of it (a sheet is a
  separate window, so a toast under it could not be seen). If the sheet closes first, the toast moves back to the
  screen and keeps its remaining time.

### When to Use
- **Do:** Use for transient confirmations ("Saved", "Copied to clipboard", "Network restored").
- **Don't:** Do not use toast for critical errors that require user action (use dialogs, sheets, or inline error text).

---

## 8. Accessibility Basics (Step 3.8)

Every UI element in ZeroNative supports standard accessibility properties mapped directly to native semantics.

### Common Accessibility Props
| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `accessibilityLabel` | `string` | Yes | Dynamic TalkBack description. Replaces merged children's text. |
| `accessibilityHint` | `string` | No | Additional action hint (e.g. "Double-tap to open settings"). |
| `accessibilityRole` | `string` | No | `"button" \| "header" \| "image" \| "link" \| "text" \| "switch" \| "checkbox" \| "none"` |
| `accessibilityHidden` | `boolean` | No | Hides element and children from accessibility tree. Touch & drawing remain active. |
| `maxFontScale` | `number` | No | Caps font scale on `Text` and `TextField` (`size * min(fontScale, maxFontScale)`). |

### Important Semantics Guidelines
1. **Single Semantics Block on Pressable:** `accessibilityRole="none"` keeps the click action while removing the "Button" announcement.
2. **Icon-only Buttons:** Always provide `accessibilityLabel` on icon-only Pressables.
3. **Decorative Images:** Images without an `accessibilityLabel` are marked as decorative and skipped by TalkBack.
4. **maxFontScale:** Use on compact layouts (like keypad buttons or tight rows) to prevent text clipping at large accessibility font settings while preserving readability.


---

## 9. `<NativeView>` (P.4b, registry 9)

A plugin's own Compose view inside a zn screen. Apps normally use the plugin's wrapper (`<QrScanner>`, `<WebView>`), not this.

```tsx
<NativeView name="scanner.qr" props={{ torch: torch() }} onEvent={(e) => e.name === "code" && onCode(e.data)} style={{ height: 320 }} />
```

| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `name` | `string` | No | `"<plugin>.<name>"`, a string literal. The build fails if no code uses that plugin's `nativeModule`. |
| `props` | JSON object | Yes | Sent as JSON text; only a real change reaches the view. Keep it small; big data goes by `zn://` handle. |
| `onEvent` | `(e: { name: string; data: any }) => void` | — | Events the view sends with `scope.emit(name, data)`. |
| `style` | `Style` | No | Must be known at build time. Give it a size: it takes no children. |

### When to Use
- **Do:** wrap it in a small component in the plugin package, with typed props and events.
- **Don't:** use it for something zn components can draw. A native view costs a plugin, an APK change and a module version.
- **Unknown name** (a plugin missing from the APK): an empty box of the given size and one reported error. The build check above
  stops this from reaching a phone. Details: `docs/guide-notes.md` §35, `docs/plugins.md` §4.

---

## 10. `<Tabs>` (tabs, registry 11)

The tab panels of a screen with tabs. It draws only its child at `selected`, filling itself. Use it with `useTabs`.

```tsx
const tabs = useTabs("home")
<Tabs selected={tabs.index()} style={{ flex: 1 }}>
  <Column style={{ flex: 1 }}>{tabs.seen("pay") && <PayTab tabs={tabs} />}</Column>
  <Column style={{ flex: 1 }}>{tabs.seen("stores") && <StoresTab tabs={tabs} />}</Column>
</Tabs>
```

| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `selected` | `number` | Yes | The position of the child to draw (default 0). Pass `tabs.index()`. |
| `style` | `Style` | No | Usually `flex: 1`. Padding and gap don't apply to the panels: put them inside each panel. |

### Behaviour
- Children are the panels, one per tab, in the route's `tabs` order.
- A panel that is not selected is not drawn (no frames, no layout), but its instances stay: JS state, signals and
  loaded data are kept. Its scroll positions are kept too, and come back when it is shown again.
- A `NativeView` in a panel that is not selected is made again when the panel comes back (a WebView reloads).
- The tab bar is not part of it: it is the app's own JSX. Details: `docs/guide-notes.md` §40.

## 11. Pull to refresh on `<Scroll>` and `<List>` (registry 12)

A vertical `<Scroll>` and a `<List>` take these props. Not on `<Scroll horizontal>` (build error).

| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `refreshing` | `boolean` | Yes | The spinner shows while true. Owned by JS: set it in `onRefresh`. |
| `onRefresh` | `() => void` | (event) | A pull past the line ended. Without it there is no pull (only `refreshing` shows the spinner). |
| `refreshColor` | `Color` | No | The arc. Default `#374151`. |
| `refreshBackground` | `Color` | No | The round disc behind the arc. Default white. |
| `refreshControl` | `<RefreshControl />` | No | React Native's shape; the compiler turns it into the props above. |

### Behaviour
- The disc slides down over the content (Android's look). The disc must come down 80 dp; it moves half as far as the
  finger. Below that, letting go does nothing.
- After the pull, the spinner shows at once and then follows `refreshing`. If `refreshing` is not true within 1 second,
  it goes away.
- A pull while the spinner shows does nothing. The pull runs natively: no JS until the finger is up.
- Details and do / don't: `docs/guide-notes.md` §41.

## 12. SVG: `.svg` files and `<Svg>` (registry 13; built as 11-13, first planned as 10)

Compiled at build time into one node; drawn natively. Design and the supported subset: `docs/svg.md`. Author rules: `docs/guide-notes.md` §42.

```tsx
import Badge from "./svg/badge.svg"
<Badge size={48} color={c.ink} parts={{ ring: { stroke: brand() } }} accessibilityLabel="Paid" />
<Svg viewBox="0 0 64 64" size={64}><Circle cx={32} cy={32} r={28} fill="url(#g)" /></Svg>
```

| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `size` | `number` | No | Width and height in dp. Or `style` width / height; with only one, the other comes from the viewBox. With none, the file's `width` / `height`, else the viewBox size. |
| `style` | `Style` | As on any element | Size, margin, position; `opacity` and transforms can change at runtime. |
| `color` | `Color` | Yes | The value of `currentColor`. The build fails if the SVG has none. |
| `parts` | `{ [id]: { fill?, stroke?, opacity?, rotate?, scale?, scaleX?, scaleY?, translateX?, translateY?, trimStart?, trimEnd?, trimOffset?, strokeWidth?, dashOffset?, animate?, paused?, replay? } }` | Yes, per value (not `animate`) | Changes the element with that `id`. Unknown ids fail the build. `.svg` files only. Transforms are in viewBox units and degrees, around the part's own centre; trims are 0–1 of its line. `strokeWidth` / `dashOffset` (registry 12) are viewBox units. The build writes the names as types (`logo.d.svg.ts`, guide §42). |
| `paused` / `replay` | `boolean` / `number` | Yes | On any element: stop its loops where they are; a new `replay` number plays them again. |
| `autoMirror` | `boolean` | No | Flip left to right on right-to-left screens. |
| `accessibilityLabel` / `accessibilityHidden` | `string` / `boolean` | As today | With a label, TalkBack reads it as an image; without, it is skipped. |

Inline `<Svg>` also takes `viewBox`, `preserveAspectRatio`, `width`, `height` (RN's names) and the elements `G`, `Path`, `Rect`, `Circle`,
`Ellipse`, `Line`, `Polyline`, `Polygon`, `Defs`, `LinearGradient`, `RadialGradient`, `Stop`, `ClipPath`, `Mask`, `Use` with react-native-svg's
camelCase props. An element's `fill`, `stroke` or `opacity` may change at runtime; nothing else may. The part motion props above
(`rotate`, `trimEnd`, `animate`, ...) also work on an inline element and make it a part.

### When to Use
- **Do:** icons, logos, illustrations, gradient cards, simple charts with a fixed shape.
- **Don't:** text inside the SVG (use `<Text>` over it in a `<Stack>`), photos (`<Image>`), or a shape that changes with data every frame.
- Phase 2 (first "not built", now **built**, 2026-11-03): part transforms, "draw the line" trims, `animate` on parts.
  **Update 2026-11-03: built** (`docs/svg.md` §9): spinners, pulse rings, gauges, a line that draws itself, a tick on a paid badge.
- **Update 2026-11-03 (S.14):** an animated `.svg` file (SMIL `<animate>`, CSS `@keyframes`) plays as it is: the build turns its
  motion into part animations. `paused` / `replay` on the component reach it; `parts` can't add a second `animate` to a part the
  file already moves. Limits: `docs/svg.md` §15.
  Try them on the SVG lab's Motion section.
- **Update 2026-11-03 (phase 4, registry 13):** `.svg` files may use filters (blur, drop shadow), masks, patterns, markers,
  blend modes, focal gradients, nested `<svg>`, `<switch>` and simple `<text>` (the TalkBack label when you set none);
  animated files may move along a path, use `<set>`, `steps()`, skews, animated stops, `points` morphs, more CSS and
  `begin="click"` (a tap on the Svg starts it). Below Android 12 a filter draws a plain shadow or nothing. Inline `<Svg>`
  has none of the new elements yet: put such art in a `.svg` file. `docs/svg.md` §17; the lab's Effects and More motion rows.

## 13. RN props pack 2 (registry 14-15): Modal, StatusBar, NavigationBar, and props on every element

How each behaves, with do / don't: `docs/guide-notes.md` §43. Lab: `/dev/rn-props`.

### `<Modal>`
A full-screen window over the app; its children are what you draw in it, laid out like a Column that fills the window.

| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `visible` | `boolean` | Yes | Shown while true. Not written: shown (as in RN). Owned by JS. |
| `transparent` | `boolean` | No | No window background (else white). |
| `animationType` | `"none" \| "fade" \| "slide"` | No | How it comes and goes. Default `"none"`. |
| `statusBarTranslucent` | `boolean` | No | The content may draw under the status bar. |
| `navigationBarTranslucent` | `boolean` | No | The content may draw under the navigation bar. |
| `onRequestClose` | `() => void` | (event) | Back was pressed. Set `visible` to false to close. |
| `onShow` | `() => void` | (event) | It is on screen. |
| `testID` | `string` | No | As on every element. |

`presentationStyle`, `hardwareAccelerated`, `supportedOrientations`, `onOrientationChange`: accepted, do nothing.

### `<StatusBar>` and `<NavigationBar>`
Take no space. While their screen is on top they set the bar; several merge, the newest winning.

| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `barStyle` | `"default" \| "light-content" \| "dark-content"` | Yes | The icons. `"default"`: the route's `statusBar` option. |
| `backgroundColor` | `Color` | Yes | Drawn behind the bar for this screen (every Android version). |
| `hidden` | `boolean` | Yes | `<StatusBar>` only: hides the status bar. |

`<StatusBar>` also accepts `animated`, `translucent`, `networkActivityIndicatorVisible`, `showHideTransition` (they do
nothing). `<NavigationBar>` is zn's own.

### Props on every element (registry 15)
| Prop | Type | Dynamic Slot | Description |
|---|---|---|---|
| `pointerEvents` | `"auto" \| "none" \| "box-none" \| "box-only"` | Yes | Who takes taps. Written `"auto"` / `"box-only"`, taps stop here. **Not written:** taps go through, except on an absolute `Box` / `Column` / `Row` / `Stack` that has a background or children. That one stops taps by default, as an RN view does, so a "busy" overlay blocks the button under it. To let taps through, write `pointerEvents="none"` (or `"box-none"` to keep taps for the children). Check old sticky bars and overlays. Guide notes §43; second-opinions 74. |
| `onLayout` | `(e) => void` | (event) | `e.nativeEvent.layout` `{ x, y, width, height }` in dp, on a change. |
| `testID` | `string` | No | The resource id UI tests see. |
| `borderTopLeftRadius` ... `borderBottomEndRadius` | `number` | No | One corner. |
| `borderColor`, `borderWidth` | `Color`, `number` | Yes (now) | A colour change redraws; a width change re-measures. |
| `shadowOffset`, `shadowOpacity`, `shadowRadius` | | | Accepted and dropped, as RN on Android. |

### Per component (registry 15)
| Component | Prop | Type | Dynamic Slot | Description |
|---|---|---|---|---|
| `Pressable` | `hitSlop` | `number \| { top, bottom, left, right }` | No | Taps this far outside still count (dp). |
| `Text` | `textTransform` | `"none" \| "uppercase" \| "lowercase" \| "capitalize"` | No | Also for runtime text. |
| `Image` | `tintColor` | `Color` | Yes | Every non-clear pixel in this colour. |
| `Image` | `onLoad`, `onError`, `onLoadEnd` | events | | `nativeEvent.source` `{ width, height, uri }` / `nativeEvent.error`. |
| `List` | `stickyHeaderIndices` | `number[]` | Yes | Rows pinned at the top while their part scrolls. |
| `List` | `inverted` | `boolean` | No | Row 0 at the bottom, growing upwards (chats; registry 19). |
| `Text` | `onPress`, `onLongPress` | events | | Top-level tap / long-press handler (registry 23). Role `Button` for TalkBack, no ripple or opacity change. |
| `Pressable` / `TouchableOpacity` | `style={{ flexDirection: "row" }}` | style | | Rewritten at build time: wraps children in `<Row>`, moves layout keys (`alignItems`, `justifyContent`, `gap`) to Row (registry 23). |

Registry 14 changes how `Pressable` long press works when `onLongPress` holds no handler (a long hold is a tap then);
the compiler sets `hasLongPress` for that. Nobody writes it.

---

## 14. `<Canvas>` (registry 23)

A native 2D drawing view. You give it a list of drawing commands, and Compose draws them in the draw phase only. Use it
for shapes made from data: charts, candlesticks, progress rings, gauges, dashed paths, rotated labels. This is what React
Native apps use `@shopify/react-native-skia` for, without adding an 8-15 MB Skia library.

### Which one to use
- **`<Svg>` / `.svg` components:** fixed art and icons.
- **`<Canvas>`:** shapes made from data at runtime.
- **`<Lottie>`:** animations made by a designer (After Effects).

### Props
| Prop | Type | Changes at runtime | Default | What it does |
|---|---|---|---|---|
| `commands` | `readonly CanvasCommand[] \| string` | Yes (prop `COMMANDS`, 298) | `[]` | The drawing commands, made with `draw.*`. |
| `accessibilityLabel` | `string` | — | — | What TalkBack reads for the drawing (for example "Sales, last 12 months, going up"). |
| `style` | `Style` | — | — | Width, height, margins, background, border. |

- `<Canvas>` takes no children: it only draws.
- `CanvasCommand` and the other types (`CanvasPaint`, `CanvasLinearGradient`, `CanvasRadialGradient`,
  `CanvasTextOptions`) come from `@zero-native/core`.
- **A string:** it is sent to native as it is (a literal `commands='[...]'` or an expression), so its colours must be
  ARGB numbers. Prefer a list: core's `canvasJson` turns a list's colour strings into numbers and checks it.

### Example
`draw` is an object of helpers. Each helper returns one command; you put them in a list:
```tsx
import { Canvas } from "@zero-native/ui"
import { draw } from "@zero-native/core"

const chart = () => [
  draw.rect(0, 0, 300, 180, { color: "#0B111A" }),
  draw.line(0, 90, 300, 90, { color: "#1F2937", strokeWidth: 1, dash: [4, 4] }),
  draw.path("M 0 120 C 50 80, 100 140, 150 90 S 250 50, 300 70", { color: "#10B981", style: "stroke", strokeWidth: 2 }),
  draw.circle(150, 90, 4, { color: "#10B981" }),
  showPrice() && draw.text("₹ 4,820.50", 150, 40, { fontSize: 16, fontWeight: "bold", color: "#F9FAFB", align: "center" }),
]

<Canvas style={{ width: 300, height: 180 }} commands={chart()} accessibilityLabel="Price today" />
```
`null` and `false` entries are skipped, so `cond && draw.circle(...)` works.

### Commands
- **Shapes:** `rect(x, y, w, h)`, `roundRect(x, y, w, h, r)`, `circle(cx, cy, r)`, `oval(x, y, w, h)`,
  `line(x1, y1, x2, y2)`, `arc(x, y, w, h, start, sweep, useCenter)`, `path(d)` (SVG path data). Each takes a paint last.
- **Text:** `text(str, x, y, { fontSize, fontWeight, color, align })`. `y` is the **baseline** (the line the letters sit
  on), not the top. `align` is `"left"`, `"center"` or `"right"` around `x`. Weights 100-900 work on Android 9+; below
  that, 600 and up is bold, the rest regular.
- **State:** `save()`, `restore()`, `translate(dx, dy)`, `scale(sx, sy)`, `rotate(degrees, px, py)`, `clipRect(x, y, w, h)`.
  A transform or clip without its own `save` / `restore` still ends at the end of the list: it never moves the view's
  border or the views after it.

### Units and angles
- Everything is in **dp**: positions, sizes, stroke widths, dash lengths, gradient points, font size.
- Arcs and `rotate` use **degrees**. 0 is 3 o'clock, and a positive angle goes clockwise. A ring that starts at the top:
  `draw.arc(x, y, w, h, -90, sweep)`.
- The thinnest stroke is 1 px (a `strokeWidth` of 0 gives 1 px).

### Paint
`color`, `style` (`"fill"` or `"stroke"`), `strokeWidth`, `strokeCap` (`"butt"`, `"round"`, `"square"`), `strokeJoin`
(`"miter"`, `"round"`, `"bevel"`), `dash`, `opacity` (0-1), `linearGradient { x0, y0, x1, y1, colors, stops? }`,
`radialGradient { cx, cy, r, colors, stops? }`.
- **Colours:** the same formats as everywhere in zero-native: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb()`, `rgba()`,
  `hsl()`, `hsla()`, CSS names and `"transparent"`. JS turns them into ARGB numbers (core's `parseColor`); native never
  reads colour strings. A bad colour draws black, with a warning.
- **Gradients** need at least 2 colours. With 1 colour, the shape is drawn in that colour; with none, in `color`.
  `stops` need one number (0-1) per colour, or they are left out.
- **`dash`** is a list of on / off lengths: an even count (2, 4, ...), each 0 or more, not all 0. Anything else draws
  no dash.

### Errors
A bad command never crashes the app.
- A command with a missing or wrong number (`NaN`, `Infinity`, a string) is skipped; the rest still draws. A
  `restore()` without a `save()` is skipped too.
- JS logs a warning naming the command's index (once per message). In a debug build, native also shows one dev error
  per command list, listing the bad indexes.
- More than 10,000 commands: nothing is drawn, with an error.
- If drawing still fails, that canvas stays empty until its list changes, and the error is reported once.

### Performance
- The list is turned into JSON once per change. Native reads it once per change; brushes, strokes, dashes and paths are
  built once per list, not on every frame.
- A change of `commands` recomposes the Canvas node itself (one small node) and redraws it. It never re-measures or
  moves other views.
- At most 10,000 commands per canvas.

### Not in v1
- Touch input (taps, drags), so no signature pad yet. A `gesture` on the Canvas's parent gives touchX / touchY
  (registry 24); a smooth signature pad still needs a native view (plan §10).
- Measuring text from JS, images, shaders.

## 15. Gestures and motion props (registry 24)
Reference: `docs/motion.md`.

| Prop | On | What |
|---|---|---|
| `gesture={g}` | any element | A gesture from usePan / usePinch / useRotate / useTap / useLongPress / useFling, or a group |
| `motion={m}` | any element; Scroll, List, Carousel, Pressable, Sheet add their own values | Fills a `useElementMotion()` object |
| style values | any element | `opacity`, `backgroundColor`, `transform` (incl. `rotateX`, `rotateY`), radii, `blurRadius`, `cameraDistance` take motion values |
| `animateLayout` | any element | Size and place changes animate (a timing) |
| `itemAnimation` | List | `"fade"` or `"move"` |
| `reorderable`, `onReorder(from, to)` | List | Long press and drag to reorder |
| `sharedTag` | any element | Shared element between two screens |
| `enter` / `exit` | rows and branches | New presets: slide-*, zoom, bounce, flip-x / y, stretch-x / y |
| Svg part `fill`, `stroke`, trims, transforms | Svg parts | Take motion values |

