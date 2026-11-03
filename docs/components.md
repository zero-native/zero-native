# Small Components & Accessibility Reference

This document covers the UI components and accessibility primitives added in Milestone 3 (Steps 3.7 and 3.8).

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
