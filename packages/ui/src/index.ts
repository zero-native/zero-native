// Types for the intrinsic components, for editors and type checking only. The compiler removes imports of this module
// and turns these elements into templates (compiler/src/compile.ts); none of this runs.
type Color = string
type Size = number | `${number}%`

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
}

type Style = StyleProps & TextStyleProps
type StyleInput = Style | false | null | undefined | StyleInput[]

interface Base extends StyleProps {
  style?: StyleInput
  key?: string | number
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
export declare const Image: Intrinsic<Base & { src?: string; contentScale?: "cover" | "contain" | "fill" }>
export declare const Icon: Intrinsic<Base & { icon?: string; color?: Color }>
export declare const Spacer: Intrinsic<Base>
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
  }
>

/** Build-time helper: returns its argument (typed). The compiler folds it. */
export const StyleSheet = { create: <T extends Record<string, Style>>(styles: T): T => styles }
