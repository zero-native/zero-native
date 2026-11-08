# Dynamic Layout Survey: Current State & Facts for Opus 5.5 Design

**Date:** 2026-11-08  
**Author:** Gemini (Batch 1, Task G1)  
**Purpose:** Factual survey of all layout-related style keys in `zero-native` to inform Opus's dynamic layout architecture.  
**Rule:** Any layout React Native can do, zero-native must do.

---

## 1. Style Key Survey Table

| Style Key | Build-time only today? (Exact error & `compile.ts` file:line) | Compiler read location (`compile.ts` file:line) | Android Runtime application (`ZnRenderer.kt` / `ZnTemplate.kt` file:line & Modifier/Param) | Phase affected if runtime (Composition / Layout / Draw) | How React Native treats it | Notes & Special Cases |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`width`** | Yes. `"${name}" must be known at build time (a literal, a const or a design token); only text, color, ... can change at runtime yet` (`compiler/src/compile.ts:2568`) | `compile.ts:1136–1140` (filters `"auto"`), `compile.ts:2561–2575` (`setProp`), `compile.ts:2699` | `ZnTemplate.kt:575–578`: `when (val w = width) { is Double -> m = m.width(w.toFloat().dp) is ZnPercent -> m = m.fillMaxWidth(...) }` | **Layout phase** (if via `Modifier.layout` / custom size modifier); Composition if via `Modifier.width(dp)` | Number (dp), percentage string (`"50%"`), or `"auto"` on Yoga node | In Row: a child's width is definite if fixed or flex. Percent needs bounded parent constraints in Compose. |
| **`height`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:1136–1140`, `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:579–582`: `when (val h = height) { is Double -> m = m.height(h.toFloat().dp) is ZnPercent -> m = m.fillMaxHeight(...) }` | **Layout phase** (if via `Modifier.layout`); Composition if via `Modifier.height(dp)` | Number (dp), percentage string, or `"auto"` on Yoga node | In Row: `alignItems: "stretch"` stretches children only when Row has a fixed height (`ZnRenderer.kt:195`). |
| **`minWidth`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:583`: `m = m.widthIn(minWidth.orUnspecified(), maxWidth.orUnspecified())` | **Layout phase** | Number (dp) or percentage on Yoga node | Affects minimum measurement constraints. |
| **`maxWidth`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:583`: `m = m.widthIn(minWidth.orUnspecified(), maxWidth.orUnspecified())` | **Layout phase** | Number (dp) or percentage on Yoga node | Affects maximum measurement constraints. |
| **`minHeight`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:584`: `m = m.heightIn(minHeight.orUnspecified(), maxHeight.orUnspecified())` | **Layout phase** | Number (dp) or percentage on Yoga node | Affects minimum height constraints. |
| **`maxHeight`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:584`: `m = m.heightIn(minHeight.orUnspecified(), maxHeight.orUnspecified())` | **Layout phase** | Number (dp) or percentage on Yoga node | Affects maximum height constraints. |
| **`%` strings** (`width`, `height`, etc.) | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2603–2608` (parses `/^(\d*\.?\d+)%$/` into `ZnPercent`) | `ZnTemplate.kt:577, 581`: `m = m.fillMaxWidth(fraction)` or `m.fillMaxHeight(fraction)` | **Layout phase** | Yoga evaluates `%` relative to parent's layout bounds | Compose `fillMaxWidth(fraction)` throws `IllegalArgumentException` if incoming parent constraints are unbounded (e.g. inside `Scroll horizontal`). |
| **`flex`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnRenderer.kt:199` (in Row: `m.weight(child.flex)`), `ZnRenderer.kt:332` (in Column: `m.weight(child.flex)`) | **Composition / Layout phase** (`RowScope.weight` / `ColumnScope.weight`) | Sets `flexGrow: flex, flexShrink: 1, flexBasis: 0` in Yoga | Works only on direct children of `Row` or `Column`. Must be $> 0$. |
| **`flexGrow`** | Yes. `flexGrow must be known at build time` (`compile.ts:1091`) | `compile.ts:1113–1120`: maps non-zero `flexGrow` to `props.flex = v` | Handled as `flex` (`weight` in `ZnRenderer.kt:199, 332`) | **Composition / Layout phase** | Shares remaining free space proportionally in Yoga | In zn, treated as alias to `flex` if `flex` not already specified. |
| **`flexShrink`** | Yes. `flexShrink must be known at build time` (`compile.ts:1091`) | `compile.ts:1121–1124`: accepts `0` or `1`, drops both; fails on others | Not stored or applied | N/A (dropped) | Controls shrinking below content size in Yoga | zn never shrinks children below their measured content size (Text in Row wraps). |
| **`flexBasis`** | Yes. `flexBasis must be known at build time` (`compile.ts:1091`) | `compile.ts:1125–1127`: accepts `0` or `"auto"`, drops both; fails on others | Not stored or applied | N/A (dropped) | Default size before free space distribution in Yoga | zn asks developers to use `width` or `flex`. |
| **`margin`** (and `Horizontal`, `Vertical`) | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:572`: `margin?.let { m = m.padding(it.toPadding()) }` (resolved via `edges()` at `ZnTemplate.kt:705–710`) | **Layout phase** (Compose `padding` modifier adjusts constraints and offsets child) | Outside spacing around element in Yoga | In Compose, margin is outer padding applied *before* element sizing in `buildChain`. |
| **`marginTop`**, `marginBottom`, `marginStart`, `marginEnd` | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:572`: `margin?.let { m = m.padding(it.toPadding()) }` | **Layout phase** | Edge-specific outer margins in Yoga | Resolved with RN precedence (specific edge beats horizontal/vertical, which beats all-edges). |
| **`marginLeft`**, `marginRight` | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:1096–1103`: renames `marginLeft` $\to$ `marginStart`, `marginRight` $\to$ `marginEnd` | Handled as `marginStart` / `marginEnd` | **Layout phase** | Physical left/right margins in Yoga | In LTR they match RN; in RTL they flip (unlike RN physical left/right). |
| **`padding`** (shorthand, and `Horizontal`, `Vertical`) | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:685–687`: `m = m.padding(...)` or `ZnTemplate.kt:691`: `staticPadding` | **Layout phase** | Inner padding inside element bounds in Yoga | The shorthands are build-time only today; per-edge padding (`paddingTop`, etc.) is dynamic. |
| **`paddingTop`**, `paddingBottom`, `paddingStart`, `paddingEnd` | **NO (Dynamic today)**. In `DynamicProps` (`registry.ts:566–569`) | `compile.ts:2567–2575`: allocates slot | `ZnTemplate.kt:684`: `m = m.layoutPadding { pad().plus(...) }`, `ZnRenderer.kt:713–718` | **Layout phase** (`Modifier.layoutPadding` runs in `layout { ... }`) | Edge-specific inner padding in Yoga | Already proven pattern for dynamic layout without recomposition! |
| **`paddingLeft`**, `paddingRight` | **NO (Dynamic today)** via alias | `compile.ts:1096–1103`: renames `paddingLeft` $\to$ `paddingStart`, `paddingRight` $\to$ `paddingEnd` | Handled as `paddingStart` / `paddingEnd` | **Layout phase** | Physical left/right inner padding in Yoga | Flips in RTL. |
| **`gap`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnRenderer.kt:191` (in Row: `horizontalArrangement`), `ZnRenderer.kt:324` (in Column: `verticalArrangement`) | **Composition / Layout phase** (passed as `Arrangement.spacedBy(s.gap.dp)`) | Spacing between items in Yoga | Applies along the container's primary axis. Works with all `justifyContent` options. |
| **`rowGap`** | Yes. `rowGap must be known at build time` (`compile.ts:1091`) | `compile.ts:1128–1134`: maps to `__rowGap` | Overrides `gap` for `Column` in `rnFinish` / `ZnRenderer.kt` | **Composition / Layout phase** | Row gap in Yoga | Dropped in `Row` without wrapping. |
| **`columnGap`** | Yes. `columnGap must be known at build time` (`compile.ts:1091`) | `compile.ts:1128–1134`: maps to `__columnGap` | Overrides `gap` for `Row` in `rnFinish` / `ZnRenderer.kt` | **Composition / Layout phase** | Column gap in Yoga | Dropped in `Column` without wrapping. |
| **`top`**, `bottom`, `start`, `end` | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699`, checked by `stackChildCheck` (`compile.ts:1387–1396`) | `ZnRenderer.kt:220–248` (inside `Stack`): `absoluteInsets` or `absoluteChild(start, top, end, bottom)` | **Layout phase** (`Modifier.layout` inside `absoluteChild`) | Offset in absolute/relative positioning in Yoga | Allowed only on children of `Stack` with `position: "absolute"`. |
| **`left`**, `right` | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:1096–1103`: renames `left` $\to$ `start`, `right` $\to$ `end` | Handled as `start` / `end` | **Layout phase** | Physical left/right positioning in Yoga | Flips in RTL. |
| **`aspectRatio`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:1152–1156` (`rnRatio` parses `"16/9"`), `compile.ts:2561–2575` | `ZnTemplate.kt:585`: `aspectRatio?.let { m = m.aspectRatio(it) }` | **Layout phase** (`Modifier.aspectRatio`) | Aspect ratio constraint in Yoga | Forces width/height ratio based on constraints. |
| **`borderRadius`** (and per-corner) | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:1096–1103` (renames `borderTopLeftRadius` $\to$ `borderTopStartRadius`, etc.), `compile.ts:2561–2575` | `ZnTemplate.kt:532–540`: resolved into `shape = RoundedCornerShape(...)`. Used in `clip()`, `background()`, `border()`, `shadow()` | **Composition phase** (reconstructs `Shape`) or **Draw phase** (outline creation) | Corner rounding in Yoga / Android RenderNode | Precedence: specific corner beats all-corners `borderRadius`. |
| **`fontSize`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:600–620` (`effectiveTextStyle`): `fontSize = s.fontSize.sp`. Passed to `BasicText(style = ...)` in `ZnRenderer.kt:80–90` | **Composition phase** (reconstructs `TextStyle` param on `BasicText`; text layout cache re-evaluates) | Font size on RN Text / Yoga inline measurement | Interacts with `maxFontScale` (`ZnTemplate.kt:602`). |
| **`lineHeight`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:600–620` (`effectiveTextStyle`): `lineHeight = s.lineHeight.sp` | **Composition phase** | Line height on RN Text | Scaled by `maxFontScale`. |
| **`letterSpacing`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnTemplate.kt:600–620` (`effectiveTextStyle`): `letterSpacing = s.letterSpacing.sp` | **Composition phase** | Tracking/letter spacing on RN Text | Scaled by `maxFontScale`. |
| **`zIndex`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:1387–1396` (`stackChildCheck`), `compile.ts:2561–2575` | `ZnRenderer.kt:202` (in Row: `m.zIndex(it)`), `ZnRenderer.kt:335` (in Column: `m.zIndex(it)`), `ZnRenderer.kt:247` (in Stack) | **Draw / Placement phase** (`Modifier.zIndex`) | Visual stacking order in RN / Android View elevation | Works on children of Column, Row, Box, Pressable, Stack. Banned in Scroll, List, Carousel. |
| **`alignSelf`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnRenderer.kt:201` (in Row: `m.align(verticalAlignment(child.alignSelf))`), `ZnRenderer.kt:334` (in Column: `m.align(horizontalAlignment(child.alignSelf))`) | **Composition / Layout phase** (`RowScope.align` / `ColumnScope.align`) | Individual cross-axis alignment in Yoga | Overrides parent's `alignItems`. |
| **`alignItems`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnRenderer.kt:192` (in Row: `verticalAlignment(s.alignItems)`), `ZnRenderer.kt:325` (in Column: `horizontalAlignment(s.alignItems)`) | **Composition / Layout phase** (passed as parameter to `Row` / `Column`) | Container cross-axis alignment in Yoga | Values: `flex-start`, `flex-end`, `center`, `stretch`. |
| **`justifyContent`** | Yes. Exact error as `width` (`compile.ts:2568`) | `compile.ts:2561–2575`, `compile.ts:2699` | `ZnRenderer.kt:191` (in Row: `horizontalArrangement`), `ZnRenderer.kt:324` (in Column: `verticalArrangement`) | **Composition / Layout phase** (parameter to `Row` / `Column`) | Container main-axis distribution in Yoga | Values: `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`. |
| **`flexWrap`** | Yes. `unknown style key "flexWrap"` (`compile.ts:2646, 2697` via `unknownStyleKey:1081`) | Not recognized. Not in `tag-props.ts:STYLE_KEYS` | Not implemented in runtime | N/A (Missing) | Multi-line flex wrapping in Yoga (`wrap`, `nowrap`) | In Compose, requires `FlowRow` / `FlowColumn` from Compose Foundation. |
| **`display`** | Yes. `unknown style key "display"` (`compile.ts:2646, 2697` via `unknownStyleKey:1081`) | Not recognized. Not in `tag-props.ts:STYLE_KEYS` | Not implemented in runtime | N/A (Missing) | `none` removes from layout; `flex` includes in Yoga | zn recommendation is conditional render (`cond && <X/>`). |

---

## 2. Dynamic Props Today (`DynamicProps` in `packages/template/src/registry.ts:551`)

The complete set of props allowed to change at runtime (bound to a slot) in Registry 22:
- **Text & Media:** `text`, `src`, `tintColor`, `spans`
- **Colors & Opacity:** `color`, `backgroundColor`, `opacity`
- **Transforms (Draw phase):** `scale`, `scaleX`, `scaleY`, `translateX`, `translateY`, `rotate`
- **Borders (Registry 15):** `borderColor` (Draw phase), `borderWidth` (Layout phase via `Modifier.znBorder`)
- **Padding (Per-edge only):** `paddingTop`, `paddingBottom`, `paddingStart`, `paddingEnd` (Layout phase via `layoutPadding`)
- **Inputs & State:** `disabled`, `visible`, `value`, `placeholder`, `editable`, `invalid` (`<OtpInput>`)
- **Interactions & Events:** `pointerEvents`, `hasLongPress`, `impressionKey`, `selected`, `refreshing`
- **Accessibility:** `accessibilityLabel`
- **SVG Part Dynamics:** `fill`, `stroke`, `strokeWidth`, `dashOffset`, `trimStart`, `trimEnd`, `trimOffset`
- **Animation Controls:** `paused`, `replay`, `animateIn` (`<Sheet>`)
- **System Bars & Navigation:** `barStyle`, `hidden`, `stickyHeaderIndices`, `viewProps`

---

## 3. End-to-End Trace: How `paddingTop` Flows from Compiler to Native

This trace demonstrates the proven pattern for dynamic properties in `zero-native`. The upcoming dynamic layout design by Opus 5.5 will follow this exact pipeline.

```
┌────────────────────────────────────────────────────────┐
│ 1. COMPILER (compiler/src/compile.ts)                  │
│    style={{ paddingTop: pad() }}                       │
│    - fold(expr) returns NOT_STATIC                     │
│    - DynamicProps.has("paddingTop") is true (line 2567)│
│    - Allocates slot s = "s" + b.slots++                │
│    - Emits binding: RUNTIME.slot(inst, @@S:s@@, ...)   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 2. TEMPLATE WRITER (packages/template/src/writer.ts)   │
│    - Writes node slot mapping for Prop.PADDING_TOP (17)│
│    - Serializes into RawTemplate.slots in .zn.ui       │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 3. TEMPLATE PREPARATION (ZnTemplate.kt)                │
│    - slotPadTop = slotFor(raw, Prop.PADDING_TOP) (524) │
│    - hasDynamicPadding = true (line 545)               │
│    - hasDynamicChain = true (line 554)                 │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 4. RENDERER INSTANTIATION (ZnRenderer.kt)              │
│    - Reads slot cell: inst.slot(slotPadTop) (line 715) │
│    - Constructs pad lambda reading slot value (line 717│
│    - Passes pad lambda to s.buildChain(...) (line 730) │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│ 5. NATIVE COMPOSE LAYOUT (ZnTemplate.kt:684, 785-795)  │
│    - Attaches Modifier.layoutPadding { pad() }         │
│    - Reads pad() strictly inside layout { measurable,  │
│      constraints -> ... } (Layout phase)               │
│    - Zero recomposition per frame; re-measures only!   │
└────────────────────────────────────────────────────────┘
```

### Detailed File & Line Breakdown:

1. **Compiler Slot Assignment (`compiler/src/compile.ts:2567–2575`):**
   - In `styleProps`, `p.name` is `"paddingTop"`.
   - `fold(p.initializer, scope)` yields `NOT_STATIC`.
   - `DynamicProps.has("paddingTop")` passes because `paddingTop` is listed in `DynamicProps` (`packages/template/src/registry.ts:566`).
   - `setProp` allocates slot index `s = "s" + b.slots++` (e.g. `s0`).
   - `b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => (${text(expr)}), 0);`)` registers the JavaScript reactive computation that pushes slot patches to native.

2. **Template Writer (`packages/template/src/writer.ts:153`):**
   - Resolves `"paddingTop"` to `Registry.Prop.PADDING_TOP` (id 17).
   - Writes the `(nodeIndex, propId, slotIndex)` triplet into `RawTemplate.slots`.

3. **Kotlin Template Preparation (`android/runtime/.../ZnTemplate.kt`):**
   - Line 524: `slotPadTop = slotFor(raw, Registry.Prop.PADDING_TOP)` finds the slot index for `PADDING_TOP` on this node.
   - Line 545: `hasDynamicPadding = slotPadTop >= 0 || slotPadBottom >= 0 || slotPadStart >= 0 || slotPadEnd >= 0`.
   - Line 554: `hasDynamicChain = ... || hasDynamicPadding || ...`.
   - If `hasDynamicChain` is false, `staticChain` is built once at startup. Because `hasDynamicPadding` is true, the node uses dynamic chain evaluation.

4. **Kotlin Composable Rendering (`android/runtime/.../ZnRenderer.kt`):**
   - Lines 713–718:
     ```kotlin
     val pad = if (s.hasDynamicPadding) {
         val base = s.staticPadding
         val cells = s.paddingSlots.map { if (it >= 0) inst.slot(it) else null }
         fun edge(i: Int, static: Float) = (cells[i]?.value as? Double)?.toFloat() ?: static
         ({ Edges(edge(0, base.start), edge(1, base.top), edge(2, base.end), edge(3, base.bottom)) })
     } else null
     ```
   - Line 730: `s.buildChain(layer, background, press, pad, accessibility, border, layout)` passes `pad` into the modifier builder.

5. **Compose Modifier Application (`android/runtime/.../ZnTemplate.kt`):**
   - Line 684:
     ```kotlin
     } else if (pad != null) {
         m = m.layoutPadding { pad().plus(bs, bt, bs, bb) }
     }
     ```
   - Lines 785–795 (`layoutPadding` implementation):
     ```kotlin
     private fun Modifier.layoutPadding(edges: () -> Edges): Modifier = layout { measurable, constraints ->
         val e = edges()
         val start = e.start.coerceAtLeast(0f).dp.roundToPx()
         val top = e.top.coerceAtLeast(0f).dp.roundToPx()
         val end = e.end.coerceAtLeast(0f).dp.roundToPx()
         val bottom = e.bottom.coerceAtLeast(0f).dp.roundToPx()
         val placeable = measurable.measure(constraints.offset(-(start + end), -(top + bottom)))
         val width = constraints.constrainWidth(placeable.width + start + end)
         val height = constraints.constrainHeight(placeable.height + top + bottom)
         layout(width, height) { placeable.placeRelative(start, top) }
     }
     ```
   - **Performance Guarantee:** Reading `edges()` inside `layout { measurable, constraints -> ... }` registers a state read exclusively with Compose's **Measure & Placement pass**. When `paddingTop` updates from JavaScript, Compose never invokes the composable lambda again—it solely re-measures the placeable and offsets placement.

---

## 4. Key Takeaways for Opus 5.5's Dynamic Layout Design

1. **Measure/Layout Phase vs Recomposition:**
   - Size properties (`width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `margin`, `padding`, `top`, `bottom`, `start`, `end`, `aspectRatio`) can be implemented via `Modifier.layout` or dynamic constraints. They run in the **Layout phase** and do not require recomposition.
   - Text properties (`fontSize`, `lineHeight`, `letterSpacing`) must update `TextStyle` on `BasicText`, which requires a single-node **Recomposition**. As Opus noted, recomposing only that single changed leaf node is very cheap.
   - Layout distribution properties (`flex`, `alignItems`, `justifyContent`, `gap`) affect container arrangements and will trigger re-measurement of the `Row` or `Column`.
2. **Special Sizing Cases to Account For:**
   - `%` dimensions (`fillMaxWidth(fraction)`) throw fatal Compose runtime exceptions if the incoming constraint is unbounded (e.g. `maxWidth == Constraints.Infinity` inside a horizontal scroll container). Dynamic `%` must clamp or fallback to intrinsic content sizing when constraints are infinite.
   - In `Row`, child stretch (`alignItems: "stretch"`) is valid in Compose only when the `Row` has a fixed, known height.
3. **The Dual-Runtime Tax (iOS Coordination):**
   - Compose uses `Modifier.layout { measurable, constraints -> ... }`.
   - SwiftUI uses `.frame(...)`, `GeometryReader`, or custom `Layout` protocol implementations (iOS 16+).
   - Any dynamic layout design must specify the exact behavior and test cases for both runtimes simultaneously.
