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
  /** "auto" (React Native's default) is dropped: the size of the content. */
  width?: Size | "auto"
  height?: Size | "auto"
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  flex?: number
  /** A number, or React Native's "16/9" (folded at build time). */
  aspectRatio?: number | `${number}/${number}` | `${number} / ${number}`
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
  /** One corner (registry 15). A corner's own value beats borderRadius; Start / End beat Left / Right. */
  borderTopLeftRadius?: number
  borderTopRightRadius?: number
  borderBottomLeftRadius?: number
  borderBottomRightRadius?: number
  borderTopStartRadius?: number
  borderTopEndRadius?: number
  borderBottomStartRadius?: number
  borderBottomEndRadius?: number
  /** Can change at runtime (registry 15): a change moves the content, as in RN (borders take space). */
  borderWidth?: number
  /** Can change at runtime (registry 15): a change only redraws. */
  borderColor?: Color
  borderTopWidth?: number
  borderBottomWidth?: number
  /** As in React Native (registry 16): the border and the top / bottom lines drawn dashed or dotted. */
  borderStyle?: "solid" | "dashed" | "dotted"
  elevation?: number
  shadowColor?: Color
  /** iOS only, as in React Native on Android: accepted and ignored. Android shadows come from `elevation`. */
  shadowOffset?: { width: number; height: number }
  /** iOS only: accepted and ignored (see shadowOffset). */
  shadowOpacity?: number
  /** iOS only: accepted and ignored (see shadowOffset). */
  shadowRadius?: number
  opacity?: number
  overflow?: "visible" | "hidden"
  position?: "relative" | "absolute"
  top?: number
  bottom?: number
  start?: number
  end?: number
  zIndex?: number
  // React Native names, changed at build time (RN-compat sweep P1, guide notes §56).
  /** = marginStart. Left / right are start / end: the same in a left-to-right app; in right-to-left they flip. */
  marginLeft?: number
  /** = marginEnd. */
  marginRight?: number
  /** = paddingStart. */
  paddingLeft?: number
  /** = paddingEnd. */
  paddingRight?: number
  /** = start (absolute children of a Stack). */
  left?: number
  /** = end. */
  right?: number
  /** = flex: n. */
  flexGrow?: number
  /** Only 0 or 1, dropped: zero-native doesn't shrink children (a Text in a Row still wraps). */
  flexShrink?: 0 | 1
  /** Only 0 or "auto", dropped. */
  flexBasis?: 0 | "auto"
  /** The gap along a Column (or vertical List / Scroll); beats gap. */
  rowGap?: number
  /** The gap along a Row (or horizontal Scroll / Carousel); beats gap. */
  columnGap?: number
  /** Only on <View>: "row" makes it a <Row>, else a <Column>. Elsewhere a build error: pick <Row> or <Column>. */
  flexDirection?: "row" | "column"
  transform?: Array<{
    scale?: number
    scaleX?: number
    scaleY?: number
    translateX?: number
    translateY?: number
    rotate?: string | number
  }>
  /**
   * RN transformOrigin (registry 20): the point that scale and rotate turn around (also for `animate` and keyframes).
   * Keywords and percents, as RN: "left" (grows from the left edge), "right", "top", "bottom", "center" (default),
   * "top left", "50% 100%", or ["0%", "50%"]. "left" / "right" are the physical sides, as in RN (not flipped for
   * right-to-left). Lengths in dp aren't supported: use a percent. Fixed at build time.
   */
  transformOrigin?: string | Array<string | number>
}

export interface TextStyleProps {
  color?: Color
  fontSize?: number
  fontWeight?: number | "normal" | "bold"
  /** React Native's "left" / "auto" are "start", "right" is "end" (they flip in right-to-left). */
  textAlign?: "start" | "center" | "end" | "left" | "right" | "auto"
  numberOfLines?: number
  lineHeight?: number
  letterSpacing?: number
  fontStyle?: "normal" | "italic"
  textDecorationLine?: "none" | "underline" | "line-through"
  /**
   * The underline / line-through drawn dashed or dotted (registry 16). RN draws this on iOS only; zn draws it on
   * Android too. Not on a nested span.
   */
  textDecorationStyle?: "solid" | "dashed" | "dotted"
  /**
   * RN Android's extra space above and below each line (registry 16). zn's default is false (as Compose); true makes a
   * line 2-3 dp taller, as an RN <Text> on Android.
   */
  includeFontPadding?: boolean
  /** As in React Native: changes the case as it draws, also for text that changes at runtime (registry 15). */
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize"
  /** Cap the font scale factor (size * min(fontScale, maxFontScale)) for this text node. */
  maxFontScale?: number
}

type Style = StyleProps & TextStyleProps
type StyleInput = Style | false | null | undefined | StyleInput[]
type PaddingStyle = Pick<StyleProps, "padding" | "paddingHorizontal" | "paddingVertical" | "paddingTop" | "paddingBottom" | "paddingStart" | "paddingEnd">
/**
 * React Native's `contentContainerStyle` on a <Scroll> or <List>: padding that scrolls with the content (so the last
 * row can scroll above a floating button). Only padding keys. On these two, the padding in `style` scrolls with the
 * content too, so set padding in one place only (the build fails if both have it); use margin for space outside.
 */
type ContentContainerStyleInput = PaddingStyle | false | null | undefined | ContentContainerStyleInput[]

/** A named curve, or a CSS cubic-bezier as [x1, y1, x2, y2] (x1 and x2 within 0–1). */
export type Easing = "standard" | "ease-out" | "ease-in" | "linear" | readonly [number, number, number, number]

/**
 * Options every timing can have (registry 13). With `from` or `keyframes` the animation plays by itself when the
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
      /** Wait this many ms before it starts: a stagger for list rows (registry 13). */
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
  /** React Native's names (RN-compat sweep P1.11): = accessibilityLabel. */
  "aria-label"?: string
  /** = accessibilityHidden. */
  "aria-hidden"?: boolean
  /** = accessibilityHidden (iOS name). */
  accessibilityElementsHidden?: boolean
  /** = accessibilityRole ("heading" is header, "img" image, "presentation" none). */
  role?: "button" | "header" | "heading" | "image" | "img" | "link" | "text" | "switch" | "checkbox" | "none" | "presentation"
  /** "no-hide-descendants" = accessibilityHidden; "auto" and "yes" change nothing. */
  importantForAccessibility?: "auto" | "yes" | "no-hide-descendants"
  /** As in React Native: UI tests (uiautomator, Espresso) find the element by this resource id. Build-time. */
  testID?: string
  /**
   * As in React Native (registry 15): its size or place in its parent changed, in dp (sent once after the first
   * layout, then only on a change). x / y: from its parent's top-left corner.
   */
  onLayout?: (e: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void
  /**
   * As in React Native (registry 15; can change at runtime): "none" = this element and its children take no taps (they
   * reach what is under it), "box-none" = only its children take them, "box-only" = only the element itself.
   * Written "auto" or "box-only", it also stops taps from reaching what is under it, as a React Native view does.
   * Not written, an absolute Box / Column / Row / Stack with a background or children stops taps too (a "busy" layer),
   * and any other zn element without handlers lets them through.
   */
  pointerEvents?: "auto" | "none" | "box-none" | "box-only"
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
export declare const Text: Intrinsic<
  Base &
    TextStyleProps & {
      text?: string
      children?: unknown
      /** React Native's name: {false} = maxFontScale={1}. */
      allowFontScaling?: boolean
      /** zero-native always cuts the end ("tail"). */
      ellipsizeMode?: "tail"
      /**
       * Only on a nested <Text> span (registry 16): a tap on that piece of text, as an RN link
       * (`By continuing you agree to <Text onPress={openTerms}>Terms</Text>`). On a whole <Text>, wrap it in a Pressable.
       */
      onPress?: () => void
    }
>
/** `src`: an https URL or "asset:path". null / undefined shows nothing (the box keeps its size). */
export declare const Image: Intrinsic<
  Base & {
    src?: string | null
    fallbackSrc?: string | null
    loading?: "none" | "shimmer"
    contentScale?: "cover" | "contain" | "fill"
    /** React Native's name for src: source={{ uri }} (a require(...) image is src="asset:images/..."). */
    source?: { uri: string }
    /** React Native's name for contentScale ("stretch" is "fill"). */
    resizeMode?: "cover" | "contain" | "stretch"
    /** As in React Native (registry 15; can change at runtime): every non-clear pixel drawn in this colour. */
    tintColor?: Color
    /** As in React Native (registry 15): src loaded. width / height: the picture's size in pixels. */
    onLoad?: (e: { nativeEvent: { source: { width: number; height: number; uri: string } } }) => void
    /** As in React Native (registry 15): src failed to load (fallbackSrc, if set, shows next). */
    onError?: (e: { nativeEvent: { error: string } }) => void
    /** As in React Native (registry 15): src loaded or failed. */
    onLoadEnd?: () => void
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
    /** A colour (off), or React Native's {{ false: off, true: on }} (= trackColor + activeTrackColor). */
    trackColor?: Color | { false?: Color; true?: Color }
    activeTrackColor?: Color
    thumbColor?: Color
    /** iOS only: accepted and ignored. */
    ios_backgroundColor?: Color
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
  | "trimStart" | "trimEnd" | "trimOffset" | "strokeWidth" | "dashOffset"

/**
 * How a part moves (registry 13): transforms in viewBox units and degrees, around the part's own centre; trims
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
  /** The stroke width of every stroked shape inside it, in viewBox units (registry 13). Can change at runtime. */
  strokeWidth?: number
  /** Moves the dashes of every dashed stroke inside it along the line, in viewBox units (registry 13). */
  dashOffset?: number
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
 * [Part]: its part names. The build writes them next to the file (`logo.d.svg.ts`, docs/svg.md §16), so `parts`
 * autocompletes; until then any name type-checks and the build checks it.
 */
export type SvgFile<Part extends string = string> = Intrinsic<
  SvgNodeProps & {
    /** Change elements by their id: `parts={{ ring: { fill: brand() } }}`. Unknown ids fail the build. */
    parts?: Partial<Record<Part, SvgPartProps>>
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
export declare const Scroll: Intrinsic<Container & RnScrollProps & ({ horizontal?: false } & RefreshProps | { horizontal: true; contentContainerStyle?: ContentContainerStyleInput })>
/**
 * React Native ScrollView / FlatList props that change nothing on screen in zero-native (speed hints, iOS only):
 * accepted and dropped (RN-compat sweep P1.7). zn draws no scroll bar, so the indicator props take only false.
 */
export interface RnScrollProps {
  showsVerticalScrollIndicator?: false
  showsHorizontalScrollIndicator?: false
  /** zero-native works like "handled": a tap reaches the button under it; the keyboard stays. */
  keyboardShouldPersistTaps?: "handled" | "always" | true
  initialNumToRender?: number
  maxToRenderPerBatch?: number
  windowSize?: number
  updateCellsBatchingPeriod?: number
  removeClippedSubviews?: boolean
  extraData?: unknown
  getItemLayout?: unknown
  scrollEventThrottle?: number
  bounces?: boolean
  alwaysBounceVertical?: boolean
  alwaysBounceHorizontal?: boolean
  nestedScrollEnabled?: boolean
  directionalLockEnabled?: boolean
  automaticallyAdjustContentInsets?: boolean
  contentInsetAdjustmentBehavior?: string
}
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
  /** RN's name for padding that scrolls with the content. Only padding keys (see ContentContainerStyleInput). */
  contentContainerStyle?: ContentContainerStyleInput
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
    /**
     * false: opens already at rest, with no slide-up (registry 21). For a sheet that is part of a screen restored at
     * start (a payment after a kill), so the user doesn't see it arrive. Closing still slides down. Default true.
     */
    animateIn?: boolean
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
type PressableProps = Container & {
    onPress?: () => void
    onPressIn?: () => void
    onPressOut?: (cancelled?: boolean) => void
    onLongPress?: () => void
    onPressRepeat?: () => void
    repeatDelay?: number
    repeatInterval?: number
    disabled?: boolean
    haptic?: boolean
    /** As in React Native (registry 15): how far past its edges a tap still counts, in dp. Build-time. */
    hitSlop?: number | { top?: number; bottom?: number; left?: number; right?: number; start?: number; end?: number }
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
    /** React Native's android_ripple (= rippleColor, rippleBorderless, rippleRadius; foreground is ignored). */
    android_ripple?: { color?: Color; borderless?: boolean; radius?: number; foreground?: boolean }
  }
export declare const Pressable: Intrinsic<PressableProps>

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
      /** React Native's name for placeholderColor. */
      placeholderTextColor?: Color
      /** React Native's "numeric" is "decimal-pad". */
      keyboardType?: "default" | "number-pad" | "decimal-pad" | "phone-pad" | "email-address" | "url" | "numeric"
      /** React Native's name: {false} = maxFontScale={1}. */
      allowFontScaling?: boolean
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
      /**
       * What the field holds, as an Android autofill hint (registry 17): the keyboard or the autofill service can then
       * offer the phone number ("tel-national"), the code from an SMS ("sms-otp"), an email. RN's names.
       */
      autoComplete?:
        | "off" | "tel" | "tel-national" | "tel-country-code" | "tel-device" | "sms-otp" | "one-time-code" | "email"
        | "name" | "given-name" | "name-given" | "family-name" | "name-family" | "name-middle" | "name-middle-initial"
        | "username" | "username-new" | "password" | "current-password" | "new-password" | "password-new"
        | "postal-code" | "street-address" | "postal-address" | "country" | "birthdate-full" | "gender"
      /** iOS's autofill hint. Accepted and ignored on Android, as in RN: use autoComplete. */
      textContentType?: string
      onSubmitEditing?: (text: string) => void
      onFocus?: () => void
      onBlur?: () => void
      /** A handle for focus(), blur(), clear(), isFocused(): `const r = createRef<TextFieldHandle>()`, then `ref={r}`. */
      ref?: { current: TextFieldHandle | null }
    }
>

/** The same shape as core's OtpInputHandle (packages/core/src/otp-input.ts), as react-native-otp-entry's ref. */
interface OtpInputHandle {
  focus(): void
  blur(): void
  clear(): void
  /** Fills the boxes (the SMS auto-read): cut to numberOfDigits, then onTextChange and, when full, onFilled. */
  setValue(code: string): void
}
/** A box's look in `theme` (known at build time). */
type OtpBoxStyle = { width?: number; height?: number; borderRadius?: number; borderWidth?: number; borderColor?: Color; backgroundColor?: Color }
/**
 * OTP boxes, as react-native-otp-entry (registry 18, guide notes §62): one hidden native field holds the code and the
 * boxes draw it, so typing, paste, the keyboard's autofill (`sms-otp`) and the SMS auto-read (`ref.setValue`) all
 * fill it. Same props as RN; `theme` must be known at build time. zn's own: `error` (a wrong code) with
 * `theme.errorPinCodeContainerStyle`.
 */
export declare const OtpInput: Intrinsic<{
  numberOfDigits?: number
  type?: "numeric" | "alpha" | "alphanumeric"
  autoFocus?: boolean
  focusColor?: Color
  blurOnFilled?: boolean
  hideStick?: boolean
  focusStickBlinkingDuration?: number
  secureTextEntry?: boolean
  /** One character for every box, or one per box. */
  placeholder?: string
  /** Can change at runtime. */
  disabled?: boolean
  /** zn's own, can change at runtime: the boxes take theme.errorPinCodeContainerStyle. */
  error?: boolean
  onTextChange?: (text: string) => void
  onFilled?: (code: string) => void
  onFocus?: () => void
  onBlur?: () => void
  textInputProps?: {
    accessibilityLabel?: string
    keyboardType?: "default" | "number-pad" | "decimal-pad" | "phone-pad" | "numeric"
    autoComplete?: "sms-otp" | "one-time-code" | "off"
    textContentType?: string
    testID?: string
  }
  theme?: {
    containerStyle?: StyleProps
    inputsContainerStyle?: StyleProps
    pinCodeContainerStyle?: OtpBoxStyle
    focusedPinCodeContainerStyle?: OtpBoxStyle
    filledPinCodeContainerStyle?: OtpBoxStyle
    disabledPinCodeContainerStyle?: OtpBoxStyle
    errorPinCodeContainerStyle?: OtpBoxStyle
    pinCodeTextStyle?: { fontSize?: number; fontWeight?: number | "normal" | "bold" | "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"; color?: Color; fontFamily?: string }
    focusStickStyle?: { width?: number; height?: number; backgroundColor?: Color }
    placeholderTextStyle?: { color?: Color }
  }
  testID?: string
  accessibilityLabel?: string
  ref?: { current: OtpInputHandle | null }
}>

/**
 * A virtualized list for long or growing data (docs/lists.md). `row` is compiled once per row kind: return one JSX
 * element, or `cond ? <A/> : <B/>` to choose between kinds (headers, banners, product rails...). Only rows near the
 * screen exist; the rest are drawn as placeholders until they are near. Keys must be unique and stable.
 * Note: `key` here is the list's key function (the JSX `key` attribute name is reused on purpose, like FlatList's
 * keyExtractor).
 */
export declare function List<T>(props: {
  data: readonly T[] | null | undefined
  onEndReached?: () => void
  style?: StyleInput
  gap?: number
  testID?: string
  /**
   * As in React Native (registry 15): these rows (by index in data) stay pinned at the top while their part of the
   * list scrolls under them; the next one pushes the last up. Can change at runtime.
   */
  stickyHeaderIndices?: readonly number[]
  /**
   * As React Native's FlatList (registry 19): row 0 sits at the bottom and the list grows upwards, for a chat with the
   * newest message first in `data`. It opens at the bottom; while you are at the bottom a new row 0 stays in view;
   * `onEndReached` fires near the top (older messages). A short list sits at the bottom. Fixed at build time.
   * Don't flip a list with `transform: [{ scaleY: -1 }]` instead: the build refuses it (flings go the wrong way).
   */
  inverted?: boolean
} & RefreshProps & RnScrollProps & (
  | {
      key: (item: T, index: number) => string | number
      row: (item: T, index: number) => unknown
    }
  | {
      /** React Native's FlatList names (RN-compat sweep P1.5): renderItem gets { item, index }. */
      renderItem: (info: { item: T; index: number }) => unknown
      /** Default, as in RN: item.key, else item.id, else the index. */
      keyExtractor?: (item: T, index: number) => string | number
    }
)): never

/**
 * React Native's Modal (registry 15): a full-screen window over the app, in which you draw your own content (a
 * centred dialog, a loading layer, a sheet of your own). Shown while `visible` (shown when not written). Back sends
 * `onRequestClose`; it closes only when you set `visible` to false. Its children are laid out like a Column that fills
 * the window. iOS-only props (presentationStyle, supportedOrientations, ...) are accepted and do nothing.
 */
export declare const Modal: Intrinsic<{
  visible?: boolean
  /** No window background: the screen shows through where your content draws nothing. Default false (white). */
  transparent?: boolean
  /** "none" (default), "fade", or "slide" (up from the bottom). */
  animationType?: "none" | "fade" | "slide"
  /** Your content may draw under the status bar (else it starts below it). */
  statusBarTranslucent?: boolean
  /** Your content may draw under the navigation bar (else it ends above it). */
  navigationBarTranslucent?: boolean
  onRequestClose?: () => void
  onShow?: () => void
  testID?: string
  presentationStyle?: string
  hardwareAccelerated?: boolean
  supportedOrientations?: string[]
  onOrientationChange?: () => void
  children?: unknown
}>

/**
 * React Native's StatusBar (registry 15): put it in a screen (or in a Modal / Sheet of that screen). While the screen
 * is on top, `barStyle` sets the icons ("light-content" over a dark header), `hidden` hides the bar, and
 * `backgroundColor` is drawn behind the bar (Android 15+ has no bar colour; this works on every version). Several
 * merge, the newest winning, as in RN. All can change at runtime. `translucent`: each route's `safeArea` decides;
 * `animated` and iOS props are accepted and do nothing. `StatusBar.setBarStyle(...)` is not built: render one.
 */
export declare const StatusBar: Intrinsic<{
  barStyle?: "default" | "light-content" | "dark-content"
  backgroundColor?: Color
  hidden?: boolean
  animated?: boolean
  translucent?: boolean
  networkActivityIndicatorVisible?: boolean
  showHideTransition?: string
}>
/** The same for the navigation bar (zn's own; React Native has none): its icons and the colour behind it. */
export declare const NavigationBar: Intrinsic<{
  barStyle?: "default" | "light-content" | "dark-content"
  backgroundColor?: Color
}>

// ---- React Native component names (RN-compat sweep P1, guide notes §56) ----------------------------------------------
// The compiler turns each into a zero-native element; import them from here, not from "react-native".

/** A <Column>, or a <Row> when its style has flexDirection: "row" (known at build time). */
export declare const View: Intrinsic<Container>
/** A <List>: data, renderItem, keyExtractor (or row, key), onEndReached, refreshing / onRefresh. */
export declare const FlatList: typeof List
/** A <Pressable> with no ripple that dims to activeOpacity (default 0.2) while pressed. */
export declare const TouchableOpacity: Intrinsic<PressableProps & { activeOpacity?: number }>
/** A <Pressable> with an overlay of underlayColor (default black) at 1 - activeOpacity (default 0.85) while pressed. */
export declare const TouchableHighlight: Intrinsic<PressableProps & { underlayColor?: Color; activeOpacity?: number }>
/** A <Pressable> with no press feedback. */
export declare const TouchableWithoutFeedback: Intrinsic<PressableProps>
/** A <Spinner>: size "small" (20 dp, default), "large" (36 dp) or dp; animating={false} hides it (it keeps its space). */
export declare const ActivityIndicator: Intrinsic<
  Base & { size?: "small" | "large" | number; color?: Color; animating?: boolean; hidesWhenStopped?: true }
>

/** RN's absoluteFill: fills the parent Stack (RN's left / right are start / end in zn). */
const absoluteFill = { position: "absolute", top: 0, start: 0, end: 0, bottom: 0 } as const satisfies Style

/** RN's flatten: one style object from an array (falsy entries skipped, later entries winning). */
function flatten(style: StyleInput): Style {
  const out: Style = {}
  const merge = (s: StyleInput) => {
    if (Array.isArray(s)) s.forEach(merge)
    else if (s) Object.assign(out, s)
  }
  merge(style)
  return out
}

/**
 * Build-time helper: `create` returns its argument (typed). The compiler folds it, and `absoluteFill` /
 * `absoluteFillObject` (the same style, as in React Native), `hairlineWidth` and `flatten` (RN-compat sweep P1.12).
 * `hairlineWidth` is 0.4 dp: RN rounds it to one real pixel per phone, which a build can't know (one pixel or a
 * little more on most phones).
 */
export const StyleSheet = {
  create: <T extends Record<string, Style>>(styles: T): T => styles,
  absoluteFill,
  absoluteFillObject: absoluteFill,
  hairlineWidth: 0.4,
  flatten,
}
