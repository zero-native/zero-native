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

/// A pinned row (stickyHeaderIndices) and the rows after it up to the next pinned one: one section of the SwiftUI
/// list, whose header SwiftUI pins.
struct ZnStickyRun: Equatable {
    let pinned: Int
    let rows: Range<Int>
}

/// The SwiftUI list's sections for pinned rows [sticky] (sorted, from znParseSticky) in [rows] rows: [lead] rows before
/// the first pinned one, then one run per pinned row inside the rows.
func znStickyRuns(_ sticky: [Int], rows: Int) -> (lead: Int, sections: [ZnStickyRun]) {
    let pins = sticky.filter { $0 >= 0 && $0 < rows }
    guard let first = pins.first else { return (rows, []) }
    var out: [ZnStickyRun] = []
    for (k, p) in pins.enumerated() {
        let next = k + 1 < pins.count ? pins[k + 1] : rows
        out.append(ZnStickyRun(pinned: p, rows: (p + 1)..<next))
    }
    return (first, out)
}

// MARK: - Item animation (itemAnimation, reorderable)

/// One move in a list update: the item at [from] (before) goes to [to] (after).
struct ZnListMove: Equatable {
    let from: Int
    let to: Int
}

/// A keyed change of the rows part as UICollectionView updates: deletes and the moves' [from] are indices before,
/// inserts and the moves' [to] after (performBatchUpdates' rules). Moves let a row glide to its new place (Compose's
/// animateItem placement) instead of fading out and in again.
struct ZnListUpdates: Equatable {
    var deletes: [Int] = []
    var inserts: [Int] = []
    var moves: [ZnListMove] = []

    var count: Int { deletes.count + inserts.count + moves.count }

    /// Does every change come before the item at [first] (its index before)? Then the items from there on stay as they
    /// are, only further along: nothing on screen changes, so the list keeps its place without an animation.
    func onlyBefore(_ first: Int) -> Bool {
        let removed = deletes.count + moves.count
        let added = inserts.count + moves.count
        guard deletes.allSatisfy({ $0 < first }), moves.allSatisfy({ $0.from < first }) else { return false }
        // The item at [first] is now at first - removed + added; every insert (and move target) lands before it.
        let now = first - removed + added
        return inserts.allSatisfy { $0 < now } && moves.allSatisfy { $0.to < now }
    }
}

/// The updates from [old] to [new] keys, moves found (Swift's CollectionDifference with inferringMoves), or nil for a
/// reload: no rows before (the first fill doesn't animate, as Compose's first layout), or more than [cap] changes. Only
/// the changed middle is diffed (znChangedRanges), so a long list with one change stays cheap.
func znListUpdates(_ old: [String], _ new: [String], cap: Int = 300) -> ZnListUpdates? {
    guard !old.isEmpty else { return nil }
    let ranges: (removed: Range<Int>, inserted: Range<Int>)
    if new.isEmpty { ranges = (0..<old.count, 0..<0) } else if let r = znChangedRanges(old, new) { ranges = r } else { return nil }
    let (removed, inserted) = ranges
    if removed.isEmpty && inserted.isEmpty { return ZnListUpdates() }
    // By key, in O(n log n): keys only in the old middle are deleted, only in the new one inserted; of the keys in
    // both, the longest run already in order stays, the others move (a row moved far is one move, not a long diff).
    var oldAt = [String: Int](minimumCapacity: removed.count)
    for i in removed {
        guard oldAt.updateValue(i, forKey: old[i]) == nil else { return nil }  // a key twice: reload
    }
    var newKeys = Set<String>(minimumCapacity: inserted.count)
    for j in inserted { guard newKeys.insert(new[j]).inserted else { return nil } }
    var out = ZnListUpdates()
    for i in removed where !newKeys.contains(old[i]) { out.deletes.append(i) }
    var common: [(from: Int, to: Int)] = []
    for j in inserted {
        if let i = oldAt[new[j]] { common.append((i, j)) } else { out.inserts.append(j) }
    }
    let stay = znLongestIncreasing(common.map(\.from))
    for (k, c) in common.enumerated() where !stay.contains(k) { out.moves.append(ZnListMove(from: c.from, to: c.to)) }
    return out.count <= cap ? out : nil
}

/// The positions in [xs] of one longest strictly increasing run (patience sorting, O(n log n)).
func znLongestIncreasing(_ xs: [Int]) -> Set<Int> {
    var tails: [Int] = []  // positions in xs: the smallest tail of a run of each length
    var prev = [Int](repeating: -1, count: xs.count)
    for (p, x) in xs.enumerated() {
        var lo = 0, hi = tails.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if xs[tails[mid]] < x { lo = mid + 1 } else { hi = mid }
        }
        if lo > 0 { prev[p] = tails[lo - 1] }
        if lo == tails.count { tails.append(p) } else { tails[lo] = p }
    }
    var out = Set<Int>()
    var p = tails.last ?? -1
    while p >= 0 { out.insert(p); p = prev[p] }
    return out
}

/// A drop's wait for JS (Android's ZnReorder: the order shown after a drop stays until JS's rows change, or a second
/// passes and the row goes back). [version] is ZnListState.version at the drop.
struct ZnReorderWait: Equatable {
    static let ms = 1000
    var version: Int?

    /// JS's rows now have [version]: keep the dropped order (true) while JS hasn't answered; an answer ends the wait.
    mutating func keepsOrder(at version: Int) -> Bool {
        guard let v = self.version else { return false }
        if v == version { return true }
        self.version = nil
        return false
    }

    /// The second has passed: go back to JS's order if JS still hasn't answered (true), else nothing to do.
    mutating func timedOut(at version: Int) -> Bool {
        defer { self.version = nil }
        return self.version == version
    }
}

/// The new place of the row dragged from [from] (rows part) to the drop's place [to] in [part], kept in the rows: the
/// header or empty item → the first row, the footer → the last (a row can't leave the rows).
func znDropTarget(part: ZnListPart, item: Int, rows: Int) -> Int {
    guard rows > 0 else { return 0 }
    switch part {
    case .header, .empty: return 0
    case .footer: return rows - 1
    case .rows: return min(max(item, 0), rows - 1)
    }
}

// MARK: - Image preload (ZnImagePreload.swift)

/// The rows whose pictures load ahead (Android's ZnPreloadAhead): the next [ahead] rows past the last item on screen
/// when the list last moved toward its end (and at first), else the [ahead] before the first one. [first] / [last]
/// are rows-part items (grid lines with [cols] > 1), nearest first; rows past either end are left out.
func znPreloadRows(first: Int, last: Int, forward: Bool, rows: Int, cols: Int, ahead: Int = 8) -> [Int] {
    let c = max(cols, 1)
    let items = (ahead + c - 1) / c
    var out: [Int] = []
    let lines = forward ? Array((last + 1)..<(last + 1 + items)) : Array(stride(from: first - 1, through: first - items, by: -1))
    for g in lines where g >= 0 {
        for r in znGridRows(line: g, cols: c, rows: rows) { out.append(r) }
    }
    return out
}

/// The preload's book keeping, as Android's ZnImagePreload: URLs waiting or running (at most [maxPending], all lists
/// together), how many run at once ([maxRunning]: a low-priority queue that never crowds an on-screen picture), and
/// the URLs done in this process (the last [doneKeep], so a list scrolled back and forth doesn't ask again).
struct ZnPreloadBook {
    static let maxPerRow = 4
    static let maxInstancesPerRow = 64

    var maxPending = 24
    var maxRunning = 3
    var doneKeep = 512
    /// URL → its owner (a list), in the order asked.
    private(set) var waiting: [(url: String, owner: Int)] = []
    private(set) var running: [String: Int] = [:]
    private var done: [String: Int] = [:]
    private var doneTick = 0

    var pending: Int { waiting.count + running.count }

    func isWaitingOrRunning(_ url: String) -> Bool { running[url] != nil || waiting.contains { $0.url == url } }

    func isKnown(_ url: String) -> Bool { done[url] != nil || isWaitingOrRunning(url) }

    /// Asks for [url] for [owner]: false when it is done, already asked, or the book is full.
    mutating func want(_ url: String, owner: Int) -> Bool {
        guard !isKnown(url), pending < maxPending else { return false }
        waiting.append((url, owner))
        return true
    }

    /// The next URLs to start now (up to [maxRunning] running).
    mutating func next() -> [String] {
        var out: [String] = []
        while running.count < maxRunning, !waiting.isEmpty {
            let w = waiting.removeFirst()
            running[w.url] = w.owner
            out.append(w.url)
        }
        return out
    }

    /// A preload ended; [ok]: its picture is on disk now.
    mutating func finished(_ url: String, ok: Bool) {
        running[url] = nil
        if ok { markDone(url) }
    }

    /// An on-screen picture asked for [url]: no preload for it from now on. True when its preload was still waiting or
    /// running (iOS joins the running download, so it is not fetched twice; a waiting one is dropped).
    mutating func onScreen(_ url: String) -> Bool {
        let was = running[url] != nil || waiting.contains { $0.url == url }
        waiting.removeAll { $0.url == url }
        markDone(url)
        return was
    }

    /// Drops the waiting URLs of [owner] (the list left, or [keep] says its row is gone); returns the running ones
    /// to cancel (they end with finished(ok: false)).
    mutating func drop(owner: Int, keep: (String) -> Bool = { _ in false }) -> [String] {
        waiting.removeAll { $0.owner == owner && !keep($0.url) }
        return running.filter { $0.value == owner && !keep($0.key) }.map(\.key)
    }

    /// Everything waiting is dropped; returns the running ones to cancel (low memory).
    mutating func dropAll() -> [String] {
        waiting.removeAll()
        return Array(running.keys)
    }

    private mutating func markDone(_ url: String) {
        doneTick += 1
        done[url] = doneTick
        if done.count > doneKeep {
            // Forget the oldest quarter at once (cheap, rarely).
            let cut = done.sorted { $0.value < $1.value }.prefix(done.count - doneKeep * 3 / 4)
            for (u, _) in cut { done[u] = nil }
        }
    }
}

/// An http(s) src (the only kind preloaded).
func znIsRemoteSrc(_ src: String) -> Bool {
    let l = src.prefix(8).lowercased()
    return l.hasPrefix("https://") || l.hasPrefix("http://")
}
