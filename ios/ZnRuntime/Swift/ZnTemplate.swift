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
    let opacity: Double
    let clip: Bool

    // Text
    let text: String?
    let color: Color?
    let fontSize: CGFloat
    let fontWeight: Int?
    let textAlign: Int
    let maxLines: Int?
    let letterSpacing: CGFloat?

    // Icon: "minX minY width height|path data"
    let icon: ZnIconData?
    let src: String?

    // List
    let onRange: Int
    let onEndReached: Int
    /// RN stickyHeaderIndices (registry 15): "0,20", or a slot with that text.
    let stickyHeaderIndices: String?
    let stickySlot: Int

    // Sheet
    let visible: Bool
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
    let onChangeText: Int, onFocus: Int, onBlur: Int, onSubmitEditing: Int

    // Pressable
    let disabled: Bool
    let haptic: Bool
    let pressScale: CGFloat
    let pressOpacity: Double

    // Slots this node reads (-1: none) and its events (0: none)
    let textSlot: Int, colorSlot: Int, backgroundSlot: Int, opacitySlot: Int, visibleSlot: Int, disabledSlot: Int, srcSlot: Int
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
        opacity = Double(num(P.opacity) ?? 1)
        clip = en(P.overflow) == Registry.Overflow.hidden

        text = p[P.text]?.string
        color = znColor(p[P.color])
        fontSize = num(P.fontSize) ?? 14
        fontWeight = num(P.fontWeight).map { Int($0) }
        textAlign = en(P.textAlign)
        maxLines = num(P.numberOfLines).map { Int($0) }
        letterSpacing = num(P.letterSpacing)

        icon = p[P.icon]?.string.flatMap(ZnIconData.parse)
        src = p[P.src]?.string

        onRange = eventFor(Registry.Event.onRange)
        onEndReached = eventFor(Registry.Event.onEndReached)
        stickyHeaderIndices = p[P.stickyHeaderIndices]?.string
        stickySlot = slotFor(P.stickyHeaderIndices)
        visible = p[P.visible]?.bool ?? false
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
        onChangeText = eventFor(Registry.Event.onChangeText); onFocus = eventFor(Registry.Event.onFocus)
        onBlur = eventFor(Registry.Event.onBlur); onSubmitEditing = eventFor(Registry.Event.onSubmitEditing)

        disabled = p[P.disabled]?.bool ?? false
        haptic = p[P.haptic]?.bool ?? false
        pressScale = num(P.pressScale) ?? 1
        pressOpacity = Double(num(P.pressOpacity) ?? 1)

        textSlot = slotFor(P.text); colorSlot = slotFor(P.color); backgroundSlot = slotFor(P.backgroundColor)
        opacitySlot = slotFor(P.opacity); visibleSlot = slotFor(P.visible); disabledSlot = slotFor(P.disabled)
        srcSlot = slotFor(P.src)
        onPress = eventFor(Registry.Event.onPress); onPressIn = eventFor(Registry.Event.onPressIn)
        onPressOut = eventFor(Registry.Event.onPressOut); onLongPress = eventFor(Registry.Event.onLongPress)
        onPressRepeat = eventFor(Registry.Event.onPressRepeat)
        hasLongPressSlot = slotFor(P.hasLongPress)
        repeatDelayMs = Double(num(P.repeatDelay) ?? 400)
        repeatIntervalMs = max(16, Double(num(P.repeatInterval) ?? 100))
    }

    var isPressable: Bool { type == Registry.Component.pressable }

    static let paddingProps = [Registry.Prop.padding, Registry.Prop.paddingHorizontal, Registry.Prop.paddingVertical,
                               Registry.Prop.paddingStart, Registry.Prop.paddingTop, Registry.Prop.paddingEnd,
                               Registry.Prop.paddingBottom]
    static let marginProps = [Registry.Prop.margin, Registry.Prop.marginHorizontal, Registry.Prop.marginVertical,
                              Registry.Prop.marginStart, Registry.Prop.marginTop, Registry.Prop.marginEnd,
                              Registry.Prop.marginBottom]

    /// Padding with runtime values filled in (reading those slots makes the caller's body follow them).
    @MainActor func paddingInsets(_ inst: ZnInstance) -> EdgeInsets { edgeInsets(Self.paddingProps, padding, inst) }
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
    }
}

extension Array {
    var nonEmpty: [Element]? { isEmpty ? nil : self }
}
