// Draws template instances with SwiftUI (ARCHITECTURE.md §9, §20). Port of the parts of android/runtime's
// ZnRenderer.kt that the i.1b spike needs: Column / Row / Box / Pressable / Fragment / Stack / Scroll, Text, Icon,
// Image, Spacer, and anchors expanded into the instances mounted there.
//
// Leaf-level updates: a slot is read only in the small view that shows it (ZnTextView reads the text and colour
// slots, ZnBackground the background slot). With one @Observable cell per slot, a patch redraws that view and
// nothing above it. ZnDebug counts every body run to check this.
//
// The fixed modifier order (docs/styling-and-layout.md §4: margin → size → opacity → background → border → clip →
// press feedback → padding) reads inside-out in SwiftUI: content.padding → size frame → clip → border → background
// → opacity → press feedback → margin.
import SwiftUI
import UIKit

/// What a parent tells a child: fill the cross axis it was stretched on, or the main axis its flex shares out.
struct ZnOuter: Equatable {
    var fillWidth = false
    var fillHeight = false
}

/// Everything a node view needs besides its own node: the template file and the store. A class: compared by identity.
@MainActor
final class ZnContext {
    let templates: [ZnTemplate]
    let store: ZnStore
    let send: (UInt32, Int, ZnPayload) -> Void
    init(templates: [ZnTemplate], store: ZnStore, send: @escaping (UInt32, Int, ZnPayload) -> Void) {
        self.templates = templates
        self.store = store
        self.send = send
    }
}

/// A screen: its root instance, filling the host.
struct ZnScreenView: View {
    let ctx: ZnContext
    let root: ZnInstance

    var body: some View {
        if let t = ctx.templates[safe: root.templateId] {
            ZnNodeView(ctx: ctx, t: t, inst: root, n: 0, outer: ZnOuter(fillWidth: true, fillHeight: true), definiteWidth: true)
        }
    }
}

/// What to draw at one child position: a node of the same template, or the root of a mounted instance.
struct ZnChildRef: Identifiable {
    let t: ZnTemplate
    let inst: ZnInstance
    let node: Int
    let id: String
}

/// The children of a node in order, anchors expanded into the instances mounted there. Reading the anchors' lists
/// makes the caller's body observe them, so a MOUNT / REMOVE redraws the parent only.
@MainActor
func znChildRefs(_ ctx: ZnContext, _ t: ZnTemplate, _ inst: ZnInstance, _ children: [Int]) -> [ZnChildRef] {
    var out: [ZnChildRef] = []
    out.reserveCapacity(children.count)
    for c in children {
        if t.nodes[c].type == Registry.Component.anchor {
            for id in inst.children(c).ids {
                guard let ci = ctx.store.find(id), let ct = ctx.templates[safe: ci.templateId] else { continue }
                if ct.nodes[0].type == Registry.Component.fragment {
                    out += znChildRefs(ctx, ct, ci, ct.nodes[0].children)
                } else {
                    out.append(ZnChildRef(t: ct, inst: ci, node: 0, id: "i\(id)"))
                }
            }
        } else {
            out.append(ZnChildRef(t: t, inst: inst, node: c, id: "\(inst.id).\(c)"))
        }
    }
    return out
}

struct ZnNodeView: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let n: Int
    let outer: ZnOuter
    /// This node's width is fixed by something other than its content (zn flex rule 4).
    let definiteWidth: Bool
    /// Draw a Sheet node as its content (a Column), inside the presented sheet.
    var sheetBody = false

    var body: some View {
        let s = t.nodes[n]
        let _ = ZnDebug.hit(s, inst)
        if s.isPressable {
            ZnPressable(ctx: ctx, s: s, inst: inst) { inner(s) }
                .padding(s.marginInsets(inst))
        } else {
            inner(s).padding(s.marginInsets(inst))
        }
    }

    @ViewBuilder
    private func inner(_ s: ZnNodeSpec) -> some View {
        if s.type == Registry.Component.sheet && !sheetBody {
            content(s)  // the sheet itself is presented; here it takes no room
        } else {
            styled(s)
        }
    }

    @ViewBuilder
    private func styled(_ s: ZnNodeSpec) -> some View {
        content(s)
            .padding(s.type == Registry.Component.list ? EdgeInsets() : s.paddingInsets(inst))
            .modifier(ZnSizeFrame(s: s, outer: outer, alignment: contentAlignment(s)))
            .modifier(ZnFieldBoxTap(s: s, inst: inst))
            .modifier(ZnPaint(s: s, inst: inst))
    }

    private func contentAlignment(_ s: ZnNodeSpec) -> Alignment {
        guard s.type == Registry.Component.text else { return .topLeading }
        switch s.textAlign {
        case Registry.TextAlign.center: return .center
        case Registry.TextAlign.end: return .trailing
        default: return .leading
        }
    }

    @ViewBuilder
    private func content(_ s: ZnNodeSpec) -> some View {
        switch s.type {
        case Registry.Component.column, Registry.Component.box, Registry.Component.pressable, Registry.Component.fragment:
            flex(s, vertical: true)
        case Registry.Component.sheet:
            if sheetBody { flex(s, vertical: true) } else { ZnSheetHost(ctx: ctx, t: t, inst: inst, s: s) }
        case Registry.Component.row:
            flex(s, vertical: false)
        case Registry.Component.stack:
            ZStack(alignment: .topLeading) {
                ForEach(znChildRefs(ctx, t, inst, s.children)) { ref in
                    ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node,
                               outer: ZnOuter(fillWidth: definiteWidth && ref.t.nodes[ref.node].width == nil),
                               definiteWidth: definiteWidth)
                }
            }
        case Registry.Component.scroll:
            ScrollView(s.props[Registry.Prop.horizontal]?.bool == true ? .horizontal : .vertical) {
                flex(s, vertical: s.props[Registry.Prop.horizontal]?.bool != true)
            }
        case Registry.Component.text:
            ZnTextView(s: s, inst: inst)
        case Registry.Component.list:
            ZnListView(ctx: ctx, inst: inst, s: s)
        case Registry.Component.textField:
            ZnTextFieldView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.icon:
            ZnIconView(s: s, inst: inst)
        case Registry.Component.image:
            ZnImageView(s: s, inst: inst)
        case Registry.Component.spacer:
            Color.clear.frame(width: 0, height: 0)
        case Registry.Component.anchor, Registry.Component.modal,
             Registry.Component.statusBar, Registry.Component.navigationBar:
            EmptyView()  // anchors are expanded by the parent; the rest take no room here (not drawn on iOS yet)
        default:
            ZnMissing(type: s.type)
        }
    }

    /// Column (vertical) or Row: the children with their flex, stretch and alignSelf (ZnRenderer.kt ZnColumn / Row).
    private func flex(_ s: ZnNodeSpec, vertical: Bool) -> some View {
        let definiteHeight = s.height != nil || outer.fillHeight
        let refs = znChildRefs(ctx, t, inst, s.children)
        let stretchAll = s.alignItems == -1 || s.alignItems == Registry.AlignItems.stretch
        return ZnFlexLayout(vertical: vertical, justify: s.justify, alignItems: s.alignItems, gap: s.gap,
                            definiteWidth: definiteWidth || s.width != nil, definiteHeight: definiteHeight) {
            ForEach(refs) { ref in
                let child = ref.t.nodes[ref.node]
                let (outer, childDefinite) = childLayout(s, child, vertical: vertical, stretchAll: stretchAll)
                ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node, outer: outer, definiteWidth: childDefinite)
                    .layoutValue(key: ZnFlexKey.self, value: child.flex)
                    .layoutValue(key: ZnAlignSelfKey.self, value: child.alignSelf)
            }
        }
    }

    /// What a Column / Row tells one child: what to fill, and whether its width is definite.
    private func childLayout(_ s: ZnNodeSpec, _ child: ZnNodeSpec, vertical: Bool, stretchAll: Bool) -> (ZnOuter, Bool) {
        let selfStretch = child.alignSelf == -1 || child.alignSelf == Registry.AlignSelf.stretch
        if vertical {
            // zn flex rule 4: a Column stretches children without a width only when its own width is definite.
            let stretched = (definiteWidth || s.width != nil) && stretchAll && child.width == nil &&
                child.type != Registry.Component.spacer && selfStretch
            return (ZnOuter(fillWidth: stretched, fillHeight: child.flex > 0), stretched || child.width != nil)
        }
        // A Row stretches children only when it has a fixed height.
        let stretched = s.alignItems == Registry.AlignItems.stretch && s.height != nil && child.height == nil
        return (ZnOuter(fillWidth: child.flex > 0, fillHeight: stretched), child.width != nil || child.flex > 0)
    }
}

/// Size: width / height / min / max, and the fill a parent asked for. Percent sizes fill (spike: not a fraction yet).
struct ZnSizeFrame: ViewModifier {
    let s: ZnNodeSpec
    let outer: ZnOuter
    let alignment: Alignment

    func body(content: Content) -> some View {
        let w: CGFloat? = if case .points(let v) = s.width { v } else { nil }
        let h: CGFloat? = if case .points(let v) = s.height { v } else { nil }
        let fillW = (outer.fillWidth && s.width == nil) || { if case .percent = s.width { true } else { false } }()
        let fillH = (outer.fillHeight && s.height == nil) || { if case .percent = s.height { true } else { false } }()
        content
            .frame(width: w, height: h, alignment: alignment)
            .frame(minWidth: s.minWidth, maxWidth: fillW ? .infinity : s.maxWidth,
                   minHeight: s.minHeight, maxHeight: fillH ? .infinity : s.maxHeight, alignment: alignment)
    }
}

/// Clip, border, background and opacity. A background slot is read only in ZnBackground (a change redraws it alone).
struct ZnPaint: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: s.radius, style: .circular)
        content
            .clipShape(s.clip ? AnyShape(shape) : AnyShape(Rectangle().inset(by: -1e6)))
            .overlay {
                if s.borderWidth > 0 { shape.strokeBorder(s.borderColor, lineWidth: s.borderWidth) }
            }
            .overlay(alignment: .bottom) {
                if s.borderBottomWidth > 0 { Rectangle().fill(s.borderColor).frame(height: s.borderBottomWidth) }
            }
            .overlay(alignment: .top) {
                if s.borderTopWidth > 0 { Rectangle().fill(s.borderColor).frame(height: s.borderTopWidth) }
            }
            .background { ZnBackground(s: s, inst: inst, shape: shape) }
            .modifier(ZnOpacity(s: s, inst: inst))
    }
}

struct ZnBackground: View {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let shape: RoundedRectangle

    var body: some View {
        let _ = ZnDebug.hit(name: "Background", inst: inst, node: s.index)
        let color = s.backgroundSlot >= 0 ? znColor(inst.slot(s.backgroundSlot).value) : s.background
        if let color { shape.fill(color) }
    }
}

struct ZnOpacity: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        let _ = ZnDebug.hit(name: "Opacity", inst: inst, node: s.index)
        let o = s.opacitySlot >= 0 ? (inst.slot(s.opacitySlot).value.number ?? 1) : s.opacity
        content.opacity(o)
    }
}

struct ZnTextView: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let _ = ZnDebug.hit(name: "TextLeaf", inst: inst, node: s.index)
        let value = s.textSlot >= 0 ? znDisplay(inst.slot(s.textSlot).value) : (s.text ?? "")
        let color = s.colorSlot >= 0 ? (znColor(inst.slot(s.colorSlot).value) ?? .black) : (s.color ?? .black)
        Text(value)
            .font(.system(size: s.fontSize, weight: znWeight(s.fontWeight)))
            .kerning(s.letterSpacing ?? 0)
            .foregroundStyle(color)
            .multilineTextAlignment(s.textAlign == Registry.TextAlign.center ? .center
                                    : s.textAlign == Registry.TextAlign.end ? .trailing : .leading)
            .lineLimit(s.maxLines)
    }
}

struct ZnIconView: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let _ = ZnDebug.hit(name: "IconLeaf", inst: inst, node: s.index)
        let color = s.colorSlot >= 0 ? (znColor(inst.slot(s.colorSlot).value) ?? .black) : (s.color ?? .black)
        let sized = s.width == nil && s.height == nil
        Canvas { g, size in
            guard let icon = s.icon else { return }
            let tr = CGAffineTransform(scaleX: size.width / icon.width, y: size.height / icon.height)
                .translatedBy(x: -icon.minX, y: -icon.minY)
            g.fill(icon.path.applying(tr), with: .color(color))
        }
        .frame(width: sized ? 24 : nil, height: sized ? 24 : nil)
    }
}

struct ZnImageView: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let _ = ZnDebug.hit(name: "ImageLeaf", inst: inst, node: s.index)
        let src = s.srcSlot >= 0 ? inst.slot(s.srcSlot).value.string : s.src
        if let src, let url = URL(string: src), url.scheme?.hasPrefix("http") == true {
            AsyncImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFill() } else { Color.gray.opacity(0.15) }
            }
            .clipped()
        } else {
            Color.gray.opacity(0.15)
        }
    }
}

/// A component this spike doesn't draw yet: a visible marker in debug builds, nothing in release.
struct ZnMissing: View {
    let type: Int
    var body: some View {
        #if DEBUG
        Text("⟨\(ZnDebug.componentName(type))⟩").font(.system(size: 10)).foregroundStyle(.red)
        #else
        EmptyView()
        #endif
    }
}

func znDisplay(_ v: ZnValue) -> String {
    switch v {
    case .null: return ""
    case .string(let s): return s
    case .bool(let b): return b ? "true" : "false"
    case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
    default: return ""
    }
}

func znWeight(_ w: Int?) -> Font.Weight {
    switch w ?? 400 {
    case ..<150: return .ultraLight
    case ..<250: return .thin
    case ..<350: return .light
    case ..<450: return .regular
    case ..<550: return .medium
    case ..<650: return .semibold
    case ..<750: return .bold
    case ..<850: return .heavy
    default: return .black
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
