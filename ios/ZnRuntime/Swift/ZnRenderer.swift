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

/// [znChildRefs] without the children that have display: "none" (written, or from a slot), as Android's shownRefs:
/// a Column / Row / Stack leaves them out, so the gaps around them go too, as in RN. Reading a child's display slot
/// here makes the parent follow it (display changes are rare).
@MainActor
func znShownRefs(_ ctx: ZnContext, _ t: ZnTemplate, _ inst: ZnInstance, _ children: [Int]) -> [ZnChildRef] {
    znChildRefs(ctx, t, inst, children).filter { !$0.t.nodes[$0.node].displayNoneNow($0.inst) }
}

/// Each child's flex now, for the children whose flex comes from a slot (by ZnChildRef.id). Read in the parent's body,
/// so a change lays the parent out again, as Android's weight read in the parent.
@MainActor
func znSlotFlexes(_ refs: [ZnChildRef]) -> [String: CGFloat] {
    var out: [String: CGFloat] = [:]
    for r in refs where r.t.nodes[r.node].flexSlot >= 0 { out[r.id] = r.t.nodes[r.node].flexNow(r.inst) }
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
        // display: "none" (written, or from a slot): no room and nothing drawn, for the parents that don't leave it out
        // themselves (a Scroll's content, pages, list rows, a screen's root), as Android lays it out 0 x 0.
        if s.displayNoneNow(inst) {
            EmptyView()
        } else {
            node(s).modifier(ZnChildTraits(s: s, inst: inst))
        }
    }

    @ViewBuilder
    private func node(_ s: ZnNodeSpec) -> some View {
        if s.isPressable {
            ZnPressable(ctx: ctx, s: s, inst: inst) { inner(s) }
                .modifier(ZnOnLayout(ctx: ctx, s: s, inst: inst))
                .padding(s.marginInsets(inst))
                .modifier(ZnPointerEventsNone(s: s, inst: inst))
        } else {
            inner(s).modifier(ZnOnLayout(ctx: ctx, s: s, inst: inst)).padding(s.marginInsets(inst))
                .modifier(ZnPointerEventsNone(s: s, inst: inst))
        }
    }

    @ViewBuilder
    private func inner(_ s: ZnNodeSpec) -> some View {
        if (s.type == Registry.Component.sheet || s.type == Registry.Component.modal) && !sheetBody {
            content(s)  // the sheet itself is presented; here it takes no room
        } else {
            styled(s)
        }
    }

    @ViewBuilder
    private func styled(_ s: ZnNodeSpec) -> some View {
        content(s)
            .modifier(ZnPointerEventsKids(s: s, inst: inst))
            // A List's and a Carousel's padding is inside their scroll (content padding), not around them.
            .padding(s.type == Registry.Component.list || s.type == Registry.Component.carousel ? EdgeInsets()
                     : s.type == Registry.Component.scroll ? s.borderInsets(inst) : s.contentInsets(inst))
            .modifier(ZnLayoutSpace(s: s, inst: inst))
            .modifier(ZnSizeFrame(s: s, inst: inst, outer: outer, alignment: contentAlignment(s)))
            .modifier(ZnFieldBoxTap(s: s, inst: inst))
            .modifier(ZnPaint(s: s, inst: inst))
    }

    private func contentAlignment(_ s: ZnNodeSpec) -> Alignment {
        // A one-line field in a taller box (height, minHeight, a stretch): text and cursor in the middle, as RN and
        // Android (B4, 2026-11-12: they were at the top). A multiline one starts at the top.
        if s.type == Registry.Component.textField { return s.multiline ? .topLeading : .leading }
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
        case Registry.Component.modal:
            if sheetBody { flex(s, vertical: true) } else { ZnModalHost(ctx: ctx, t: t, inst: inst, s: s) }
        case Registry.Component.row:
            if s.flexWrap { wrap(s) } else { flex(s, vertical: false) }
        case Registry.Component.stack:
            stack(s)
        case Registry.Component.scroll:
            // The padding scrolls with the content (Android: the scroll's content padding), so nothing is clipped at
            // the edges and the last item can scroll clear of a floating button.
            // A vertical Scroll with no height that doesn't fill (no flex, no stretch) is as tall as its content, up to
            // what it is offered (its maxHeight, the space left): Compose's verticalScroll Column. A SwiftUI ScrollView
            // takes all it is offered, so ZeroBill's checkout offers sheet (`maxHeight: 400`, one or two rows) was
            // 400 tall with an empty band (2026-11-09).
            let hug = s.props[Registry.Prop.horizontal]?.bool != true && !s.hasHeight && !outer.fillHeight
            ZnScrollHugLayout(hug: hug) {
            ScrollView(s.props[Registry.Prop.horizontal]?.bool == true ? .horizontal : .vertical) {
                flex(s, vertical: s.props[Registry.Prop.horizontal]?.bool != true)
                    .padding(s.paddingInsets(inst))
                    .background {
                        // Pull to refresh (ZnTabsRefresh.swift): finds this scroll view from inside it.
                        if s.hasRefresh && s.props[Registry.Prop.horizontal]?.bool != true {
                            ZnScrollRefresh(ctx: ctx, s: s, inst: inst, refreshing: s.refreshingNow(inst))
                        }
                    }
            }
            }
        case Registry.Component.text:
            ZnTextView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.carousel:
            ZnCarouselView(ctx: ctx, t: t, inst: inst, s: s)
        case Registry.Component.list:
            ZnListView(ctx: ctx, inst: inst, s: s)
        case Registry.Component.textField:
            ZnTextFieldView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.nativeView:
            ZnNativeViewNode(ctx: ctx, s: s, inst: inst,
                             props: s.viewPropsSlot >= 0 ? inst.slot(s.viewPropsSlot).value.string : s.viewProps)
        case Registry.Component.tabs:
            ZnTabsView(ctx: ctx, t: t, inst: inst, s: s)
        case Registry.Component.otpInput:
            ZnOtpInputView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.switch:
            ZnSwitchView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.checkbox:
            ZnCheckboxView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.spinner:
            ZnSpinnerView(s: s, inst: inst)
        case Registry.Component.progress:
            ZnProgressView(s: s, inst: inst)
        case Registry.Component.svg:
            ZnSvgView(ctx: ctx, t: t, inst: inst, s: s)
        case Registry.Component.svgPart:
            EmptyView()  // read by its <Svg> (ZnSvgView), never drawn on its own
        case Registry.Component.icon:
            ZnIconView(s: s, inst: inst)
        case Registry.Component.image:
            ZnImageView(ctx: ctx, s: s, inst: inst)
        case Registry.Component.shimmer:
            ZnShimmerView(s: s)
        case Registry.Component.spacer:
            Color.clear.frame(width: 0, height: 0)
        case Registry.Component.statusBar, Registry.Component.navigationBar:
            ZnBarElement(s: s, inst: inst, navigation: s.type == Registry.Component.navigationBar)
        case Registry.Component.anchor:
            EmptyView()  // anchors are expanded by the parent
        default:
            ZnMissing(type: s.type)
        }
    }

    /// Stack: normal children on top of each other, placed by alignItems / justifyContent; absolute children by
    /// their insets (ZnStackLayout). Same rules as android/runtime's ZnRenderer.kt STACK.
    private func stack(_ s: ZnNodeSpec) -> some View {
        // A normal child stretches to the Stack's width like a Column's (zn flex rule 4, RN's alignItems: 'stretch').
        let stretchAll = s.alignItems == -1 || s.alignItems == Registry.AlignItems.stretch
        let stretch = definiteWidth || s.hasWidth
        // An aspectRatio box is given both sides (ZnSizeFrame): its Stack fills them, so bottom / end children sit at
        // its bottom and end.
        let ratio = s.hasAspectRatio
        let (minW, minH) = innerMin(s)
        return ZnStackLayout(alignItems: s.alignItems, justify: s.justify,
                             fillWidth: outer.fillWidth || s.hasWidth || ratio,
                             fillHeight: outer.fillHeight || s.hasHeight || ratio, minWidth: minW, minHeight: minH) {
            ForEach(znShownRefs(ctx, t, inst, s.children)) { ref in
                let child = ref.t.nodes[ref.node]
                // An inset from a slot counts as set (its value may come later), as on Android.
                let fillW = child.absolute && child.hasPosStart && child.hasPosEnd
                let fillH = child.absolute && child.hasPosTop && child.hasPosBottom
                // alignSelf stretch stretches even when alignItems doesn't (RN; layout conformance case 27).
                let stretched = !child.absolute && stretch && !child.hasWidth && child.type != Registry.Component.spacer &&
                    (child.alignSelf == Registry.AlignSelf.stretch || (child.alignSelf == -1 && stretchAll))
                // The insets and a "%" size are set by the child itself (ZnChildTraits), so moving it re-places it alone.
                ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node,
                           outer: ZnOuter(fillWidth: stretched || fillW, fillHeight: fillH),
                           definiteWidth: stretched || child.hasWidth || fillW)
                    .zIndex(child.zIndex ?? 0)
            }
        }
    }

    /// Column (vertical) or Row: the children with their flex, stretch and alignSelf (ZnRenderer.kt ZnColumn / Row).
    private func flex(_ s: ZnNodeSpec, vertical: Bool) -> some View {
        // An absolute Row pinned top and bottom has a set height too, as in RN (ZnRenderer.kt pinnedH).
        let definiteHeight = s.hasHeight || outer.fillHeight || s.hasAspectRatio || pinnedHeight(s)
        let refs = znShownRefs(ctx, t, inst, s.children)
        let flexes = znSlotFlexes(refs)
        let stretchAll = s.alignItems == -1 || s.alignItems == Registry.AlignItems.stretch
        let (minW, minH) = innerMin(s)
        return ZnFlexLayout(vertical: vertical, justify: s.justify, alignItems: s.alignItems, gap: s.gapNow(inst),
                            definiteWidth: definiteWidth || s.hasWidth, definiteHeight: definiteHeight,
                            minWidth: minW, minHeight: minH) {
            ForEach(refs) { ref in
                let child = ref.t.nodes[ref.node]
                let flex = flexes[ref.id] ?? child.flex
                let (outer, childDefinite) = childLayout(s, child, flex: flex, vertical: vertical, stretchAll: stretchAll)
                ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node, outer: outer, definiteWidth: childDefinite)
                    .layoutValue(key: ZnFlexKey.self, value: flex)
                    .layoutValue(key: ZnAlignSelfKey.self, value: child.alignSelf)
                    .zIndex(child.zIndex ?? 0)  // R23: a row with zIndex draws its tooltip over the rows after it
            }
        }
    }

    /// minWidth / minHeight inside the padding and border (RN's min counts them): what a container's own layout is
    /// raised to, so its children are aligned in the raised box, not at its top.
    private func innerMin(_ s: ZnNodeSpec) -> (CGFloat, CGFloat) {
        if s.type == Registry.Component.scroll { return (0, 0) }  // its content scrolls; the min is the viewport's
        let i = s.contentInsets(inst)
        return (max(0, (s.minWidthNow(inst) ?? 0) - i.leading - i.trailing), max(0, (s.minHeightNow(inst) ?? 0) - i.top - i.bottom))
    }

    private func pinnedHeight(_ s: ZnNodeSpec) -> Bool { s.absolute && s.hasPosTop && s.hasPosBottom }

    /// A Row with flexWrap "wrap" (registry 24): ZnWrapLayout, ZnRenderer.kt ZnWrapRow. A child stretches to its line's
    /// height only when stretch is written (alignItems or alignSelf) and it has no height; a flex child fills the share
    /// of its line the layout gives it.
    private func wrap(_ s: ZnNodeSpec) -> some View {
        let gap = s.gapNow(inst)
        let refs = znShownRefs(ctx, t, inst, s.children)
        let flexes = znSlotFlexes(refs)
        return ZnWrapLayout(justify: s.justify, alignItems: s.alignItems, alignContent: s.alignContent, gap: gap,
                            crossGap: s.crossGapNow(inst) ?? gap, definiteWidth: definiteWidth || s.hasWidth,
                            definiteHeight: s.hasHeight || outer.fillHeight, minHeight: innerMin(s).1) {
            ForEach(refs) { ref in
                let child = ref.t.nodes[ref.node]
                let flex = flexes[ref.id] ?? child.flex
                let stretch = !child.hasHeight && (child.alignSelf == Registry.AlignSelf.stretch ||
                    (child.alignSelf == -1 && s.alignItems == Registry.AlignItems.stretch))
                ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node,
                           outer: ZnOuter(fillWidth: flex > 0, fillHeight: stretch),
                           definiteWidth: child.hasWidth || flex > 0)
                    .layoutValue(key: ZnFlexKey.self, value: flex)
                    .layoutValue(key: ZnAlignSelfKey.self, value: child.alignSelf)
                    .layoutValue(key: ZnStretchKey.self, value: stretch)
                    .zIndex(child.zIndex ?? 0)
            }
        }
    }

    /// What a Column / Row tells one child: what to fill, and whether its width is definite.
    /// [flex] is the child's flex now (a slot's value, or the template's). A size from a slot counts as set.
    private func childLayout(_ s: ZnNodeSpec, _ child: ZnNodeSpec, flex: CGFloat, vertical: Bool, stretchAll: Bool) -> (ZnOuter, Bool) {
        let selfStretch = child.alignSelf == -1 || child.alignSelf == Registry.AlignSelf.stretch
        if vertical {
            // zn flex rule 4: a Column stretches children without a width only when its own width is definite.
            // alignSelf stretch stretches even when alignItems doesn't (RN; layout conformance case 19).
            let stretched = (definiteWidth || s.hasWidth) && !child.hasWidth && child.type != Registry.Component.spacer &&
                (child.alignSelf == Registry.AlignSelf.stretch || (stretchAll && selfStretch))
            return (ZnOuter(fillWidth: stretched, fillHeight: flex > 0), stretched || child.hasWidth)
        }
        // A Row stretches children only when it has a fixed height (or is pinned top and bottom in a Stack).
        // With a fixed height: alignItems stretch, or the child's own alignSelf stretch (case 28).
        let stretched = (s.hasHeight || pinnedHeight(s)) && !child.hasHeight &&
            (child.alignSelf == Registry.AlignSelf.stretch || (child.alignSelf == -1 && s.alignItems == Registry.AlignItems.stretch))
        return (ZnOuter(fillWidth: flex > 0, fillHeight: stretched), child.hasWidth || flex > 0)
    }
}

/// Size: width / height / min / max / aspectRatio, and the fill a parent asked for. Values from slots are read here, in
/// this modifier's own body, so a change (an animated width) lays this node out again without running its view or its
/// parent's again: SwiftUI's form of Android reading them in the layout phase (dynamicSize in ZnRenderer.kt).
struct ZnSizeFrame: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let outer: ZnOuter
    let alignment: Alignment

    /// Set sizes in points, with aspectRatio giving the other side from the one that is set (width / height = ratio).
    private func points(_ width: ZnSize?, _ height: ZnSize?, _ ratio: CGFloat?) -> (CGFloat?, CGFloat?, CGFloat?, CGFloat?) {
        var w: CGFloat? = if case .points(let v) = width { v } else { nil }
        var h: CGFloat? = if case .points(let v) = height { v } else { nil }
        let wf: CGFloat? = if case .percent(let f) = width { f } else { nil }
        let hf: CGFloat? = if case .percent(let f) = height { f } else { nil }
        if let r = ratio {
            if let ww = w, h == nil, hf == nil { h = ww / r } else if let hh = h, w == nil, wf == nil { w = hh * r }
        }
        return (w.map { max($0, 0) }, h.map { max($0, 0) }, wf, hf)
    }

    func body(content: Content) -> some View {
        let width = s.widthNow(inst), height = s.heightNow(inst)
        let minWidth = s.minWidthNow(inst), maxWidth = s.maxWidthNow(inst)
        let minHeight = s.minHeightNow(inst), maxHeight = s.maxHeightNow(inst)
        let aspect = s.aspectRatioNow(inst)
        let (w, h, wf, hf) = points(width, height, aspect)
        // A percent fills what its parent offers (the parent takes the fraction: ZnPercentKey).
        let fillW = (outer.fillWidth && width == nil) || wf != nil
        let fillH = (outer.fillHeight && height == nil) || hf != nil
        // A fill (stretch, flex) still stops at maxWidth / maxHeight; a min beats a max (RN), and SwiftUI wants min <= max.
        let minW = minWidth.map { max($0, 0) }, minH = minHeight.map { max($0, 0) }
        let maxW = maxWidth.map { max($0, minW ?? 0, 0) }, maxH = maxHeight.map { max($0, minH ?? 0, 0) }
        // aspectRatio with no side in points gives one side from the other: the width it is offered (set by a stretch,
        // a flex or a "%" width), or a "%" height alone. Its content then fills that size (a Stack's absolute children
        // are placed in it: ZeroBill's scanner window, width "75%" + aspectRatio 1, was 0 tall with its corners on one
        // line, 2026-11-09).
        let ratio: CGFloat? = w == nil && h == nil && !(wf != nil && hf != nil) ? aspect : nil
        let bounds = ZnMinMaxLayout(minW: minW, maxW: maxW, minH: minH, maxH: maxH,
                                    fillW: fillW || ratio != nil, fillH: fillH || ratio != nil, alignment: alignment)
        content
            .frame(width: w, height: h, alignment: alignment)
            .modifier(ZnMinMaxFrame(layout: bounds))
            .modifier(ZnRatioFrame(ratio: ratio, fromHeight: wf == nil && hf != nil,
                                   minW: minW, maxW: maxW, minH: minH, maxH: maxH))
    }
}

/// minWidth / maxWidth / minHeight / maxHeight and a fill, with RN's (Yoga's) meaning, as android/runtime's
/// widthIn / heightIn: a max only caps the size and a min only raises it. SwiftUI's own `.frame(maxWidth: 190)` grows a
/// view to 190 when it is offered more, so a Text with maxWidth took 190 points whatever it said (ZeroBill's store pill
/// on Offer Details squeezed the price pill beside it to three lines).
/// - A fill (stretch, flex) takes what it is offered, kept between min and max.
/// - Otherwise the child is offered at most max and keeps its own size, kept between min and max.
/// A child smaller than its box (a min above its size) is placed by the node's content alignment.
struct ZnMinMaxLayout: Layout {
    var minW: CGFloat?, maxW: CGFloat?, minH: CGFloat?, maxH: CGFloat?
    var fillW: Bool, fillH: Bool
    var alignment: Alignment

    var needed: Bool { minW != nil || maxW != nil || minH != nil || maxH != nil || fillW || fillH }

    private static func clamp(_ v: CGFloat, _ lo: CGFloat?, _ hi: CGFloat?) -> CGFloat {
        var r = v
        if let hi { r = min(r, hi) }
        if let lo { r = max(r, lo) }  // a min beats a max (RN); ZnSizeFrame already raised max to min
        return r
    }

    private static func finite(_ v: CGFloat?) -> CGFloat? { v.flatMap { $0.isFinite ? $0 : nil } }

    /// What the child is offered on one axis: the fill's size, or the offer capped at max.
    private static func offer(_ p: CGFloat?, fill: Bool, lo: CGFloat?, hi: CGFloat?) -> CGFloat? {
        guard let p = finite(p) else { return hi }
        return fill ? clamp(p, lo, hi) : min(p, hi ?? p)
    }

    private func axes(_ proposal: ProposedViewSize, _ child: LayoutSubview) -> CGSize {
        let ow = Self.offer(proposal.width, fill: fillW, lo: minW, hi: maxW)
        let oh = Self.offer(proposal.height, fill: fillH, lo: minH, hi: maxH)
        let fit = child.sizeThatFits(ProposedViewSize(width: ow, height: oh))
        let w = fillW && ow != nil ? ow! : Self.clamp(fit.width, minW, maxW)
        let h = fillH && oh != nil ? oh! : Self.clamp(fit.height, minH, maxH)
        return CGSize(width: w, height: h)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        return axes(proposal, child)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let offer = ProposedViewSize(width: bounds.width, height: bounds.height)
        let s = child.sizeThatFits(offer)
        let cw = min(s.width, bounds.width), ch = min(s.height, bounds.height)
        let h = alignment.horizontal, v = alignment.vertical
        let x = h == .center ? bounds.midX - cw / 2 : h == .trailing ? bounds.maxX - cw : bounds.minX
        let y = v == .center ? bounds.midY - ch / 2 : v == .bottom ? bounds.maxY - ch : bounds.minY
        child.place(at: CGPoint(x: x, y: y), proposal: offer)
    }
}

/// A vertical Scroll that hugs its content (see the scroll case in content()): a ScrollView's ideal height (asked with no
/// height) is its content's, so the Scroll takes that, up to the height it is offered. Without hug it is the ScrollView
/// as it is.
struct ZnScrollHugLayout: Layout {
    var hug: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        guard hug else { return child.sizeThatFits(proposal) }
        let ideal = child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        var h = ideal.height
        if let p = proposal.height, p.isFinite { h = min(h, p) }
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? ideal.width
        return CGSize(width: w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}

struct ZnMinMaxFrame: ViewModifier {
    let layout: ZnMinMaxLayout

    func body(content: Content) -> some View {
        if layout.needed { layout { content } } else { content }
    }
}

/// An aspectRatio with neither side set: the width the parent offers (a stretch, a flex) gives the height. Asking again
/// with the size it answered gives the same size, so a re-proposal at placement is safe.
struct ZnRatioFrame: ViewModifier {
    let ratio: CGFloat?
    /// The height is the given side (a "%" height and no width): the width follows it.
    var fromHeight = false
    /// The node's min / max: the side given by the ratio stays inside them (Android's dynamicSize clamps it).
    var minW: CGFloat? = nil, maxW: CGFloat? = nil, minH: CGFloat? = nil, maxH: CGFloat? = nil

    func body(content: Content) -> some View {
        if let ratio, ratio > 0 {
            ZnRatioLayout(ratio: ratio, fromHeight: fromHeight, minW: minW, maxW: maxW, minH: minH, maxH: maxH) { content }
        } else {
            content
        }
    }
}

struct ZnRatioLayout: Layout {
    let ratio: CGFloat
    var fromHeight = false
    var minW: CGFloat? = nil, maxW: CGFloat? = nil, minH: CGFloat? = nil, maxH: CGFloat? = nil

    private static func clamp(_ v: CGFloat, _ lo: CGFloat?, _ hi: CGFloat?) -> CGFloat {
        var r = v
        if let hi { r = min(r, hi) }
        if let lo { r = max(r, lo) }
        return r
    }

    /// The known side keeps its size; the other is ratio-derived and kept between its min and max (a maxHeight caps a
    /// wide box's height, as Compose's aspectRatio inside heightIn on Android).
    private func size(_ p: ProposedViewSize, _ child: LayoutSubview) -> CGSize {
        if fromHeight, let h = p.height, h.isFinite { return CGSize(width: Self.clamp(h * ratio, minW, maxW), height: h) }
        if let w = p.width, w.isFinite { return CGSize(width: w, height: Self.clamp(w / ratio, minH, maxH)) }
        let fit = child.sizeThatFits(p)
        return CGSize(width: fit.width, height: Self.clamp(fit.width / ratio, minH, maxH))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        return size(proposal, child)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// Clip, border, background and opacity. A background slot is read only in ZnBackground (a change redraws it alone).
struct ZnPaint: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        // A node's animate / enter / exit never change, so the branches don't swap at runtime.
        Group {
            if s.animate?.selfPlaying == true {
                content.modifier(ZnPaintPlaying(s: s, inst: inst))
            } else {
                content.modifier(ZnPaintLayers(s: s, inst: inst, motion: nil))
            }
        }
        .modifier(ZnEnterExitIfAny(s: s, inst: inst))
    }
}

struct ZnEnterExitIfAny: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.enter != nil || (s.index == 0 && s.exit != nil) {
            content.modifier(ZnEnterExit(s: s, inst: inst))
        } else {
            content
        }
    }
}

/// Background, borders, clip, then the layer (opacity and transforms) over all of them, as android/runtime's chain:
/// transform + opacity → shadow → background → border → clip.
struct ZnPaintLayers: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let motion: ZnMotion?
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        // Corners from slots are read here: a change redraws this node's paint alone.
        let shape = s.shapeNow(inst)
        // Images and shimmers clip to their rounded shape by default, as in RN (and Android). One whose corners come
        // from a slot always clips (to a square when they are 0), so the branch never swaps and the picture never reloads.
        let picture = s.type == Registry.Component.image || s.type == Registry.Component.shimmer
        let clips = s.clip || (picture && (s.hasDynamicRadius || s.rounded))
        content
            .modifier(ZnClip(clip: clips, shape: shape))
            .overlay { ZnBorder(s: s, inst: inst, shape: shape) }
            .background {
                // Top / bottom lines go under the children, over the background (Android draws them behind content:
                // a child that stands out over the line, like a raised Scan button, covers it).
                ZStack {
                    ZnBackground(s: s, inst: inst, shape: shape, motion: motion)
                    ZnSideBorders(s: s, inst: inst)
                }
                // A background takes no taps of its own: a tap goes through to what is under it, as on Android, where
                // an element without handlers isn't a hit target (before 2026-11-21 any background stopped taps on iOS).
                .allowsHitTesting(false)
            }
            .background {
                // pointerEvents "auto" / "box-only", or an absolute layer without pointerEvents: the box stops taps
                // here, so a Pressable under it gets none, as a React Native view (ZnTouch.kt znBlockTouches).
                if znStopsTaps(s, inst, touchOff: touchOff) { Color.clear.contentShape(shape) }
            }
            .modifier(ZnLayer(s: s, inst: inst, motion: motion))
    }
}

/// Does [s] stop taps on its own box (ZnNode in ZnRenderer.kt)? pointerEvents "auto" or "box-only" written, or not
/// written on an absolute layer (ZnNodeSpec.absoluteLayer); never inside pointerEvents "none".
@MainActor func znStopsTaps(_ s: ZnNodeSpec, _ inst: ZnInstance, touchOff: Bool) -> Bool {
    if touchOff { return false }
    let pe = s.pointerEventsNow(inst)
    return pe == Registry.PointerEvents.auto || pe == Registry.PointerEvents.boxOnly ||
        (pe == znPointerEventsUnset && s.absoluteLayer)
}

/// pointerEvents "none" on a node (written, or from a slot): neither it nor anything inside takes a tap, so it goes to
/// what is under it. Pressables inside hide their touch views (znTouchOff), as Android's LocalTouchOff.
struct ZnPointerEventsNone: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        if s.pointerEvents == znPointerEventsUnset && s.pointerEventsSlot < 0 {
            content  // the usual case: nothing written, no slot (never changes at runtime)
        } else {
            let none = s.pointerEventsNow(inst) == Registry.PointerEvents.none
            content.allowsHitTesting(!none).environment(\.znTouchOff, touchOff || none)
        }
    }
}

/// pointerEvents "box-only": the node takes taps, its children don't (Android passes LocalTouchOff to them).
struct ZnPointerEventsKids: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        if s.pointerEvents == znPointerEventsUnset && s.pointerEventsSlot < 0 {
            content
        } else {
            let boxOnly = s.pointerEventsNow(inst) == Registry.PointerEvents.boxOnly
            content.allowsHitTesting(!boxOnly).environment(\.znTouchOff, touchOff || boxOnly)
        }
    }
}

/// What a child tells its parent's layout, set by the child itself (outermost, so the parent's Layout sees it): its
/// "%" size and, in a Stack, its absolute insets. Read here, a slot's change (an animated `start`) re-places the child
/// without running the parent's body again.
struct ZnChildTraits: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        content
            .layoutValue(key: ZnPercentKey.self, value: s.percentNow(inst))
            .layoutValue(key: ZnAbsoluteKey.self, value: s.absolute ? ZnAbsolute(s, inst) : nil)
    }
}

/// A node with values that play by themselves (`animate` with from / keyframes): owns their ZnMotion while on
/// screen, starts it when it appears and on each new `replay`, follows `paused`, and plays a `from` again towards
/// a new resting value.
struct ZnPaintPlaying: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @State private var motion = ZnMotion()

    private var timings: [Int: ZnTiming] {
        var out: [Int: ZnTiming] = [:]
        for prop in ZnLayer.animatable { if let t = s.animate?.timing(prop), t.selfPlaying { out[prop] = t } }
        return out
    }

    func body(content: Content) -> some View {
        let rests = ZnLayer.rests(s, inst)
        let paused = s.pausedSlot >= 0 ? inst.slot(s.pausedSlot).value == .bool(true) : s.paused
        let replay = s.replaySlot >= 0 ? inst.slot(s.replaySlot).value : .null
        content
            .modifier(ZnPaintLayers(s: s, inst: inst, motion: motion))
            .onAppear { motion.start(timings, rests: rests, paused: paused) }
            .onDisappear { motion.stop() }
            .onChange(of: replay) { motion.start(timings, rests: rests, paused: paused) }
            .onChange(of: paused) { _, p in motion.setPaused(p) }
            .onChange(of: rests) { _, r in for (prop, v) in r { motion.restChanged(prop, to: v) } }
    }
}

/// Opacity and transforms (scale, scaleX, scaleY, rotate about transformOrigin, then translate), each value from
/// its motion, its slot, or the template. A value with a timing that follows a slot animates to each new value
/// (SwiftUI animation scoped to that modifier). The same order as Compose's graphicsLayer: scale, rotate, translate.
struct ZnLayer: ViewModifier {
    typealias P = Registry.Prop
    let s: ZnNodeSpec
    let inst: ZnInstance
    let motion: ZnMotion?

    static let animatable = [P.opacity, P.scale, P.scaleX, P.scaleY, P.rotate, P.translateX, P.translateY, P.backgroundColor]

    /// Each animatable prop's resting value now (slot or template), for motions that start from or play towards it.
    @MainActor static func rests(_ s: ZnNodeSpec, _ inst: ZnInstance) -> [Int: [Double]] {
        func n(_ slot: Int, _ v: CGFloat) -> [Double] { [slot >= 0 ? inst.slot(slot).value.number ?? Double(v) : Double(v)] }
        let bg = s.backgroundSlot >= 0 ? znColorVector(inst.slot(s.backgroundSlot).value) : znColorVector(s.props[P.backgroundColor])
        return [
            P.opacity: n(s.opacitySlot, CGFloat(s.opacity)), P.scale: n(s.scaleSlot, s.scaleBase),
            P.scaleX: n(s.scaleXSlot, s.scaleXOnly), P.scaleY: n(s.scaleYSlot, s.scaleYOnly),
            P.rotate: n(s.rotateSlot, s.rotate), P.translateX: n(s.translateXSlot, s.translateX),
            P.translateY: n(s.translateYSlot, s.translateY), P.backgroundColor: bg ?? [0, 0, 0, 0],
        ]
    }

    private func value(_ prop: Int, _ slot: Int, _ fixed: CGFloat) -> CGFloat {
        if let m = motion?.values[prop]?.first { return CGFloat(m) }
        return slot >= 0 ? inst.slot(slot).value.number.map { CGFloat($0) } ?? fixed : fixed
    }

    /// The animation for a value that follows its slot; nil: it changes at once.
    private func follow(_ prop: Int) -> Animation? {
        guard let t = s.animate?.timing(prop), !t.selfPlaying else { return nil }
        return t.animation
    }

    func body(content: Content) -> some View {
        let _ = ZnDebug.hit(name: "Layer", inst: inst, node: s.index)
        let opacity = value(P.opacity, s.opacitySlot, CGFloat(s.opacity))
        if !s.hasTransform {
            content.opacity(opacity)
        } else {
            // A scale of exactly 0 is a singular transform: kept just above it (nothing shows either way).
            let sc: (CGFloat) -> CGFloat = { abs($0) < 1e-4 ? 1e-4 : $0 }
            let o = s.origin
            content
                .animation(follow(P.scale)) { $0.scaleEffect(sc(value(P.scale, s.scaleSlot, s.scaleBase)), anchor: o) }
                .animation(follow(P.scaleX)) { $0.scaleEffect(x: sc(value(P.scaleX, s.scaleXSlot, s.scaleXOnly)), y: 1, anchor: o) }
                .animation(follow(P.scaleY)) { $0.scaleEffect(x: 1, y: sc(value(P.scaleY, s.scaleYSlot, s.scaleYOnly)), anchor: o) }
                .animation(follow(P.rotate)) { $0.rotationEffect(.degrees(value(P.rotate, s.rotateSlot, s.rotate)), anchor: o) }
                .animation(follow(P.translateX)) { $0.offset(x: value(P.translateX, s.translateXSlot, s.translateX)) }
                .animation(follow(P.translateY)) { $0.offset(y: value(P.translateY, s.translateYSlot, s.translateY)) }
                .animation(follow(P.opacity)) { $0.opacity(opacity) }
        }
    }
}

/// overflow: hidden. Only when asked: the old way, `clipShape(Rectangle().inset(by: -1e6))` for "no clip", made SwiftUI
/// fill that 2,000,000 pt rectangle with the background of an empty box (the RN props lab's progress bars covered
/// the whole screen, 2026-11-08). A node's clip never changes, so the two branches don't swap at runtime.
struct ZnClip: ViewModifier {
    let clip: Bool
    let shape: UnevenRoundedRectangle

    func body(content: Content) -> some View {
        if clip { content.clipShape(shape) } else { content }
    }
}

/// The border over the content: solid (the shape minus the shape inset by the width), or dashed / dotted (the shape
/// stroked along the middle of the border, RN Android's pattern: dashed 3 widths on and 3 off, dotted 1 and 1), and
/// the top / bottom lines. Width and colour may change at runtime (slots).
struct ZnBorder: View {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let shape: UnevenRoundedRectangle

    var body: some View {
        let w = s.borderWidthNow(inst)
        let color = s.borderColorNow(inst)
        let dash: (CGFloat) -> [CGFloat] = { lw in
            let on = max(s.borderStyle == Registry.BorderStyle.dotted ? lw : 3 * lw, 1)
            return [on, on]
        }
        ZStack {
            if w > 0 {
                if s.borderDashed {
                    shape.inset(by: w / 2).stroke(color, style: StrokeStyle(lineWidth: w, dash: dash(w)))
                } else {
                    shape.strokeBorder(color, lineWidth: w)
                }
            }
        }
        .allowsHitTesting(false)
    }
}

/// borderTopWidth / borderBottomWidth: lines along the edge, drawn behind the children (ZnTemplate.kt drawBehind).
struct ZnSideBorders: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        if s.borderTopWidth > 0 || s.borderBottomWidth > 0 {
            let color = s.borderColorNow(inst)
            let dash: (CGFloat) -> [CGFloat] = { lw in
                let on = max(s.borderStyle == Registry.BorderStyle.dotted ? lw : 3 * lw, 1)
                return [on, on]
            }
            Canvas { g, size in
                for (lw, y) in [(s.borderTopWidth, s.borderTopWidth / 2), (s.borderBottomWidth, size.height - s.borderBottomWidth / 2)] where lw > 0 {
                    var line = Path()
                    line.move(to: CGPoint(x: 0, y: y))
                    line.addLine(to: CGPoint(x: size.width, y: y))
                    g.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: lw, dash: s.borderDashed ? dash(lw) : []))
                }
            }
            .allowsHitTesting(false)
        }
    }
}

struct ZnBackground: View {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let shape: UnevenRoundedRectangle
    let motion: ZnMotion?

    var body: some View {
        let _ = ZnDebug.hit(name: "Background", inst: inst, node: s.index)
        let played = motion?.values[Registry.Prop.backgroundColor].flatMap(znColorFromVector)
        let color = played ?? (s.backgroundSlot >= 0 ? znColor(inst.slot(s.backgroundSlot).value) : s.background)
        let follow = s.animate?.timing(Registry.Prop.backgroundColor).flatMap { $0.selfPlaying ? nil : $0.animation }
        if color != nil || s.gradient != nil {
            ZStack {
                if let color { shape.fill(color) }
                // backgroundImage: a linear gradient over the background colour.
                if let g = s.gradient {
                    Canvas { ctx, size in
                        let (a, b) = g.line(size)
                        ctx.fill(shape.path(in: CGRect(origin: .zero, size: size)),
                                 with: .linearGradient(g.gradient, startPoint: a, endPoint: b))
                    }
                }
            }
            // elevation: Android's material shadow, drawn here as a soft shadow below (y = elevation / 2, blur =
            // elevation, 20 % of shadowColor); only under a background, as nothing else has a shape to cast it.
            .shadow(color: s.elevation > 0 ? s.shadowColor.opacity(0.2) : .clear, radius: s.elevation, x: 0, y: s.elevation / 2)
            .animation(follow, value: s.backgroundSlot >= 0 ? znColorVector(inst.slot(s.backgroundSlot).value) : nil)
        }
    }
}

/// A CSS linear gradient from the compiler's "angle|argb@position|..." (position 0–1, or -1 = spread evenly), as
/// ZnGradient in ZnTemplate.kt. Angles as in CSS: 0deg points up, 90deg right, 180deg down.
struct ZnGradient {
    let angle: Double
    let gradient: Gradient

    static func parse(_ spec: String) -> ZnGradient? {
        let parts = spec.split(separator: "|").map(String.init)
        guard let angle = parts.first.flatMap(Double.init) else { return nil }
        let raw: [(Color, Double)] = parts.dropFirst().compactMap { stop in
            let p = stop.split(separator: "@")
            guard p.count == 2, let argb = Int64(p[0]), let c = znColor(.color(UInt32(truncatingIfNeeded: argb))) else { return nil }
            return (c, Double(p[1]) ?? -1)
        }
        guard raw.count >= 2 else { return nil }
        let stops = raw.enumerated().map { i, r in
            Gradient.Stop(color: r.0, location: r.1 >= 0 ? r.1 : Double(i) / Double(raw.count - 1))
        }
        return ZnGradient(angle: angle, gradient: Gradient(stops: stops))
    }

    /// The gradient line for a box of [size]: through the centre, long enough to reach the corners.
    func line(_ size: CGSize) -> (CGPoint, CGPoint) {
        let rad = angle * .pi / 180
        let dx = sin(rad), dy = -cos(rad)
        let half = (abs(size.width * dx) + abs(size.height * dy)) / 2
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        return (CGPoint(x: c.x - dx * half, y: c.y - dy * half), CGPoint(x: c.x + dx * half, y: c.y + dy * half))
    }
}

struct ZnIconView: View {
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let _ = ZnDebug.hit(name: "IconLeaf", inst: inst, node: s.index)
        let color = s.colorSlot >= 0 ? (znColor(inst.slot(s.colorSlot).value) ?? .black) : (s.color ?? .black)
        let sized = !s.hasWidth && !s.hasHeight
        Canvas { g, size in
            guard let icon = s.icon else { return }
            let tr = CGAffineTransform(scaleX: size.width / icon.width, y: size.height / icon.height)
                .translatedBy(x: -icon.minX, y: -icon.minY)
            g.fill(icon.path.applying(tr), with: .color(color))
        }
        .frame(width: sized ? 24 : nil, height: sized ? 24 : nil)
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

/// RN textTransform (registry 15), as transformText in android/runtime's ZnRenderer.kt: no phone locale (so "i" never
/// becomes the Turkish "İ"); capitalize makes each word's first letter upper case and the rest lower case ("don't"
/// is one word).
func znTransformText(_ text: String, _ transform: Int) -> String {
    let root = Locale(identifier: "en_US_POSIX")
    switch transform {
    case Registry.TextTransform.uppercase: return text.uppercased(with: root)
    case Registry.TextTransform.lowercase: return text.lowercased(with: root)
    case Registry.TextTransform.capitalize:
        var out = ""
        var at = text.startIndex
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { word, range, _, _ in
            guard let word, let first = word.first else { return }
            out += text[at..<range.lowerBound]
            out += first.isLetter || first.isNumber
                ? String(first).uppercased(with: root) + word.dropFirst().lowercased(with: root) : word
            at = range.upperBound
        }
        out += text[at...]
        return out
    default: return text
    }
}

/// A node whose child has onLayout names a coordinate space (its box with its padding), so the child's x / y are
/// relative to it, as RN's onLayout.
struct ZnLayoutSpace: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.namesSpace { content.coordinateSpace(.named(ZnOnLayout.space(inst, s.index))) } else { content }
    }
}

/// RN onLayout (registry 15): { layout: { x, y, width, height } } (pt, two decimals) when the box inside the margin
/// gets a new size or place in its parent; only a real change sends. x / y are relative to the parent node in the
/// same template; an instance's root (its parent is in another template) reports them in window coordinates.
struct ZnOnLayout: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    static func space(_ inst: ZnInstance, _ node: Int) -> String { "zn-layout-\(inst.id)-\(node)" }

    func body(content: Content) -> some View {
        if s.onLayout != 0 {
            let space: CoordinateSpace = s.parent >= 0 ? .named(Self.space(inst, s.parent)) : .global
            let (ctx, id, event) = (ctx, inst.id, s.onLayout)
            content.onGeometryChange(for: CGRect.self) { $0.frame(in: space) } action: { r in
                func r2(_ v: CGFloat) -> Double { (Double(v) * 100).rounded() / 100 }
                let json = ZnModules.json(["layout": ["x": r2(r.minX), "y": r2(r.minY), "width": r2(r.width), "height": r2(r.height)]])
                ZnApp.shared.afterJSDrew { if let json { ctx.send(id, event, .string(json)) } }
            }
        } else {
            content
        }
    }
}
