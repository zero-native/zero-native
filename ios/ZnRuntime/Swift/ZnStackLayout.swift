// <Stack> with absolute children, as android/runtime's ZnRenderer.kt STACK + absoluteChild / absoluteInsets (R29, R44):
// - the Stack's size comes from its normal children (or its set size / its parent's fill); absolute children take no
//   room, so a tall header shape never makes the Stack taller;
// - a normal child is placed by the Stack's alignItems (horizontal) and justifyContent (vertical);
// - an absolute child is placed at its insets; both sides of a pair (start + end, top + bottom) stretch it between
//   them (StyleSheet.absoluteFill); with neither side it is placed like a normal child. Its own size: a set size is
//   kept even when bigger than the Stack, no width is at most the Stack's width, no height is its content's height.
//   It draws outside the Stack when bigger (no clipping unless the Stack clips).
import SwiftUI

struct ZnAbsolute: Equatable {
    var top: CGFloat?, bottom: CGFloat?, start: CGFloat?, end: CGFloat?
    var fixedWidth: Bool  // a set width in points: may be wider than the Stack
    var percentHeight: Bool

    /// The child's insets and size now (from slots too: an animated `start` moves it, ZnChildTraits).
    @MainActor init(_ s: ZnNodeSpec, _ inst: ZnInstance) {
        (top, bottom, start, end) = s.posNow(inst)
        if case .points = s.widthNow(inst) { fixedWidth = true } else { fixedWidth = false }
        if case .percent = s.heightNow(inst) { percentHeight = true } else { percentHeight = false }
    }
}

struct ZnAbsoluteKey: LayoutValueKey { static let defaultValue: ZnAbsolute? = nil }

struct ZnStackLayout: Layout {
    var alignItems: Int
    var justify: Int
    /// The Stack takes the whole offered size on that axis (a set size, or its parent fills it).
    var fillWidth: Bool
    var fillHeight: Bool
    /// minWidth / minHeight less padding and border (ZnFlexLayout.minWidth).
    var minWidth: CGFloat = 0
    var minHeight: CGFloat = 0

    private static func bounded(_ v: CGFloat?) -> CGFloat? {
        guard let v, v.isFinite else { return nil }
        return v
    }

    /// Where a child without insets sits on each axis: 0 start, 0.5 centre, 1 end.
    private var bias: (x: CGFloat, y: CGFloat) {
        func b(_ v: Int) -> CGFloat { v == Registry.AlignItems.center ? 0.5 : v == Registry.AlignItems.flexEnd ? 1 : 0 }
        let y: CGFloat = justify == Registry.JustifyContent.center ? 0.5 : justify == Registry.JustifyContent.flexEnd ? 1 : 0
        return (b(alignItems), y)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        var size = CGSize.zero
        for sv in subviews where sv[ZnAbsoluteKey.self] == nil {
            let s = sv.sizeThatFits(znPercentOffer(sv, proposal))
            size.width = max(size.width, s.width)
            size.height = max(size.height, s.height)
        }
        if fillWidth, let w = Self.bounded(proposal.width) { size.width = w }
        if fillHeight, let h = Self.bounded(proposal.height) { size.height = h }
        return CGSize(width: max(size.width, minWidth), height: max(size.height, minHeight))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let w = bounds.width, h = bounds.height
        let (bx, by) = bias
        for sv in subviews {
            guard let a = sv[ZnAbsoluteKey.self] else {
                let s = sv.sizeThatFits(znPercentOffer(sv, ProposedViewSize(width: w, height: h)))
                sv.znPlace(at: CGPoint(x: bounds.minX + bx * (w - s.width), y: bounds.minY + by * (h - s.height)),
                           in: bounds, proposal: ProposedViewSize(width: s.width, height: s.height))
                continue
            }
            let fillW = a.start != nil && a.end != nil
            let fillH = a.top != nil && a.bottom != nil
            let fullW = max(0, w - (a.start ?? 0) - (a.end ?? 0))
            let fullH = max(0, h - (a.top ?? 0) - (a.bottom ?? 0))
            let offer = ProposedViewSize(
                width: fillW ? fullW : a.fixedWidth ? nil : w,
                height: fillH ? fullH : a.percentHeight ? h : nil)
            var s = sv.sizeThatFits(znPercentOffer(sv, offer))
            if fillW { s.width = fullW }
            if fillH { s.height = fullH }
            let x = a.start ?? a.end.map { w - s.width - $0 } ?? bx * (w - s.width)
            let y = a.top ?? a.bottom.map { h - s.height - $0 } ?? by * (h - s.height)
            sv.znPlace(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y), in: bounds,
                       proposal: ProposedViewSize(width: s.width, height: s.height))
        }
    }
}
