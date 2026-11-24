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
//
// Seams: each later part of a node has its own modifier in its own file, already in its place in the chain (most are
// pass-throughs until their work lands), so that work changes its file and not this one. Outermost first:
// ZnChildTraits, display: "none", ZnPointerEventsNone (ZnPointerEvents.swift), margin, ZnImpressionProbe
// (ZnImpressions.swift), ZnSharedProbe (ZnShared.swift); then in styled: ZnAnimatePlace (ZnLayoutMotion.swift), ZnA11y
// (ZnAccessibility.swift) over the paint, ZnAnimateLayout (ZnLayoutMotion.swift) over the size frame; inside
// ZnPaintLayers, before ZnLayer: ZnElementProbe (ZnElementMotion.swift) and ZnGestureModifier (ZnGestureHub.swift).
// Scroll and Canvas: ZnScroll.swift, ZnCanvas.swift.
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
        #if DEBUG
        let _ = ZnMotionPerf.hit("node")
        #endif
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
                .modifier(ZnSharedProbe(s: s, inst: inst))
                .modifier(ZnImpressionProbe(ctx: ctx, s: s, inst: inst))
                .padding(s.marginInsets(inst))
                .modifier(ZnPointerEventsNone(s: s, inst: inst))
        } else {
            inner(s).modifier(ZnOnLayout(ctx: ctx, s: s, inst: inst))
                .modifier(ZnSharedProbe(s: s, inst: inst))
                .modifier(ZnImpressionProbe(ctx: ctx, s: s, inst: inst))
                .padding(s.marginInsets(inst))
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
            // What a child's formula reads as `parent` (its content box), written only once one wants it. A vertical
            // Scroll writes its scrolled content's instead (below), as Android's verticalScroll Column.
            .modifier(ZnSizeWriter(box: s.feedsChildSite && !s.scrollsVertically ? inst.contentBox(s.index) : nil))
            .modifier(ZnPointerEventsKids(s: s, inst: inst))
            // A List's and a Carousel's padding is inside their scroll (content padding), not around them.
            .padding(s.type == Registry.Component.list || s.type == Registry.Component.carousel ? EdgeInsets()
                     : s.type == Registry.Component.scroll ? s.borderInsets(inst) : s.contentInsets(inst))
            .modifier(ZnLayoutSpace(s: s, inst: inst))
            .modifier(ZnSizeFrame(s: s, inst: inst, outer: outer, alignment: contentAlignment(s)))
            .modifier(ZnAnimateLayout(s: s, inst: inst))
            .modifier(ZnFieldBoxTap(s: s, inst: inst))
            .modifier(ZnPaint(s: s, inst: inst))
            .modifier(ZnA11y(s: s, inst: inst))
            .modifier(ZnAnimatePlace(s: s, inst: inst))
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
            // ZnScroll.swift. Its content and padding are read here, in this body; refreshing by its probe.
            ZnScrollView(ctx: ctx, s: s, inst: inst, outer: outer, padding: s.paddingInsets(inst)) {
                // A child's `parent` in a vertical Scroll is the content inside the padding, all of it (Android: the
                // children's parent is the scrolling Column, laid out at its full height). A horizontal one is a
                // LazyRow on Android, so there it is the viewport (styled).
                flex(s, vertical: !s.horizontal)
                    .modifier(ZnSizeWriter(box: s.feedsChildSite && s.scrollsVertically ? inst.contentBox(s.index) : nil))
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
        case Registry.Component.canvas:
            ZnCanvasView(ctx: ctx, s: s, inst: inst, outer: outer)
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
        // A Column whose width isn't definite but is raised by minWidth: its stretching children fill the raised width
        // (Yoga stretches to the box's final width; ZeroBill's badge, a flexGrow pill in an absolute ring with
        // minWidth 18, came out narrow on iOS, 2026-11-24). They never push it wider than the min (rule 4).
        let raised = vertical && !(definiteWidth || s.hasWidth) && minW > 0
        return ZnFlexLayout(vertical: vertical, justify: s.justify, alignItems: s.alignItems, gap: s.gapNow(inst),
                            definiteWidth: definiteWidth || s.hasWidth, definiteHeight: definiteHeight,
                            minWidth: minW, minHeight: minH, roomless: znRoomless(refs)) {
            ForEach(refs) { ref in
                let child = ref.t.nodes[ref.node]
                let flex = flexes[ref.id] ?? child.flex
                let (outer, childDefinite) = childLayout(s, child, flex: flex, vertical: vertical, stretchAll: stretchAll,
                                                         raisedWidth: raised)
                ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node, outer: outer, definiteWidth: childDefinite)
                    .layoutValue(key: ZnNoRoomKey.self, value: child.takesNoRoom)
                    .layoutValue(key: ZnFlexKey.self, value: flex)
                    .layoutValue(key: ZnMinStretchKey.self, value: raised && outer.fillWidth)
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

    /// Some shown child takes no room (a Sheet, Modal or bar): the layout then leaves it out (ZnNoRoomKey).
    private func znRoomless(_ refs: [ZnChildRef]) -> Bool { refs.contains { $0.t.nodes[$0.node].takesNoRoom } }

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
                            definiteHeight: s.hasHeight || outer.fillHeight, minHeight: innerMin(s).1,
                            roomless: znRoomless(refs)) {
            ForEach(refs) { ref in
                let child = ref.t.nodes[ref.node]
                let flex = flexes[ref.id] ?? child.flex
                let stretch = !child.hasHeight && (child.alignSelf == Registry.AlignSelf.stretch ||
                    (child.alignSelf == -1 && s.alignItems == Registry.AlignItems.stretch))
                ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node,
                           outer: ZnOuter(fillWidth: flex > 0, fillHeight: stretch),
                           definiteWidth: child.hasWidth || flex > 0)
                    .layoutValue(key: ZnNoRoomKey.self, value: child.takesNoRoom)
                    .layoutValue(key: ZnFlexKey.self, value: flex)
                    .layoutValue(key: ZnAlignSelfKey.self, value: child.alignSelf)
                    .layoutValue(key: ZnStretchKey.self, value: stretch)
                    .zIndex(child.zIndex ?? 0)
            }
        }
    }

    /// What a Column / Row tells one child: what to fill, and whether its width is definite.
    /// [flex] is the child's flex now (a slot's value, or the template's). A size from a slot counts as set.
    /// [raisedWidth]: the Column's width isn't definite but minWidth raises it; a stretching child then fills the raised
    /// width (ZnFlexLayout offers it max(its own width, the min): ZnMinStretchKey).
    private func childLayout(_ s: ZnNodeSpec, _ child: ZnNodeSpec, flex: CGFloat, vertical: Bool, stretchAll: Bool,
                             raisedWidth: Bool = false) -> (ZnOuter, Bool) {
        let selfStretch = child.alignSelf == -1 || child.alignSelf == Registry.AlignSelf.stretch
        if vertical {
            // zn flex rule 4: a Column stretches children without a width only when its own width is definite, or
            // raised by its minWidth (to that width only, layout conformance case 48).
            // alignSelf stretch stretches even when alignItems doesn't (RN; layout conformance case 19).
            let stretched = (definiteWidth || s.hasWidth || raisedWidth) && !child.hasWidth && child.type != Registry.Component.spacer &&
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

    /// Set sizes in points, each kept between its own min and max first (RN, c29a), with aspectRatio giving the other
    /// side from the one that is set (width / height = ratio), kept between that side's min and max (znRatioSides).
    private func points(_ width: ZnSize?, _ height: ZnSize?, _ ratio: CGFloat?,
                        _ minW: CGFloat?, _ maxW: CGFloat?, _ minH: CGFloat?, _ maxH: CGFloat?) -> (CGFloat?, CGFloat?, CGFloat?, CGFloat?) {
        var w: CGFloat? = if case .points(let v) = width { znClamp(max(v, 0), minW, maxW) } else { nil }
        var h: CGFloat? = if case .points(let v) = height { znClamp(max(v, 0), minH, maxH) } else { nil }
        let wf: CGFloat? = if case .percent(let f) = width { f } else { nil }
        let hf: CGFloat? = if case .percent(let f) = height { f } else { nil }
        if let r = ratio {
            if let ww = w, h == nil, hf == nil {
                h = znRatioSides(given: ww, ratio: r, fromHeight: false, minW: minW, maxW: maxW, minH: minH, maxH: maxH).h
            } else if let hh = h, w == nil, wf == nil {
                w = znRatioSides(given: hh, ratio: r, fromHeight: true, minW: minW, maxW: maxW, minH: minH, maxH: maxH).w
            }
        }
        return (w, h, wf, hf)
    }

    func body(content: Content) -> some View {
        #if DEBUG
        let _ = ZnMotionPerf.hit("Size")
        #endif
        // A width / height that follows a motion value lays this node out again each frame (ZnMotionBindings.swift).
        let width = znBoundSize(s.widthSlot, inst) { s.widthNow(inst) }
        let height = znBoundSize(s.heightSlot, inst) { s.heightNow(inst) }
        let minWidth = s.minWidthNow(inst), maxWidth = s.maxWidthNow(inst)
        let minHeight = s.minHeightNow(inst), maxHeight = s.maxHeightNow(inst)
        let aspect = s.aspectRatioNow(inst)
        // A fill (stretch, flex) still stops at maxWidth / maxHeight; a min beats a max (RN), and SwiftUI wants min <= max.
        let minW = minWidth.map { max($0, 0) }, minH = minHeight.map { max($0, 0) }
        let maxW = maxWidth.map { max($0, minW ?? 0, 0) }, maxH = maxHeight.map { max($0, minH ?? 0, 0) }
        let (w, h, wf, hf) = points(width, height, aspect, minW, maxW, minH, maxH)
        // A percent fills what its parent offers (the parent takes the fraction: ZnPercentKey).
        let fillW = (outer.fillWidth && width == nil) || wf != nil
        let fillH = (outer.fillHeight && height == nil) || hf != nil
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

    /// The known side (what is offered, or the content's width when nothing is) gives the other (znRatioSides: both
    /// kept between their min and max, as Android's dynamicSize).
    private func size(_ p: ProposedViewSize, _ child: LayoutSubview) -> CGSize {
        let given: CGFloat
        var byHeight = false
        if fromHeight, let h = p.height, h.isFinite { given = h; byHeight = true }
        else if let w = p.width, w.isFinite { given = w }
        else { given = child.sizeThatFits(p).width }
        let (w, h) = znRatioSides(given: given, ratio: ratio, fromHeight: byHeight, minW: minW, maxW: maxW, minH: minH, maxH: maxH)
        return CGSize(width: w, height: h)
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
    @Environment(\.znSeeThrough) private var seeThrough

    func body(content: Content) -> some View {
        #if DEBUG
        let _ = ZnMotionPerf.hit("Paint")
        #endif
        // Corners from slots are read here (motion values too): a change redraws this node's paint alone.
        let shape = znShapeNow(s, inst)
        // Images and shimmers clip to their rounded shape by default, as in RN (and Android). So does a rounded Pressable
        // whose ripple isn't borderless, whatever its pressFeedback, as on Android (ZnTemplate.kt clipsByDefault): a
        // card's full-width picture or coloured strip gets its rounded corners without overflow: "hidden" (2026-11-24).
        // One whose corners come from a slot always clips (to a square when they are 0; Android doesn't clip then), so
        // the branch never swaps and nothing inside is made again (a picture would reload). The shadow and the border
        // are outside the clip.
        let picture = s.type == Registry.Component.image || s.type == Registry.Component.shimmer
        let pressClip = s.isPressable && !s.rippleBorderless
        let clips = s.clip || ((picture || pressClip) && (s.hasDynamicRadius || s.rounded))
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
                // In a see-through screen its holder only finds UIKit views, so a marker tells it the box stops taps.
                if znStopsTaps(s, inst, touchOff: touchOff) {
                    Color.clear.contentShape(shape).background { if seeThrough { ZnSeeThroughTapMarker() } }
                }
            }
            // Inside the layer: a gesture's touch area and the element's box move, scale and turn with the node.
            .modifier(ZnGestureModifier(s: s, inst: inst))
            .modifier(ZnElementProbe(s: s, inst: inst))
            .modifier(ZnLayer(s: s, inst: inst, motion: motion))
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
        #if DEBUG
        let _ = ZnMotionPerf.hit("Playing")
        #endif
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

/// Opacity and transforms (scale, scaleX, scaleY, rotate about transformOrigin, 3D turns, then translate; blur under
/// them), each value from its motion, its slot (a number, or a motion value read here: ZnMotionBindings.swift), or the
/// template. A value with a timing that follows a slot animates to each new value (SwiftUI animation scoped to that
/// modifier); one that follows a motion value doesn't, it already moves smoothly (Android's animatedFloat). The same
/// order as Compose's graphicsLayer: scale, rotate, the 3D turn, translate. A node with no layer slots and no
/// transform gets only its opacity (ZnLayerFull, with its state, is only on the others; the branch is fixed per node).
struct ZnLayer: ViewModifier {
    typealias P = Registry.Prop
    let s: ZnNodeSpec
    let inst: ZnInstance
    let motion: ZnMotion?

    static let animatable = [P.opacity, P.scale, P.scaleX, P.scaleY, P.rotate, P.translateX, P.translateY, P.backgroundColor]

    /// Each animatable prop's resting value now (slot or template), for motions that start from or play towards it.
    /// A motion value is read only for a prop that plays `from` (Android's znMotion plays towards its read, so a new
    /// value starts it again); for any other prop the rest is never used, and reading the value here would run
    /// ZnPaintPlaying's body each frame it moves.
    @MainActor static func rests(_ s: ZnNodeSpec, _ inst: ZnInstance) -> [Int: [Double]] {
        func playsFrom(_ prop: Int) -> Bool {
            guard let t = s.animate?.timing(prop) else { return false }
            return t.from != nil && t.keyframes == nil
        }
        func n(_ prop: Int, _ slot: Int, _ v: CGFloat) -> [Double] {
            guard slot >= 0 else { return [Double(v)] }
            if playsFrom(prop) { return [Double(inst.layerNumber(slot, v))] }
            return [inst.slot(slot).value.number.flatMap { $0.isFinite ? $0 : nil } ?? Double(v)]
        }
        let bgValue = s.backgroundSlot >= 0 ? inst.slot(s.backgroundSlot).value : nil
        let bgMotion = playsFrom(P.backgroundColor) ? bgValue.flatMap { znBoundColor($0) }.flatMap { znColorVector(.color($0)) } : nil
        let bg = bgMotion ?? (bgValue.map(znColorVector) ?? znColorVector(s.props[P.backgroundColor]))
        return [
            P.opacity: n(P.opacity, s.opacitySlot, CGFloat(s.opacity)), P.scale: n(P.scale, s.scaleSlot, s.scaleBase),
            P.scaleX: n(P.scaleX, s.scaleXSlot, s.scaleXOnly), P.scaleY: n(P.scaleY, s.scaleYSlot, s.scaleYOnly),
            P.rotate: n(P.rotate, s.rotateSlot, s.rotate), P.translateX: n(P.translateX, s.translateXSlot, s.translateX),
            P.translateY: n(P.translateY, s.translateYSlot, s.translateY), P.backgroundColor: bg ?? [0, 0, 0, 0],
        ]
    }

    func body(content: Content) -> some View {
        if s.hasLayerSlots || s.layerTransforms {
            content.modifier(ZnLayerFull(s: s, inst: inst, motion: motion))
        } else {
            let _ = ZnDebug.hit(name: "Layer", inst: inst, node: s.index)
            content.modifier(ZnOpacityGroup(on: s.fadesAsGroup))
                .opacity(motion?.values[P.opacity]?.first.map { CGFloat($0) } ?? CGFloat(s.opacity))
        }
    }
}

/// ZnLayer for a node whose layer has slots or transforms.
struct ZnLayerFull: ViewModifier {
    typealias P = Registry.Prop
    let s: ZnNodeSpec
    let inst: ZnInstance
    let motion: ZnMotion?
    /// The node's sizes for a bound formula that reads `self` / `parent` (made when one does).
    @State private var site: ZnSite?
    @Environment(\.displayScale) private var displayScale

    private func value(_ prop: Int, _ slot: Int, _ fixed: CGFloat) -> CGFloat {
        if let m = motion?.values[prop]?.first { return CGFloat(m) }
        return inst.layerNumber(slot, fixed, site: site)
    }

    /// The animation for a value that follows its slot; nil: it changes at once (no timing, or a motion value).
    private func follow(_ prop: Int, _ slot: Int) -> Animation? {
        guard let t = s.animate?.timing(prop), !t.selfPlaying, !inst.followsMotion(slot) else { return nil }
        return t.animation
    }

    func body(content: Content) -> some View {
        let _ = ZnDebug.hit(name: "Layer", inst: inst, node: s.index)
        #if DEBUG
        let _ = ZnMotionPerf.hit("Layer")
        #endif
        let opacity = value(P.opacity, s.opacitySlot, CGFloat(s.opacity))
        // Only a node whose layer has slots can follow a formula reading `self` / `parent` (fixed per node).
        let fed = Group {
            if s.hasLayerSlots {
                content.modifier(ZnSiteFeed(s: s, inst: inst, on: znSiteUsed(s, inst), site: $site))
            } else {
                content
            }
        }
        // A scale of exactly 0 is a singular transform: kept just above it (nothing shows either way).
        let sc: (CGFloat) -> CGFloat = { abs($0) < 1e-4 ? 1e-4 : $0 }
        let o = s.origin
        let depth = s.hasDepth
        if !s.layerTransforms {
            // Opacity from a slot only: `animate` implies a transform (ZnTemplate), so no timing applies here.
            fed.modifier(ZnOpacityGroup(on: s.fadesAsGroup)).opacity(opacity)
        } else if s.animate == nil {
            // Nothing animates through SwiftUI here: SwiftUI's own effects with no animation scopes, the cheapest to
            // move per frame. (One custom GeometryEffect for the whole matrix was cheaper still, but a UITextField
            // under it kept its touch area where it was laid out, 2026-11-22; the built-in effects move it.)
            let scale = value(P.scale, s.scaleSlot, s.scaleBase)
            fed
                .modifier(ZnBlurIf(on: s.blurs, radius: s.blurs ? max(0, value(P.blurRadius, s.blurRadiusSlot, s.blurRadius)) : 0,
                                   scale: displayScale))
                .scaleEffect(x: sc(scale * value(P.scaleX, s.scaleXSlot, s.scaleXOnly)),
                             y: sc(scale * value(P.scaleY, s.scaleYSlot, s.scaleYOnly)), anchor: o)
                .rotationEffect(.degrees(value(P.rotate, s.rotateSlot, s.rotate)), anchor: o)
                .modifier(ZnDepthIf(on: depth,
                                    rotateX: depth ? value(P.rotateX, s.rotateXSlot, s.rotateX) : 0,
                                    rotateY: depth ? value(P.rotateY, s.rotateYSlot, s.rotateY) : 0,
                                    camera: depth ? value(P.cameraDistance, s.cameraDistanceSlot, s.cameraDistance) : 8,
                                    origin: o, scale: displayScale))
                .offset(x: value(P.translateX, s.translateXSlot, s.translateX), y: value(P.translateY, s.translateYSlot, s.translateY))
                .modifier(ZnOpacityGroup(on: s.fadesAsGroup))
                .opacity(opacity)
        } else {
            fed
                .modifier(ZnBlurIf(on: s.blurs, radius: s.blurs ? max(0, value(P.blurRadius, s.blurRadiusSlot, s.blurRadius)) : 0,
                                   scale: displayScale))
                .animation(follow(P.scale, s.scaleSlot)) { $0.scaleEffect(sc(value(P.scale, s.scaleSlot, s.scaleBase)), anchor: o) }
                .animation(follow(P.scaleX, s.scaleXSlot)) { $0.scaleEffect(x: sc(value(P.scaleX, s.scaleXSlot, s.scaleXOnly)), y: 1, anchor: o) }
                .animation(follow(P.scaleY, s.scaleYSlot)) { $0.scaleEffect(x: 1, y: sc(value(P.scaleY, s.scaleYSlot, s.scaleYOnly)), anchor: o) }
                .animation(follow(P.rotate, s.rotateSlot)) { $0.rotationEffect(.degrees(value(P.rotate, s.rotateSlot, s.rotate)), anchor: o) }
                .modifier(ZnDepthIf(on: depth,
                                    rotateX: depth ? value(P.rotateX, s.rotateXSlot, s.rotateX) : 0,
                                    rotateY: depth ? value(P.rotateY, s.rotateYSlot, s.rotateY) : 0,
                                    camera: depth ? value(P.cameraDistance, s.cameraDistanceSlot, s.cameraDistance) : 8,
                                    origin: o, scale: displayScale))
                .animation(follow(P.translateX, s.translateXSlot)) { $0.offset(x: value(P.translateX, s.translateXSlot, s.translateX)) }
                .animation(follow(P.translateY, s.translateYSlot)) { $0.offset(y: value(P.translateY, s.translateYSlot, s.translateY)) }
                .modifier(ZnOpacityGroup(on: s.fadesAsGroup))
                .animation(follow(P.opacity, s.opacitySlot)) { $0.opacity(opacity) }
        }
    }
}

/// opacity below 1 fades the node as one picture (its shadow, background, border and children together), as Android's
/// graphicsLayer alpha, drawn offscreen when alpha < 1. Without it SwiftUI fades each drawn part on its own, so
/// overlapping children, and a picture under text, show through each other (2026-11-24). Only on a node whose opacity
/// can be below 1 and that draws parts which could overlap (fadesAsGroup); fixed per node, so the branch never swaps.
/// It costs: 30 boxes whose opacity follows a motion value took 8.6 ms of main thread per frame with the group and
/// 4.2 to 5.4 without (the simulator, ZN_MOTION_PERF, 2026-11-24), so a plain filled box, which looks the same either
/// way, has none.
struct ZnOpacityGroup: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.compositingGroup() } else { content }
    }
}

extension ZnNodeSpec {
    /// A Sheet, Modal, StatusBar or NavigationBar: no room in its Column / Row, so no gap or justifyContent share
    /// (ZnNoRoomKey), as Android, where they have no layout node in the parent (ZnRenderer.kt ZnNodeContent).
    var takesNoRoom: Bool {
        type == Registry.Component.sheet || type == Registry.Component.modal ||
            type == Registry.Component.statusBar || type == Registry.Component.navigationBar
    }

    /// Its opacity can be below 1 (written below 1, from a slot or motion value, or animated) and it draws parts that a
    /// fade would show through each other (drawsOverlappingParts).
    var fadesAsGroup: Bool {
        (opacity < 1 || opacitySlot >= 0 || animate?.timing(Registry.Prop.opacity) != nil) && drawsOverlappingParts
    }

    /// Children, or two of its own parts: a fill, a gradient, a border, a shadow, its own content (a Text's glyphs, a
    /// picture, a control, a Pressable's ripple). A box with only a fill fades the same with or without a group.
    var drawsOverlappingParts: Bool {
        if !children.isEmpty { return true }
        let C = Registry.Component.self
        let plain = [C.column, C.row, C.stack, C.box, C.spacer, C.fragment, C.anchor].contains(type)
        let parts = [background != nil || backgroundSlot >= 0, gradient != nil,
                     borderWidth > 0 || borderTopWidth > 0 || borderBottomWidth > 0 || borderWidthSlot >= 0,
                     elevation > 0, !plain]
        return parts.filter { $0 }.count > 1
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
        #if DEBUG
        let _ = ZnMotionPerf.hit("Background")
        #endif
        // Read only when the colour itself plays (motion.values changes each frame of any played prop: a node whose
        // scale plays would otherwise run this body each frame too).
        let plays = s.animate?.timing(Registry.Prop.backgroundColor)?.selfPlaying == true
        let played = plays ? motion?.values[Registry.Prop.backgroundColor].flatMap(znColorFromVector) : nil
        // A motion colour (mapColor, a colour formula) is read here frame by frame, never through `animate`'s timing.
        let color = played ?? inst.motionColor(s.backgroundSlot)
            ?? (s.backgroundSlot >= 0 ? znColor(inst.slot(s.backgroundSlot).value) : s.background)
        let follow = s.animate?.timing(Registry.Prop.backgroundColor).flatMap { $0.selfPlaying ? nil : $0.animation }
        // elevation: Android's material shadow, cast by the node's shape whether or not anything is painted (Compose's
        // shadow(elevation, shape) from the outline): an image card with no backgroundColor is lifted too (before
        // 2026-11-24 the shadow followed the fill: none without one, faint under a translucent one). It shows only
        // outside the shape, so a translucent or empty box stays see-through (ZnElevationShadow).
        if s.elevation > 0 { ZnElevationShadow(s: s, shape: shape) }
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
            .animation(follow, value: s.backgroundSlot >= 0 ? znColorVector(inst.slot(s.backgroundSlot).value) : nil)
        }
    }
}

/// The elevation shadow alone: a soft shadow below the shape (y = elevation / 2, blur = elevation, 20 % of
/// shadowColor), the shape itself not drawn. Its canvas reaches past the box by the blur, so the shadow isn't cut.
/// The shape is cut out of it: Android's caster is opaque (Compose's outline alpha is the layer's, 1), and Skia leaves
/// out the shadow under an opaque caster, so a translucent card or an elevated box with no fill shows what is behind
/// it, not a grey slab (2026-11-24). An opaque card looks the same either way.
struct ZnElevationShadow: View {
    let s: ZnNodeSpec
    let shape: UnevenRoundedRectangle

    var body: some View {
        let e = s.elevation
        let pad = e * 3 + e / 2
        let color = s.shadowColor.opacity(0.2)
        Canvas { ctx, size in
            let box = CGRect(x: pad, y: pad, width: max(0, size.width - 2 * pad), height: max(0, size.height - 2 * pad))
            let path = shape.path(in: box)
            ctx.clip(to: path, options: .inverse)
            ctx.addFilter(.shadow(color: color, radius: e, x: 0, y: e / 2, options: .shadowOnly))
            ctx.fill(path, with: .color(.black))
        }
        .padding(-pad)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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
    // A motion value as text (`v.format(...)`): formatted from its value now, never its raw control characters.
    case .string(let s): return znShownString(s)
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
