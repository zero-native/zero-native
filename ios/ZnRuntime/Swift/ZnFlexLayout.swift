// Column / Row layout with zn's flex rules (docs/styling-and-layout.md), as one SwiftUI Layout. SwiftUI has no
// weight or flex of its own; this does what Compose's Column / Row + weight() do in android/runtime's ZnRenderer.kt:
// - children without flex are measured first, in order, each offered what is left on the main axis;
// - children with flex share the free space by weight (only when the main size is bounded);
// - a container whose main size is definite (a set size, or its parent fills it) takes all of it, and
//   justifyContent places the children in it; otherwise it wraps its children;
// - gap is kept with every justifyContent, as in RN (second-opinions 112).
// Stretching on the cross axis (zn flex rule 4) is decided by the parent view: a stretched child gets a fill frame
// (ZnNodeView), and the layout offers it the container's cross size.
import SwiftUI

struct ZnFlexKey: LayoutValueKey { static let defaultValue: CGFloat = 0 }
/// A stretching child of a Column whose width isn't definite but is raised by minWidth: offered max(its own width, the
/// min), so it fills the raised box without pushing it wider (Yoga's stretch to the final width; ZnRenderer flex()).
struct ZnMinStretchKey: LayoutValueKey { static let defaultValue = false }
struct ZnAlignSelfKey: LayoutValueKey { static let defaultValue: Int = -1 }
/// A child that takes no room (a Sheet, Modal, StatusBar or NavigationBar: Android draws them in their own window or
/// as effects, with no layout node): left out of the gaps, justifyContent's shares and line breaking, placed 0 x 0.
struct ZnNoRoomKey: LayoutValueKey { static let defaultValue = false }

extension LayoutSubviews {
    /// The children that take room (ZnNoRoomKey).
    var znRoomy: [LayoutSubview] { filter { !$0[ZnNoRoomKey.self] } }
    /// The others, placed at the top-left with no size.
    func znPlaceRoomless(in bounds: CGRect) {
        for sv in self where sv[ZnNoRoomKey.self] { sv.place(at: bounds.origin, anchor: .topLeading, proposal: .zero) }
    }
}
/// A percent width / height (fractions; zn flex rule 5): the parent offers that much of its content box, and the
/// child fills what it is offered. Resolved by the parent, as a re-proposal at placement must not take it again.
struct ZnPercentKey: LayoutValueKey { static let defaultValue: ZnPercent = ZnPercent() }
struct ZnPercent: Equatable {
    var width: CGFloat?
    var height: CGFloat?
}

/// [p] with a child's percent sizes taken of it.
func znPercentOffer(_ sv: LayoutSubview, _ p: ProposedViewSize) -> ProposedViewSize {
    let pc = sv[ZnPercentKey.self]
    guard pc.width != nil || pc.height != nil else { return p }
    return ProposedViewSize(width: pc.width.flatMap { f in p.width.map { $0.isFinite ? $0 * f : $0 } } ?? p.width,
                            height: pc.height.flatMap { f in p.height.map { $0.isFinite ? $0 * f : $0 } } ?? p.height)
}

struct ZnFlexLayout: Layout {
    var vertical: Bool
    var justify: Int
    var alignItems: Int
    var gap: CGFloat
    /// The container takes the whole offered size on that axis (a set size, or its parent fills it).
    var definiteWidth: Bool
    var definiteHeight: Bool
    /// minWidth / minHeight less padding and border: a box raised to its min lays its children out in the raised size
    /// (Yoga, Compose's heightIn), so alignItems center centres them in it (ZeroBill's ListTile rows, minHeight 56).
    var minWidth: CGFloat = 0
    var minHeight: CGFloat = 0
    /// Some child takes no room (ZnNoRoomKey, known to the renderer): only then are the children filtered, so the
    /// layouts with none (almost all) pay nothing for it.
    var roomless = false

    struct Measured {
        var size: CGSize
        var children: [CGSize]
    }

    private func main(_ s: CGSize) -> CGFloat { vertical ? s.height : s.width }
    private func cross(_ s: CGSize) -> CGFloat { vertical ? s.width : s.height }
    private func offer(main: CGFloat?, cross: CGFloat?) -> ProposedViewSize {
        vertical ? ProposedViewSize(width: cross, height: main) : ProposedViewSize(width: main, height: cross)
    }
    private static func bounded(_ v: CGFloat?) -> CGFloat? {
        guard let v, v.isFinite else { return nil }
        return v
    }

    /// The cross size offered to one child: the container's, or for a ZnMinStretchKey child max(its own width, minWidth).
    private func crossFor(_ sv: LayoutSubview, main: CGFloat?, _ crossAvail: CGFloat?) -> CGFloat? {
        guard vertical, sv[ZnMinStretchKey.self] else { return crossAvail }
        // Its own width as content-sized (no cross offer), kept within what the container has (text still wraps).
        let own = sv.sizeThatFits(offer(main: main, cross: nil)).width
        return max(min(own, crossAvail ?? own), minWidth)
    }

    private func measure<C: RandomAccessCollection>(_ proposal: ProposedViewSize, _ subviews: C) -> Measured
        where C.Element == LayoutSubview, C.Index == Int {
        let mainAvail = Self.bounded(vertical ? proposal.height : proposal.width)
        let crossAvail = Self.bounded(vertical ? proposal.width : proposal.height)
        let gaps = gap * CGFloat(max(subviews.count - 1, 0))
        var sizes = Array(repeating: CGSize.zero, count: subviews.count)
        var used = gaps
        var weights: CGFloat = 0
        for (i, sv) in subviews.enumerated() {
            let w = sv[ZnFlexKey.self]
            if w > 0 && mainAvail != nil { weights += w; continue }
            let left = mainAvail.map { max(0, $0 - used) }
            let pc = sv[ZnPercentKey.self]
            let pm = vertical ? pc.height : pc.width
            let mainOffer = pm != nil ? mainAvail : left
            let s = sv.sizeThatFits(znPercentOffer(sv, offer(main: mainOffer, cross: crossFor(sv, main: mainOffer, crossAvail))))
            sizes[i] = s
            used += main(s)
        }
        if weights > 0, let mainAvail {
            let free = max(0, mainAvail - used)
            for (i, sv) in subviews.enumerated() {
                let w = sv[ZnFlexKey.self]
                guard w > 0 else { continue }
                let m = free * w / weights
                let s = sv.sizeThatFits(offer(main: m, cross: crossFor(sv, main: m, crossAvail)))
                sizes[i] = vertical ? CGSize(width: s.width, height: m) : CGSize(width: m, height: s.height)
                used += m
            }
        }
        let contentMain = used
        let contentCross = sizes.map(cross).max() ?? 0
        let definiteMain = vertical ? definiteHeight : definiteWidth
        let definiteCross = vertical ? definiteWidth : definiteHeight
        // Flex children fill a bounded main axis, as Compose's weight() does.
        let m = max(((definiteMain || weights > 0) ? mainAvail : nil) ?? contentMain, vertical ? minHeight : minWidth)
        let c = max((definiteCross ? crossAvail : nil) ?? contentCross, vertical ? minWidth : minHeight)
        return Measured(size: vertical ? CGSize(width: c, height: m) : CGSize(width: m, height: c), children: sizes)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews all: Subviews, cache: inout ()) -> CGSize {
        roomless ? measure(proposal, all.znRoomy).size : measure(proposal, all).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews all: Subviews, cache: inout ()) {
        if roomless {
            all.znPlaceRoomless(in: bounds)
            place(in: bounds, all.znRoomy)
        } else {
            place(in: bounds, all)
        }
    }

    private func place<C: RandomAccessCollection>(in bounds: CGRect, _ subviews: C) where C.Element == LayoutSubview, C.Index == Int {
        let m = measure(ProposedViewSize(bounds.size), subviews)
        let mainSize = main(bounds.size), crossSize = cross(bounds.size)
        let content = m.children.reduce(0) { $0 + main($1) } + gap * CGFloat(max(subviews.count - 1, 0))
        let free = max(0, mainSize - content)
        let n = CGFloat(subviews.count)
        var lead: CGFloat = 0, between: CGFloat = gap
        switch justify {
        case Registry.JustifyContent.center: lead = free / 2
        case Registry.JustifyContent.flexEnd: lead = free
        case Registry.JustifyContent.spaceBetween: if n > 1 { between += free / (n - 1) }
        case Registry.JustifyContent.spaceAround: if n > 0 { lead = free / n / 2; between += free / n }
        case Registry.JustifyContent.spaceEvenly: if n > 0 { lead = free / (n + 1); between += free / (n + 1) }
        default: break
        }
        var at = lead
        for (i, sv) in subviews.enumerated() {
            let s = m.children[i]
            let align = sv[ZnAlignSelfKey.self] >= 0 ? sv[ZnAlignSelfKey.self] : alignItems
            var c: CGFloat = 0
            switch align {
            case Registry.AlignItems.center: c = (crossSize - cross(s)) / 2
            case Registry.AlignItems.flexEnd: c = crossSize - cross(s)
            default: c = 0
            }
            let origin = vertical ? CGPoint(x: bounds.minX + c, y: bounds.minY + at)
                                  : CGPoint(x: bounds.minX + at, y: bounds.minY + c)
            sv.znPlace(at: origin, in: bounds, proposal: ProposedViewSize(s))
            at += main(s) + between
        }
    }
}
