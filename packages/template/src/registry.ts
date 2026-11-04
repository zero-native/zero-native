// The component registry (ARCHITECTURE.md §6.1, §16.2): the numbers templates use for components, props, events
// and enum values. **This file is the single source of truth.** `bun run gen:registry` writes the Kotlin copy
// (android/runtime/src/main/java/dev/zeronative/runtime/Registry.kt); a test fails if the two drift apart.
//
// Rules: never reuse, renumber, retype or remove an id. Adding something raises REGISTRY_VERSION and lists it in
// `Added` (end of this file) with that version; so does a visible change to an existing entry. Templates ask for
// the lowest version that has what they use, so OTA bundles keep running on older apps (docs/ota.md §3.2).
// `bun run gen:registry` checks these rules against registry.lock.json before writing anything. Step by step:
// docs/adding-components.md.

export const REGISTRY_VERSION = 15 // 2: Anchor. 3: transforms, shadow, absolute position, press repeat, text styles.
// 4: per-edge padding can change at runtime (read in the layout phase; for headers padded by insets()).
// 5: feeds (milestone 2 step 2.4): List, onRange, onEndReached (more of 2.4 lands in v5 before it ships).
// 6: Fragment, text spans, TextField (milestone 3 steps 3.2-3.3).
// 7: animation (step 3.6): animate / enter / exit, transforms can change at runtime; Pressable press feedback
//    (ripple by default, pressScale).
// 8: small components & accessibility (milestone 3 steps 3.7–3.8): Switch, Checkbox, Spinner, Progress, Shimmer;
//    accessibilityLabel, accessibilityRole, maxFontScale.
// 9: NativeView, a plugin's Compose view inside a screen (docs/plugins.md §5): viewName, viewProps, onNativeEvent.
// 10: TextField `ref` (RN basics pack): focus(), blur(), clear() from JS; focus changes come back on its event id.
// 11: Tabs, a container that draws only its selected child (docs/guide-notes.md §40): selected.
// 12: pull to refresh on a vertical Scroll and on List (docs/guide-notes.md §41): refreshing, refreshColor,
//     refreshBackground, onRefresh.
// 13: SVG (docs/svg.md; phases 1-4 built as 11-13 on their branch, moved to one number before any shipped):
//     Svg, SvgPart, svg, part, fill, stroke (fill and stroke can change at runtime), autoMirror; trimStart / trimEnd /
//     trimOffset, pivotX / pivotY. Timing options for every animation (format "timing.motion": delay, repeat,
//     reverse, keyframes, cubic-bezier easing) and the element props paused / replay. SvgPart strokeWidth /
//     dashOffset (can change at runtime), scaleOutline, morph / morphAt (§16). Draw data with masks, patterns,
//     filters, text, focal gradients, paint-order and blend modes (format "svg.effects"); non-scaling strokes
//     (format "svg.nonScaling"); SvgPart motionPath / motionAt (animateMotion), skewX / skewY, frame, trimCaps;
//     animations that start on a tap (format "timing.tap") (§17).
// 14: Pressable long press as in React Native: an onLongPress that holds no handler at that moment doesn't stop the
//     tap (hasLongPress, set by the compiler).
// 15: RN props pack 2 (docs/guide-notes.md §43): textTransform, testID; a Stack child with both start and end (or top
//     and bottom) stretches between them, as RN's absoluteFill; per-corner radius; borderColor and borderWidth can
//     change at runtime; pointerEvents (can change at runtime), Pressable hitSlop; Image tintColor, onLoad, onError,
//     onLoadEnd; onLayout; Modal (transparent, animationType, statusBarTranslucent, navigationBarTranslucent,
//     onRequestClose, onShow); StatusBar and NavigationBar (barStyle, hidden, backgroundColor; can change at runtime); List stickyHeaderIndices.

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
  // 30-39: Claude (18-19 went to the SVG work).
  /**
   * Tabs (useTabs): draws only its child at `selected` (its children are the tab panels, in order). The others leave
   * the screen but keep their instances, and their scroll positions (Compose saved state).
   */
  Tabs: 30,
  /**
   * React Native's Modal (registry 15): a full-screen window over the app; its children are what the app draws in it
   * (laid out like a Column that fills the window). Shown while `visible`; back sends onRequestClose.
   */
  Modal: 31,
  /**
   * React Native's StatusBar (registry 15): draws nothing in the layout. While its screen is on top, its barStyle and
   * hidden set the status bar, and its backgroundColor is drawn behind the bar (Android 15+ has no bar colour).
   * Several on a screen merge, the newest winning, as in RN.
   */
  StatusBar: 32,
  /** The same for the navigation bar (zn's own; RN has none): barStyle, backgroundColor. */
  NavigationBar: 33,
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
  /** <Tabs>: the position of the child to draw (default 0). */
  selected: { id: 149, type: "number" },
  // Pull to refresh (vertical Scroll, List). Ids from the middle of Claude's range, so a branch taking the next free id
  // (150) doesn't clash.
  /** Whether the list is refreshing (the spinner shows). Owned by JS: a pull sends onRefresh, JS sets this. */
  refreshing: { id: 170, type: "bool" },
  /** The spinner's arc (RN RefreshControl `colors[0]` / `tintColor`). Default: dark grey. */
  refreshColor: { id: 171, type: "color" },
  /** The round disc behind the arc (RN `progressBackgroundColor`). Default: white. */
  refreshBackground: { id: 172, type: "color" },
  // SVG (docs/svg.md). Ids from the top of Claude's range, so a parallel branch taking the next free ids doesn't clash.
  /** <Svg>: the draw data the compiler made from the SVG (format: compiler/src/svg-data.ts). */
  svg: { id: 180, type: "string" },
  /** <SvgPart>: which element of the parent Svg's draw list (its index among the draw data's shapes and groups). */
  part: { id: 181, type: "number" },
  /** <SvgPart>: replaces the fill of every shape in the part that has one. */
  fill: { id: 182, type: "color" },
  /** <SvgPart>: replaces the stroke of every shape in the part that has one. */
  stroke: { id: 183, type: "color" },
  /** <SvgPart>: "draw the line": the visible piece of the part's paths, as fractions 0–1 of their whole length. */
  trimStart: { id: 184, type: "number" },
  trimEnd: { id: 185, type: "number" },
  /** <SvgPart>: moves the visible piece along the line (0–1; it wraps round). */
  trimOffset: { id: 186, type: "number" },
  /** <Svg>: flipped left to right when the layout is right to left (back arrows, chevrons). */
  autoMirror: { id: 187, type: "bool" },
  /** <SvgPart>: the point it turns and scales around, in viewBox units (the compiler writes the part's centre). */
  pivotX: { id: 188, type: "number" },
  pivotY: { id: 189, type: "number" },
  /** Stops this element's own animations (loops, keyframes) where they are; false plays on (CSS play-state). */
  paused: { id: 190, type: "bool" },
  /** Each new value plays this element's own animations (loops, keyframes) again from the start. */
  replay: { id: 191, type: "number" },
  /** <SvgPart>: the stroke width of every shape in the part that has a stroke (viewBox units). */
  strokeWidth: { id: 192, type: "number" },
  /** <SvgPart>: moves the dash pattern of every dashed stroke in the part along its line (viewBox units). */
  dashOffset: { id: 193, type: "number" },
  /** <SvgPart> of one shape (set by the compiler): its scale changes the outline, and the stroke keeps its width. */
  scaleOutline: { id: 194, type: "bool" },
  /** <SvgPart> of one shape (set by the compiler): the keyframe paths it morphs through (docs/svg.md §15). */
  morph: { id: 195, type: "string" },
  /** <SvgPart>: where in [morph] it is (0 = the first path, 1.5 = half way from the second to the third); -1 = its own. */
  morphAt: { id: 196, type: "number" },
  /**
   * <SvgPart> (registry 13, set by the compiler): a path to move along (animateMotion), with how the part turns on it:
   * "ox oy angle mode;path" (svg-anim.ts). The part's origin (ox, oy) rides on the path.
   */
  motionPath: { id: 197, type: "string" },
  /** <SvgPart>: where on [motionPath] it is, 0–1 of its length. */
  motionAt: { id: 198, type: "number" },
  /** <SvgPart>: skews around the pivot, in degrees (after rotate, before scale). */
  skewX: { id: 199, type: "number" },
  // 136-199: Claude (milestone 3). 200-249: Gemini (milestone 3 brief). 250-299: Claude (SVG phase 4 on).
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
  /** <SvgPart>: skews around the pivot, in degrees (after skewX). */
  skewY: { id: 250, type: "number" },
  /**
   * <SvgPart> (set by the compiler): "a b c d e f", the space the part's own transforms happen in (its parent's, when
   * that space is stretched): the part draws through frame · its transform · frame⁻¹.
   */
  frame: { id: 251, type: "string" },
  /** <SvgPart> (set by the compiler): a trimmed piece of length 0 still draws its caps (an SVG dash of length 0). */
  trimCaps: { id: 252, type: "bool" },
  // RN props pack 2 (registry 14-15). Ids from 260, so a parallel branch taking the next free ids doesn't clash.
  /**
   * <Pressable> (set by the compiler, registry 14): whether `onLongPress` holds a handler right now, when it isn't a
   * function written in place (`onLongPress={props.onLongPress}`). Without one, a long hold still gives onPress.
   */
  hasLongPress: { id: 260, type: "bool" },
  /** <Text> (registry 15): RN's textTransform, also on text that changes at runtime. */
  textTransform: { id: 261, type: "enum" },
  /** RN's testID (registry 15): a Compose test tag, shown to UI tests (uiautomator) as the resource id. */
  testID: { id: 262, type: "string" },
  // Per-corner radius (registry 15), as in RN: a corner's own value beats borderRadius; Start / End beat Left / Right.
  // Left / Right are drawn as Start / End (the same in a left-to-right layout; zn flips them for right-to-left).
  borderTopLeftRadius: { id: 263, type: "number" },
  borderTopRightRadius: { id: 264, type: "number" },
  borderBottomLeftRadius: { id: 265, type: "number" },
  borderBottomRightRadius: { id: 266, type: "number" },
  borderTopStartRadius: { id: 267, type: "number" },
  borderTopEndRadius: { id: 268, type: "number" },
  borderBottomStartRadius: { id: 269, type: "number" },
  borderBottomEndRadius: { id: 270, type: "number" },
  /**
   * RN pointerEvents (registry 15; can change at runtime): "none" = this element and its children take no touches
   * (they go to what is under it), "box-none" = only its children do, "box-only" = only it does. Written "auto" or
   * "box-only", the element also stops touches from reaching what is under it, as a React Native view does.
   */
  pointerEvents: { id: 271, type: "enum" },
  /** <Pressable> RN hitSlop (registry 15): "start,top,end,bottom" in dp, made by the compiler from a number or object. */
  hitSlop: { id: 272, type: "string" },
  /** <Image> RN tintColor (registry 15; can change at runtime): every non-clear pixel drawn in this colour. */
  tintColor: { id: 273, type: "color" },
  // <Modal> (registry 15), as in React Native on Android.
  /** No window background: the screen shows through where the content draws nothing. Default false (white). */
  transparent: { id: 274, type: "bool" },
  /** How it comes and goes: "none" (default), "fade", "slide" (up from the bottom). */
  animationType: { id: 275, type: "enum" },
  /** The content may draw under the status bar (else it starts below it). */
  statusBarTranslucent: { id: 276, type: "bool" },
  /** The content may draw under the navigation bar (else it ends above it). */
  navigationBarTranslucent: { id: 277, type: "bool" },
  /** <StatusBar> / <NavigationBar> (registry 15): "dark-content" (dark icons), "light-content", or "default". */
  barStyle: { id: 278, type: "enum" },
  /** <StatusBar> (registry 15): hides the status bar while its screen is on top. */
  hidden: { id: 279, type: "bool" },
  /**
   * <List> RN stickyHeaderIndices (registry 15; can change at runtime): "1,30", the rows (by data index) that stay
   * pinned at the top while their part of the list scrolls; the next one pushes it up.
   */
  stickyHeaderIndices: { id: 280, type: "string" },
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
  textTransform: { none: 0, uppercase: 1, lowercase: 2, capitalize: 3 },
  pointerEvents: { auto: 0, none: 1, "box-none": 2, "box-only": 3 },
  animationType: { none: 0, slide: 1, fade: 2 },
  barStyle: { default: 0, "light-content": 1, "dark-content": 2 },
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
  /**
   * <Scroll> / <List>: the user pulled down past the line and let go (pull to refresh). Set refreshing to true while
   * you load. Id from the middle of Claude's range (see refreshing).
   */
  onRefresh: 25,
  // RN props pack 2 (registry 15). Native sends JSON; the compiler hands it to the handler as RN's `{ nativeEvent }`.
  /** <Image>: its src loaded. nativeEvent: { source: { width, height, uri } } (the picture's size in pixels). */
  onLoad: 17,
  /** <Image>: its src failed (a fallbackSrc may still show). nativeEvent: { error }. */
  onError: 18,
  /** <Image>: its src loaded or failed. No payload. */
  onLoadEnd: 19,
  /** Any element: its size or place in its parent changed. nativeEvent: { layout: { x, y, width, height } } in dp. */
  onLayout: 20,
  /** <Modal>: back was pressed. JS decides: set visible to false to close it. */
  onRequestClose: 21,
  /** <Modal>: it is on screen (after its animation). */
  onShow: 22,
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
  "selected",
  "refreshing",
  "fill",
  "stroke",
  "trimStart",
  "trimEnd",
  "trimOffset",
  "paused",
  "replay",
  "strokeWidth",
  "dashOffset",
  "hasLongPress",
  // Registry 15: the colour is read in the draw phase, the width in the layout phase (borders take space).
  "borderColor",
  "borderWidth",
  "pointerEvents",
  "tintColor",
  "barStyle",
  "hidden",
  "stickyHeaderIndices",
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
  /** A newer form of a string prop's value (key: a name in [Formats]). */
  format: Partial<Record<FormatName, number>>
} = {
  component: { NativeView: 9, Tabs: 11, Svg: 13, SvgPart: 13, Modal: 15, StatusBar: 15, NavigationBar: 15 },
  prop: {
    viewName: 9, viewProps: 9, selected: 11, refreshing: 12, refreshColor: 12, refreshBackground: 12,
    // SVG phases 1-4 (built as 11-13 on their branch; one number, as none shipped).
    svg: 13, part: 13, fill: 13, stroke: 13, autoMirror: 13, trimStart: 13, trimEnd: 13, trimOffset: 13, pivotX: 13,
    pivotY: 13, paused: 13, replay: 13, strokeWidth: 13, dashOffset: 13, scaleOutline: 13, morph: 13, morphAt: 13,
    motionPath: 13, motionAt: 13, skewX: 13, skewY: 13, frame: 13, trimCaps: 13,
    hasLongPress: 14,
    textTransform: 15, testID: 15, borderTopLeftRadius: 15, borderTopRightRadius: 15, borderBottomLeftRadius: 15,
    borderBottomRightRadius: 15, borderTopStartRadius: 15, borderTopEndRadius: 15, borderBottomStartRadius: 15,
    borderBottomEndRadius: 15, pointerEvents: 15, hitSlop: 15, tintColor: 15,
    transparent: 15, animationType: 15, statusBarTranslucent: 15, navigationBarTranslucent: 15, barStyle: 15, hidden: 15,
    stickyHeaderIndices: 15,
  },
  dynamic: {
    viewProps: 9, selected: 11, refreshing: 12, fill: 13, stroke: 13, trimStart: 13, trimEnd: 13, trimOffset: 13,
    paused: 13, replay: 13, strokeWidth: 13, dashOffset: 13, hasLongPress: 14, borderColor: 15, borderWidth: 15,
    pointerEvents: 15, tintColor: 15, barStyle: 15, hidden: 15, stickyHeaderIndices: 15,
  },
  enumValue: {
    "textTransform.none": 15, "textTransform.uppercase": 15, "textTransform.lowercase": 15, "textTransform.capitalize": 15,
    "pointerEvents.auto": 15, "pointerEvents.none": 15, "pointerEvents.box-none": 15, "pointerEvents.box-only": 15,
    "animationType.none": 15, "animationType.slide": 15, "animationType.fade": 15,
    "barStyle.default": 15, "barStyle.light-content": 15, "barStyle.dark-content": 15,
  },
  event: { onNativeEvent: 9, ref: 10, onRefresh: 12, onLoad: 15, onError: 15, onLoadEnd: 15, onLayout: 15,
    onRequestClose: 15, onShow: 15 },
  format: { "timing.motion": 13, "svg.nonScaling": 13, "svg.effects": 13, "timing.tap": 13 },
}

/**
 * A `position: "absolute"` node with both start and end (or both top and bottom) stretches between them, as React
 * Native's absoluteFill does, since this registry version. Older apps place it at one side only (writer.ts).
 */
export const ABSOLUTE_STRETCH_SINCE = 15

/**
 * Newer forms of a string prop's value that older apps can't read (an older app would show the old behaviour, so a
 * bundle that uses one must ask for the version that brought it). [uses]: does this value use the form?
 */
export const Formats = {
  /** Timings with "~" options: delay, repeat, reverse, from, keyframes, times, cubic-bezier (see compiler timing()). */
  "timing.motion": { props: ["animate", "enter", "exit"] as PropName[], uses: (raw: string) => raw.includes("~") },
  /**
   * SVG draw data with a non-scaling stroke (docs/svg.md §16): a shape whose stroke width is negative. A false match
   * (a path that looks like a shape op) only asks for a newer app than needed.
   */
  "svg.nonScaling": {
    props: ["svg"] as PropName[],
    uses: (raw: string) => /(?:^| )S (?:-|c|#[0-9A-F]{8}|@\d+) \S+ (?:c|#[0-9A-F]{8}|@\d+) \S+ [01] \S+ -\d/.test(raw),
  },
  /**
   * SVG draw data with registry 13's ops (docs/svg.md §17): RF, SL, FL, PT, MK, X or T tokens, a pattern paint, or a
   * shape whose rule says paint-order. A false match only asks for a newer app than needed.
   */
  "svg.effects": {
    props: ["svg"] as PropName[],
    uses: (raw: string) => /(?:^| )(?:RF|SL|FL|PT|MK|X|T) |(?:^| )%\d|(?:^| )S \S+ \S+ \S+ \S+ [23] /.test(raw),
  },
  /** Timings that start on a tap ("~w", SMIL begin="click"; docs/svg.md §17). */
  "timing.tap": { props: ["animate"] as PropName[], uses: (raw: string) => /~w(?:[~;,]|$)/.test(raw) },
} as const
export type FormatName = keyof typeof Formats

/** The registry version that [kind] [name] needs ([BASE_VERSION] unless listed in [Added]). */
export function since(kind: keyof typeof Added, name: string): number {
  return (Added[kind] as Record<string, number | undefined>)[name] ?? BASE_VERSION
}
