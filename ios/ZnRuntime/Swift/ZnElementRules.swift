// The plain rules behind useElementMotion's scroll values (ZnElementMotion.swift, ZnList.swift, ZnCarousel.swift),
// apart from UIKit so the Mac suite (ios/tests/element) checks them. Foundation only. Points everywhere (dp on Android).
import Foundation

extension ZnListShape {
    /// The flat item (Android's lazy item index: header, empty, rows or grid lines, footer) of [item] in [part].
    func flat(_ part: ZnListPart, _ item: Int) -> Int {
        ZnListPart.allCases.filter { $0.rawValue < part.rawValue }.reduce(0) { $0 + count($1) } + item
    }
}

enum ZnElementRules {
    /// The item at a list's scroll position [at] (from the content's start) and how far it is scrolled past, from the
    /// items on screen ([starts]: each one's start along the list, in any order): the last one starting at or before
    /// [at] (Compose's firstVisibleItemIndex / firstVisibleItemScrollOffset; an item's trailing gap counts as its own).
    /// Nil with no items. Before the first item (a gap at the top), the first one, 0 past.
    static func listPosition(at: Double, starts: [(item: Int, start: Double)]) -> (item: Int, offset: Double)? {
        let sorted = starts.sorted { $0.start < $1.start }
        guard var pick = sorted.first else { return nil }
        for s in sorted where s.start <= at + 0.5 { pick = s }
        return (pick.item, max(0, at - pick.start))
    }

    /// A Carousel's page as a number (Compose's currentPage + currentPageOffsetFraction): how far it is scrolled from
    /// its first page ([offset], from the content's start) over the step from one page to the next (width + gap), kept
    /// between the first and the last page.
    static func carouselPage(offset: Double, pageWidth: Double, gap: Double, count: Int) -> Double {
        let step = pageWidth + gap
        guard step > 0, count > 0 else { return 0 }
        return min(max(offset / step, 0), Double(count - 1))
    }

    /// m.follow(v) on a Carousel (Android: pager.scrollToPage(round(v), v - round(v))): the offset from the content's
    /// start, kept inside the content ([maxOffset]).
    static func carouselFollow(_ v: Double, pageWidth: Double, gap: Double, count: Int, maxOffset: Double) -> Double? {
        guard count > 0, v.isFinite else { return nil }
        let p = min(max(Int(v.rounded()), 0), count - 1)
        let frac = min(max(v - Double(p), -0.5), 0.5)
        return min(max((Double(p) + frac) * (pageWidth + gap), 0), max(0, maxOffset))
    }

    /// m.follow(v) on a List: the item floor(v) (kept inside the list) and the share of its size past its start.
    static func listFollow(_ v: Double, total: Int) -> (item: Int, fraction: Double)? {
        guard total > 0, v.isFinite else { return nil }
        let i = min(Int(max(0, v.rounded(.down))), total - 1)
        return (i, min(max(v - Double(i), 0), 1))
    }

    /// m.pull: the pulled distance over the refresh line, 0 → 1, at most 1.5 (Android's disc stops at 1.5 lines).
    static func pull(distance: Double, line: Double) -> Double {
        guard line > 0, distance > 0 else { return 0 }
        return min(1.5, distance / line)
    }
}
