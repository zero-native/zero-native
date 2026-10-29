// The component registry (ARCHITECTURE.md §6.1, §16.2): the numbers templates use for components, props, events
// and enum values. **This file is the single source of truth.** `bun run gen:registry` writes the Kotlin copy
// (android/runtime/src/main/java/dev/zeronative/runtime/Registry.kt); a test fails if the two drift apart.
//
// Rules: never reuse or renumber an id. Adding ids bumps REGISTRY_VERSION; an app only loads templates whose
// registry version it knows (capability manifest, §16.2).

export const REGISTRY_VERSION = 4 // 2: Anchor. 3: transforms, shadow, absolute position, press repeat, text styles.
// 4: per-edge padding can change at runtime (read in the layout phase; for headers padded by insets()).

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
} as const
export type EventName = keyof typeof EventKind

/** Props that may be bound to a slot (change at runtime) in this registry version. Others must be static. */
export const DynamicProps: ReadonlySet<PropName> = new Set<PropName>([
  "text",
  "color",
  "backgroundColor",
  "opacity",
  "src",
  "disabled",
  // Per-edge only: the shorthands (padding, paddingHorizontal, ...) stay build-time.
  "paddingTop",
  "paddingBottom",
  "paddingStart",
  "paddingEnd",
])
