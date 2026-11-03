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

/** 250 (ms, tween) | "spring" | "bouncy" | { duration, easing? } | { spring: { damping?, stiffness? } } */
export type Timing =
  | number
  | "spring"
  | "bouncy"
  | { duration: number; easing?: "standard" | "ease-out" | "ease-in" | "linear" }
  | { spring: { damping?: number; stiffness?: number } }

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
      easing?: "standard" | "ease-out" | "ease-in" | "linear"
      spring?: { damping?: number; stiffness?: number }
    }

interface Base extends StyleProps {
  style?: StyleInput
  /**
   * Animate changes of this element's opacity, background colour and transforms natively (build-time value):
   * `animate={250}` for all of them, or `animate={{ opacity: 200, translateY: "spring" }}`.
   */
  animate?: Timing | Partial<Record<AnimatableProp, Timing>>
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
export declare const Scroll: Intrinsic<Container & { horizontal?: boolean }>
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
}): never

/** Build-time helper: returns its argument (typed). The compiler folds it. */
export const StyleSheet = { create: <T extends Record<string, Style>>(styles: T): T => styles }
