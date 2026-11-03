// The component registry (ARCHITECTURE.md §6.1, §16.2): the numbers templates use for components, props, events
// and enum values. **This file is the single source of truth.** `bun run gen:registry` writes the Kotlin copy
// (android/runtime/src/main/java/dev/zeronative/runtime/Registry.kt); a test fails if the two drift apart.
//
// Rules: never reuse, renumber, retype or remove an id. Adding something raises REGISTRY_VERSION and lists it in
// `Added` (end of this file) with that version; so does a visible change to an existing entry. Templates ask for
// the lowest version that has what they use, so OTA bundles keep running on older apps (docs/ota.md §3.2).
// `bun run gen:registry` checks these rules against registry.lock.json before writing anything. Step by step:
// docs/adding-components.md.

export const REGISTRY_VERSION = 10 // 2: Anchor. 3: transforms, shadow, absolute position, press repeat, text styles.
// 4: per-edge padding can change at runtime (read in the layout phase; for headers padded by insets()).
// 5: feeds (milestone 2 step 2.4): List, onRange, onEndReached (more of 2.4 lands in v5 before it ships).
// 6: Fragment, text spans, TextField (milestone 3 steps 3.2-3.3).
// 7: animation (step 3.6): animate / enter / exit, transforms can change at runtime; Pressable press feedback
//    (ripple by default, pressScale).
// 8: small components & accessibility (milestone 3 steps 3.7–3.8): Switch, Checkbox, Spinner, Progress, Shimmer;
//    accessibilityLabel, accessibilityRole, maxFontScale.
// 9: NativeView, a plugin's Compose view inside a screen (docs/plugins.md §5): viewName, viewProps, onNativeEvent.
// 10: SVG (docs/svg.md): Svg, SvgPart, svg, part, fill, stroke (fill and stroke can change at runtime), autoMirror.

export const Component = {
  Column: 1,
  Row: 2,
  Stack: 3,
  Box: 4,
  Text: 5,
  Image: 6,
  Pressable: 7,
  Spacer: 8,
  Icon: 9,
  /** Where child instances mount (components, `cond && <X/>`, `list.map(...)`). Draws nothing itself: its children
   *  are laid out as if they were direct children of the Anchor's parent. Created by the compiler. */
  Anchor: 10,
  /** Virtualized list (docs/lists.md): rows are template instances mounted by JS only around the visible range. */
  List: 11,
  /** Scrollable container. horizontal: children drawn lazily (only the visible ones are composed): product rails. */
  Scroll: 12,
  /** Native pager: snap per item, optional auto-advance and dots. Children = its pages (usually a .map). */
  Carousel: 13,
  /** Bottom sheet over the whole screen, controlled by JS (`visible`); drag, detents and dismiss are native. */
  Sheet: 14,
  /** `<>...</>` and the children passed to a user component: no layout of its own; its children are laid out as
   *  direct children of the parent (like Anchor's). Alone (a screen or a list row) it lays out like a Column. */
  Fragment: 15,
  /** A text input. The native field owns the text while the user types; JS hears onChangeText and may set `value`. */
  TextField: 16,
  /** A plugin's Compose view inside a screen, chosen by name. JS sends it JSON props and hears named events. */
  NativeView: 17,
  /** An SVG compiled at build time (docs/svg.md): `svg` holds its draw data. One node, whatever the SVG holds. */
  Svg: 18,
  /** A part of its parent Svg (an element with an id) whose paint or opacity the screen sets. Drawn by the Svg. */
  SvgPart: 19,
  // 18-19: Claude (milestone 3). 20-29: Gemini (milestone 3 brief).
  Switch: 20,
  Checkbox: 21,
  Spinner: 22,
  Progress: 23,
  Shimmer: 24,
} as const
export type ComponentName = keyof typeof Component

/** How a prop value is stored in a template. */
export type PropType = "number" | "size" | "string" | "color" | "enum" | "bool"

/** Props, including style keys (docs/styling-and-layout.md §3). `size` accepts a number (dp) or "N%". */
export const Prop = {
  // Size (fixed order step 2)
  width: { id: 1, type: "size" },
  height: { id: 2, type: "size" },
  minWidth: { id: 3, type: "number" },
  maxWidth: { id: 4, type: "number" },
  minHeight: { id: 5, type: "number" },
  maxHeight: { id: 6, type: "number" },
  flex: { id: 7, type: "number" },
  aspectRatio: { id: 8, type: "number" },
  // Margin (step 1)
  margin: { id: 10, type: "number" },
  marginHorizontal: { id: 11, type: "number" },
  marginVertical: { id: 12, type: "number" },
  marginTop: { id: 13, type: "number" },
  marginBottom: { id: 14, type: "number" },
  marginStart: { id: 15, type: "number" },
  marginEnd: { id: 16, type: "number" },
  // Padding (step 9)
  padding: { id: 20, type: "number" },
  paddingHorizontal: { id: 21, type: "number" },
  paddingVertical: { id: 22, type: "number" },
  paddingTop: { id: 23, type: "number" },
  paddingBottom: { id: 24, type: "number" },
  paddingStart: { id: 25, type: "number" },
  paddingEnd: { id: 26, type: "number" },
  // Layout of children
  gap: { id: 30, type: "number" },
  justifyContent: { id: 31, type: "enum" },
  alignItems: { id: 32, type: "enum" },
  alignSelf: { id: 33, type: "enum" },
  // Drawing (steps 3–7)
  backgroundColor: { id: 40, type: "color" },
  borderRadius: { id: 41, type: "number" },
  borderWidth: { id: 42, type: "number" },
  borderColor: { id: 43, type: "color" },
  opacity: { id: 44, type: "number" },
  overflow: { id: 45, type: "enum" },
  borderTopWidth: { id: 46, type: "number" },
  borderBottomWidth: { id: 47, type: "number" },
  elevation: { id: 48, type: "number" },
  shadowColor: { id: 49, type: "color" },
  // Transform (step 3). In TSX: style={{ transform: [{ scale: 0.98 }, { rotate: "45deg" }] }}
  scale: { id: 90, type: "number" },
  scaleX: { id: 91, type: "number" },
  scaleY: { id: 92, type: "number" },
  translateX: { id: 93, type: "number" },
  translateY: { id: 94, type: "number" },
  rotate: { id: 95, type: "number" }, // degrees
  // Absolute positioning, only for children of Stack
  position: { id: 100, type: "enum" },
  top: { id: 101, type: "number" },
  bottom: { id: 102, type: "number" },
  start: { id: 103, type: "number" },
  end: { id: 104, type: "number" },
  zIndex: { id: 105, type: "number" },
  // Text
  text: { id: 50, type: "string" },
  color: { id: 51, type: "color" },
  fontSize: { id: 52, type: "number" },
  fontWeight: { id: 53, type: "number" },
  textAlign: { id: 54, type: "enum" },
  numberOfLines: { id: 55, type: "number" },
  lineHeight: { id: 56, type: "number" },
  letterSpacing: { id: 57, type: "number" },
  fontStyle: { id: 58, type: "enum" },
  textDecorationLine: { id: 59, type: "enum" },
  // Image / Icon
  src: { id: 60, type: "string" },
  contentScale: { id: 61, type: "enum" },
  icon: { id: 70, type: "string" },
  // Pressable
  disabled: { id: 80, type: "bool" },
  /** Haptic tick on press-in, using the system setting (View.performHapticFeedback). */
  haptic: { id: 81, type: "bool" },
  /** onPressRepeat: first repeat after this many ms while held (default 400). */
  repeatDelay: { id: 82, type: "number" },
  /** onPressRepeat: then every this many ms (default 100). */
  repeatInterval: { id: 83, type: "number" },
  // Scroll
  horizontal: { id: 110, type: "bool" },
  /**
   * CSS linear gradient, as in React Native (`linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 100%)`). Parsed at build
   * time into "angle|argb@position|..." (position 0–1, or -1 when not given); drawn over backgroundColor.
   */
  backgroundImage: { id: 111, type: "string" },
  // Carousel
  /** Move to the next page every this many ms (0 / absent = never). Only while on screen and the app is in front. */
  autoAdvance: { id: 112, type: "number" },
  /** After the user touches the carousel, wait this long before auto-advancing again (default 3000 ms). */
  pauseAfterTouch: { id: 113, type: "number" },
  /** Page indicator dots under the pages. */
  dots: { id: 114, type: "bool" },
  dotColor: { id: 115, type: "color" },
  activeDotColor: { id: 116, type: "color" },
  /** Width of each page in dp (pages after it peek in). Default: the carousel's width minus its padding. */
  itemWidth: { id: 117, type: "number" },
  /** Impressions: native counts this key once it is visible enough on the top screen (useImpressions). */
  impressionKey: { id: 118, type: "string" },
  // Sheet
  /** Whether the sheet is open. Owned by JS: native asks to close it with onDismiss and follows what JS sets. */
  visible: { id: 119, type: "bool" },
  /** Where the sheet can rest, comma-separated, first = where it opens: "content" (its content's height), "half", "full". */
  detents: { id: 120, type: "string" },
  /** false: drag-down, scrim tap and back don't ask to close (default true). */
  dismissible: { id: 121, type: "bool" },
  // Text spans (nested <Text>): the compiler writes the spans' styles here as JSON, one entry per span, and joins
  // the spans' text with U+001F in `text`. Build-time only.
  spans: { id: 122, type: "string" },
  // TextField
  /** The field's text, owned by JS (controlled). Optional: without it the field keeps its own text. */
  value: { id: 123, type: "string" },
  placeholder: { id: 124, type: "string" },
  placeholderColor: { id: 125, type: "color" },
  keyboardType: { id: 126, type: "enum" },
  secureTextEntry: { id: 127, type: "bool" },
  maxLength: { id: 128, type: "number" },
  multiline: { id: 129, type: "bool" },
  autoFocus: { id: 130, type: "bool" },
  returnKeyType: { id: 131, type: "enum" },
  /** false: the field can't be edited (still selectable). Default true. */
  editable: { id: 132, type: "bool" },
  autoCapitalize: { id: 133, type: "enum" },
  autoCorrect: { id: 134, type: "bool" },
  /** Cursor and selection handle colour. */
  selectionColor: { id: 135, type: "color" },
  // Animation (step 3.6, ARCHITECTURE §10). Build-time strings made by the compiler from the TSX values:
  /** `animate`: "<propId|*>=<timing>;..." with timing "t<ms>e<easing>" (tween) or "s<dampingRatio>,<stiffness>". */
  animate: { id: 136, type: "string" },
  /** `enter` / `exit`: "<opacity>,<translateX>,<translateY>,<scale>|<timing>": the state it enters from / exits to. */
  enter: { id: 137, type: "string" },
  exit: { id: 138, type: "string" },
  // Pressable feedback (step 3.6). Default on Android: a ripple from the touch point, clipped to the shape.
  pressFeedback: { id: 139, type: "enum" },
  /** Ripple colour (default: the platform's, dark at low alpha). Use white on dark buttons. */
  rippleColor: { id: 140, type: "color" },
  /** Scale while pressed (e.g. 0.95), springing back on release. Native, draw phase only. */
  pressScale: { id: 141, type: "number" },
  /** Ripple opacity 0–1 (default 0.12; 0.24 when rippleColor is set). */
  rippleOpacity: { id: 142, type: "number" },
  /** Ripple not clipped to the element: a circle around the touch, for icon buttons (RN android_ripple borderless). */
  rippleBorderless: { id: 143, type: "bool" },
  /** Ripple radius in dp (default: reaches the farthest corner, or a circle around an icon button when borderless). */
  rippleRadius: { id: 144, type: "number" },
  /** Opacity while pressed, e.g. 0.6 (the iOS / RN TouchableOpacity feel); animated back on release. */
  pressOpacity: { id: 145, type: "number" },
  /** Overlay colour for pressFeedback "highlight" (RN TouchableHighlight underlayColor). Default black at 10 %. */
  highlightColor: { id: 146, type: "color" },
  /** <NativeView name="...">: which view; fixed at build time so the build can check its plugin. */
  viewName: { id: 147, type: "string" },
  /** <NativeView props={...}>: the props as JSON text. */
  viewProps: { id: 148, type: "string" },
  // SVG (docs/svg.md). Ids from the top of Claude's range, so a parallel branch taking the next free ids doesn't clash.
  /** <Svg>: the draw data the compiler made from the SVG (format: compiler/src/svg-data.ts). */
  svg: { id: 180, type: "string" },
  /** <SvgPart>: which element of the parent Svg's draw list (its index among the draw data's shapes and groups). */
  part: { id: 181, type: "number" },
  /** <SvgPart>: replaces the fill of every shape in the part that has one. */
  fill: { id: 182, type: "color" },
  /** <SvgPart>: replaces the stroke of every shape in the part that has one. */
  stroke: { id: 183, type: "color" },
  /** <Svg>: flipped left to right when the layout is right to left (back arrows, chevrons). */
  autoMirror: { id: 187, type: "bool" },
  // 136-199: Claude (milestone 3). 200-249: Gemini (milestone 3 brief).
  trackColor: { id: 200, type: "color" },
  activeTrackColor: { id: 201, type: "color" },
  thumbColor: { id: 202, type: "color" },
  activeColor: { id: 203, type: "color" },
  size: { id: 204, type: "number" },
  fallbackSrc: { id: 205, type: "string" },
  loading: { id: 206, type: "enum" },
  baseColor: { id: 207, type: "color" },
  period: { id: 208, type: "number" },
  accessibilityLabel: { id: 209, type: "string" },
  accessibilityHint: { id: 210, type: "string" },
  accessibilityRole: { id: 211, type: "enum" },
  accessibilityHidden: { id: 212, type: "bool" },
  maxFontScale: { id: 213, type: "number" },
} as const satisfies Record<string, { id: number; type: PropType }>
export type PropName = keyof typeof Prop

/** Enum values, per enum prop. */
export const Enum = {
  justifyContent: {
    "flex-start": 0,
    center: 1,
    "flex-end": 2,
    "space-between": 3,
    "space-around": 4,
    "space-evenly": 5,
  },
  alignItems: { "flex-start": 0, center: 1, "flex-end": 2, stretch: 3 },
  alignSelf: { "flex-start": 0, center: 1, "flex-end": 2, stretch: 3 },
  overflow: { visible: 0, hidden: 1 },
  textAlign: { start: 0, center: 1, end: 2 },
  contentScale: { cover: 0, contain: 1, fill: 2 },
  position: { relative: 0, absolute: 1 },
  fontStyle: { normal: 0, italic: 1 },
  textDecorationLine: { none: 0, underline: 1, "line-through": 2 },
  keyboardType: { default: 0, "number-pad": 1, "decimal-pad": 2, "phone-pad": 3, "email-address": 4, url: 5 },
  returnKeyType: { done: 0, go: 1, next: 2, search: 3, send: 4 },
  autoCapitalize: { none: 0, sentences: 1, words: 2, characters: 3 },
  pressFeedback: { ripple: 0, highlight: 1, none: 2 },
  loading: { none: 0, shimmer: 1 },
  accessibilityRole: {
    button: 0,
    header: 1,
    image: 2,
    link: 3,
    text: 4,
    switch: 5,
    checkbox: 6,
    none: 7,
  },
} as const satisfies Partial<Record<PropName, Record<string, number>>>

/**
 * Native → JS events a node can have (ARCHITECTURE §5.3). Press lifecycle: onPressIn, then exactly one onPressOut
 * (payload: true if the press was cancelled), then onPress only for a completed tap that didn't long-press or repeat.
 */
export const EventKind = {
  onPress: 1,
  onPressIn: 2,
  onPressOut: 3,
  onLongPress: 4,
  /** Fired by native while the finger stays down (after repeatDelay, then every repeatInterval). */
  onPressRepeat: 5,
  /** <List>: the visible row range changed. Payload "first,last". Bound by the compiler, not by authors. */
  onRange: 6,
  /** <List>: the end is near (once per row count). */
  onEndReached: 7,
  /** <Carousel>: the page settled on a new index (payload: the index). Sent only if bound. */
  onPageChange: 8,
  /** <Sheet>: the user asked to close it (drag down, fling, scrim tap, back). JS decides: set visible to false. */
  onDismiss: 9,
  /** <Sheet>: it settled on another detent (payload: "content" | "half" | "full"). */
  onDetentChange: 10,
  /** <TextField>: the text changed (payload: the new text). */
  onChangeText: 11,
  /** <TextField>: the keyboard's action key (done / go / next / search / send) was pressed. */
  onSubmitEditing: 12,
  onFocus: 13,
  onBlur: 14,
  /** <NativeView>: payload is JSON text, { name, data }; the compiler adds the parse. */
  onNativeEvent: 15,
  /**
   * <TextField ref={r}>: not a handler. Its id names the field for focus() / blur() / clear() (ZnKeyboard), and native
   * sends true / false on it when focus comes or goes. Bound by the compiler (core text-field.ts fieldRef).
   */
  ref: 16,
  // 16-29: Claude (milestone 3). 30-39: Gemini (milestone 3 brief).
  onValueChange: 30,
} as const
export type EventName = keyof typeof EventKind

/** Props that may be bound to a slot (change at runtime) in this registry version. Others must be static. */
export const DynamicProps: ReadonlySet<PropName> = new Set<PropName>([
  "text",
  "color",
  "backgroundColor",
  "opacity",
  // Transforms (step 3.6): read in the draw phase, so changing them never recomposes or re-lays out.
  "scale",
  "scaleX",
  "scaleY",
  "translateX",
  "translateY",
  "rotate",
  "src",
  "disabled",
  // Per-edge only: the shorthands (padding, paddingHorizontal, ...) stay build-time.
  "paddingTop",
  "paddingBottom",
  "paddingStart",
  "paddingEnd",
  "impressionKey",
  "visible",
  "value",
  "placeholder",
  "editable",
  "accessibilityLabel",
  "viewProps",
  "fill",
  "stroke",
])

// ---- Which registry version each thing needs (OTA capability check, docs/ota.md §3.2) -------------------------------

/** The registry version every released app has at least. Everything not listed in [Added] exists since it. */
export const BASE_VERSION = 8

/**
 * What was added after [BASE_VERSION], or changed in a way the screen shows, with the registry version it came in.
 * A bundle asks for the highest version among the things it really uses (writer.ts), so a bundle that doesn't use
 * a new component still runs on older apps. The registry test compares with `registry.lock.json`: anything new that
 * is missing here fails it, and `bun run gen:registry` refuses to write.
 * - New component / prop / event / enum value: add it here with the new REGISTRY_VERSION.
 * - A prop that becomes dynamic (can change at runtime): `dynamic`.
 * - A visible change in how an existing entry draws or behaves: set it to the new REGISTRY_VERSION. Bundles that use
 *   it then need the new app; older apps keep the bundle they have, which matches how they draw it.
 */
export const Added: {
  component: Partial<Record<ComponentName, number>>
  prop: Partial<Record<PropName, number>>
  dynamic: Partial<Record<PropName, number>>
  /** Key: "<prop>.<value>", e.g. "pressFeedback.highlight". */
  enumValue: Record<string, number>
  event: Partial<Record<EventName, number>>
} = {
  component: { NativeView: 9, Svg: 10, SvgPart: 10 },
  prop: { viewName: 9, viewProps: 9, svg: 10, part: 10, fill: 10, stroke: 10, autoMirror: 10 },
  dynamic: { viewProps: 9, fill: 10, stroke: 10 },
  enumValue: {},
  event: { onNativeEvent: 9, ref: 10 },
}

/** The registry version that [kind] [name] needs ([BASE_VERSION] unless listed in [Added]). */
export function since(kind: keyof typeof Added, name: string): number {
  return (Added[kind] as Record<string, number | undefined>)[name] ?? BASE_VERSION
}
