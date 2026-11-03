/// <reference path="./svg-modules.d.ts" />
// Types for the intrinsic components, for editors and type checking only. The compiler removes imports of this module
// and turns these elements into templates (compiler/src/compile.ts); none of this runs.
type Color = string
type Size = number | `${number}%`
/** The same shape as core's TextFieldHandle (packages/core/src/text-field.ts). */
interface TextFieldHandle {
  focus(): void
  blur(): void
  clear(): void
  isFocused(): boolean
}

declare const znElement: unique symbol
/** What JSX makes (a template instance to show). Opaque: return it from a component or pass it on. */
export type ZnElement = { readonly [znElement]: true }
/**
 * JSX passed to a component: its children (`<Card>...</Card>`) or a JSX prop (`header={<Title/>}`). Show it with
 * `{props.children}` / `{props.header}`; anything else (reading, mapping, counting) isn't supported.
 */
export type Children = ZnElement | readonly Children[] | null | undefined | false

declare global {
  // The JSX types for editors and `tsc` (tsconfig: "jsx": "preserve"). The compiler does the real work.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    type Element = ZnElement
    interface ElementChildrenAttribute {
      children: {}
    }
    interface IntrinsicAttributes {
      // `any`: <List key={(item) => ...}> reuses the name for its key function (see List below).
      key?: any
    }
    interface IntrinsicElements {}
  }
}

export interface StyleProps {
  width?: Size
  height?: Size
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  flex?: number
  aspectRatio?: number
  margin?: number
  marginHorizontal?: number
  marginVertical?: number
  marginTop?: number
  marginBottom?: number
  marginStart?: number
  marginEnd?: number
  padding?: number
  paddingHorizontal?: number
  paddingVertical?: number
  paddingTop?: number
  paddingBottom?: number
  paddingStart?: number
  paddingEnd?: number
  gap?: number
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly"
  alignItems?: "flex-start" | "center" | "flex-end" | "stretch"
  alignSelf?: "flex-start" | "center" | "flex-end" | "stretch"
  backgroundColor?: Color
  /** React Native's CSS gradient: `"linear-gradient(180deg, rgba(0,0,0,0) 0%, #000 100%)"` (build-time only). */
  backgroundImage?: string
  borderRadius?: number
  borderWidth?: number
  borderColor?: Color
  borderTopWidth?: number
  borderBottomWidth?: number
  elevation?: number
  shadowColor?: Color
  opacity?: number
  overflow?: "visible" | "hidden"
  position?: "relative" | "absolute"
  top?: number
  bottom?: number
  start?: number
  end?: number
  zIndex?: number
  transform?: Array<{
    scale?: number
    scaleX?: number
    scaleY?: number
    translateX?: number
    translateY?: number
    rotate?: string | number
  }>
}

export interface TextStyleProps {
  color?: Color
  fontSize?: number
  fontWeight?: number | "normal" | "bold"
  textAlign?: "start" | "center" | "end"
  numberOfLines?: number
  lineHeight?: number
  letterSpacing?: number
  fontStyle?: "normal" | "italic"
  textDecorationLine?: "none" | "underline" | "line-through"
  /** Cap the font scale factor (size * min(fontScale, maxFontScale)) for this text node. */
  maxFontScale?: number
}

type Style = StyleProps & TextStyleProps
type StyleInput = Style | false | null | undefined | StyleInput[]

/** A named curve, or a CSS cubic-bezier as [x1, y1, x2, y2] (x1 and x2 within 0–1). */
export type Easing = "standard" | "ease-out" | "ease-in" | "linear" | readonly [number, number, number, number]

/**
 * Options every timing can have (registry 11). With `from` or `keyframes` the animation plays by itself when the
 * element appears (and again on `replay`); without them it plays when the value changes, as before.
 */
export interface Motion {
  /** Wait this many ms before it starts (each time it starts). */
  delay?: number
  /** How many times it plays in all (CSS iteration-count): 2 = twice. "forever" loops while the element is shown. */
  repeat?: number | "forever"
  /** Every second play runs backwards (CSS alternate): a pulse goes 1 → 1.1 → 1 instead of jumping back. */
  reverse?: boolean
  /** Wait this many ms between plays. */
  repeatDelay?: number
  /** Plays from this value to the style value. A colour for backgroundColor. */
  from?: number | string
  /** Plays through these values; the style value is where it rests when animations are off. */
  keyframes?: readonly (number | string)[]
  /** When each keyframe is reached, 0–1 of the duration (default: evenly spaced). Same length as keyframes. */
  times?: readonly number[]
}

/** 250 (ms, tween) | "spring" | "bouncy" | { duration, easing?, ...Motion } | { spring: { damping?, stiffness? }, ...Motion } */
export type Timing =
  | number
  | "spring"
  | "bouncy"
  | ({ duration: number; easing?: Easing } & Motion)
  | ({ spring: { damping?: number; stiffness?: number } } & Omit<Motion, "keyframes" | "times">)

export type AnimatableProp =
  | "opacity"
  | "backgroundColor"
  | "scale"
  | "scaleX"
  | "scaleY"
  | "translateX"
  | "translateY"
  | "rotate"

/** The state an element enters from (enter) or leaves to (exit). */
export type Transition =
  | "fade"
  | "fade-up"
  | "fade-down"
  | "scale"
  | "pop"
  | {
      opacity?: number
      translateX?: number
      translateY?: number
      scale?: number
      duration?: number
      easing?: Easing
      spring?: { damping?: number; stiffness?: number }
      /** Wait this many ms before it starts: a stagger for list rows (registry 11). */
      delay?: number
    }

interface Base extends StyleProps {
  style?: StyleInput
  /**
   * Animate changes of this element's opacity, background colour and transforms natively (build-time value):
   * `animate={250}` for all of them, or `animate={{ opacity: 200, translateY: "spring" }}`.
   */
  animate?: Timing | Partial<Record<AnimatableProp, Timing>>
  /** Stops this element's own loops and keyframes where they are (CSS play-state). Can change at runtime. */
  paused?: boolean
  /** Each new value plays this element's loops and keyframes again from the start (a shake on a wrong PIN). */
  replay?: number
  /** On the root of `cond && <X/>`, a ternary branch or a `.map` row: how it appears. */
  enter?: Transition
  /** Same, how it leaves: native keeps it on screen until this finishes. */
  exit?: Transition
  key?: string | number
  /** Counted natively when visible enough on a screen that calls useImpressions(...). Usually your item's id. */
  impressionKey?: string
  /** Accessibility label read by TalkBack. Dynamic slot allowed. */
  accessibilityLabel?: string
  /** Additional hint read after the accessibility label. */
  accessibilityHint?: string
  /** The semantic role for TalkBack. */
  accessibilityRole?: "button" | "header" | "image" | "link" | "text" | "switch" | "checkbox" | "none"
  /** Skip this node and its children in accessibility traversal. */
  accessibilityHidden?: boolean
}

interface Container extends Base {
  children?: unknown
}

declare const intrinsic: unique symbol
type Intrinsic<P> = ((props: P) => never) & { [intrinsic]: true }

export declare const Column: Intrinsic<Container>
export declare const Row: Intrinsic<Container>
export declare const Stack: Intrinsic<Container>
export declare const Box: Intrinsic<Container>
export declare const Text: Intrinsic<Base & TextStyleProps & { text?: string; children?: unknown }>
/** `src`: an https URL or "asset:path". null / undefined shows nothing (the box keeps its size). */
export declare const Image: Intrinsic<
  Base & {
    src?: string | null
    fallbackSrc?: string | null
    loading?: "none" | "shimmer"
    contentScale?: "cover" | "contain" | "fill"
  }
>
export declare const Icon: Intrinsic<Base & { icon?: string; color?: Color }>
export declare const Spacer: Intrinsic<Base>
/**
 * A controlled native switch toggle.
 */
export declare const Switch: Intrinsic<
  Base & {
    value: boolean
    onValueChange?: (value: boolean) => void
    disabled?: boolean
    trackColor?: Color
    activeTrackColor?: Color
    thumbColor?: Color
  }
>
/**
 * A controlled native checkbox toggle.
 */
export declare const Checkbox: Intrinsic<
  Base & {
    value: boolean
    onValueChange?: (value: boolean) => void
    disabled?: boolean
    color?: Color
    activeColor?: Color
  }
>
/**
 * A plugin's Compose view inside a screen (docs/plugins.md §4). `name` must be a string literal; the build fails if the
 * app doesn't use that plugin. Give it a size in `style`. Takes no children.
 */
export declare const NativeView: Intrinsic<
  Base & {
    name: string
    props?: Record<string, unknown>
    onEvent?: (e: { name: string; data: any }) => void
  }
>
// ---- SVG (docs/svg.md) -------------------------------------------------------------------------------------------

/** What a part can animate (docs/svg.md §9). */
export type SvgPartAnimatable =
  | "opacity" | "fill" | "stroke" | "rotate" | "scale" | "scaleX" | "scaleY" | "translateX" | "translateY"
  | "trimStart" | "trimEnd" | "trimOffset"

/**
 * How a part moves (registry 11): transforms in viewBox units and degrees, around the part's own centre; trims
 * "draw the line" (0–1 of its length; a group's pieces count as one line). All can change at runtime, except animate.
 */
export interface SvgPartMotion {
  rotate?: number
  scale?: number
  scaleX?: number
  scaleY?: number
  translateX?: number
  translateY?: number
  /** Where the visible piece of the line starts, 0–1 (default 0). It cuts the fill too. */
  trimStart?: number
  /** Where it ends, 0–1 (default 1). trimEnd from 0 to 1 draws the line. */
  trimEnd?: number
  /** Moves the piece round the line (wraps past the end). */
  trimOffset?: number
  /** Animate this part, like `animate` on any element (build time). */
  animate?: Timing | Partial<Record<SvgPartAnimatable, Timing>>
  /** Stops this part's loops and keyframes where they are. */
  paused?: boolean
  /** Each new value plays this part's loops and keyframes again. */
  replay?: number
}

/** What a part of an SVG can change: the paint of every shape inside it, its opacity as a whole, and how it moves. */
export interface SvgPartProps extends SvgPartMotion {
  fill?: Color
  stroke?: Color
  opacity?: number
}

/** Props of an Svg node: the whole SVG as one element. */
interface SvgNodeProps extends Base {
  /** Width and height in dp (build time). Without any size, the SVG's own width / height (or viewBox) is used. */
  size?: number
  /** The value of currentColor inside the SVG (may change at runtime). The build fails if the SVG has none. */
  color?: Color
  /** Flip left to right when the screen is right to left (back arrows, chevrons). */
  autoMirror?: boolean
}

/**
 * An .svg file imported as a component: `import Logo from "./logo.svg"`, then `<Logo size={24} color={c.ink} />`.
 * Compiled at build time, so it is only valid as JSX (`icon={<Logo />}`), never as a value.
 */
export type SvgFile = Intrinsic<
  SvgNodeProps & {
    /** Change elements by their id: `parts={{ ring: { fill: brand() } }}`. Unknown ids fail the build. */
    parts?: Record<string, SvgPartProps>
  }
>

type SvgNumber = number | string
/** SVG presentation attributes, as react-native-svg names them, plus zn's part motion (it makes the element a part). */
interface SvgPaintProps extends SvgPartMotion {
  id?: string
  fill?: Color
  fillOpacity?: SvgNumber
  fillRule?: "nonzero" | "evenodd"
  stroke?: Color
  strokeWidth?: SvgNumber
  strokeOpacity?: SvgNumber
  strokeLinecap?: "butt" | "round" | "square"
  strokeLinejoin?: "miter" | "round" | "bevel"
  strokeMiterlimit?: SvgNumber
  strokeDasharray?: string | readonly number[]
  strokeDashoffset?: SvgNumber
  opacity?: SvgNumber
  clipPath?: string
  clipRule?: "nonzero" | "evenodd"
  mask?: string
  transform?: string
  color?: Color
  display?: "none" | "inline"
  visibility?: "visible" | "hidden"
  key?: string | number
  children?: unknown
}

/** Inline SVG (react-native-svg's shape). The whole subtree is compiled at build time into one element. */
export declare const Svg: Intrinsic<
  SvgNodeProps &
    Omit<SvgPaintProps, "color" | "key" | keyof SvgPartMotion> & {
      viewBox?: string
      preserveAspectRatio?: string
      width?: number
      height?: number
      children?: unknown
    }
>
export declare const G: Intrinsic<SvgPaintProps>
export declare const Path: Intrinsic<SvgPaintProps & { d: string }>
export declare const Rect: Intrinsic<
  SvgPaintProps & { x?: SvgNumber; y?: SvgNumber; width: SvgNumber; height: SvgNumber; rx?: SvgNumber; ry?: SvgNumber }
>
export declare const Circle: Intrinsic<SvgPaintProps & { cx?: SvgNumber; cy?: SvgNumber; r: SvgNumber }>
export declare const Ellipse: Intrinsic<SvgPaintProps & { cx?: SvgNumber; cy?: SvgNumber; rx: SvgNumber; ry: SvgNumber }>
export declare const Line: Intrinsic<SvgPaintProps & { x1?: SvgNumber; y1?: SvgNumber; x2?: SvgNumber; y2?: SvgNumber }>
export declare const Polyline: Intrinsic<SvgPaintProps & { points: string | readonly number[] }>
export declare const Polygon: Intrinsic<SvgPaintProps & { points: string | readonly number[] }>
export declare const Defs: Intrinsic<{ children?: unknown }>
interface GradientProps {
  id: string
  gradientUnits?: "objectBoundingBox" | "userSpaceOnUse"
  gradientTransform?: string
  spreadMethod?: "pad" | "reflect" | "repeat"
  href?: string
  children?: unknown
}
export declare const LinearGradient: Intrinsic<GradientProps & { x1?: SvgNumber; y1?: SvgNumber; x2?: SvgNumber; y2?: SvgNumber }>
export declare const RadialGradient: Intrinsic<GradientProps & { cx?: SvgNumber; cy?: SvgNumber; r?: SvgNumber }>
export declare const Stop: Intrinsic<{ offset: SvgNumber; stopColor?: Color; stopOpacity?: SvgNumber; key?: string | number }>
export declare const ClipPath: Intrinsic<{ id: string; clipPathUnits?: "objectBoundingBox" | "userSpaceOnUse"; children?: unknown }>
export declare const Mask: Intrinsic<{ id: string; maskContentUnits?: "objectBoundingBox" | "userSpaceOnUse"; children?: unknown }>
export declare const Use: Intrinsic<SvgPaintProps & { href: string; x?: SvgNumber; y?: SvgNumber }>

/**
 * An endless circular loading spinner drawn natively in the draw phase (0 recompositions).
 */
export declare const Spinner: Intrinsic<
  Base & {
    size?: number
    color?: Color
  }
>
/**
 * A progress bar, value 0–1 (or indeterminate if value omitted).
 */
export declare const Progress: Intrinsic<
  Base & {
    value?: number
    color?: Color
    trackColor?: Color
  }
>
/**
 * A standalone shimmer box for list placeholders, synced to a shared frame clock.
 */
export declare const Shimmer: Intrinsic<
  Base & {
    baseColor?: Color
    highlightColor?: Color
    period?: number
  }
>
/**
 * A scrolling container. `horizontal` makes a rail: only the visible children are drawn, and scrolling never involves
 * JS. Its padding scrolls with the content (like RN's contentContainerStyle). For long vertical data use <List>.
 */
export declare const Scroll: Intrinsic<Container & ({ horizontal?: false } & RefreshProps | { horizontal: true })>
/**
 * Pull to refresh on a vertical <Scroll> or a <List> (guide notes §41). **Controlled**, like RN: a pull past the line
 * sends `onRefresh`; set `refreshing` to true while you load and back to false when done. The spinner shows while
 * `refreshing` is true (also without a pull, for a first load). Pulling works only when `onRefresh` is set.
 */
export interface RefreshProps {
  refreshing?: boolean
  onRefresh?: () => void
  /** The spinner's arc (RN `colors[0]` / `tintColor`). Default dark grey. */
  refreshColor?: Color
  /** The round disc behind the arc (RN `progressBackgroundColor`). Default white. */
  refreshBackground?: Color
  /** React Native's shape: `refreshControl={<RefreshControl refreshing={...} onRefresh={...} colors={[c]} />}`. */
  refreshControl?: ZnElement
}
/**
 * React Native's RefreshControl, for porting: only as `refreshControl={<RefreshControl ... />}` on a vertical <Scroll>
 * or a <List>, written right there (not kept in a variable). The compiler turns it into the flat props above.
 * `colors` takes one colour (only the first is used); `tintColor` is used when `colors` is not given.
 */
export declare const RefreshControl: Intrinsic<{
  refreshing?: boolean
  onRefresh?: () => void
  colors?: readonly Color[]
  tintColor?: Color
  progressBackgroundColor?: Color
}>
/**
 * A bottom sheet over the whole screen. **Controlled:** you own `visible`; when the user drags it down, flings it,
 * taps outside or presses back, `onDismiss` asks you to close it (set `visible` to false). If you keep it true, it
 * springs back. Dragging and settling are native (no JS during the gesture). `detents`: "content" (default),
 * "half", "full", comma-separated, first = where it opens. Place it anywhere in a screen: it takes no space there.
 */
export declare const Sheet: Intrinsic<
  Container & {
    visible: boolean
    onDismiss?: () => void
    detents?: string
    dismissible?: boolean
    onDetentChange?: (detent: "content" | "half" | "full") => void
  }
>
/**
 * A native pager (banners): its children are the pages (usually `items.map(...)`). Snaps per page; the next page
 * peeks in when `itemWidth` is smaller than the carousel. `autoAdvance` (ms) runs natively, only while the carousel
 * is on screen and the app is in front, and pauses `pauseAfterTouch` ms (default 3000) after the user touches it.
 * No JS timer, no re-render per page. Padding is content padding (the first page starts inset).
 */
export declare const Carousel: Intrinsic<
  Container & {
    itemWidth?: number
    autoAdvance?: number
    pauseAfterTouch?: number
    dots?: boolean
    dotColor?: Color
    activeDotColor?: Color
    onPageChange?: (index: number) => void
  }
>
/**
 * The tab panels of a screen with tabs (`useTabs`, guide notes §40): its children are the panels, one per tab, in the
 * route's order; it draws only the one at `selected` (pass `tabs.index()`). A panel you leave keeps its JS state and
 * its scroll position, but isn't drawn (no frames while its data loads). Guard each panel's content with
 * `tabs.seen(name) &&` so a tab is built only when first shown. The tab bar is your own JSX, outside it.
 */
export declare const Tabs: Intrinsic<Container & { selected: number }>
export declare const Pressable: Intrinsic<
  Container & {
    onPress?: () => void
    onPressIn?: () => void
    onPressOut?: (cancelled?: boolean) => void
    onLongPress?: () => void
    onPressRepeat?: () => void
    repeatDelay?: number
    repeatInterval?: number
    disabled?: boolean
    haptic?: boolean
    /** "ripple" (default on Android: from the touch point, inside the shape), "highlight" (a flat overlay) or "none". */
    pressFeedback?: "ripple" | "highlight" | "none"
    /** The ripple's colour; use white (or a light colour) on dark buttons. */
    rippleColor?: Color
    /** Scale while pressed, e.g. 0.95; springs back on release. */
    pressScale?: number
    /** Ripple opacity 0–1 (default 0.12, or 0.24 with a rippleColor). */
    rippleOpacity?: number
    /** A ripple not clipped to the element (a circle around the touch), for icon buttons. */
    rippleBorderless?: boolean
    /** Ripple radius in dp (default: covers the element). */
    rippleRadius?: number
    /** Opacity while pressed, e.g. 0.6 (iOS-style "dim while pressed"); animated. Combines with any feedback. */
    pressOpacity?: number
    /** The overlay colour for pressFeedback="highlight" (default black at 10 %). Give it its own alpha. */
    highlightColor?: Color
  }
>

/**
 * A text input. The native field owns the text while the user types (no lag); you hear `onChangeText`.
 * Controlled: pass `value` too and set it in onChangeText (synchronously); the field always ends up showing `value`,
 * so you can format or reject input there. Without `value` the field keeps its own text.
 * `onSubmitEditing` fires on the keyboard's action key (its label: `returnKeyType`).
 */
export declare const TextField: Intrinsic<
  Base &
    TextStyleProps & {
      value?: string
      onChangeText?: (text: string) => void
      placeholder?: string
      placeholderColor?: Color
      keyboardType?: "default" | "number-pad" | "decimal-pad" | "phone-pad" | "email-address" | "url"
      secureTextEntry?: boolean
      maxLength?: number
      multiline?: boolean
      autoFocus?: boolean
      returnKeyType?: "done" | "go" | "next" | "search" | "send"
      editable?: boolean
      autoCapitalize?: "none" | "sentences" | "words" | "characters"
      autoCorrect?: boolean
      /** Cursor and selection handle colour. */
      selectionColor?: Color
      onSubmitEditing?: (text: string) => void
      onFocus?: () => void
      onBlur?: () => void
      /** A handle for focus(), blur(), clear(), isFocused(): `const r = createRef<TextFieldHandle>()`, then `ref={r}`. */
      ref?: { current: TextFieldHandle | null }
    }
>

/**
 * A virtualized list for long or growing data (docs/lists.md). `row` is compiled once per row kind: return one JSX
 * element, or `cond ? <A/> : <B/>` to choose between kinds (headers, banners, product rails...). Only rows near the
 * screen exist; the rest are drawn as placeholders until they are near. Keys must be unique and stable.
 * Note: `key` here is the list's key function (the JSX `key` attribute name is reused on purpose, like FlatList's
 * keyExtractor).
 */
export declare function List<T>(props: {
  data: readonly T[] | null | undefined
  key: (item: T, index: number) => string | number
  row: (item: T, index: number) => unknown
  onEndReached?: () => void
  style?: StyleInput
  gap?: number
} & RefreshProps): never

/** Build-time helper: returns its argument (typed). The compiler folds it. */
export const StyleSheet = { create: <T extends Record<string, Style>>(styles: T): T => styles }
