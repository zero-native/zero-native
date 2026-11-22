# SVG in zero-native (design)

**Status: design approved by Pavan (2026-11-03); phase 1 built (static SVG) and checked on the Lava. What changed
while building, and the phone numbers, are in §14. Phase 2 (motion: part transforms, trims, loops and keyframes for
every element) is built and checked on the Lava (§15). S.14, animated `.svg` files from the web (SMIL and CSS), is built too:
95 of 104 real loaders play as they are (§15). Phase 3 (registry 12: stroke width and dash motion, stroked shapes that
grow, path morphing, `non-scaling-stroke`, typed part names) is built: 100 of 104 play (§16). Phase 4 (registry 13: filters, masks, patterns, markers, `<text>`, moving along a path) is built too: 104 of 104 play (§17).** Calls taken as recommended: draw data in the
template file, `parts={{...}}`, no SVG `<text>` in phase 1, part names checked at build time only, `autoMirror` in phase 1,
`non-scaling-stroke` refused. Looping (`repeat`) is decided at the phase 2 check-in. Reviewed by agy (2026-11-03): its
points are folded in below. Framework work only: ZeroBill's own
SVG files and screens stay in ZeroBill's repo.

Words used here:
- **draw data**: the compact form the compiler makes from an SVG. The phone draws from it.
- **part**: one element of an SVG that the screen changes (colour, opacity, later movement), found by its `id`.
- **viewBox**: the SVG's own coordinate box (`viewBox="0 0 24 24"`).

## 1. Goal

SVG is common and powerful, so zn should support it as a first-class feature, built in, with no plugin:
1. `import Logo from "./logo.svg"` and use `<Logo size={48} color={c.brand} />`. The `.svg` stays a normal file in
   the app's source.
2. Inline SVG in TSX, in react-native-svg's shape (`<Svg viewBox="..."><Path d="..." /></Svg>`), so RN code ports.
3. Change colours and opacity of named parts at runtime (`parts={{ ring: { fill: brand() } }}`).
4. Phase 2: animate named parts (rotate, scale, move, fade, colour, "draw the line"), with zn's own `animate`.
5. No XML parsing on the phone, no cold-start cost for SVGs that are not on screen, OTA works (it is data in the
   bundle), and every unsupported SVG feature fails the build with a clear message.

## 2. What we learned from the ZeroBill RN app (read only, 2026-11-03)

- 108 files import react-native-svg; **95 are Material Symbols icons**, each a `.tsx` file with an `SvgXml` string
  (one path, `fill="currentColor"`, viewBox 24). They are imported statically (Monicon), never chosen by a string at
  runtime.
- 27 `.svg` files (icons and illustrations, 0.5–30 KB each, ~180 KB in all), loaded by `ZLocalSvg`, which reads the
  XML at runtime (and needed a workaround for release builds). Feature census of those 27 files:
  - elements: `path` 469, `circle` 37, `polygon` 37, `rect` 36, `ellipse` 32, `g` 20, `defs` 6, `clipPath` 4,
    `linearGradient` 1, `polyline` 1, `mask` 1, plus `title` / `metadata` noise from design tools;
  - attributes: `fill` 545, `transform` 259 (**all `translate`**), `opacity` 42, `fill-rule` 40, `stroke` 44,
    `stroke-width` 15, `stroke-linecap` 10, `clip-path` 4, inline `style="fill:..."` 21;
  - the one `mask` is a Figma export artefact: a white rectangle over the whole picture, the same as a clip;
  - no `<style>`, no `class`, no `<text>`, no `<image>`, no filters, no embedded bitmaps.
- About 13 files draw SVG inline. Their elements: `Stop` 45, `Path` 31, `Rect` 19, `Circle` 15, `Defs` 12,
  `LinearGradient` 8, `RadialGradient` 6, `G` 5, `ClipPath` 2, `Ellipse` 2, `Pattern` 1, `Line` 1.
  - The brief's "`Text` 26" and "`Image` 4" are **React Native's** `Text` and `Image` in those files, not SVG elements.
    **ZeroBill uses no SVG `<text>` at all.**
  - Radial gradients use object-relative units (`cx="0.38" r="0.78"`), some with stop opacity.
  - One shape is sized from JS (`rx={width / 2}`); one `Pattern` (a striped coin edge).
- Animation: 2 files. The launch story moves a dash along a heart's ECG line (`strokeDashoffset` driven by
  Reanimated); the payment banner animates a plain `View`, not SVG. Lottie is used in 7 files (stays a separate
  plugin later).

So phase 1 must cover: paths and basic shapes, fills and strokes, fill rule, transforms, opacity, linear and radial
gradients (with object units), clip paths, inline styles, `currentColor`. Text, images, filters and patterns can wait.

## 3. How it compares

| | Android VectorDrawable | AndroidSVG | react-native-svg | Compose `ImageVector` | **zn (proposed)** |
|---|---|---|---|---|---|
| Where the SVG is read | aapt at APK build (XML) | on the phone (XML parse) | on the phone (JS XML parse, `SvgXml`) | code or XML at APK build | **our compiler at bundle build** |
| OTA update | no (compiled into the APK) | yes, but parses XML each start | yes, parses in JS | no | **yes, plain data in the bundle** |
| Phone cost | small | XML parse + DOM per SVG | one native view per element, JS parse | small; bitmap cache per instance | **one Compose node, lazy parse of compact data** |
| Gradients | linear, radial, sweep | yes | yes | linear, radial (no matrix) | **linear, radial with matrix** |
| Group opacity | no | yes | yes | no | **yes (layer only when needed)** |
| Dashes | no | yes | yes | no | **yes** |
| Clip paths | groups only | yes | yes | groups only | **yes** |
| Text, filters, masks | no | most | most | no | **no in phase 1 (build error)** |
| Animate parts | AnimatedVectorDrawable | no | Reanimated (JS-driven) | Compose state | **phase 2: native, from target values** |
| Download cost | 0 | ~100+ KB dex [check] | Java + JS code | in Compose | **~8 KB of release dex (measured)** |

**Why not VectorDrawable:** it must be inside the APK, so OTA can't add or change one, and it has no group opacity or
dashes. **Why not AndroidSVG:** it parses XML on the phone (cold-start cost per SVG) and adds a library for features
ZeroBill doesn't use. **Why not Compose's `ImageVector`:** no group opacity, no dashes, no gradient matrix (needed
for object-relative radial gradients), and `VectorPainter` keeps one bitmap per instance (a 300 dp illustration is
~2.7 MB on a 2.75× phone). **Why our own small interpreter:** it draws with the same Compose `DrawScope` calls the
current `Icon` already uses ([ZnRenderer.kt:272](../android/runtime/src/main/java/dev/zeronative/runtime/ZnRenderer.kt:272)),
covers exactly the subset we promise, and its data is designed so the iOS renderer (Core Graphics) can draw the same
bytes later (SVG path text and plain matrices; Core Graphics needs a small helper for arcs, §14).

## 4. The API (proposed)

### 4.1 `.svg` files
```tsx
import Logo from "./art/logo.svg"
import Check from "./icons/check-rounded.svg"

<Check size={20} color={c.ink} />                        // tints fill="currentColor"
<Logo style={{ width: 160 }} />                           // height from the viewBox's aspect ratio
<Logo size={64} parts={{ ring: { fill: brand() }, dot: { opacity: on() ? 1 : 0.3 } }} />
<Logo size={64} accessibilityLabel="ZeroBill" />          // read by TalkBack as an image
```
- The import gives a component, not a string. The compiler reads the file at build time (like token modules today,
  [plugin.ts:182](../compiler/src/plugin.ts:182)) and the import itself disappears from the JS bundle.
- **Props:**
  | Prop | Runtime? | What it does |
  |---|---|---|
  | `size` | build time | width and height, in dp. Short for `style={{ width, height }}` |
  | `style` | build time (as today) | size, margin, position, transform, opacity of the whole SVG (`opacity` and transforms can change at runtime, as on any element) |
  | `color` | **yes** | the value of `currentColor` inside the SVG |
  | `parts` | **yes**, per value | per-part `fill`, `stroke`, `opacity` (phase 2: transforms, trim, `animate`) |
  | `accessibilityLabel`, `accessibilityHidden` | as today | see §8 |
- **Size rules:** `size`, or `style` width / height. With only one of them, the other comes from the viewBox's aspect
  ratio. With neither, the SVG's own `width` / `height` attributes are used as dp, else the viewBox size (an icon with
  `viewBox="0 0 24 24"` is 24 dp).
- **Build errors** (each with file:line:col): `color` on an SVG that has no `currentColor` ("logo.svg has no
  currentColor: add fill="currentColor" where the colour should change, or use parts"); a part name the file doesn't
  have (the message lists the ids it has); a `.svg` file with an unsupported feature (§5).
- **Choosing an SVG at runtime** uses zn's normal control flow: `{active() ? <HomeFilled /> : <HomeOutline />}`.
  There is no `src={someSvg}` slot in phase 1 (§10, open item).
- **An imported SVG is a build-time name, not a JS value.** `<Logo />` works anywhere JSX works, also as a JSX prop
  (`icon={<Logo size={20} />}`). `icon={Logo}`, `const icons = { logo: Logo }` or `Logo` in plain code are build
  errors ("pass it as JSX: icon={<Logo />}").
- **Re-export files work** (`icons.ts` with `export { default as Check } from "./check.svg"`, as in the RN app): the
  compiler follows `export ... from "./x.svg"` in relative `.ts` files to the `.svg` file. Such a file must only
  re-export; it is never run at build time for its SVGs.
- **`autoMirror`** (build time): the SVG is flipped left to right when the screen is right to left (back arrows,
  chevrons), like Android's `autoMirrored`.

### 4.2 Inline `<Svg>` (react-native-svg names)
```tsx
import { Svg, Defs, RadialGradient, Stop, Path, Circle, G } from "@zeronative/ui"

<Svg width={120} height={120} viewBox="0 0 200 200">
  <Defs>
    <RadialGradient id="shade" cx="0.38" cy="0.32" r="0.78">
      <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.4} />
      <Stop offset="1" stopColor="#082F49" stopOpacity={0.55} />
    </RadialGradient>
  </Defs>
  <Circle cx="100" cy="100" r="96" fill="url(#shade)" />
  <Path d={HEART} fill={liked() ? c.like : c.muted} />      {/* runtime value: becomes a part by itself */}
</Svg>
```
- Same names and camelCase props as react-native-svg (`strokeWidth`, `fillOpacity`, `stopColor`, `clipPath`), so
  RN code mostly copies over. `width` / `height` on `<Svg>` are allowed for RN's sake and mean the same as `style`.
- The compiler turns the whole `<Svg>` subtree into the same draw data as a `.svg` file. **It is one node in the
  template**, not one node per element.
- Values must be known at build time, except the part values in §4.3: an element with a runtime `fill`, `stroke` or
  `opacity` becomes a part automatically. A runtime value anywhere else (`cx={x()}`) is a build error: "SVG geometry
  is fixed at build time; move it with a part transform (phase 2) or choose between two shapes with a ternary".
- `.map(...)` inside `<Svg>` works only over an array known at build time (a module `const`); it is expanded by the
  compiler. `cond && <X/>` inside `<Svg>` is a build error: use the element's `opacity`.
- SVG elements outside an `<Svg>` are a build error.

### 4.3 Parts
- Any element with an `id` can be a part: a shape or a `<g>`. Paint servers (`linearGradient`, `clipPath`) can't.
- `fill` / `stroke` on a part replace the paint of **every shape inside it** that has one (a gradient too); `none`
  stays `none`. `opacity` applies to the part as a whole (a group fades as one picture).
- Values may be constants or change at runtime. Each changing value is one slot, like any other prop: a change
  redraws the one SVG and recomposes nothing.
- Why `parts={{ ring: {...} }}` (grouped by part), and not `fill={{ ring: x }}` (grouped by attribute) or
  `<Part id="ring">` children: phase 2 adds per-part `animate`, which belongs with the part's other values; one prop
  is easy to type per file later (§10); no new child rules. See `docs/second-opinions.md` entry 51.

### 4.4 `Icon`
- **Kept as it is** ([ui/index.ts:183](../packages/ui/src/index.ts:183)): registry entries are never removed, and
  screens using it keep working. Docs will say: new code uses `.svg` files.
- Not rebuilt on the new renderer: it works, and "do no harm".
- No Material Symbols conversion script in this repo. For the ZeroBill port, the icons are fetched again as `.svg`
  files (they come from Iconify) or extracted by a one-off script in ZeroBill's repo.

## 5. The supported SVG subset (phase 1; registry 13 adds much more, see §17)

Same rules for `.svg` files and inline `<Svg>`.

**Elements:** `svg` (root only), `g`, `path`, `rect` (with `rx` / `ry`), `circle`, `ellipse`, `line`, `polyline`,
`polygon`, `defs`, `linearGradient`, `radialGradient`, `stop`, `clipPath`, `use` / `symbol` (expanded at build time).
`title`, `desc`, `metadata` and editor namespaces (Inkscape, Sketch, RDF) are dropped.

**Painting:** `fill`, `stroke` (colour, `none`, `currentColor`, `url(#gradient)`), `fill-opacity`, `stroke-opacity`,
`opacity`, `fill-rule`, `clip-rule`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`,
`stroke-dasharray`, `stroke-dashoffset`. Colours: hex (3, 4, 6, 8 digits), `rgb()` / `rgba()`, the 147 SVG colour
names (converted at build time), `transparent`.

**Gradients:** `x1 y1 x2 y2` / `cx cy r`, `gradientUnits` (both), `gradientTransform`, `spreadMethod` (pad, reflect,
repeat), `stop-color`, `stop-opacity`, `offset`, `href` inheritance. Object-relative units become a matrix at build
time (the compiler works out each shape's exact bounding box), so an oval shape gets an oval radial gradient, as SVG
says.

**Geometry and transforms:** all path commands (arcs are kept; they become cubic curves only when a transform changes
their shape, such as a skew or a mirror), every `transform` form
(`matrix`, `translate`, `scale`, `rotate(a cx cy)`, `skewX`, `skewY`), `clip-path` on any element (clips may hold
shapes with transforms; `clipPathUnits` both), `display="none"` / `visibility="hidden"` (dropped).

**Root:** `viewBox`, `width`, `height`, `preserveAspectRatio` (all nine alignments, `meet`, `slice`, `none`). `none`
stretches: useful for a shape that must fill any box (the RN app's shadow ellipse sized from JS becomes
`viewBox="0 0 100 100" preserveAspectRatio="none"`).

**`style="..."`** with the same properties as above. **A `mask`** whose content is only white (fully opaque) shapes
is turned into a clip at build time (the Figma case); any other mask is an error.

**Ignored on purpose** (hints that don't change the picture): `xmlns*`, `version`, `id` on elements nobody uses,
`data-*`, `class` with no `<style>` present, `shape-rendering`, `text-rendering`, `image-rendering`,
`color-interpolation*`, `isolation`, `aria-*`, `role`, `xml:space`, `enable-background`.

**Build error, with a hint** (anything not listed above is an error too):
| Feature | Hint in the message |
|---|---|
| `text`, `tspan`, `textPath` | Convert text to outlines in the design tool, or put a zn `<Text>` over the SVG in a `<Stack>` (real text is read by TalkBack and follows font size) |
| `image` | Use `<Image>` (Coil) in a `<Stack>` |
| `pattern` | Draw the repeats as shapes (the RN coin edge is 2 stripes) |
| `filter` (blur, drop shadow) | Use the element's `elevation` / `shadowColor`, or export the effect as a PNG |
| `mask` (non-trivial), `marker`, `foreignObject`, `switch` | Flatten in the design tool |
| `animate`, `animateTransform`, `set` (SMIL) | Use parts + `animate` (phase 2) or a Lottie file (later plugin). **Update S.14:** `animate` and `animateTransform` now import (§15); `set` and `animateMotion` still fail |
| `<style>`, `class` with CSS | Inline the styles (`svgo --config` with `inlineStyles`, or the design tool's "presentation attributes" export). **Update S.14:** plain rules (class, id, tag, descendant) and `@keyframes` now import (§15) |
| nested `<svg>`, external `href`, `fx` / `fy` not equal to `cx` / `cy`, `paint-order`, `mix-blend-mode` | Flatten, or remove the attribute |
| `vector-effect="non-scaling-stroke"` | Not supported yet: the stroke would grow with the SVG. Remove it and set the stroke width for the size you use (added later if a real file needs it). **Update phase 3: supported** (§16); other `vector-effect` values still fail |

## 6. The build pipeline (compiler)

New files, all build time only:
- `compiler/src/svg-xml.ts`: a small XML reader for SVG (elements, attributes, comments, CDATA, entities, doctype).
  Every error has the `.svg` file's line and column. About 150 lines; no XML library, because we want exact error
  positions and the input is simple. (svgo was considered: big dependency tree, and its own rewrites could change a
  picture without telling us.)
- `compiler/src/svg-path.ts`: path data parser, arc → cubic, shapes → paths, matrices, exact bounding boxes.
- `compiler/src/svg.ts`: SVG tree → checked, simplified tree → draw data. Used for `.svg` files and inline `<Svg>`.

Steps for one SVG:
1. **Read** the XML (or the inline JSX subtree) into one tree. Attribute names become one internal form
   (`stroke-width` and `strokeWidth` are the same).
2. **Check** every element and attribute against §5. The first unsupported thing fails the build.
3. **Resolve** `style`, inheritance (fill, stroke, opacity... down the tree, as SVG does), `use`, gradient `href`,
   `currentColor`, colour names.
4. **Simplify:** every shape becomes a path (circles and rounded corners as arcs); path commands become absolute
   `M L C Q A Z` inside the compiler; all transforms are applied to the coordinates (stroke width scaled to match),
   except that a stroked shape under a non-uniform scale or a skew keeps a matrix (its stroke must stretch too); a
   group's `opacity` moves down to its only child; a shape's `opacity` folds into its fill and stroke alpha unless it
   has both; empty and invisible elements are dropped. **Elements with an `id` are never merged or dropped**, so a
   part's index is the same in every screen that uses the file.
5. **Round** numbers to a precision that depends on the viewBox (1/2,000 of its larger side, at most 4 decimals:
   2 decimals for a 24 icon, 1 for a 960 Material Symbol or a 1263-wide logo), then write the draw data (§6.1). Paths
   are written as short SVG path text (relative or absolute, whichever is shorter). Each relative step is taken
   between rounded points, so rounding never adds up along a long path.
6. **Parts:** for each `parts` entry (or runtime value inline), find the element by id and write an `SvgPart` child
   node with its index and values (§7).

The compiled result is cached by file path and change time, so `zn dev` doesn't recompile untouched files. `zn dev`'s
watcher must also react to `.svg` changes (today it only watches `.ts`, `.tsx`, `.json`,
[zn-dev.ts:202](../tools/zn-dev.ts:202)). Bun needs to resolve the import: the plugin adds an `onLoad` for `.svg`
that returns an empty module (the compiler has removed the import before that matters).

### 6.1 Draw data (format v1, final details in the code header)
One ASCII string per SVG: tokens separated by spaces, read once in a single pass on the phone (no XML, no regex).
The full grammar is the header of [svg-data.ts](../compiler/src/svg-data.ts:1). A tinted check icon, as built:
```
Z1 0 0 24 24 4 S c 1 - 1 0 1 0 M9.55 15.15l8.47-8.47q.3-.3.7-.3;
```
- Header: version, viewBox, aspect mode (9 alignments × meet / slice, or none).
- Defs: gradients (`LG` / `RG`: points, spread, matrix, stops) and clips (`K`: a union of paths, each with a fill rule).
- Draw list: `G` (push a group: opacity, clip) / `g` (pop), and shapes `S`: fill paint and alpha, stroke paint and
  alpha, fill rule, opacity, the stroke's width / cap / join / miter / dashes, an optional matrix, and the path as
  SVG path text ending in `;`. The phone reads the path with Compose's `PathParser` (as `Icon` does).

**Why text and not binary:** the template file already stores strings, so the format of `.zn.ui`, the template
reader and the bundle files don't change at all. **Why SVG path text and not our own cubic list** (changed while
building, `docs/second-opinions.md` entry 53): the first version wrote every curve as absolute cubic numbers, and the
draw data came out *bigger* than the source SVG (the RN assets: 162 KB of SVG → 190 KB). Minified path text with
`Q`, `T`, `A` kept is what design tools already optimise: the same assets are now 180 KB → 112 KB, and a Material icon
~450 bytes.

## 7. Template and registry changes (registry 13; host API unchanged)

**All SVG is registry 13 (2026-11-03, `docs/second-opinions.md` entry 73):** main took 11 for Tabs and 12 for pull to
refresh while SVG was being built. Phases 1–4 were built as 11, 12 and 13; none had shipped, so every SVG entry now
has since 13, one number for one feature. The ids did not change. Read "registry 11" or "registry 12" in the notes
below about SVG as 13.

**Renumbered 10 → 11 (2026-11-03):** main took registry 10 for the RN basics `TextField` `ref` while phase 1 was
being built. The SVG entries moved to 11; the ids below did not change (no clash with main). Read "registry 10" in
older notes about SVG as 11.

**Phase 3 is registry 12** (§16): SvgPart props `strokeWidth` (192, can change at runtime), `dashOffset` (193, can change
at runtime), `scaleOutline` (194), `morph` (195), `morphAt` (196). The repo's rule raises the version once per step,
also when the last one has not shipped (`docs/adding-components.md` §1). A bundle that uses none of them still asks
for 11 (or less).

**Where the draw data lives (decision, see `docs/second-opinions.md` entry 52):** as a string prop of the `Svg` node,
inside `main.zn.ui`. The template writer already stores each distinct string once
([writer.ts:124](../packages/template/src/writer.ts:124)), so an icon used in 30 screens costs one copy. The `.svg`
source stays in the app's source; its compiled form sits once in the bundle and is attached to every place that
uses it. No new bundle file, no change to bundle loading, OTA checks or signing. The other way, a separate
`main.zn.svg` pack file, is kept for later if SVG data grows past ~500 KB or a runtime `src` slot is needed (§10).

**Registry 10** (`packages/template/src/registry.ts`; ids from Claude's range, picked high so they don't clash with
the RN basics session; whichever branch merges second renumbers if needed):
| Kind | Name | Id | Type | Runtime? | Phase |
|---|---|---|---|---|---|
| component | `Svg` | 18 | | | 1 |
| component | `SvgPart` | 19 | | | 1 |
| prop | `svg` | 180 | string (draw data) | no | 1 |
| prop | `part` | 181 | number (index in the draw list) | no | 1 |
| prop | `fill` | 182 | color | **yes** | 1 |
| prop | `stroke` | 183 | color | **yes** | 1 |
| prop | `autoMirror` | 187 | bool | no | 1 |
| prop | `trimStart`, `trimEnd`, `trimOffset` | 184–186 | number (0–1 of the length) | **yes** | 2 |
| prop | `pivotX`, `pivotY` | 188–189 | number (viewBox units, written by the compiler) | no | 2 |
| prop | `paused` | 190 | bool (any element) | **yes** | 2 |
| prop | `replay` | 191 | number (any element) | **yes** | 2 |
| format | `timing.motion` | | the `~` options inside `animate` / `enter` / `exit` strings | | 2 |

**A new kind of registry entry, `format`** ([registry.ts:408](../packages/template/src/registry.ts:408)): a newer
form *inside* a string prop's value. A timing with loops or keyframes is still an `animate` string, but an older app
would misread it, so the writer raises the bundle's registry to 11 when a value uses it
([writer.ts:254](../packages/template/src/writer.ts:254)); `animate="*=t250e0"` still asks for the old registry.

`fill` and `stroke` go in `DynamicProps` and in `Added.dynamic` too: the registry lock checks runtime props on their own.

- `Svg` also uses existing props: size / margin / position style keys, `color` (runtime), `opacity` and transforms
  (runtime), `accessibilityLabel`, `accessibilityHidden`.
- `SvgPart` nodes are children of their `Svg` node. They are never drawn as their own Compose nodes; the `Svg` reads
  them. They use existing props too: `opacity` (runtime), and in phase 2 `scale`, `scaleX`, `scaleY`, `translateX`,
  `translateY`, `rotate`, `animate`.
- **Host API: no change.** No new host function, batch op, event or value kind. A bundle that uses SVG asks for
  registry 11 (the existing `Added` mechanism); bundles without SVG still run on older apps.
- **Template format: no change.**

## 8. Drawing on the phone (Kotlin)

New file `ZnSvg.kt` in the runtime, one line in `ZnRenderer.kt`'s `when`, prop fields in `ZnTemplate.kt`:
- **Lazy and shared:** the draw data is parsed the first time an SVG is drawn, not when templates load, so SVGs that
  are not on screen cost nothing beyond their string (the template reader decodes every string once at start). The
  parsed drawing (Compose `Path`s, `Stroke`s, gradient brushes) is kept in a cache that belongs to the bundle and is
  keyed by the draw data string: one parse per distinct SVG, shared by every instance and list row; it goes away with
  its bundle (after an OTA apply in place or a `zn dev` reload). Only the main thread uses it. (Changed after review: a
  global weak map was the first plan.)
- **One node:** a `Spacer` with `drawBehind`, like `Icon` today. The viewBox → box mapping (with
  `preserveAspectRatio`) is one transform; gradients are made in viewBox space, so they don't depend on the size.
- **Runtime values** (`color`, part `fill` / `stroke` / `opacity`) are read from slot cells inside the draw lambda:
  a change redraws the SVG only, never recomposes or re-lays out.
- **Opacity:** a group (or a shape with both fill and stroke) that is translucent is drawn in a layer
  (`saveLayer`), so overlapping children don't show through each other. Everything else just multiplies alpha, no
  layer. The compiler already removed most layers (§6 step 4).
- **Gradients:** `android.graphics` `LinearGradient` / `RadialGradient` with the compiled matrix as their local
  matrix, wrapped in a Compose `ShaderBrush`.
- **Clips:** `clipPath` in the draw scope. [check: edge smoothness of clips on old Android versions; the Lava is
  Android 14.]
- **A bad draw data string** (should never happen: the compiler made it) draws nothing and reports one error,
  like an unknown `<NativeView>`.

**Accessibility:** like `Image`. Without `accessibilityLabel` the SVG is decorative and TalkBack skips it. With one,
TalkBack reads it once, as an image. The SVG's own `<title>` is ignored (design tools fill it with names like
"Group 12"). An icon-only button puts the label on its `Pressable`, as today.

**Dark mode:** colours inside an SVG are fixed. Colours that follow the theme go through `color` or `parts`, with
`scheme(...)` values as on any other element (guide notes §37).

**Right to left:** an SVG is not mirrored (same as react-native-svg), unless it has `autoMirror` (§4.1).

## 9. Animation (phase 2, built 2026-11-03)

```tsx
<Gauge size={120} parts={{ needle: { rotate: angle(), animate: "spring" }, arc: { trimEnd: progress(), animate: 600 } }} />
<Heart size={160} parts={{ ecg: { trimEnd: 1, animate: { trimEnd: { duration: 900, from: 0, repeat: "forever" } } } }} />
// Inline: motion props make the element a part.
<Svg viewBox="0 0 24 24" size={36}>
  <Circle cx={12} cy={12} r={9} stroke={c.primary} fill="none" trimEnd={0.28}
    rotate={360} animate={{ rotate: { duration: 900, easing: "linear", from: 0, repeat: "forever" } }} paused={paused()} />
</Svg>
```

**As built** (the plan as it was is kept below it):
- **Timing options for every element**, not only SVG parts (Pavan's call: industry standard plus zn's own). A timing
  object takes `delay`, `repeat` (how many plays in all, or `"forever"`, as in CSS `iteration-count`, Compose
  `repeatable`, RN `Animated.loop`), `reverse` (every second play backwards, CSS `alternate`), `repeatDelay`,
  `from` (plays from this value to the rest value), `keyframes` + `times`, and `easing` as a name or a cubic-bezier
  `[x1, y1, x2, y2]`. `enter` / `exit` take `delay` (a list stagger). The element props `paused` (CSS play-state)
  and `replay` (a new number plays it again: a shake on a wrong OTP) can change at runtime.
- **When it plays:** a timing with `from` or `keyframes` plays by itself when the element appears and on each
  `replay` change (with `from`, also when the rest value changes). Without them it animates value changes, as
  before. A finite run stays where its last play ends. With "Remove animations" on (Android's animator scale 0),
  the rest value shows and nothing loops; other scales stretch the time, like the rest of Android.
- **Build checks:** `repeat`, `reverse`, `from` and `keyframes` belong to one prop (`animate={{ rotate: {...} }}`),
  not to `animate={{...all}}`; `reverse` and `repeatDelay` need `repeat`; `keyframes` need 2 or more; `times` rise
  from 0 to 1 with one per keyframe; colours work in `from` / `keyframes` for `backgroundColor`, `fill`, `stroke`.
- **Parts move:** `rotate`, `scale` / `scaleX` / `scaleY`, `translateX` / `translateY` (viewBox units) and the trims,
  as part values (runtime or build time) and in a part's `animate`. The pivot is the part's own box centre,
  worked out by the compiler (`pivotX` / `pivotY`, only when the part turns or scales).
- **Trims** cut fill and stroke, like VectorDrawable and Lottie. `start > end` swaps them; `trimOffset` moves the
  piece round the line and wraps. A group's trim treats all its shapes as one line, in draw order; the nearest
  trim wins (a shape's own trim over its group's). Lengths are measured on the first trimmed draw only.
- **Code:** compiler [compile.ts:893](../compiler/src/compile.ts:893) (timing options),
  [compile.ts:548](../compiler/src/compile.ts:548) (part values and pivot), boxes in
  [svg.ts:200](../compiler/src/svg.ts:200); phone [ZnAnimation.kt:378](../android/runtime/src/main/java/dev/zeronative/runtime/ZnAnimation.kt:378)
  (`znMotion`: the clock for loops and keyframes, [motionAt](../android/runtime/src/main/java/dev/zeronative/runtime/ZnAnimation.kt:307)
  for the play position), [ZnSvg.kt:504](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:504)
  (per-part readers), [ZnSvg.kt:595](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:595)
  (drawing with transforms), [ZnSvg.kt:760](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:760)
  (trims).
- **Changed from the plan below:** `repeat: "loop" | "reverse"` became `repeat` (a count or `"forever"`) plus
  `reverse`, the names CSS and Compose use. `paused` is an element prop, not a timing option, so it can change at
  runtime without a new timing. Trim lengths come from `PathMeasure` as planned, but the cut runs on every draw
  while a part is trimmed (one reused path; cheap for icon-sized lines). SMIL in `.svg` files is still refused: see
  §15 for the proposed import.

**The plan, as written before building:**
- **Animatable on a part:** `opacity`, `fill`, `stroke`, `scale` / `scaleX` / `scaleY`, `translateX` /
  `translateY` (in viewBox units), `rotate` (degrees), `trimStart` / `trimEnd` / `trimOffset` ("draw the line": the
  visible part of the stroke, as fractions of its length; all its pieces count as one line).
- **Same model as zn's `animate` today** ([guide-notes.md §22](guide-notes.md)): JS sets target values, native
  animates with a tween or spring, read in the draw phase. No per-frame JS.
- **Pivot:** a part rotates and scales around the centre of its own bounding box (worked out at build time), like
  CSS `transform-box: fill-box`. SVG's default (the viewBox origin) is almost never what an author wants. An
  `origin` option can come later if a real case needs it.
- **Looping** (spinners, pulse rings, the ECG sweep) needs something zn doesn't have yet: `repeat: "loop" | "reverse"`
  on a timing. It is general (it would work on a `Box` too), so it is a separate decision (§10).
- **`enter`** on a part (for example a "draw" preset that traces the line when the SVG appears) fits the same model.
- **Not planned:** SMIL in `.svg` files (refused at build), CSS animations, morphing one path into another (needs
  matching point counts; Lottie covers it).
- Kotlin: per part, an `Animatable` per animated value inside the `Svg` composable (the part count is fixed by the
  template, so this is stable). Trim uses `android.graphics.PathMeasure`: it measures one contour at a time, so the
  code steps through every contour with `nextContour()`, adds up their lengths, and cuts each one. Done only while
  trim values change.

## 10. Open items (decided later, not blockers)

- **Typed part names in the editor.** Phase 1: `parts` keys are checked at build time; in the editor they are plain
  strings. Option: the build writes `logo.d.svg.ts` next to each `.svg` (TypeScript's `allowArbitraryExtensions`), so
  `parts` keys autocomplete. Costs one generated file per SVG in the source folders. **Built in phase 3** (§16).
- **Simple `<text>`** (one line, system font, `x`, `y`, `font-size`, `font-weight`, `text-anchor`, fill). Not used
  by ZeroBill; real text is better as a zn `<Text>` over the SVG.
- **Later, as an official plugin ("SVG by value", decided 2026-11-03):** both of these draw an SVG the build never
  saw, so they need an SVG reader on the phone. That belongs in a plugin, not in core:
  - **Runtime choice by value** (`<Svg src={icons[name()]} />`, for server-chosen icons). (Inside core it would need
    the pack file, §7, so JS can send a small number instead of the data.)
  - **Remote SVG** (`https://.../x.svg`): a reader on the phone, with size and time limits, as the files are untrusted.
- **Later (decided 2026-11-03):** masks other than plain white shapes, patterns. Built only when a real file needs them.
- **Later, maybe:** drop shadows and blur (filters). Android's blur works on Android 12+ only, so older phones would
  skip the filter; the 4 corpus files still refused ("gooey" balls) need it. Sweep gradients.
- **iOS:** the same draw data drawn with Core Graphics (`CGPath`, `CGGradient`).

## 11. Size and cold start

**Measured so far** (2026-11-03, no phone yet): the SVG classes are ~7.8 KB of release dex (apkanalyzer with the R8
mapping, 17 classes); no new library. The RN assets compile to 112 KB of draw data (from 180 KB of SVG); the 95
Material icons to 41 KB (avg 445 B). Phone numbers (Lava, release): see §14.

**Targets** (set before building):
- Runtime code: under 25 KB of dex after R8. No new library.
- Bundle: about the size of the minified SVG. A Material icon ~250–400 bytes; the 27 RN assets (~180 KB of XML) should
  shrink to roughly 90–120 KB of draw data, before zip.
- Cold start: no change when the first screen has no SVG. Template reading decodes the strings (a fraction of a ms
  for 100 KB). Parsing happens at first draw: well under 1 ms for an icon, ~1 ms for a 30 KB illustration
  [check on the Lava].

**How we will measure** (method in `docs/startup-and-performance.md` §3; release R8 build of the sample, Lava):
1. Download size and dex size of the sample before and after (bundletool + brotli), and `main.zn.ui` before / after
   the SVG lab screen.
2. Cold start of the start screen before and after (should be equal), n = 10, median.
3. A one-off measuring build that logs parse and first-draw time of each lab SVG, and frame times while scrolling a
   list of illustrations (`dumpsys gfxinfo`).
4. Phone rule: the app is stopped with HOME + `am kill` for release cold starts, not `am force-stop` (DuraSpeed,
   `~/.claude/android-phone-notes.md`). Every phone step is cleared with Pavan first.

## 12. Phases and steps

**Phase 1 (static):**
| Step | What | Done when |
|---|---|---|
| S.1 | Registry 10: `Svg`, `SvgPart`, `svg`, `part`, `fill`, `stroke`; `gen:registry`; types in `packages/ui` (`Svg`, the element names, `declare module "*.svg"`) | registry test and type tests pass |
| S.2 | Compiler: `svg-xml.ts`, `svg-path.ts`, `svg.ts`; `.svg` imports; inline `<Svg>`; `parts`; `zn dev` watches `.svg` | a test for every supported feature and every refused one (message and position) |
| S.3 | Kotlin `ZnSvg.kt`: parser, drawing, gradients, clips, layers, runtime values | Kotlin unit tests for the parser; lint |
| S.4 | Sample "SVG lab" screen: an icon set (Material Symbols, Apache 2.0), a gradient card, a clipped logo-style shape, the text-over-SVG pattern, parts changing at runtime, SVGs in a list | looks right on the Lava next to the source SVGs |
| S.5 | Check the 95 icons + 27 assets of the RN app compile (read from its folder, **nothing copied into this repo**); fix or list what fails | a short result list in the hand-over |
| S.6 | R8 release: size and cold start, parse / draw times (§11) | numbers in `docs/startup-and-performance.md` §4 |
| S.7 | Docs: this file (as built), `components.md`, `guide-notes.md`, `rn-compatibility.md` rows, `ARCHITECTURE.md` (§9.2, §24), `milestones.md`, `second-opinions.md` | |

**Phase 2 (animated), after a check-in:** S.8 part transforms + pivot, S.9 trim, S.10 `repeat` loops (if Pavan
agrees, §9), S.11 lab screen with a spinner, a gauge and a line drawing itself; phone check.

**Phase 2 as agreed at the check-in (2026-11-03):**
| Step | What | Status |
|---|---|---|
| S.8 | Timing options for every element: `repeat`, `reverse`, `from`, `delay`, `repeatDelay`, `keyframes` + `times`, bezier easing; `paused`, `replay` | done |
| S.9 | Part transforms around the part's centre | done |
| S.10 | Trims (fill and stroke; a group is one line) | done |
| S.11 | Per-part `animate` (and inline motion props) | done |
| S.12 | Lab: spinner, pulse, gauge, ECG line, a tick that draws itself, a shake, a looping button, one pause | done; checked on the Lava |
| S.13 | Docs | done |
| S.14 | Animated `.svg` files (SMIL, CSS `@keyframes`) import as part animations; a corpus of 104 real files as tests | done; 95 of 104; checked on the Lava |

**Phase 3 (registry 12), agreed 2026-11-03** (§16):
| Step | What | Status |
|---|---|---|
| S.15 | Stroke motion: stroked shapes that grow (the outline scales, the stroke keeps its width), `strokeWidth` and `dashOffset` on parts, one-dash animations as trims | built |
| S.16 | `vector-effect="non-scaling-stroke"` | built |
| S.17 | Path morphing (SMIL `d`, CSS `d: path()`) | built |
| S.18 | Typed part names (`logo.d.svg.ts`) | built |
| S.19 | Lab, tests (corpus 100 of 104), docs; phone check | built; checked on the Lava (debug) |

## 13. Risks

| Risk | What we do |
|---|---|
| Our renderer draws something differently from browsers | Lab screen next to the source SVGs on the phone; the corpus check (S.5); refuse what we can't draw right instead of drawing it wrong |
| Big illustrations are slow to draw in a scrolling list (Android draws paths again each frame) | Measure in S.6. If slow: draw into a cached layer (`graphicsLayer`) for static SVGs |
| Clip edges look jagged on old Android versions | [check] on an older phone or emulator; else clip with a layer and `DstIn` |
| Design tools export features we refuse, so authors hit build errors | Clear hints per feature (§5 table); the RN assets show the common cases pass |
| The RN basics session takes the same registry ids | Renumber at the second merge (agreed); ids picked from the top of the range |
| Draw data parse on the main thread at first draw for a huge SVG | Measure; if over ~4 ms, parse the bundle's SVGs on the I/O thread after the first frame (not before it, so cold start stays the same). **Measured:** a 23 KB SVG takes 6–7 ms on a fresh install, 1.4 ms with AOT code; kept on first draw for now (entry 54, §14). **Phase 4:** draw data of 8 KB or more is read on a background thread after the first frame ([ZnSvgCache.prefetch](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:688)); an SVG drawn before that still reads on first draw |

## 14. As built (phase 1, 2026-11-03)

Where the code is:
- Compiler: [svg-xml.ts](../compiler/src/svg-xml.ts:1) (XML reader), [svg-path.ts](../compiler/src/svg-path.ts:1)
  (path data, arcs, matrices, boxes), [svg.ts](../compiler/src/svg.ts:149) (checks, inheritance, gradients, clips,
  parts), [svg-data.ts](../compiler/src/svg-data.ts:1) (format v1 and its writer). In TSX:
  [compile.ts:488](../compiler/src/compile.ts:488) (`.svg` components and `parts`),
  [compile.ts:537](../compiler/src/compile.ts:537) (inline `<Svg>`), re-export files in
  [plugin.ts:185](../compiler/src/plugin.ts:185).
- Phone: [ZnSvg.kt](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:122) (reader, cache at line 429,
  drawing at line 508, the composable at line 773), one line in
  [ZnRenderer.kt:288](../android/runtime/src/main/java/dev/zeronative/runtime/ZnRenderer.kt:288).
- Tests: [compiler/test/svg.test.ts](../compiler/test/svg.test.ts:1) (59 tests: every supported and refused feature,
  TSX use), [ZnSvgTest.kt](../android/runtime/src/test/java/dev/zeronative/runtime/ZnSvgTest.kt:1).
- Sample: [SvgLab.tsx](../examples/sample/src/SvgLab.tsx:1), route `/dev/svg`, a row on the Dev screens list.

What changed from the design above:
- **Paths are SVG path text, arcs kept** (§6.1; second-opinions entry 53). For the iOS renderer later this means a
  small SVG-path reader with an arc → cubic helper (about 80 lines), not "plain cubics only".
- **Precision is 1/2,000 of the viewBox's larger side** (the design said 1/10,000). At 1/2,000 a 24 dp icon is exact
  to 0.012 dp, far below a pixel; it saved ~10 % more data (125 → 112 KB on the RN assets).
- **The node count includes the parts:** a `.svg` with 2 parts is 3 template nodes (`Svg` + 2 `SvgPart`), so a branch
  after it mounts at the right index.

Checked so far:
- The RN app's 27 `.svg` assets and 95 Material icons all compile (read from its folder; nothing copied).
- **Compiler output vs the browser:** a scratch page turned the draw data of 39 SVGs (the 27 assets, the lab's 12
  files) back into SVG and compared it with the original, pixel by pixel, in the browser pane. No strong pixel
  differences; only anti-aliased edge pixels (under 1 %). This checks the compiler, not the Kotlin drawing.
- A real bug found by the new tests and fixed: extra number pairs after `M x y` were read as more moves instead of
  lines (SVG says they are lines).
- Material Symbols files as downloaded have **no fill** (black by default), so `color` can't tint them: add
  `fill="currentColor"` to their `<svg>` (the lab's icons have it; guide notes say so).

On the Lava (2026-11-03, release R8 build unless it says debug):
- **Looks right** (debug and release): the gradient card with its clipped corners and glow, text over it, the 8 tinted
  icons, the clipped avatar. Taps work: the heart swaps between two files, the badge's ring and tick change colour
  (a part `stroke`), the tick hides (a part `opacity`). No errors in the log.
- **Cold start** of the start screen (no SVG on it): **176.5 ms** median (p90 180, min 165, n=10; HOME + `am kill`).
  Same as after P.3b–P.6 (177.5 ms).
- **Parse at first draw** (one-off timing log, since removed), as installed by adb (no AOT code yet) / after
  `cmd package compile -m speed`:
  | SVG | Draw data | Parse, as installed | Parse, AOT | Each later draw |
  |---|---|---|---|---|
  | a generated 30 KB test illustration (~400 shapes) | 23 KB | 6.3–7.3 ms | 1.4–1.5 ms | ~0.6 ms |
  | the wallet card | 1.2 KB | ~0.5 ms | ~0.1 ms | ~0.02 ms |
  | a Material icon | 0.3–0.6 KB | 0.13–0.5 ms | 0.03–0.1 ms | 0.01–0.05 ms |
  The first parse of a big SVG on a fresh install is over the ~4 ms line in §13. Not changed for now
  (`docs/second-opinions.md` entry 54).
- **Scrolling** (`dumpsys gfxinfo`, 90 Hz screen, fast flings): the 60-row list with an icon per row, 5 janky frames
  of 641 (0.8 %), median frame 7 ms. A stress list of 20 full-width copies of the 23 KB illustration: 5 janky of 825
  (0.6 %), median 15 ms, GPU median 9 ms. The few janky frames come at the start of flings in both, so they don't
  look SVG-specific.

Not checked yet: TalkBack on the lab, right to left (`autoMirror`), an older Android version (clip edges, §13).

## 15. As built (phase 2, 2026-11-03) and what comes next

What is in (details in §9):
- Timing options for every element, `paused` / `replay`, part transforms around the part's centre, trims, per-part `animate`, and the
  same motion props on inline elements. Registry 11 with the `format` kind (§7).
- Tests: [svg.test.ts](../compiler/test/svg.test.ts:1) (part motion, pivots, inline motion props, errors), the motion block in
  [compile.test.ts](../compiler/test/compile.test.ts:1) (timing encodings, errors, old format unchanged), the registry format test,
  [ZnAnimationTest.kt](../android/runtime/src/test/java/dev/zeronative/runtime/ZnAnimationTest.kt:1) (options, play positions),
  [ZnSvgTest.kt](../android/runtime/src/test/java/dev/zeronative/runtime/ZnSvgTest.kt:1) (trim ranges). JS 385, Kotlin 142.
- Lab: the Motion section of [SvgLab.tsx:142](../examples/sample/src/SvgLab.tsx:142): a spinner, a live pulse, a gauge (tap),
  an ECG line, a paid badge whose ring and tick draw themselves (tap to replay), a wrong-OTP shake, a looping Pay button, one pause.

Not checked yet: the lab on the phone, frame times while loops run, "Remove animations" (the rest values must show), TalkBack.
**Update (Lava, debug build, 2026-11-03):** checked. Every tile moves and looks right; taps replay; pause holds every loop
(two shots 1.5 s apart are identical); with the three animation scales at 0 the rest values show and nothing loops (scales
put back to 1.0). 8 s with all loops on screen: 736 frames at 90 Hz, 0 janky, GPU median 4 ms. **A crash found and fixed:** a
shape whose own trim showed the whole line (`trimEnd={1}` at rest) read index -1 in `trimPath`
([ZnSvg.kt:722](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:722)). TalkBack still not checked.

Known limits:
- Trim lengths ignore a shape's own matrix shape (a skew); they use its average scale. Only matters for a group trim across
  shapes with different skews. **Fixed in phase 4 (§17):** such a shape is measured on its transformed path.
- Nested trims: the nearest wins; they don't combine. **Fixed in phase 4 (§17):** they combine, so a shape shows only what
  every trim above it shows.
- "Remove animations" reaches us as Compose's `MotionDurationScale` (Android's animator scale). Scale 0 shows the rest values
  (checked on the Lava, above).

**S.14: animated `.svg` files from the web, built (2026-11-03, approved by Pavan: "add them as tests").** The import is
[svg-anim.ts](../compiler/src/svg-anim.ts:1), run by `compileSvgTree` before and after the still-picture compiler. A downloaded
loader now plays as it is: `import Spinner from "./spinner.svg"` then `<Spinner size={24} color={c.primary} paused={...} />`.
- **Corpus:** 104 real files from two MIT sets (svg-spinners: 46 SMIL + 46 CSS; SVG-Loaders: 12), kept as test fixtures with
  their licences ([fixtures/animated-svg](../compiler/test/fixtures/animated-svg/README.md)). **95 compile**; the 9 others fail with
  a hint: 4 use filters (gooey), 2 animate dashes, 1 stroke width, 2 grow shapes that have a stroke.
- **How it maps** (all exact, no sampling):
  - SMIL `values` / `keyTimes` / `keySplines` / `calcMode` / `repeatCount` / `fill`, and CSS `animation-*` / `@keyframes` /
    keyframe timing functions / `transform-origin` / `transform-box`, become `keyframes` / `times` / one easing per segment
    (new `z` option) / `repeat` / `delay` / `reverse`. `discrete` and `step-end` use a step easing (id 5).
  - Transforms (rotate with its centre, scale, translate; CSS lists in translate → rotate → scale order) become the part's
    transform, with the pivot at the rotate centre or the CSS origin.
  - Geometry of shapes with no stroke (`cx`, `cy`, `r`, `rx`, `ry`, `x`, `y`, `width`, `height`) becomes a scale and a move
    around the shape's centre: exact for a fill. A size that starts at 0 is drawn at its largest and scaled down.
  - `fill-opacity` / `stroke-opacity` on a plain colour become that colour's alpha (exact even with the other paint).
  - **SMIL begin chains** (`begin="0;b.end-0.1s"`) are worked out over 120 s and flattened into one cycle per animation;
    several animations of one attribute merge by SMIL's rule (the one that started last wins).
  - A negative CSS delay turns the loop round to start part way in. Static CSS rules (class, id, tag, `a b`) are written
    into the elements, so `<style>` with plain colours now works too.
  - `paused` / `replay` on the `<Svg>` node reach every part inside it, the file's own motion included.
- **Still refused, with a hint:** filters, `animateMotion`, morphing `d`, stroke width or dash animation (draw the line with
  trims instead), geometry of stroked shapes, `begin="click"` and other events, `steps(n)` with n > 1, CSS selectors other
  than class / id / tag / descendant, `@media`, skews, rotations inside stretched groups. **Update phase 3:** morphing,
  stroke width, dashes and stroked shapes now import (§16); 100 of 104 compile.
- **Checked on the Lava** (debug): six loaders in the lab (ring, dots, bars, pulse rings, wifi, bouncing ball) play and look
  right; pause and play work; 16 loops on screen at once: 0 janky frames in 8 s, GPU median 3 ms.
- **Tests:** [svg-anim.test.ts](../compiler/test/svg-anim.test.ts:1) (the corpus by name, exact encodings for each rule, errors,
  TSX use), `segmentEasings` in [ZnAnimationTest.kt](../android/runtime/src/test/java/dev/zeronative/runtime/ZnAnimationTest.kt:1).
  JS 403, Kotlin 143.
- **Size:** a loader's draw data plus motion is about the size of the source file (the six lab loaders added ~5 KB to
  `main.zn.ui`, sources ~6 KB).

**The S.14 proposal, as written before building:** files from icon and loader sites move with SMIL
(`<animate>`, `<animateTransform>`) or CSS `@keyframes` inside the file. Both are refused today (§5). An import could turn them
into the same part animations at build time, as most of them only turn, scale, move, fade, recolour or dash a line:
- SMIL `values` / `keyTimes` / `keySplines` / `repeatCount` / `begin` map onto `keyframes` / `times` / bezier / `repeat` / `delay`;
  CSS `@keyframes`, `animation-*` and `transform-origin` the same way. `stroke-dashoffset` tricks become trims.
- Still refused, with a hint: path morphing (animating `d`), `animateMotion` (move along a path), JS-driven files (SVGator's
  player, GSAP), triggers like `begin="click"`, animated filters.
- Start with a corpus check: 30–50 real animated SVGs (fetched to a scratch folder only), to count how many the import would cover.

## 16. As built (phase 3, registry 12, 2026-11-03)

What it adds, and how. All of it is framework work.

**Stroke motion** (S.15):
- **A stroked shape that grows** (`r`, `rx`, `ry`, `width`, `height` animated on a circle, ellipse or rect with a stroke):
  the compiler sets the part's `scaleOutline` ([svg-anim.ts:1547](../compiler/src/svg-anim.ts:1547)). On the phone the
  part's scale goes into the path, not the canvas, so the stroke keeps its width, as when the browser changes `r`
  ([ZnSvg.kt:838](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:838)). A stroked shape that only moves
  (`cx`, `cy`, `x`, `y`) needs no flag. Inside a stretched group (a stroke under a non-uniform scale) it still fails.
- **`strokeWidth`** on a part: the width of every stroke inside it, in viewBox units. Animated `stroke-width` in a file
  maps to it (it starts from the inherited width; a width that starts at 0 is baked at its largest). Authors can set it
  in `parts` too, and change it at runtime.
- **Dashes** ([bakeStroke](../compiler/src/svg-anim.ts:604)):
  - **One dash with a gap at least as long as the line** (the usual "ring that fills" and "draw the line" tricks): only
    the first dash can ever show, so it becomes the part's trims and the shape is drawn solid. The piece runs from
    `-offset` to `dash - offset` along the line, cut at its ends (SVG doesn't wrap dashes round). Where a cut end
    reaches the line's end, the segment is split exactly at that moment ([clampSplit](../compiler/src/svg-anim.ts:1767)).
    `pathLength` is honoured. Lines of one piece only (a circle, a rect, one path).
  - **A fixed pattern whose offset moves** ("marching ants"): the dashes stay in the draw data and move with the part's
    `dashOffset`. Any other changing dash pattern fails with a hint.
- On the phone a part's width or offset makes one new `Stroke` per shape, made again only when the value changes
  ([strokeFor](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:870)).

**`vector-effect="non-scaling-stroke"`** (S.16): the stroke is that many dp wide, whatever the SVG's size, the shape's
matrix or a part's scale. The draw data writes the width negative (format v1, no new token;
[svg.ts:419](../compiler/src/svg.ts:419), read at [ZnSvg.kt:251](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:251)).
Dashes on a non-scaling stroke fail (their lengths would need the same rule). Other `vector-effect` values fail. An
older app refuses a negative width, so the registry `format` "svg.nonScaling" (since 12) makes such a bundle ask for 12.

**Path morphing** (S.17): SMIL `<animate attributeName="d">` and CSS `d: path("...")` keyframes.
- The compiler writes every keyframe in one form: M, C and Z only (lines become straight cubics, arcs become cubics, both
  exact; [cubicForm](../compiler/src/svg-anim.ts:1705)). Keyframes with different commands fail with a hint, as SMIL itself
  needs matching paths.
- The part gets `morph` ("MCCZ|x y ...|x y ...", in viewBox space) and an animated `morphAt` (0 = the first keyframe, 1.5 =
  half way from the second to the third), on the same timing as any other motion, so easing, repeat, pause and replay all
  work. At rest (`morphAt` -1, also with "Remove animations") the shape draws its own `d`.
- On the phone each frame mixes two keyframes' numbers into one reused path
  ([ZnSvgMorph](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:495)). A morph and a trim on one shape fail at build.

**Typed part names** (S.18): when a TSX file imports `logo.svg`, the build writes `logo.d.svg.ts` next to it with the
file's part names ([writeSvgTypes](../compiler/src/compile.ts:1406)), so `parts={{ ri| }}` autocompletes and a typo is a
type error. It needs `"allowArbitraryExtensions": true` in the app's tsconfig, and `*.d.svg.ts` in `.gitignore` (both set
for the sample and this repo). Until the first build, the plain `*.svg` type stays, and the build still checks the names.

**Corpus:** 100 of 104 compile (was 95). Fixed: `ball-triangle` (stroked circles that move), `puff` (stroked circles that
grow), `rings` (grow plus stroke width), `ring-resize` SMIL and CSS (one dash as trims). Still refused: the 4 "gooey" files
(filters).

**Lab** (`zn://sample/dev/svg`, Motion section): Resize, Puff, Ripple (`rings`), Triangle, a dash that morphs into a tick
(our own `svg/tick-morph.svg`), and a chart line with a non-scaling stroke at 20, 40 and 52 dp (`svg/spark-line.svg`).

**Checked:** JS 821 tests (corpus by name, exact encodings for each new rule, errors, TSX `parts` and the type file), both
type checks (and a wrong part name failing in the sample), Kotlin 163 (`nonScalingStrokeIsANegativeWidth`,
`morphMixesKeyframes`), lint, sample debug build. On the Lava (debug build, 2026-11-03): all six new tiles draw and
move (Resize trims its arc, Puff's ring grows with a thin stroke, Ripple, Triangle, the dash turns into a tick and back);
the chart line is the same 2 dp (4 px) at 20, 40 and 52 dp; pause holds every frame; with "Remove animations" each file
shows its own rest values (Resize a full ring, Puff a dot, Morph the dash); 729 frames in 8 s with every loop running,
1 slow frame, 99th percentile 19 ms; no app errors in the log. **Not checked yet:** a release build, TalkBack.

**Known limits:**
- A dash's zero-length start with a round cap: SVG draws a dot, the trims draw nothing (for one frame of `ring-resize`).
  **Fixed in phase 4 (§17):** the part's `trimCaps` draws the dot.
- A non-scaling stroke inside a part that scales a group uses the group's average scale (`sqrt(|sx * sy|)`).
  **Fixed in phase 4 (§17):** when the way to the screen stretches unevenly, the stroke is drawn in screen space.
- `strokeWidth` on a group part replaces the width of every stroke inside, also a child that set its own (SVG would keep
  the child's). **Fixed in phase 4 (§17):** the compiler gives such a child its own `strokeWidth`.

## 17. As built (phase 4, registry 13, 2026-11-03)

Pavan's ask: finish SVG and animated SVG on Android. All of it is framework work. A bundle that uses any of it asks for
registry 13 (registry `format` "svg.effects" for the draw data, "timing.tap" for a tap to start); bundles without it
still run on older apps. Host API, template format and draw data format v1 are unchanged (new tokens only).

**Corpus first.** A survey (a Haiku agent, 2026-11-03) picked 78 real files that use what was still refused: the resvg
test suite (one feature per file), Meteocons weather icons, line-md and Fluent emoji. They are test fixtures now, with
their licences ([fixtures/svg-features](../compiler/test/fixtures/svg-features/README.md)). **75 of 78 compile**; the 3
others are refused on purpose (below). The animated corpus: **104 of 104** (was 100; the 4 "gooey" files use filters).

### Still pictures

What compiles now that failed before ([svg.ts](../compiler/src/svg.ts:1), tokens in
[svg-data.ts](../compiler/src/svg-data.ts:1)):
- **Filters** ("FL", [filterPrims](../compiler/src/svg.ts:1299)): `feGaussianBlur`, `feOffset`, `feFlood`,
  `feColorMatrix`, `feComposite` (the plain operators, plus the arithmetic forms of a sum and Figma's inner shadow),
  `feBlend`, `feMerge`, `feDropShadow`, with `in` / `in2` / `result`, the filter region and `primitiveUnits`.
  Refused with a hint: turbulence, displacement, lighting, morphology, convolve, component transfer, `feImage`,
  `feTile`, and arithmetic with other numbers ("export the effect as a PNG").
- **Masks** ("MK", [mask](../compiler/src/svg.ts:1543)): luminance and alpha, `maskUnits` / `maskContentUnits`.
  A mask of plain white shapes still becomes a clip (cheaper), as before.
- **Patterns** ("PT", [pattern](../compiler/src/svg.ts:1187)) as fill or stroke paint, with `patternUnits`,
  `patternContentUnits`, `patternTransform`, `viewBox` and `href` inheritance.
- **Radial gradients with a focal point** ("RF"): `fx`, `fy`, `fr`. A focal point outside the circle moves onto its
  edge, as browsers do.
- **Markers** ([markers](../compiler/src/svg.ts:730)): `marker-start` / `-mid` / `-end` and the `marker` shorthand,
  `orient` (a number, `auto`, `auto-start-reverse`), `markerUnits`, `viewBox`, `refX` / `refY`, overflow. They are
  copied into the draw data at build time, so the phone draws plain shapes.
- **`paint-order`** ([paintOrder](../compiler/src/svg.ts:554)) and **`mix-blend-mode`** (all 15 modes; "X" op).
  A blend mixes only with what the SVG itself drew, so an SVG with a blend draws in one layer.
- **Nested `<svg>`** ([nestedSvg](../compiler/src/svg.ts:523)) and **`<switch>`**: the first child whose conditions
  pass. `systemLanguage` is checked against English (the build can't know the phone's language).
- **Text** ("T", [text](../compiler/src/svg.ts:801)): `<text>` and `<tspan>` with `x`, `y`, one `dx` / `dy` per piece,
  `text-anchor`, `font-size`, `font-weight`, `font-style`, a generic `font-family` (sans-serif, serif, monospace: the
  phone's own fonts), `letter-spacing`, `dominant-baseline`, fill and stroke. The joined text is the Svg's TalkBack
  label when the author gave none ([compile.ts:516](../compiler/src/compile.ts:516)). Refused: `<textPath>`, `rotate`, `textLength`,
  several `dx` / `dy` values (one per character), decorations. Text drawn in a design tool is best exported as
  outlines; this is for simple labels.
- **Clips** with `clipPathUnits="objectBoundingBox"` on a group now use the group's box.

On the phone ([ZnSvgEffects.kt](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvgEffects.kt:1)):
- A filter runs as an Android `RenderEffect` on a `RenderNode` (Android 12+, hardware drawing), made again only when
  the SVG's scale changes. **Below Android 12 (Pavan: "your call")**: the group is drawn without its filter, under the
  plain drop shadows the compiler found in it (a `BlurMaskFilter`, Android 9+). A blur alone draws the group sharp.
- **iOS** ([ZnSvgFilters.swift](../ios/ZnRuntime/Swift/ZnSvgFilters.swift:1)) runs the whole graph as Android 12+ does,
  on the CPU (vImage and Core Graphics, 8 bits a channel, sRGB), with the same fallbacks (a pattern's tile, a region
  over 4096 px a side: the plain drop shadows). A region over 4M px is filtered at a lower resolution.
  `ZN_SVG_FILTER_TIMING=1` prints draw times.
- Masks and blends use a layer (`saveLayer`) for the group only. A pattern's tile is drawn once into a bitmap at the
  screen's resolution and used as a shader; it is made again only when the scale changes a lot.
- **Blur in lists** (Pavan: "sure"): the lab's 60-row list has a coin with a drop shadow in every row.

### More motion

In the importer ([svg-anim.ts](../compiler/src/svg-anim.ts:1)):
- **`<animateMotion>`** ([motionTrack](../compiler/src/svg-anim.ts:984)): `path`, `<mpath>`, `values`, `from` / `to` /
  `by`, `keyPoints`, every `calcMode`, `rotate` (a number, `auto`, `auto-reverse`). The path goes to the part's
  `motionPath` ("ox oy angle mode;MCZ;numbers", in viewBox units) and the animated value is `motionAt` (0–1 of its
  length). `calcMode="linear"` on a path moves at an even speed, like `paced` (browsers do the same for a path).
  **CSS `offset-path: path(...)`** with `offset-distance` keyframes and `offset-rotate` maps the same way
  ([cssMotion](../compiler/src/svg-anim.ts:1606)). A turning motion inside a stretched or skewed group fails with a hint.
- **`<set>`**: a step to its value that holds (for `dur` or for ever).
- **CSS `steps(n)`** with every jump term, and `step-start` / `step-end` ([expandSteps](../compiler/src/svg-anim.ts:210)).
- **Skews**: `skewX` / `skewY` in SMIL and CSS transform lists; the part gets `skewX` / `skewY` (after rotate, before
  scale, around the pivot). CSS matrices are split into move, turn, skew and scale.
- **A rotated, skewed or stretched group** around a moving element: the part gets a `frame` (the group's matrix) and
  draws its motion inside it, so the motion stays in the element's own units.
- **Animated gradient stops** (`stop-color`, `stop-opacity`): each stop becomes a part with a fill ("SL" token). On the
  phone the gradient's brush is made again only on a frame where a stop changed
  ([updateStops](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:1145)).
- **Polygon and polyline `points`** morph like `d` (§16).
- **CSS extras**: `@media` (`all`, `screen`, `print` is skipped, `prefers-reduced-motion`; others fail), selectors with
  `>` `+` `~` and descendant combinators, attribute selectors (`=` `~=` `^=` `$=` `*=`), `:first-child`,
  `:last-child`, `:nth-child()`, `:nth-last-child()`, `:root`, `:not(simple)`, real specificity order, custom
  properties with `var()` and fallbacks (inherited), and static `d: path()`.
- **A tap to start** (`begin="click"`, `begin="id.click"`, and chains that start from them; Pavan: "follow the industry
  standard"): the timing gets the `~w` option. On the phone a tap anywhere on the Svg starts it, and each tap plays it
  again from the start ([ZnSvg.kt:2021](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:2021)). The tap
  is counted, not taken, so a Pressable around the Svg still gets it. Before the first tap the part shows its rest
  values. A tap mixed with a time (`begin="click;2s"`) fails with a hint. Other events (`mouseover`, `focusin`) fail.

### Known limits fixed (Pavan: "sure fix it")

1. **Trims on skewed shapes** (§15): a shape whose matrix doesn't keep shapes is measured on its transformed path.
2. **Nested trims** (§15): they combine; a shape shows only what every trim above it shows
   ([znTrimIntersect](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:1758)).
3. **A dash of length 0 with a round cap** (§16): the part's `trimCaps` draws the dot.
4. **Non-scaling stroke under an uneven scale** (§16): when the way from the shape to the screen stretches one axis
   more than the other, the stroke is drawn in screen space at its dp width
   ([screenStroke](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:1699)). Not inside a filter, a
   mask's content or a pattern tile (those keep the average scale).
5. **A group part's `strokeWidth` over a child's own width** (§16): the compiler gives such a child its own
   `strokeWidth` ([pinWidths](../compiler/src/compile.ts:589)).

### Speed (Pavan: "your call")

- Draw data of 8 KB or more is read on a background thread after the first frame
  ([prefetch](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvg.kt:688)), so a big SVG further down the
  screen doesn't cost a main-thread parse when it first shows. An SVG drawn in the first frame still reads on first
  draw (cold start stays the same, §13).
- The part transform uses one shared matrix, and the effects reuse their paints, nodes and tiles.

### Lab

`zn://sample/dev/svg`, our own small files in `examples/sample/src/svg/r13/`, one feature each:
- **Effects**: Shadow (drop shadow and `<text>` with ₹), Pattern (stripes faded by a gradient mask), Route (markers on a
  dashed line), Blend (multiply).
- **More motion** (in the Motion section, under the pause button's control): Along (an arrow that follows a curve and
  turns with it), Clock (`steps(12)` and a `<set>` after 3 s), Flag (skews), Colours (animated stops), Star (points
  morph), Tap me (`begin="click"`), CSS (`var()`, `:nth-child`, `:not`, `@media`).
- **In a list**: every row's icon is the coin with the drop shadow.

### Checked

JS 829 tests (both corpora by name, exact encodings for each new rule, the refusals), both type checks, Kotlin 168
(stop links, nested trims, tap timing, bad motion paths, the big-SVG list), lint (no new warnings), sample debug build.

**On the Lava (Android 14, 90 Hz), 2026-11-03, debug and release:**
- Every new tile draws and moves as in a browser: the shadow under the coin and its ₹, stripes faded by the mask, route
  markers (the arrow follows the line's direction), multiply blend, the arrow along the curve turning with it, the clock in
  12 steps and its `<set>` dot green after 3 s, the flag's skews, the ring's stop colours, the star morph, the CSS bars
  (`:nth-child` delays, `:not` colour). A tap on the heart pops it and spreads the ring; each tap plays it again, and the
  tile's own `onPress` gets the tap too. Pause holds every loop (0 frames in 8 s). With the three animation scales at 0
  every tile shows its still state (0 frames; scales put back to 1.0). Force RTL: the layout flips, the SVGs don't
  (no `autoMirror`); put back.
- **Release:** the template file reads in 65 ms (480 ms in debug). 8 s with every loop on screen: 731 frames, 0 janky,
  99th percentile 16 ms. Fast flings over the 60 shadowed list rows: 818 frames, 0 janky, 99th percentile 15 ms.
- Accessibility tree: tiles read by their labels, the heart by its own. The SVG text became the label as planned, which
  made every list row start with "₹"; the lab now hides that decorative coin (`accessibilityHidden`, guide §42).
- **Found and fixed:** a filter's `RenderNode` lived in the parsed drawing, which every instance shares. A RenderNode is
  drawn by reference, so the list's 32 dp coins showed the disc recorded for the 40 dp coin (wrong size and place). The
  nodes now belong to each Svg node on screen and are freed when it leaves
  ([ZnSvgFilterNodes](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSvgEffects.kt:151)).

**Not checked yet:** TalkBack itself (the tree only), and an older Android (the below-12 fallback).

### Known limits

- A loop with a delay shows its first keyframe during the delay (SMIL shows the base value). Only a single play gets
  the base value first.
- CSS `offset-path` coordinates are read in the parent's space; `offset-anchor` / `offset-position` other than `auto` fail.
- `@media (prefers-reduced-motion: reduce)` rules are never used: "Remove animations" already shows the rest values
  (§15).
- Custom property names are read in lower case (CSS keeps their case).
- A stroked shape whose size moves under a `frame` fails with a hint.
- Text uses the phone's own fonts; a named font family falls back to sans-serif.
