// <List>'s pure rules (Foundation only), so the Mac harness (ios/tests/list, ios/tests/spec) builds them without UIKit
// or SwiftUI: pinned rows, the grid row style, the item order (header, empty, rows, footer), grid lines, the visible
// range sent to JS, the splice between two key lists and a scroll command's target. Ports of android/runtime's
// ZnLazyList (ZnRenderer.kt), parseSticky and ZnColumnWrapper (ZnTemplate.kt).
import Foundation

/// "1,30" → the sorted, distinct row indices (bad entries dropped), as Android's parseSticky.
func znParseSticky(_ text: String?) -> [Int] {
    guard let text else { return [] }
    return Array(Set(text.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }.filter { $0 >= 0 })).sorted()
}

/// RN columnWrapperStyle (registry 24), written by the compiler as "g<gap>;j<justify>;a<align>;p<start>,<top>,<end>,<bottom>"
/// (-1: unset). A grid row is laid out like a <Row> with these. Unreadable parts keep their defaults (ZnTemplate.kt).
struct ZnColumnWrapper: Equatable {
    var gap: Double = 0
    var justify = -1
    var align = -1
    var start: Double = 0, top: Double = 0, end: Double = 0, bottom: Double = 0

    static let none = ZnColumnWrapper()

    static func parse(_ s: String?) -> ZnColumnWrapper {
        guard let s, !s.isEmpty else { return .none }
        var w = ZnColumnWrapper()
        for part in s.split(separator: ";", omittingEmptySubsequences: true) {
            let v = String(part.dropFirst())
            switch part.first {
            case "g": w.gap = Double(v).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } ?? 0
            case "j": w.justify = Int(v) ?? -1
            case "a": w.align = Int(v) ?? -1
            case "p":
                let pad = v.split(separator: ",", omittingEmptySubsequences: false).compactMap { Double($0) }
                if pad.count == 4 { (w.start, w.top, w.end, w.bottom) = (pad[0], pad[1], pad[2], pad[3]) }
            default: break
            }
        }
        return w
    }
}

/// The four parts of a List, in Android's item order (ZnRenderer.kt ZnLazyList, also when inverted): the header, the
/// empty item (only while there are no rows), the rows (one item per grid line in a grid), the footer. On iOS each
/// is a section of the collection view.
enum ZnListPart: Int, CaseIterable {
    case header = 0, empty = 1, rows = 2, footer = 3
}

/// How many items each part has now, and the grid's columns (1: a plain list).
struct ZnListShape: Equatable {
    var header = false
    var empty = false
    /// Rows, not lines.
    var rows = 0
    var footer = false
    var cols = 1

    /// Items in the rows part: grid lines when cols > 1 (the last one may be short).
    var lines: Int { znGridLines(rows: rows, cols: cols) }

    func count(_ part: ZnListPart) -> Int {
        switch part {
        case .header: return header ? 1 : 0
        case .empty: return empty && rows == 0 ? 1 : 0
        case .rows: return lines
        case .footer: return footer ? 1 : 0
        }
    }

    /// Every item, in order (Android's lazy item count).
    var total: Int { ZnListPart.allCases.reduce(0) { $0 + count($1) } }

    /// The [flat]th item in Android's order (0 = the first drawn), as its part and the item in it; nil past the end.
    func item(_ flat: Int) -> (part: ZnListPart, item: Int)? {
        guard flat >= 0 else { return nil }
        var left = flat
        for p in ZnListPart.allCases {
            let n = count(p)
            if left < n { return (p, left) }
            left -= n
        }
        return nil
    }

    /// The gap before a part's first item: the list's gap goes between every two items, extras too (Android's
    /// spacedBy), so a part that follows a drawn item starts one gap further.
    func gapBefore(_ part: ZnListPart) -> Bool {
        count(part) > 0 && ZnListPart.allCases.contains { $0.rawValue < part.rawValue && count($0) > 0 }
    }
}

/// Grid lines for [rows] items in [cols] columns (RN numColumns): one per started row of the grid.
func znGridLines(rows: Int, cols: Int) -> Int {
    let c = max(cols, 1)
    return rows <= 0 ? 0 : (rows + c - 1) / c
}

/// The rows in grid line [line]: line * cols until the next line, short at the end.
func znGridRows(line: Int, cols: Int, rows: Int) -> Range<Int> {
    let c = max(cols, 1)
    let from = min(max(line, 0) * c, max(rows, 0))
    return from..<min(from + c, max(rows, 0))
}

/// The rows of the grid line that starts at row [from] (its first row's index now, nil: gone): up to [cols] rows. A
/// line is drawn from its first row's key, so rows added or removed above it move it, never change what it draws.
func znGridRows(from: Int?, cols: Int, rows: Int) -> Range<Int> {
    let n = max(rows, 0)
    guard let from, from >= 0, from < n else { return n..<n }
    return from..<min(from + max(cols, 1), n)
}

/// <List numColumns> now: from its slot (a number, else the template's), 1...12 (Android's gridColumns); always 1 when
/// horizontal.
func znGridColumns(slot: Double?, fixed: Int, horizontal: Bool) -> Int {
    if horizontal { return 1 }
    if let v = slot, v.isFinite { return Int(min(max(v.rounded(.towardZero), 1), 12)) }
    return min(max(fixed, 1), 12)
}

/// The rows range "a,b" JS gets from the items on screen (ZnRenderer.kt's snapshotFlow in ZnLazyList): a grid line
/// counts as all its rows; a pinned row is left out while other rows show (it sits above rows far below it); only
/// pinned rows on screen give those; only the footer (past the rows) gives the last row, so JS knows it is at the
/// end; no rows, or only the header, give 0,0.
func znVisibleRange(_ visible: [(part: ZnListPart, item: Int)], rows n: Int, cols: Int, pinned: Set<Int>) -> (Int, Int) {
    let c = max(cols, 1)
    var lo = Int.max, hi = -1
    var pinnedLo = Int.max, pinnedHi = -1
    var pastRows = false
    for v in visible {
        switch v.part {
        case .footer: pastRows = true
        case .header, .empty: continue
        case .rows:
            let g = v.item
            if c > 1 {
                if g * c >= n { pastRows = true; continue }
                if g < 0 { continue }
                lo = min(lo, g * c)
                hi = max(hi, min(g * c + c - 1, n - 1))
                continue
            }
            if g >= n { pastRows = true; continue }
            if g < 0 { continue }
            if pinned.contains(g) { pinnedLo = min(pinnedLo, g); pinnedHi = max(pinnedHi, g) }
            else { lo = min(lo, g); hi = max(hi, g) }
        }
    }
    if hi >= 0 { return (lo, hi) }
    if pinnedHi >= 0 { return (pinnedLo, pinnedHi) }
    if n > 0 && pastRows { return (n - 1, n - 1) }
    return (0, 0)
}

/// The rows that differ between [old] and [new], found from their common start and end (a splice: an insert at the
/// top, a removal, a replaced block). O(n), so a 10,000-row list stays cheap. nil when either is empty (nothing is
/// shared: reload).
func znChangedRanges(_ old: [String], _ new: [String]) -> (removed: Range<Int>, inserted: Range<Int>)? {
    guard !old.isEmpty, !new.isEmpty else { return nil }
    var start = 0
    while start < old.count, start < new.count, old[start] == new[start] { start += 1 }
    var end = 0
    while end < old.count - start, end < new.count - start, old[old.count - 1 - end] == new[new.count - 1 - end] { end += 1 }
    return (start..<(old.count - end), start..<(new.count - end))
}

/// The keys the rows part is diffed by: the row keys, or in a grid one key per line, "__zn_g:" + its first row's key
/// (Android's lazy keys), so a new numColumns changes every line.
func znLineKeys(_ rowKeys: [String], cols: Int) -> [String] {
    guard cols > 1 else { return rowKeys }
    return stride(from: 0, to: rowKeys.count, by: cols).map { "__zn_g:" + rowKeys[$0] }
}

/// The item a scroll command goes to, in Android's order (ZnListShape.item), or nil when it moves by offset or does
/// nothing. index: its row (clamped to the rows) → its grid line, after the header; with no rows that lands on the
/// empty item (or what is there). end: the last item (the footer when there is one).
func znScrollTarget(_ cmd: ZnScrollCommand, _ shape: ZnListShape) -> Int? {
    let count = shape.total
    guard count > 0 else { return nil }
    switch cmd.action {
    case .index:
        let row = min(max(Int(cmd.param.rounded(.towardZero)), 0), max(shape.rows - 1, 0))
        return min(max(row / max(shape.cols, 1) + shape.count(.header), 0), count - 1)
    case .end: return count - 1
    default: return nil
    }
}

/// A scroll offset kept between the start (-[before], the padding before the content) and the end.
func znClampOffset(_ v: Double, before: Double, content: Double, viewport: Double, after: Double) -> Double {
    let lo = -before
    let hi = max(lo, content - viewport + after)
    return min(max(v, lo), hi)
}
