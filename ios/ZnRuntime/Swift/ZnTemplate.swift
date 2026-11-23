// Templates prepared once for drawing (ARCHITECTURE.md §9.1): typed fields per node instead of prop lookups while
// drawing. Port of android/runtime's ZnTemplate.kt (ZnNodeSpec). Some fields are read here before iOS draws them
// (registry 23 and 24: accessibility, fonts, List and Scroll extras, gestures and motion), so the work that draws
// each one doesn't need this file. Reading a field draws nothing; docs/guides/platform-differences.md lists the gaps.
import SwiftUI

struct ZnEdges: Equatable {
    var start: CGFloat = 0, top: CGFloat = 0, end: CGFloat = 0, bottom: CGFloat = 0
    var insets: EdgeInsets { EdgeInsets(top: top, leading: start, bottom: bottom, trailing: end) }
}

func znColor(_ v: ZnValue?) -> Color? {
    let argb: UInt32
    switch v {
    case .color(let c): argb = c
    case .number(let n): argb = UInt32(truncatingIfNeeded: Int64(n))  // JS sends ARGB as a number (toColor in Kotlin)
    default: return nil
    }
    return Color(.sRGB,
                 red: Double((argb >> 16) & 0xFF) / 255, green: Double((argb >> 8) & 0xFF) / 255,
                 blue: Double(argb & 0xFF) / 255, opacity: Double((argb >> 24) & 0xFF) / 255)
}

/// One node of a template, prepared once. A class, so views compare it by identity.
final class ZnNodeSpec {
    let index: Int
    let type: Int
    let children: [Int]
    let props: [Int: ZnValue]

    // Layout
    let width: ZnSize?
    let height: ZnSize?
    let minWidth: CGFloat?, maxWidth: CGFloat?, minHeight: CGFloat?, maxHeight: CGFloat?
    let flex: CGFloat
    let alignSelf: Int
    let margin: ZnEdges?
    let padding: ZnEdges?
    /// Padding / margin props whose value changes at runtime (a slot), prop id → slot: `paddingTop: insets().top + 32`.
    let edgeSlots: [Int: Int]
    let gap: CGFloat
    /// RN flexWrap "wrap" on a Row (registry 24): ZnWrapLayout. alignContent with justifyContent's numbers (-1 = start);
    /// crossGap is the gap between lines (rowGap; unset = gap).
    let flexWrap: Bool
    let alignContent: Int
    let crossGap: CGFloat?
    let justify: Int
    let alignItems: Int
    let absolute: Bool
    /// position: 'absolute' insets (only inside a Stack), as top / bottom / start / end in RN.
    let posTop: CGFloat?, posBottom: CGFloat?, posStart: CGFloat?, posEnd: CGFloat?
    let zIndex: Double?

    // Layout values from a slot (registry 23), -1 when the value is fixed; read by the "now" readers below. A corner's
    // slot is its Start / End one, else its Left / Right one (ZnTemplate.kt radiusSlots).
    let widthSlot: Int, heightSlot: Int, minWidthSlot: Int, maxWidthSlot: Int, minHeightSlot: Int, maxHeightSlot: Int
    let flexSlot: Int, aspectRatioSlot: Int, gapSlot: Int, crossGapSlot: Int, displaySlot: Int
    let topSlot: Int, bottomSlot: Int, startSlot: Int, endSlot: Int
    let borderRadiusSlot: Int
    let topStartRadiusSlot: Int, topEndRadiusSlot: Int, bottomEndRadiusSlot: Int, bottomStartRadiusSlot: Int
    let fontSizeSlot: Int, lineHeightSlot: Int, letterSpacingSlot: Int
    /// Registry.Display, -1 when not written.
    let display: Int
    /// RN pointerEvents (registry 15, ZnTouch.kt): Registry.PointerEvents, or znPointerEventsUnset; and its slot.
    let pointerEvents: Int
    let pointerEventsSlot: Int
    /// A layer drawn over its siblings: an absolute Box / Column / Row / Stack with a background or children. Without
    /// pointerEvents it stops taps, as a React Native view does (ZnTemplate.kt absoluteLayer).
    let absoluteLayer: Bool
    /// Set at build time or from a slot: what a parent decides from (a slot counts as set, as on Android, even while
    /// its value is null or "auto").
    var hasWidth: Bool { width != nil || widthSlot >= 0 }
    var hasHeight: Bool { height != nil || heightSlot >= 0 }
    var hasAspectRatio: Bool { aspectRatio != nil || aspectRatioSlot >= 0 }
    var hasPosTop: Bool { posTop != nil || topSlot >= 0 }
    var hasPosBottom: Bool { posBottom != nil || bottomSlot >= 0 }
    var hasPosStart: Bool { posStart != nil || startSlot >= 0 }
    var hasPosEnd: Bool { posEnd != nil || endSlot >= 0 }
    var hasDynamicRadius: Bool {
        borderRadiusSlot >= 0 || topStartRadiusSlot >= 0 || topEndRadiusSlot >= 0 || bottomEndRadiusSlot >= 0 || bottomStartRadiusSlot >= 0
    }

    // Drawing
    let background: Color?
    let radius: CGFloat
    let borderWidth: CGFloat
    let borderBottomWidth: CGFloat
    let borderTopWidth: CGFloat
    let borderColor: Color
    /// RN borderStyle (registry 16): Registry.BorderStyle; dashed / dotted for borders and top / bottom lines.
    let borderStyle: Int
    var borderDashed: Bool { borderStyle == Registry.BorderStyle.dashed || borderStyle == Registry.BorderStyle.dotted }
    /// Per corner (registry 15), as in RN: the corner's own value, else borderRadius; Start / End beat Left / Right.
    let topStart: CGFloat, topEnd: CGFloat, bottomEnd: CGFloat, bottomStart: CGFloat
    var rounded: Bool { topStart > 0 || topEnd > 0 || bottomEnd > 0 || bottomStart > 0 }
    /// The node's shape (start / end follow the layout direction, as Compose's RoundedCornerShape).
    var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: max(topStart, 0), bottomLeadingRadius: max(bottomStart, 0),
                               bottomTrailingRadius: max(bottomEnd, 0), topTrailingRadius: max(topEnd, 0), style: .circular)
    }
    let opacity: Double
    let clip: Bool
    /// Android's elevation shadow, drawn on iOS as a soft shadow under the background (see ZnBackground).
    let elevation: CGFloat
    /// backgroundImage: a CSS linear gradient drawn over the background colour.
    let gradient: ZnGradient?
    let shadowColor: Color

    // Transform (static parts; each can also have a slot). scale multiplies scaleX / scaleY, as in RN.
    let scaleBase: CGFloat, scaleXOnly: CGFloat, scaleYOnly: CGFloat
    let translateX: CGFloat, translateY: CGFloat
    /// Degrees.
    let rotate: CGFloat
    /// RN transformOrigin (registry 20): the pivot of scale and rotate as fractions of the size ("0 0.5" = the left
    /// edge's middle, written by the compiler); the centre when absent.
    let origin: UnitPoint
    let hasTransform: Bool

    // Animation (ZnAnimation.swift)
    let animate: ZnAnimate?
    let paused: Bool
    /// `enter` / `exit`: the state the element comes in from / leaves to.
    let enter: ZnTransition?
    let exit: ZnTransition?

    // Gestures and motion (registry 24, ZnTemplate.kt): 3D turns in degrees, the camera distance (default 8), blur,
    // each also from a slot; the gesture this node handles and the useElementMotion() it fills (slots holding their
    // ids); animateLayout's timing; a shared element's tag. Drawn by ZnMotionBindings / ZnDepthEffect, ZnGestureHub,
    // ZnElementMotion, ZnLayoutMotion and ZnShared.
    let rotateX: CGFloat, rotateY: CGFloat, cameraDistance: CGFloat, blurRadius: CGFloat
    let rotateXSlot: Int, rotateYSlot: Int, cameraDistanceSlot: Int, blurRadiusSlot: Int
    let gestureSlot: Int
    let motionSlot: Int
    let animateLayout: ZnTiming?
    let sharedTag: String?
    let sharedTagSlot: Int
    /// Something of registry 24's layer is used (3D turns, camera, blur), an enter / exit that turns included
    /// (the flip presets), as Android.
    let hasDepth: Bool
    /// A child here has a gesture or transform / opacity slots, or this node has anchor children: it tells them its
    /// size (a gesture's or formula's parent size). Set by ZnTemplate, which sees the children.
    fileprivate(set) var feedsChildSite = false

    // Text
    let text: String?
    let color: Color?
    let fontSize: CGFloat
    let fontWeight: Int?
    let textAlign: Int
    let maxLines: Int?
    let letterSpacing: CGFloat?
    /// RN textTransform (registry 15), -1 / 0: none.
    let textTransform: Int
    let italic: Bool
    let lineHeight: CGFloat?
    /// Registry.TextDecorationLine / TextDecorationStyle (-1: not written).
    let decorationLine: Int
    let decorationStyle: Int
    /// Nested <Text> spans: one style per span (JSON); the text holds the spans' texts joined by U+001F.
    let spans: [ZnSpan]?
    /// Registry 16: spans that change at runtime come in this slot, as the same JSON.
    let spansSlot: Int
    /// Registry 16: a span with onPress was tapped; the payload is its index.
    let onSpanPress: Int
    /// RN fontFamily (registry 24): an app font's family or a system name; nil = the system font.
    let fontFamily: String?
    /// The largest text size scale this text follows (allowFontScaling={false} is 1); nil: no cap.
    let maxFontScale: CGFloat?
    /// RN selectable (registry 23), and its slot.
    let selectable: Bool
    let selectableSlot: Int
    /// RN adjustsFontSizeToFit / minimumFontScale (registry 23): shrink to fit numberOfLines, down to that scale.
    let adjustsFontSizeToFit: Bool
    let minimumFontScale: CGFloat?

    // Icon: "minX minY width height|path data"
    let icon: ZnIconData?
    let src: String?

    // Image (registry 15 / 16) and Shimmer
    let fallbackSrc: String?
    let contentScale: Int
    /// Registry.Loading: shimmer while the picture loads.
    let loading: Int
    let tintColor: Color?
    let tintColorSlot: Int
    let onLoad: Int, onError: Int, onLoadEnd: Int
    let baseColor: Color?
    let shimmerHighlight: Color
    let period: Double?

    // List
    let onRange: Int
    let onEndReached: Int
    /// RN stickyHeaderIndices (registry 15): "0,20", or a slot with that text.
    let stickyHeaderIndices: String?
    let stickySlot: Int
    /// A List or Scroll that scrolls sideways (registry 10); a List's inverted (registry 19): row 0 at the bottom.
    let horizontal: Bool
    let inverted: Bool
    /// <List numColumns> (registry 24): rows of this many items (1...12, 1 = a plain list), also from a slot; and
    /// columnWrapperStyle, how each grid row places them.
    let numColumns: Int
    let numColumnsSlot: Int
    let columnWrapper: ZnColumnWrapper
    /// <List ref> / <Scroll ref>: the slot core writes scroll commands into (ZnScrollCommand).
    let scrollCommandSlot: Int
    /// <List> rows animate when added, removed or moved: "fade" or "move" (registry 24).
    let itemAnimation: String?
    /// <List reorderable> (registry 24): long press and drag a row; onReorder(from, to) on the drop.
    let reorderable: Bool
    let onReorder: Int
    /// An impression key (useImpressions): static, or from its slot.
    let impressionKey: String?
    let impressionKeySlot: Int
    var hasImpression: Bool { impressionKey != nil || impressionKeySlot >= 0 }

    // Scroll extras (registry 24, ZnScrollExtras.kt)
    /// Snap rules (core scrollSnap), static or from a slot.
    let snap: String?
    let snapSlot: Int
    /// The scroll events JS has handlers for, "t16;s;b;e;mb;me"; and the event they go to.
    let scrollEvents: String?
    let onScrollEvent: Int
    /// RN keyboardDismissMode: "on-drag", "interactive" or nil ("none").
    let keyboardDismissMode: String?
    /// The pull-to-refresh spinner's disc colour (Android's default: white); nil when not written.
    let refreshBackground: Color?

    // Canvas (registry 24): its draw commands, static or from a slot.
    let commands: String?
    let commandsSlot: Int

    // Svg and SvgPart (docs/svg.md §7): the draw data (parsed on first draw, ZnSvgDraw.swift) and a part's values.
    let svg: String?
    let autoMirror: Bool
    let aspectRatio: CGFloat?
    /// SvgPart: the index of the op it changes (G, S and T ops, counted from 0), or -1.
    let part: Int
    let fill: UInt32?, stroke: UInt32?
    let fillSlot: Int, strokeSlot: Int
    let trimStart: CGFloat, trimEnd: CGFloat, trimOffset: CGFloat
    let trimStartSlot: Int, trimEndSlot: Int, trimOffsetSlot: Int
    let hasTrim: Bool
    let pivotX: CGFloat, pivotY: CGFloat
    let strokeWidth: CGFloat, dashOffset: CGFloat
    let strokeWidthSlot: Int, dashOffsetSlot: Int
    let scaleOutline: Bool
    let morph: String?
    let morphAt: CGFloat
    let motionPath: String?
    let motionAt: CGFloat
    let skewX: CGFloat, skewY: CGFloat
    let frame: String?
    let trimCaps: Bool

    // OtpInput (registry 18) and TextField extras
    let otpTheme: String?
    let otpType: Int
    let blurOnFilled: Bool
    let invalid: Bool
    let invalidSlot: Int
    let placeholderSlot: Int
    /// Registry.AutoComplete, -1 when not written.
    let autoComplete: Int
    let onFilled: Int

    // Accessibility (registry 15): label (also from a slot), hint, role (Registry.AccessibilityRole, -1 when not
    // written), hidden; and RN testID.
    let accessibilityLabel: String?
    let accessibilityLabelSlot: Int
    let accessibilityHint: String?
    let accessibilityRole: Int
    let accessibilityHidden: Bool
    let testID: String?
    /// One of the accessibility props is set, or it is an image / svg / icon / shimmer (decorative without a label):
    /// ZnA11y has work to do. Without it ZnA11y passes the content through.
    let hasA11y: Bool
    /// A Pressable, Switch, Checkbox, TextField, OtpInput or a Text with onPress is under this node in the same
    /// template, so a Pressable here keeps them separately focusable. Set by ZnTemplate, which sees the children.
    fileprivate(set) var hasInteractiveDescendant = false

    // Tabs and pull to refresh
    let selected: Int
    let selectedSlot: Int
    let refreshing: Bool
    let refreshingSlot: Int
    let refreshColor: Color
    let onRefresh: Int

    // Switch, Checkbox, Spinner, Progress
    let trackColor: Color?, activeTrackColor: Color?, thumbColor: Color?, activeColor: Color?
    let size: CGFloat?
    let onValueChange: Int

    // NativeView (docs/plugins.md §4)
    let viewName: String?
    let viewProps: String?
    let viewPropsSlot: Int
    let onNativeEvent: Int

    // Carousel
    let autoAdvanceMs: Int
    let pauseAfterTouchMs: Double
    let dots: Bool
    let dotColor: Color
    let activeDotColor: Color
    let itemWidth: CGFloat?
    /// A page's width as a percent (1-100) of the Carousel's width inside its padding (registry 23).
    let itemWidthPercent: CGFloat?
    let onPageChange: Int
    /// RN onLayout (registry 15): { layout: { x, y, width, height } } when the box inside the margin changes.
    let onLayout: Int
    /// Its parent in this template (-1 for the root): onLayout's x / y are relative to it.
    let parent: Int
    /// A child has onLayout: this node names a coordinate space for it (set by ZnTemplate).
    fileprivate(set) var namesSpace = false

    // Sheet
    let visible: Bool
    /// `visible` is written (a Modal without it is shown, as in RN).
    let hasVisible: Bool
    // Modal (registry 15)
    let transparent: Bool
    let animationType: Int
    let statusBarTranslucent: Bool
    let navigationBarTranslucent: Bool
    // StatusBar / NavigationBar (registry 15)
    let barStyle: Int
    let barStyleSlot: Int
    let hidden: Bool
    let hasHiddenProp: Bool
    let hiddenSlot: Int
    let onShow: Int
    let detents: [String]
    let dismissible: Bool
    let onDismiss: Int
    /// A drag settled the Sheet at another detent: "content", "half" or "full".
    let onDetentChange: Int
    /// Sheet `animateIn={false}` (registry 21): opens already at rest. `animateIn={expr}` (registry 22): read when the
    /// sheet opens, not on every change.
    let animateIn: Bool
    let animateInSlot: Int

    // TextField
    let valueSlot: Int
    let placeholder: String?
    let keyboardType: Int
    let secure: Bool
    let maxLength: Int?
    let autoFocus: Bool
    let multiline: Bool
    /// `editable={false}`: the field shows its text but takes no typing (ZnTemplate.kt editable); and its slot.
    let editable: Bool
    let editableSlot: Int
    /// Registry.AutoCapitalize (-1: not written); autoCorrect is on unless written false.
    let autoCapitalize: Int
    let autoCorrect: Bool
    /// The placeholder's colour and the cursor / selection colour; nil when not written. Android's defaults: the
    /// placeholder #9CA3AF, the selection the theme's (Android's selectionColor is null when not written).
    let placeholderColor: Color?
    let selectionColor: Color?
    /// -1: not written (single-line: Done; multi-line: Return makes a new line).
    let returnKeyType: Int
    /// `<TextField ref>`: the ref event (focus changes go to it as a boolean; Keyboard.focus / blur / clear name it).
    let ref: Int
    let onChangeText: Int, onFocus: Int, onBlur: Int, onSubmitEditing: Int

    // Pressable
    let disabled: Bool
    let haptic: Bool
    let pressScale: CGFloat
    let pressOpacity: Double
    /// hitSlop (registry 15): taps this far past each edge still count ("start,top,end,bottom" from the compiler), or nil.
    let hitSlop: ZnEdges?
    /// Press feedback (ZnTemplate.kt): Registry.PressFeedback ripple (default) / highlight / none; the ripple's colour
    /// (nil: black), opacity (nil: 12 %, 24 % with a colour), borderless and radius; highlight's colour (black at 10 %).
    let pressFeedback: Int
    let rippleColor: Color?
    let rippleOpacity: Double?
    let rippleBorderless: Bool
    let rippleRadius: CGFloat?
    let highlightColor: Color

    // Slots this node reads (-1: none) and its events (0: none)
    let textSlot: Int, colorSlot: Int, backgroundSlot: Int, opacitySlot: Int, visibleSlot: Int, disabledSlot: Int, srcSlot: Int
    /// Border width and colour bound to slots (registry 15; -1 = static).
    let borderWidthSlot: Int, borderColorSlot: Int
    let scaleSlot: Int, scaleXSlot: Int, scaleYSlot: Int, translateXSlot: Int, translateYSlot: Int, rotateSlot: Int
    let pausedSlot: Int, replaySlot: Int
    let onPress: Int, onPressIn: Int, onPressOut: Int, onLongPress: Int, onPressRepeat: Int, hasLongPressSlot: Int
    let repeatDelayMs: Double, repeatIntervalMs: Double

    init(raw: RawTemplate, index: Int, children: [Int]) {
        self.index = index
        self.type = raw.component[index]
        self.children = children
        let p = raw.props[index]
        self.props = p
        func num(_ id: Int) -> CGFloat? { p[id]?.number.map { CGFloat($0) } }
        func en(_ id: Int) -> Int { if case .enumValue(let v) = p[id] { return v } else { return -1 } }
        func size(_ id: Int) -> ZnSize? {
            switch p[id] {
            case .number(let n): return .points(CGFloat(n))
            case .percent(let f): return .percent(CGFloat(f))
            default: return nil
            }
        }
        func edges(_ all: Int, _ h: Int, _ v: Int, _ s: Int, _ t: Int, _ e: Int, _ b: Int) -> ZnEdges? {
            guard [all, h, v, s, t, e, b].contains(where: { p[$0] != nil }) else { return nil }
            let a = num(all) ?? 0
            let hh = num(h) ?? a, vv = num(v) ?? a
            return ZnEdges(start: num(s) ?? hh, top: num(t) ?? vv, end: num(e) ?? hh, bottom: num(b) ?? vv)
        }
        func slotFor(_ prop: Int) -> Int { raw.slots.firstIndex { $0.node == index && $0.prop == prop } ?? -1 }
        func eventFor(_ kind: Int) -> Int { raw.events.first { $0.node == index && $0.kind == kind }?.eventId ?? 0 }
        typealias P = Registry.Prop

        width = size(P.width); height = size(P.height)
        minWidth = num(P.minWidth); maxWidth = num(P.maxWidth); minHeight = num(P.minHeight); maxHeight = num(P.maxHeight)
        flex = num(P.flex) ?? 0
        alignSelf = en(P.alignSelf)
        margin = edges(P.margin, P.marginHorizontal, P.marginVertical, P.marginStart, P.marginTop, P.marginEnd, P.marginBottom)
        var slots: [Int: Int] = [:]
        for prop in Self.paddingProps + Self.marginProps {
            let i = slotFor(prop)
            if i >= 0 { slots[prop] = i }
        }
        edgeSlots = slots
        padding = edges(P.padding, P.paddingHorizontal, P.paddingVertical, P.paddingStart, P.paddingTop, P.paddingEnd, P.paddingBottom)
        gap = num(P.gap) ?? 0
        flexWrap = en(P.flexWrap) == Registry.FlexWrap.wrap
        alignContent = en(P.alignContent)
        crossGap = num(P.crossGap)
        justify = en(P.justifyContent)
        alignItems = en(P.alignItems)
        absolute = en(P.position) == Registry.Position.absolute
        posTop = num(P.top); posBottom = num(P.bottom); posStart = num(P.start); posEnd = num(P.end)
        zIndex = p[P.zIndex]?.number
        widthSlot = slotFor(P.width); heightSlot = slotFor(P.height)
        minWidthSlot = slotFor(P.minWidth); maxWidthSlot = slotFor(P.maxWidth)
        minHeightSlot = slotFor(P.minHeight); maxHeightSlot = slotFor(P.maxHeight)
        flexSlot = slotFor(P.flex); aspectRatioSlot = slotFor(P.aspectRatio)
        gapSlot = slotFor(P.gap); crossGapSlot = slotFor(P.crossGap); displaySlot = slotFor(P.display)
        topSlot = slotFor(P.top); bottomSlot = slotFor(P.bottom); startSlot = slotFor(P.start); endSlot = slotFor(P.end)
        borderRadiusSlot = slotFor(P.borderRadius)
        func cornerSlot(_ start: Int, _ left: Int) -> Int { let s = slotFor(start); return s >= 0 ? s : slotFor(left) }
        topStartRadiusSlot = cornerSlot(P.borderTopStartRadius, P.borderTopLeftRadius)
        topEndRadiusSlot = cornerSlot(P.borderTopEndRadius, P.borderTopRightRadius)
        bottomEndRadiusSlot = cornerSlot(P.borderBottomEndRadius, P.borderBottomRightRadius)
        bottomStartRadiusSlot = cornerSlot(P.borderBottomStartRadius, P.borderBottomLeftRadius)
        fontSizeSlot = slotFor(P.fontSize); lineHeightSlot = slotFor(P.lineHeight); letterSpacingSlot = slotFor(P.letterSpacing)
        display = en(P.display)
        pointerEvents = en(P.pointerEvents)
        pointerEventsSlot = slotFor(P.pointerEvents)
        let container = [Registry.Component.box, Registry.Component.column, Registry.Component.row, Registry.Component.stack]
            .contains(raw.component[index])
        absoluteLayer = en(P.position) == Registry.Position.absolute && container &&
            (p[P.backgroundColor] != nil || slotFor(P.backgroundColor) >= 0 || !children.isEmpty)

        background = znColor(p[P.backgroundColor])
        radius = num(P.borderRadius) ?? 0
        borderWidth = num(P.borderWidth) ?? 0
        borderTopWidth = num(P.borderTopWidth) ?? 0
        borderBottomWidth = num(P.borderBottomWidth) ?? 0
        borderColor = znColor(p[P.borderColor]) ?? .black
        borderStyle = en(P.borderStyle)
        let r = radius
        func corner(_ left: Int, _ start: Int) -> CGFloat { num(start) ?? num(left) ?? r }
        topStart = corner(P.borderTopLeftRadius, P.borderTopStartRadius)
        topEnd = corner(P.borderTopRightRadius, P.borderTopEndRadius)
        bottomEnd = corner(P.borderBottomRightRadius, P.borderBottomEndRadius)
        bottomStart = corner(P.borderBottomLeftRadius, P.borderBottomStartRadius)
        opacity = Double(num(P.opacity) ?? 1)
        clip = en(P.overflow) == Registry.Overflow.hidden
        elevation = num(P.elevation) ?? 0
        gradient = p[P.backgroundImage]?.string.flatMap(ZnGradient.parse)
        shadowColor = znColor(p[P.shadowColor]) ?? .black
        scaleBase = num(P.scale) ?? 1; scaleXOnly = num(P.scaleX) ?? 1; scaleYOnly = num(P.scaleY) ?? 1
        translateX = num(P.translateX) ?? 0; translateY = num(P.translateY) ?? 0
        rotate = num(P.rotate) ?? 0
        origin = Self.parseOrigin(p[P.transformOrigin]?.string)
        animate = p[P.animate]?.string.map(ZnAnimate.parse)
        paused = p[P.paused]?.bool ?? false
        enter = p[P.enter]?.string.flatMap(ZnTransition.parse)
        exit = p[P.exit]?.string.flatMap(ZnTransition.parse)
        rotateX = num(P.rotateX) ?? 0; rotateY = num(P.rotateY) ?? 0
        cameraDistance = num(P.cameraDistance) ?? 8; blurRadius = num(P.blurRadius) ?? 0
        rotateXSlot = slotFor(P.rotateX); rotateYSlot = slotFor(P.rotateY)
        cameraDistanceSlot = slotFor(P.cameraDistance); blurRadiusSlot = slotFor(P.blurRadius)
        gestureSlot = slotFor(P.gesture)
        motionSlot = slotFor(P.motion)
        animateLayout = p[P.animateLayout]?.string.flatMap(ZnTiming.parse)
        sharedTag = p[P.sharedTag]?.string
        sharedTagSlot = slotFor(P.sharedTag)
        hasDepth = rotateX != 0 || rotateY != 0 || blurRadius != 0 || rotateXSlot >= 0 || rotateYSlot >= 0 ||
            cameraDistanceSlot >= 0 || blurRadiusSlot >= 0 || enter?.turns == true || exit?.turns == true

        text = p[P.text]?.string
        color = znColor(p[P.color])
        fontSize = num(P.fontSize) ?? 14
        fontWeight = num(P.fontWeight).map { Int($0) }
        textAlign = en(P.textAlign)
        maxLines = num(P.numberOfLines).map { Int($0) }
        letterSpacing = num(P.letterSpacing)
        textTransform = en(P.textTransform)
        italic = en(P.fontStyle) == Registry.FontStyle.italic
        lineHeight = num(P.lineHeight)
        decorationLine = en(P.textDecorationLine)
        decorationStyle = en(P.textDecorationStyle)
        spans = p[P.spans]?.string.flatMap(ZnSpan.parse)
        spansSlot = slotFor(P.spans)
        onSpanPress = eventFor(Registry.Event.onSpanPress)
        fontFamily = p[P.fontFamily]?.string
        maxFontScale = num(P.maxFontScale)
        selectable = p[P.selectable]?.bool ?? false
        selectableSlot = slotFor(P.selectable)
        adjustsFontSizeToFit = p[P.adjustsFontSizeToFit]?.bool ?? false
        minimumFontScale = num(P.minimumFontScale)

        icon = p[P.icon]?.string.flatMap(ZnIconData.parse)
        src = p[P.src]?.string
        fallbackSrc = p[P.fallbackSrc]?.string
        contentScale = en(P.contentScale)
        loading = en(P.loading)
        tintColor = znColor(p[P.tintColor])
        tintColorSlot = slotFor(P.tintColor)
        onLoad = eventFor(Registry.Event.onLoad); onError = eventFor(Registry.Event.onError)
        onLoadEnd = eventFor(Registry.Event.onLoadEnd)
        baseColor = znColor(p[P.baseColor])
        shimmerHighlight = znColor(p[P.highlightColor]) ?? Color.white.opacity(0.55)
        period = p[P.period]?.number

        onRange = eventFor(Registry.Event.onRange)
        onEndReached = eventFor(Registry.Event.onEndReached)
        stickyHeaderIndices = p[P.stickyHeaderIndices]?.string
        stickySlot = slotFor(P.stickyHeaderIndices)
        horizontal = p[P.horizontal]?.bool ?? false
        inverted = p[P.inverted]?.bool ?? false
        // Clamped as a number first: Int() of NaN or a huge value would trap.
        numColumns = num(P.numColumns).flatMap { $0.isFinite ? Int(min(max($0, 1), 12)) : nil } ?? 1
        numColumnsSlot = slotFor(P.numColumns)
        columnWrapper = ZnColumnWrapper.parse(p[P.columnWrapper]?.string)
        scrollCommandSlot = slotFor(P.scrollCommand)
        itemAnimation = p[P.itemAnimation]?.string
        reorderable = p[P.reorderable]?.bool ?? false
        onReorder = eventFor(Registry.Event.onReorder)
        impressionKey = p[P.impressionKey]?.string
        impressionKeySlot = slotFor(P.impressionKey)
        snap = p[P.snap]?.string
        snapSlot = slotFor(P.snap)
        scrollEvents = p[P.scrollEvents]?.string
        onScrollEvent = eventFor(Registry.Event.onScrollEvent)
        keyboardDismissMode = p[P.keyboardDismissMode]?.string
        refreshBackground = znColor(p[P.refreshBackground])
        commands = p[P.commands]?.string
        commandsSlot = slotFor(P.commands)
        func argb(_ id: Int) -> UInt32? {
            switch p[id] {
            case .color(let c): return c
            case .number(let n): return UInt32(truncatingIfNeeded: Int64(n))
            default: return nil
            }
        }
        svg = p[P.svg]?.string
        autoMirror = p[P.autoMirror]?.bool ?? false
        aspectRatio = num(P.aspectRatio)
        part = num(P.part).map { Int($0) } ?? -1
        fill = argb(P.fill); stroke = argb(P.stroke)
        fillSlot = slotFor(P.fill); strokeSlot = slotFor(P.stroke)
        trimStart = num(P.trimStart) ?? 0; trimEnd = num(P.trimEnd) ?? 1; trimOffset = num(P.trimOffset) ?? 0
        trimStartSlot = slotFor(P.trimStart); trimEndSlot = slotFor(P.trimEnd); trimOffsetSlot = slotFor(P.trimOffset)
        pivotX = num(P.pivotX) ?? 0; pivotY = num(P.pivotY) ?? 0
        strokeWidth = num(P.strokeWidth) ?? .nan; dashOffset = num(P.dashOffset) ?? .nan
        strokeWidthSlot = slotFor(P.strokeWidth); dashOffsetSlot = slotFor(P.dashOffset)
        scaleOutline = p[P.scaleOutline]?.bool ?? false
        morph = p[P.morph]?.string
        morphAt = num(P.morphAt) ?? -1
        motionPath = p[P.motionPath]?.string
        motionAt = num(P.motionAt) ?? -1
        skewX = num(P.skewX) ?? 0; skewY = num(P.skewY) ?? 0
        frame = p[P.frame]?.string
        trimCaps = p[P.trimCaps]?.bool ?? false
        let animated = p[P.animate]?.string.map(ZnAnimate.parse)
        hasTrim = p[P.trimStart] != nil || p[P.trimEnd] != nil || p[P.trimOffset] != nil ||
            trimStartSlot >= 0 || trimEndSlot >= 0 || trimOffsetSlot >= 0 ||
            [P.trimStart, P.trimEnd, P.trimOffset].contains { animated?.timing($0) != nil }
        selected = num(P.selected).map { Int($0) } ?? 0
        selectedSlot = slotFor(P.selected)
        refreshing = p[P.refreshing]?.bool ?? false
        refreshingSlot = slotFor(P.refreshing)
        refreshColor = znColor(p[P.refreshColor]) ?? Color(.sRGB, red: 0x37 / 255, green: 0x41 / 255, blue: 0x51 / 255)
        onRefresh = eventFor(Registry.Event.onRefresh)
        otpTheme = p[P.otpTheme]?.string
        otpType = max(en(P.otpType), 0)
        blurOnFilled = p[P.blurOnFilled]?.bool ?? false
        invalid = p[P.invalid]?.bool ?? false
        invalidSlot = slotFor(P.invalid)
        placeholderSlot = slotFor(P.placeholder)
        autoComplete = en(P.autoComplete)
        onFilled = eventFor(Registry.Event.onFilled)
        accessibilityLabel = p[P.accessibilityLabel]?.string
        accessibilityLabelSlot = slotFor(P.accessibilityLabel)
        accessibilityHint = p[P.accessibilityHint]?.string
        accessibilityRole = en(P.accessibilityRole)
        accessibilityHidden = p[P.accessibilityHidden]?.bool ?? false
        testID = p[P.testID]?.string
        hasA11y = accessibilityLabel != nil || accessibilityLabelSlot >= 0 || accessibilityHint != nil ||
            accessibilityRole >= 0 || accessibilityHidden ||
            [Registry.Component.image, Registry.Component.svg, Registry.Component.icon, Registry.Component.shimmer].contains(type)
        trackColor = znColor(p[P.trackColor]); activeTrackColor = znColor(p[P.activeTrackColor])
        thumbColor = znColor(p[P.thumbColor]); activeColor = znColor(p[P.activeColor])
        self.size = num(P.size)
        onValueChange = eventFor(Registry.Event.onValueChange)
        viewName = p[P.viewName]?.string
        viewProps = p[P.viewProps]?.string
        viewPropsSlot = slotFor(P.viewProps)
        onNativeEvent = eventFor(Registry.Event.onNativeEvent)
        autoAdvanceMs = Int(num(P.autoAdvance) ?? 0)
        pauseAfterTouchMs = Double(num(P.pauseAfterTouch) ?? 3000)
        dots = p[P.dots]?.bool ?? false
        dotColor = znColor(p[P.dotColor]) ?? Color(.sRGB, red: 0xD1 / 255, green: 0xD5 / 255, blue: 0xDB / 255)
        activeDotColor = znColor(p[P.activeDotColor]) ?? Color(.sRGB, red: 0x04 / 255, green: 0x78 / 255, blue: 0x57 / 255)
        itemWidth = num(P.itemWidth)
        itemWidthPercent = num(P.itemWidthPercent)
        onPageChange = eventFor(Registry.Event.onPageChange)
        onLayout = eventFor(Registry.Event.onLayout)
        parent = index == 0 ? -1 : raw.parent[index]
        visible = p[P.visible]?.bool ?? false
        hasVisible = p[P.visible] != nil
        transparent = p[P.transparent]?.bool ?? false
        animationType = en(P.animationType)
        statusBarTranslucent = p[P.statusBarTranslucent]?.bool ?? false
        navigationBarTranslucent = p[P.navigationBarTranslucent]?.bool ?? false
        barStyle = en(P.barStyle)
        barStyleSlot = slotFor(P.barStyle)
        hidden = p[P.hidden]?.bool ?? false
        hasHiddenProp = p[P.hidden] != nil
        hiddenSlot = slotFor(P.hidden)
        onShow = eventFor(Registry.Event.onShow)
        detents = (p[P.detents]?.string ?? "content").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { ["content", "half", "full"].contains($0) }
            .nonEmpty ?? ["content"]
        dismissible = p[P.dismissible]?.bool ?? true
        animateIn = p[P.animateIn]?.bool ?? true
        animateInSlot = slotFor(P.animateIn)
        onDismiss = raw.events.first { $0.node == index && $0.kind == Registry.Event.onDismiss }?.eventId ?? 0
        onDetentChange = eventFor(Registry.Event.onDetentChange)

        valueSlot = slotFor(P.value)
        placeholder = p[P.placeholder]?.string
        keyboardType = en(P.keyboardType)
        secure = p[P.secureTextEntry]?.bool ?? false
        maxLength = num(P.maxLength).map { Int($0) }
        autoFocus = p[P.autoFocus]?.bool ?? false
        multiline = p[P.multiline]?.bool ?? false
        editable = p[P.editable]?.bool ?? true
        editableSlot = slotFor(P.editable)
        autoCapitalize = en(P.autoCapitalize)
        autoCorrect = p[P.autoCorrect]?.bool ?? true
        placeholderColor = znColor(p[P.placeholderColor])
        selectionColor = znColor(p[P.selectionColor])
        returnKeyType = en(P.returnKeyType)
        ref = eventFor(Registry.Event.ref)
        onChangeText = eventFor(Registry.Event.onChangeText); onFocus = eventFor(Registry.Event.onFocus)
        onBlur = eventFor(Registry.Event.onBlur); onSubmitEditing = eventFor(Registry.Event.onSubmitEditing)

        disabled = p[P.disabled]?.bool ?? false
        haptic = p[P.haptic]?.bool ?? false
        pressScale = num(P.pressScale) ?? 1
        pressOpacity = Double(num(P.pressOpacity) ?? 1)
        hitSlop = Self.parseHitSlop(p[P.hitSlop]?.string)
        pressFeedback = en(P.pressFeedback) ?? Registry.PressFeedback.ripple
        rippleColor = znColor(p[P.rippleColor])
        rippleOpacity = num(P.rippleOpacity).map { min(max(Double($0), 0), 1) }
        rippleBorderless = p[P.rippleBorderless]?.bool ?? false
        rippleRadius = num(P.rippleRadius)
        highlightColor = znColor(p[P.highlightColor]) ?? Color.black.opacity(0.1)

        textSlot = slotFor(P.text); colorSlot = slotFor(P.color); backgroundSlot = slotFor(P.backgroundColor)
        opacitySlot = slotFor(P.opacity); visibleSlot = slotFor(P.visible); disabledSlot = slotFor(P.disabled)
        srcSlot = slotFor(P.src)
        borderWidthSlot = slotFor(P.borderWidth); borderColorSlot = slotFor(P.borderColor)
        scaleSlot = slotFor(P.scale); scaleXSlot = slotFor(P.scaleX); scaleYSlot = slotFor(P.scaleY)
        translateXSlot = slotFor(P.translateX); translateYSlot = slotFor(P.translateY); rotateSlot = slotFor(P.rotate)
        pausedSlot = slotFor(P.paused); replaySlot = slotFor(P.replay)
        hasTransform = scaleBase != 1 || scaleXOnly != 1 || scaleYOnly != 1 || translateX != 0 || translateY != 0 ||
            rotate != 0 || [scaleSlot, scaleXSlot, scaleYSlot, translateXSlot, translateYSlot, rotateSlot].contains { $0 >= 0 } ||
            animate != nil
        onPress = eventFor(Registry.Event.onPress); onPressIn = eventFor(Registry.Event.onPressIn)
        onPressOut = eventFor(Registry.Event.onPressOut); onLongPress = eventFor(Registry.Event.onLongPress)
        onPressRepeat = eventFor(Registry.Event.onPressRepeat)
        hasLongPressSlot = slotFor(P.hasLongPress)
        repeatDelayMs = Double(num(P.repeatDelay) ?? 400)
        repeatIntervalMs = max(16, Double(num(P.repeatInterval) ?? 100))
    }

    var isPressable: Bool { type == Registry.Component.pressable }

    /// A transform value comes from a slot (Android's hasTransformSlots, 3D turns, camera and blur included).
    var hasTransformSlots: Bool {
        [scaleSlot, scaleXSlot, scaleYSlot, translateXSlot, translateYSlot, rotateSlot,
         rotateXSlot, rotateYSlot, cameraDistanceSlot, blurRadiusSlot].contains { $0 >= 0 }
    }

    /// Percent width / height as fractions now (a slot's "50%" too), for the parent layout (ZnPercentKey).
    @MainActor func percentNow(_ inst: ZnInstance) -> ZnPercent {
        var p = ZnPercent()
        if case .percent(let f) = widthNow(inst) { p.width = f }
        if case .percent(let f) = heightNow(inst) { p.height = f }
        return p
    }

    /// "x y" fractions → a pivot; else the centre (parseTransformOrigin in ZnTemplate.kt).
    static func parseOrigin(_ s: String?) -> UnitPoint {
        let parts = (s ?? "").split(separator: " ").compactMap { Double($0) }
        return parts.count == 2 ? UnitPoint(x: parts[0], y: parts[1]) : .center
    }

    static let paddingProps = [Registry.Prop.padding, Registry.Prop.paddingHorizontal, Registry.Prop.paddingVertical,
                               Registry.Prop.paddingStart, Registry.Prop.paddingTop, Registry.Prop.paddingEnd,
                               Registry.Prop.paddingBottom]
    /// "start,top,end,bottom" → edges, or nil (none written, or all 0), as Android's parseHitSlop.
    static func parseHitSlop(_ spec: String?) -> ZnEdges? {
        let v = (spec ?? "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }.map { CGFloat($0) }
        guard v.count == 4, v.contains(where: { $0 > 0 }) else { return nil }
        return ZnEdges(start: v[0], top: v[1], end: v[2], bottom: v[3])
    }

    static let marginProps = [Registry.Prop.margin, Registry.Prop.marginHorizontal, Registry.Prop.marginVertical,
                              Registry.Prop.marginStart, Registry.Prop.marginTop, Registry.Prop.marginEnd,
                              Registry.Prop.marginBottom]

    /// Padding with runtime values filled in (reading those slots makes the caller's body follow them).
    @MainActor func paddingInsets(_ inst: ZnInstance) -> EdgeInsets { edgeInsets(Self.paddingProps, padding, inst) }

    /// `disabled` now (a slot, or the template's).
    @MainActor func disabledNow(_ inst: ZnInstance) -> Bool {
        disabledSlot >= 0 ? inst.slot(disabledSlot).value == .bool(true) : disabled
    }

    /// The border width now (a slot, or the template's).
    @MainActor func borderWidthNow(_ inst: ZnInstance) -> CGFloat {
        borderWidthSlot >= 0 ? inst.slot(borderWidthSlot).value.number.map { CGFloat($0) } ?? borderWidth : borderWidth
    }
    @MainActor func borderColorNow(_ inst: ZnInstance) -> Color {
        borderColorSlot >= 0 ? znColor(inst.slot(borderColorSlot).value) ?? borderColor : borderColor
    }

    /// Padding plus the border widths: borders take space, content sits inside them (zn flex rule 2, as Android).
    @MainActor func contentInsets(_ inst: ZnInstance) -> EdgeInsets {
        let p = paddingInsets(inst), b = borderInsets(inst)
        return EdgeInsets(top: p.top + b.top, leading: p.leading + b.leading, bottom: p.bottom + b.bottom,
                          trailing: p.trailing + b.trailing)
    }

    /// The border widths alone (a Scroll's padding goes inside its scrolling content instead).
    @MainActor func borderInsets(_ inst: ZnInstance) -> EdgeInsets {
        let w = max(borderWidthNow(inst), 0)
        return EdgeInsets(top: w + borderTopWidth, leading: w, bottom: w + borderBottomWidth, trailing: w)
    }
    @MainActor func marginInsets(_ inst: ZnInstance) -> EdgeInsets { edgeInsets(Self.marginProps, margin, inst) }

    // MARK: Layout values now (registry 23)
    // A value from a slot, else the template's. Each reads its slot only when it has one, so a fixed node observes
    // nothing; the view that calls one follows that slot (a change redraws or re-lays out that view alone). A null
    // value falls back to the template's, as Android's `inst.finiteNum(slot) ?: s.gap`.

    /// A number slot: its finite value, or [fixed] when it isn't a finite number.
    @MainActor private func numNow(_ slot: Int, _ fixed: CGFloat?, _ inst: ZnInstance) -> CGFloat? {
        slot >= 0 ? znFinite(inst.slot(slot).value) ?? fixed : fixed
    }
    /// A size slot: null keeps the template's; "auto", other text and NaN are not set (resolveSizePx).
    @MainActor private func sizeNow(_ slot: Int, _ fixed: ZnSize?, _ inst: ZnInstance) -> ZnSize? {
        guard slot >= 0 else { return fixed }
        let v = inst.slot(slot).value
        return v.isNull ? fixed : znSizeValue(v)
    }
    /// min / max: a number, null keeps the template's, anything else is not set (resolveDpPx).
    @MainActor private func boundNow(_ slot: Int, _ fixed: CGFloat?, _ inst: ZnInstance) -> CGFloat? {
        guard slot >= 0 else { return fixed }
        let v = inst.slot(slot).value
        return v.isNull ? fixed : znFinite(v)
    }

    @MainActor func widthNow(_ inst: ZnInstance) -> ZnSize? { sizeNow(widthSlot, width, inst) }
    @MainActor func heightNow(_ inst: ZnInstance) -> ZnSize? { sizeNow(heightSlot, height, inst) }
    @MainActor func minWidthNow(_ inst: ZnInstance) -> CGFloat? { boundNow(minWidthSlot, minWidth, inst) }
    @MainActor func maxWidthNow(_ inst: ZnInstance) -> CGFloat? { boundNow(maxWidthSlot, maxWidth, inst) }
    @MainActor func minHeightNow(_ inst: ZnInstance) -> CGFloat? { boundNow(minHeightSlot, minHeight, inst) }
    @MainActor func maxHeightNow(_ inst: ZnInstance) -> CGFloat? { boundNow(maxHeightSlot, maxHeight, inst) }
    @MainActor func flexNow(_ inst: ZnInstance) -> CGFloat { numNow(flexSlot, flex, inst) ?? 0 }
    /// Only a finite ratio above 0 counts.
    @MainActor func aspectRatioNow(_ inst: ZnInstance) -> CGFloat? {
        numNow(aspectRatioSlot, aspectRatio, inst).flatMap { $0 > 0 ? $0 : nil }
    }
    @MainActor func gapNow(_ inst: ZnInstance) -> CGFloat { numNow(gapSlot, gap, inst) ?? 0 }
    /// The gap between lines of a wrapping Row; nil: the gap.
    @MainActor func crossGapNow(_ inst: ZnInstance) -> CGFloat? { numNow(crossGapSlot, crossGap, inst) }

    /// An absolute child's insets. A slot that isn't a finite number is not set (absoluteChild in ZnRenderer.kt).
    @MainActor func posNow(_ inst: ZnInstance) -> (top: CGFloat?, bottom: CGFloat?, start: CGFloat?, end: CGFloat?) {
        func at(_ slot: Int, _ fixed: CGFloat?) -> CGFloat? { slot >= 0 ? znFinite(inst.slot(slot).value) : fixed }
        return (at(topSlot, posTop), at(bottomSlot, posBottom), at(startSlot, posStart), at(endSlot, posEnd))
    }

    /// The corners now: topStart, topEnd, bottomEnd, bottomStart (dynamicShape in ZnRenderer.kt).
    @MainActor func cornersNow(_ inst: ZnInstance) -> [CGFloat] {
        let fixed = [topStart, topEnd, bottomEnd, bottomStart]
        guard hasDynamicRadius else { return fixed.map { max($0, 0) } }
        typealias P = Registry.Prop
        func has(_ a: Int, _ b: Int) -> Bool { props[a] != nil || props[b] != nil }
        func at(_ slot: Int) -> CGFloat? { slot >= 0 ? znFinite(inst.slot(slot).value) : nil }
        return znCorners(fixed: fixed,
                         written: [has(P.borderTopStartRadius, P.borderTopLeftRadius), has(P.borderTopEndRadius, P.borderTopRightRadius),
                                   has(P.borderBottomEndRadius, P.borderBottomRightRadius),
                                   has(P.borderBottomStartRadius, P.borderBottomLeftRadius)],
                         cornerSlots: [at(topStartRadiusSlot), at(topEndRadiusSlot), at(bottomEndRadiusSlot), at(bottomStartRadiusSlot)],
                         all: at(borderRadiusSlot))
    }
    /// The node's shape now (start / end follow the layout direction).
    @MainActor func shapeNow(_ inst: ZnInstance) -> UnevenRoundedRectangle {
        guard hasDynamicRadius else { return shape }
        let c = cornersNow(inst)
        return UnevenRoundedRectangle(topLeadingRadius: c[0], bottomLeadingRadius: c[3], bottomTrailingRadius: c[2],
                                      topTrailingRadius: c[1], style: .circular)
    }

    @MainActor func fontSizeNow(_ inst: ZnInstance) -> CGFloat { numNow(fontSizeSlot, fontSize, inst) ?? fontSize }
    @MainActor func lineHeightNow(_ inst: ZnInstance) -> CGFloat? { numNow(lineHeightSlot, lineHeight, inst) }
    @MainActor func letterSpacingNow(_ inst: ZnInstance) -> CGFloat? { numNow(letterSpacingSlot, letterSpacing, inst) }

    /// display: "none" now (written, or from its slot).
    @MainActor func displayNoneNow(_ inst: ZnInstance) -> Bool {
        displaySlot >= 0 ? znDisplayNone(inst.slot(displaySlot).value) : display == Registry.Display.none
    }
    /// pointerEvents now: the slot's string, or the written value (pointerEventsOf in ZnTouch.kt).
    @MainActor func pointerEventsNow(_ inst: ZnInstance) -> Int {
        pointerEventsSlot >= 0 ? znPointerEvents(inst.slot(pointerEventsSlot).value) : pointerEvents
    }

    @MainActor private func edgeInsets(_ group: [Int], _ fixed: ZnEdges?, _ inst: ZnInstance) -> EdgeInsets {
        guard group.contains(where: { edgeSlots[$0] != nil }) else { return fixed?.insets ?? EdgeInsets() }
        func num(_ prop: Int) -> CGFloat? {
            if let slot = edgeSlots[prop] { return inst.slot(slot).value.number.map { CGFloat($0) } }
            return props[prop]?.number.map { CGFloat($0) }
        }
        let a = num(group[0]) ?? 0
        let h = num(group[1]) ?? a, v = num(group[2]) ?? a
        return EdgeInsets(top: num(group[4]) ?? v, leading: num(group[3]) ?? h, bottom: num(group[6]) ?? v, trailing: num(group[5]) ?? h)
    }
}

// A screen's template with its nodes read. iOS reads every prop and slot of registry 24 (the props with nothing to map
// to on iOS, such as Text includeFontPadding, are in docs/guides/platform-differences.md "Different by design"), so
// the debug notice for props iOS didn't draw yet is gone (2026-11-24).
final class ZnTemplate {
    let raw: RawTemplate
    let nodes: [ZnNodeSpec]
    /// Slot defaults, in slot order (shown until JS sends a value).
    let slotDefaults: [ZnValue]

    init(_ raw: RawTemplate) {
        self.raw = raw
        slotDefaults = raw.slots.map(\.defaultValue)
        var children = Array(repeating: [Int](), count: raw.component.count)
        for i in 1..<max(raw.component.count, 1) { children[raw.parent[i]].append(i) }
        nodes = (0..<raw.component.count).map { ZnNodeSpec(raw: raw, index: $0, children: children[$0]) }
        for n in nodes where n.onLayout != 0 && n.parent >= 0 { nodes[n.parent].namesSpace = true }
        for n in nodes where n.parent >= 0 && (n.type == Registry.Component.anchor || n.gestureSlot >= 0 || n.opacitySlot >= 0 ||
                                               n.hasTransformSlots) {
            nodes[n.parent].feedsChildSite = true
        }
        // Mark every ancestor of an interactive node, stopping at one already marked (its ancestors are too).
        typealias C = Registry.Component
        let interactive: Set<Int> = [C.pressable, C.switch, C.checkbox, C.textField, C.otpInput]
        for n in nodes where interactive.contains(n.type) || (n.type == C.text && n.onPress != 0) {
            var up = n.parent
            while up >= 0 && !nodes[up].hasInteractiveDescendant {
                nodes[up].hasInteractiveDescendant = true
                up = nodes[up].parent
            }
        }
    }
}

extension Array {
    var nonEmpty: [Element]? { isEmpty ? nil : self }
}
