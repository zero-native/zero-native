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
struct ZnAlignSelfKey: LayoutValueKey { static let defaultValue: Int = -1 }

struct ZnFlexLayout: Layout {
    var vertical: Bool
    var justify: Int
    var alignItems: Int
    var gap: CGFloat
    /// The container takes the whole offered size on that axis (a set size, or its parent fills it).
    var definiteWidth: Bool
    var definiteHeight: Bool

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

    private func measure(_ proposal: ProposedViewSize, _ subviews: Subviews) -> Measured {
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
            let s = sv.sizeThatFits(offer(main: left, cross: crossAvail))
            sizes[i] = s
            used += main(s)
        }
        if weights > 0, let mainAvail {
            let free = max(0, mainAvail - used)
            for (i, sv) in subviews.enumerated() {
                let w = sv[ZnFlexKey.self]
                guard w > 0 else { continue }
                let m = free * w / weights
                let s = sv.sizeThatFits(offer(main: m, cross: crossAvail))
                sizes[i] = vertical ? CGSize(width: s.width, height: m) : CGSize(width: m, height: s.height)
                used += m
            }
        }
        let contentMain = used
        let contentCross = sizes.map(cross).max() ?? 0
        let definiteMain = vertical ? definiteHeight : definiteWidth
        let definiteCross = vertical ? definiteWidth : definiteHeight
        // Flex children fill a bounded main axis, as Compose's weight() does.
        let m = ((definiteMain || weights > 0) ? mainAvail : nil) ?? contentMain
        let c = (definiteCross ? crossAvail : nil) ?? contentCross
        return Measured(size: vertical ? CGSize(width: c, height: m) : CGSize(width: m, height: c), children: sizes)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        measure(proposal, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
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
            sv.place(at: origin, anchor: .topLeading, proposal: ProposedViewSize(s))
            at += main(s) + between
        }
    }
}
