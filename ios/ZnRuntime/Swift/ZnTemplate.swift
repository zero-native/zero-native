// Templates prepared once for drawing (ARCHITECTURE.md §9.1): typed fields per node instead of prop lookups while
// drawing. Port of the parts of android/runtime's ZnTemplate.kt (ZnNodeSpec) that the i.1b spike draws.
import SwiftUI

struct ZnEdges: Equatable {
    var start: CGFloat = 0, top: CGFloat = 0, end: CGFloat = 0, bottom: CGFloat = 0
    var insets: EdgeInsets { EdgeInsets(top: top, leading: start, bottom: bottom, trailing: end) }
}

/// A size prop: points, or a fraction of the parent.
enum ZnSize: Equatable {
    case points(CGFloat)
    case percent(CGFloat)
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
    let justify: Int
    let alignItems: Int
    let absolute: Bool
    /// position: 'absolute' insets (only inside a Stack), as top / bottom / start / end in RN.
    let posTop: CGFloat?, posBottom: CGFloat?, posStart: CGFloat?, posEnd: CGFloat?
    let zIndex: Double?

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

    // Switch, Checkbox, Spinner, Progress
    let trackColor: Color?, activeTrackColor: Color?, thumbColor: Color?, activeColor: Color?
    let size: CGFloat?
    let onValueChange: Int

    // Carousel
    let autoAdvanceMs: Int
    let pauseAfterTouchMs: Double
    let dots: Bool
    let dotColor: Color
    let activeDotColor: Color
    let itemWidth: CGFloat?
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
    let onShow: Int
    let detents: [String]
    let dismissible: Bool
    let onDismiss: Int

    // TextField
    let valueSlot: Int
    let placeholder: String?
    let keyboardType: Int
    let secure: Bool
    let maxLength: Int?
    let autoFocus: Bool
    let multiline: Bool
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
        justify = en(P.justifyContent)
        alignItems = en(P.alignItems)
        absolute = en(P.position) == Registry.Position.absolute
        posTop = num(P.top); posBottom = num(P.bottom); posStart = num(P.start); posEnd = num(P.end)
        zIndex = p[P.zIndex]?.number

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
        trackColor = znColor(p[P.trackColor]); activeTrackColor = znColor(p[P.activeTrackColor])
        thumbColor = znColor(p[P.thumbColor]); activeColor = znColor(p[P.activeColor])
        self.size = num(P.size)
        onValueChange = eventFor(Registry.Event.onValueChange)
        autoAdvanceMs = Int(num(P.autoAdvance) ?? 0)
        pauseAfterTouchMs = Double(num(P.pauseAfterTouch) ?? 3000)
        dots = p[P.dots]?.bool ?? false
        dotColor = znColor(p[P.dotColor]) ?? Color(.sRGB, red: 0xD1 / 255, green: 0xD5 / 255, blue: 0xDB / 255)
        activeDotColor = znColor(p[P.activeDotColor]) ?? Color(.sRGB, red: 0x04 / 255, green: 0x78 / 255, blue: 0x57 / 255)
        itemWidth = num(P.itemWidth)
        onPageChange = eventFor(Registry.Event.onPageChange)
        onLayout = eventFor(Registry.Event.onLayout)
        parent = index == 0 ? -1 : raw.parent[index]
        visible = p[P.visible]?.bool ?? false
        hasVisible = p[P.visible] != nil
        transparent = p[P.transparent]?.bool ?? false
        animationType = en(P.animationType)
        statusBarTranslucent = p[P.statusBarTranslucent]?.bool ?? false
        navigationBarTranslucent = p[P.navigationBarTranslucent]?.bool ?? false
        onShow = eventFor(Registry.Event.onShow)
        detents = (p[P.detents]?.string ?? "content").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { ["content", "half", "full"].contains($0) }
            .nonEmpty ?? ["content"]
        dismissible = p[P.dismissible]?.bool ?? true
        onDismiss = raw.events.first { $0.node == index && $0.kind == Registry.Event.onDismiss }?.eventId ?? 0

        valueSlot = slotFor(P.value)
        placeholder = p[P.placeholder]?.string
        keyboardType = en(P.keyboardType)
        secure = p[P.secureTextEntry]?.bool ?? false
        maxLength = num(P.maxLength).map { Int($0) }
        autoFocus = p[P.autoFocus]?.bool ?? false
        multiline = p[P.multiline]?.bool ?? false
        returnKeyType = en(P.returnKeyType)
        ref = eventFor(Registry.Event.ref)
        onChangeText = eventFor(Registry.Event.onChangeText); onFocus = eventFor(Registry.Event.onFocus)
        onBlur = eventFor(Registry.Event.onBlur); onSubmitEditing = eventFor(Registry.Event.onSubmitEditing)

        disabled = p[P.disabled]?.bool ?? false
        haptic = p[P.haptic]?.bool ?? false
        pressScale = num(P.pressScale) ?? 1
        pressOpacity = Double(num(P.pressOpacity) ?? 1)

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

    /// Percent width / height as fractions, for the parent layout (ZnPercentKey).
    var percent: ZnPercent {
        var p = ZnPercent()
        if case .percent(let f) = width { p.width = f }
        if case .percent(let f) = height { p.height = f }
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
    }
}

extension Array {
    var nonEmpty: [Element]? { isEmpty ? nil : self }
}
