// RN flexWrap: "wrap" on a Row (registry 24): chips and tags, laid out as Yoga does (android/runtime's ZnWrap.kt).
//
// Rules, as RN and Android:
// - A child with flex > 0 counts as 0 wide when lines are made (RN's flex: n is flexBasis 0); then the flex children of
//   a line share what the line has left, by their flex.
// - A "%" width is a percent of the whole Row.
// - justifyContent places the children of each line (gap included); alignItems / alignSelf place each child in its
//   line, which is as tall as its tallest child. Only an explicit "stretch" stretches a child without a height to its
//   line's height (unset is flex-start).
// - alignContent places the lines when the Row has a height (justifyContent's arrangements, with the gap between lines,
//   crossGap: rowGap, else gap).
// - The Row is as wide as its longest line (all of its width when that is definite), and as tall as its lines and gaps.
// Points are floats here, as Yoga's dp: no pixel rounding, so children that fit a line exactly stay on it (Android needs
// half a pixel of slack per child for that; a hundredth of a point is kept here for float noise).
import SwiftUI

/// The child has no height and stretch is written: it takes its line's height.
struct ZnStretchKey: LayoutValueKey { static let defaultValue = false }

struct ZnWrapLayout: Layout {
    var justify: Int
    var alignItems: Int
    var alignContent: Int
    var gap: CGFloat
    var crossGap: CGFloat
    var definiteWidth: Bool
    var definiteHeight: Bool
    /// minHeight less padding and border (ZnFlexLayout.minWidth): the lines are arranged in the raised height.
    var minHeight: CGFloat = 0

    struct Measured {
        var size: CGSize
        var frames: [CGRect]
    }

    private static func finite(_ v: CGFloat?) -> CGFloat? { v.flatMap { $0.isFinite ? $0 : nil } }

    /// Where [count] items of [sizes] go along [length] with [arrangement] (JustifyContent numbers) and [gap].
    static func arrange(_ arrangement: Int, length: CGFloat, sizes: [CGFloat], gap: CGFloat) -> [CGFloat] {
        let n = CGFloat(sizes.count)
        let content = sizes.reduce(0, +) + gap * max(n - 1, 0)
        let free = max(0, length - content)
        var lead: CGFloat = 0, between = gap
        switch arrangement {
        case Registry.JustifyContent.center: lead = free / 2
        case Registry.JustifyContent.flexEnd: lead = free
        case Registry.JustifyContent.spaceBetween: if n > 1 { between += free / (n - 1) }
        case Registry.JustifyContent.spaceAround: if n > 0 { lead = free / n / 2; between += free / n }
        case Registry.JustifyContent.spaceEvenly: if n > 0 { lead = free / (n + 1); between += free / (n + 1) }
        default: break
        }
        var at = lead
        return sizes.map { s in
            defer { at += s + between }
            return at
        }
    }

    func measure(_ proposal: ProposedViewSize, _ subviews: Subviews) -> Measured {
        let n = subviews.count
        let maxW = Self.finite(proposal.width)
        var sizes = Array(repeating: CGSize.zero, count: n)
        var main = Array(repeating: CGFloat(0), count: n)
        // 1. The width each child has for line breaking.
        for (i, sv) in subviews.enumerated() {
            if sv[ZnFlexKey.self] > 0 { continue }  // flexBasis 0: measured with its share (step 3)
            let pc = sv[ZnPercentKey.self]
            let w = pc.width.flatMap { f in maxW.map { $0 * f } } ?? maxW
            let s = sv.sizeThatFits(ProposedViewSize(width: w, height: nil))
            sizes[i] = s
            main[i] = min(s.width, maxW ?? .infinity)
        }
        // 2. Lines: start indices.
        var starts: [Int] = []
        var lineLen: CGFloat = 0
        var inLine = 0
        for i in 0..<n {
            let add = inLine == 0 ? main[i] : gap + main[i]
            if inLine > 0, let maxW, lineLen + add > maxW + 0.01 {
                starts.append(i)
                lineLen = main[i]
                inLine = 1
            } else {
                if inLine == 0 { starts.append(i) }
                lineLen += add
                inLine += 1
            }
        }
        let lines = starts.count
        var lineHeights = Array(repeating: CGFloat(0), count: lines)
        var lineWidths = Array(repeating: CGFloat(0), count: lines)
        func range(_ l: Int) -> Range<Int> { starts[l]..<(l + 1 < lines ? starts[l + 1] : n) }
        // 3. Per line: flex shares, the line's height, stretched children.
        for l in 0..<lines {
            let r = range(l)
            var fixed: CGFloat = 0, flexSum: CGFloat = 0
            for i in r {
                let f = subviews[i][ZnFlexKey.self]
                if f > 0 { flexSum += f } else { fixed += main[i] }
            }
            let gaps = gap * CGFloat(max(r.count - 1, 0))
            if flexSum > 0 {
                let free = maxW.map { max(0, $0 - fixed - gaps) } ?? 0
                for i in r where subviews[i][ZnFlexKey.self] > 0 {
                    let w = free * subviews[i][ZnFlexKey.self] / flexSum
                    main[i] = w
                    sizes[i] = CGSize(width: w, height: subviews[i].sizeThatFits(ProposedViewSize(width: w, height: nil)).height)
                }
            }
            let h = r.map { sizes[$0].height }.max() ?? 0
            lineHeights[l] = h
            for i in r where subviews[i][ZnStretchKey.self] { sizes[i].height = h }
            lineWidths[l] = r.reduce(0) { $0 + main[$1] } + gaps
        }
        // 4. The Row's size and every child's frame.
        let contentW = lineWidths.max() ?? 0
        let width = definiteWidth ? (maxW ?? contentW) : min(contentW, maxW ?? .infinity)
        let contentH = lineHeights.reduce(0, +) + crossGap * CGFloat(max(lines - 1, 0))
        let height = max(definiteHeight ? (Self.finite(proposal.height) ?? contentH) : contentH, minHeight)
        let tops = Self.arrange(alignContent, length: height, sizes: lineHeights, gap: crossGap)
        var frames = Array(repeating: CGRect.zero, count: n)
        for l in 0..<lines {
            let r = Array(range(l))
            let xs = Self.arrange(justify, length: width, sizes: r.map { main[$0] }, gap: gap)
            for (k, i) in r.enumerated() {
                let s = sizes[i]
                let self_ = subviews[i][ZnAlignSelfKey.self]
                let align = self_ >= 0 ? self_ : alignItems
                let dy: CGFloat = switch align {
                case Registry.AlignItems.center: (lineHeights[l] - s.height) / 2
                case Registry.AlignItems.flexEnd: lineHeights[l] - s.height
                default: 0
                }
                frames[i] = CGRect(x: xs[k], y: tops[l] + dy, width: main[i], height: s.height)
            }
        }
        return Measured(size: CGSize(width: width, height: height), frames: frames)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        measure(proposal, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let m = measure(ProposedViewSize(bounds.size), subviews)
        for (i, sv) in subviews.enumerated() {
            let f = m.frames[i]
            sv.znPlace(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), in: bounds,
                       proposal: ProposedViewSize(f.size))
        }
    }
}
