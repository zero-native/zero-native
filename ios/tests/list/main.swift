// <List>'s pure rules on the Mac (ZnListLogic.swift, ZnScrollCommand.swift). The cases follow android/runtime's
// ZnLazyList (ZnRenderer.kt): the item order header, empty, rows, footer; one lazy item per grid line; the visible
// range from the items on screen; scrollToIndex / scrollToEnd's target item.
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func range(_ visible: [(ZnListPart, Int)], rows: Int, cols: Int = 1, pinned: Set<Int> = []) -> [Int] {
    let r = znVisibleRange(visible.map { (part: $0.0, item: $0.1) }, rows: rows, cols: cols, pinned: pinned)
    return [r.0, r.1]
}

func at(_ shape: ZnListShape, _ flat: Int) -> String? { shape.item(flat).map { "\($0.part)\($0.item)" } }

// Grid lines (RN numColumns): n = 119, c = 3 → 40 lines, line 39 = rows 117-118.
check("lines 119 / 3", znGridLines(rows: 119, cols: 3), 40)
check("lines 41 / 2", znGridLines(rows: 41, cols: 2), 21)
check("lines 0", znGridLines(rows: 0, cols: 3), 0)
check("lines one column", znGridLines(rows: 7, cols: 1), 7)
check("last line short", znGridRows(line: 39, cols: 3, rows: 119), 117..<119)
check("first line", znGridRows(line: 0, cols: 3, rows: 119), 0..<3)
check("line past the end", znGridRows(line: 50, cols: 3, rows: 119), 119..<119)
// A line drawn from its first row's key (a cell UIKit keeps while rows are added above it): rows a...f in 2 columns,
// x, y added at the top. The cell of line "__zn_g:a" finds a at 2 and draws a, b, not x, y.
let before = ["a", "b", "c", "d", "e", "f"], after = ["x", "y"] + before
check("prepend keeps the line's rows", znGridRows(from: after.firstIndex(of: "a"), cols: 2, rows: after.count), 2..<4)
check("prepend splice is one insert", znChangedRanges(znLineKeys(before, cols: 2), znLineKeys(after, cols: 2)).map { [$0.removed, $0.inserted] }, [0..<0, 0..<1])
check("removed first line keeps the others", znGridRows(from: Array(before.dropFirst(2)).firstIndex(of: "e"), cols: 2, rows: 4), 2..<4)
check("short last line by key", znGridRows(from: 118, cols: 3, rows: 119), 118..<119)
check("gone first row draws nothing", znGridRows(from: nil, cols: 2, rows: 6), 6..<6)
// numColumns: the slot wins, 1...12, always 1 sideways.
check("cols from slot", znGridColumns(slot: 3, fixed: 2, horizontal: false), 3)
check("cols slot clamped", znGridColumns(slot: 40, fixed: 2, horizontal: false), 12)
check("cols slot 0 → 1", znGridColumns(slot: 0, fixed: 2, horizontal: false), 1)
check("cols slot NaN → fixed", znGridColumns(slot: .nan, fixed: 2, horizontal: false), 2)
check("cols no slot", znGridColumns(slot: nil, fixed: 4, horizontal: false), 4)
check("cols horizontal", znGridColumns(slot: 3, fixed: 3, horizontal: true), 1)
// Line keys: "__zn_g:" + the first row's key.
check("line keys", znLineKeys(["a", "b", "c", "d", "e"], cols: 2), ["__zn_g:a", "__zn_g:c", "__zn_g:e"])
check("line keys one column", znLineKeys(["a", "b"], cols: 1), ["a", "b"])

// The item order: header, empty (no rows only), rows, footer.
let full = ZnListShape(header: true, empty: true, rows: 30, footer: true, cols: 1)
check("total with rows", full.total, 32)  // the empty item isn't drawn while there are rows
check("item 0 header", at(full, 0), "header0")
check("item 1 row 0", at(full, 1), "rows0")
check("item 31 footer", at(full, 31), "footer0")
check("item 32 none", at(full, 32), nil)
let none = ZnListShape(header: true, empty: true, rows: 0, footer: true, cols: 1)
check("total empty", none.total, 3)
check("empty shows", at(none, 1), "empty0")
check("gap before rows after header", full.gapBefore(.rows), true)
check("no gap before header", full.gapBefore(.header), false)
check("gap before footer", full.gapBefore(.footer), true)
check("no gap before a hidden empty", full.gapBefore(.empty), false)
check("gap before empty after header", none.gapBefore(.empty), true)
check("no gap before first rows", ZnListShape(rows: 3).gapBefore(.rows), false)
let grid = ZnListShape(header: true, rows: 119, footer: true, cols: 3)
check("grid total", grid.total, 42)

// Visible range (ZnRenderer.kt ZnLazyList's snapshotFlow).
check("rows", range([(.header, 0), (.rows, 0), (.rows, 4)], rows: 30), [0, 4])
check("pinned left out", range([(.rows, 0), (.rows, 31), (.rows, 32)], rows: 60, pinned: [0, 20]), [31, 32])
check("only pinned", range([(.rows, 20)], rows: 60, pinned: [0, 20]), [20, 20])
check("only the footer → last row", range([(.footer, 0)], rows: 30), [29, 29])
check("rows and footer", range([(.rows, 27), (.rows, 29), (.footer, 0)], rows: 30), [27, 29])
check("no rows", range([(.header, 0), (.empty, 0), (.footer, 0)], rows: 0), [0, 0])
check("only the header", range([(.header, 0)], rows: 30), [0, 0])
check("nothing on screen", range([], rows: 30), [0, 0])
check("grid lines → rows", range([(.rows, 2), (.rows, 5)], rows: 41, cols: 2), [4, 11])
check("grid short last line", range([(.rows, 38), (.rows, 39)], rows: 119, cols: 3), [114, 118])
check("grid only footer", range([(.footer, 0)], rows: 41, cols: 2), [40, 40])
check("grid pinned ignored", range([(.rows, 0)], rows: 41, cols: 2, pinned: [0]), [0, 1])

// Splices between two key lists.
func ranges(_ a: [String], _ b: [String]) -> String {
    znChangedRanges(a, b).map { "\($0.removed.lowerBound)..<\($0.removed.upperBound) → \($0.inserted.lowerBound)..<\($0.inserted.upperBound)" } ?? "all"
}
check("insert at top", ranges(["a", "b"], ["n", "a", "b"]), "0..<0 → 0..<1")
check("append", ranges(["a", "b"], ["a", "b", "c", "d"]), "2..<2 → 2..<4")
check("remove middle", ranges(["a", "b", "c"], ["a", "c"]), "1..<2 → 1..<1")
check("replace block", ranges(["a", "b", "c", "d"], ["a", "x", "y", "d"]), "1..<3 → 1..<3")
check("same", ranges(["a"], ["a"]), "1..<1 → 1..<1")
check("from empty", ranges([], ["a"]), "all")
check("to empty", ranges(["a"], []), "all")

// Scroll command targets (ZnRenderer.kt's scroll command effect): index → its grid line after the header, clamped;
// end → the last item.
func target(_ text: String, _ shape: ZnListShape) -> Int? { znScrollTarget(ZnScrollCommand(text)!, shape) }
check("index 15", target("index:15:1:0:3", full), 16)
check("index 0", target("index:0:1:0:3", full), 1)
check("index past the rows", target("index:99:1:0:3", full), 30)
check("index negative", target("index:-4:1:0:3", full), 1)
check("index 30 in a 3-column grid", target("index:30:1:0:1", grid), 11)
check("index 30 in a 2-column grid", target("index:30:1:0:1", ZnListShape(header: true, rows: 41, footer: true, cols: 2)), 16)
check("end is the footer", target("end:0:1:0:4", full), 31)
check("end with no footer", target("end:0:1:0:4", ZnListShape(rows: 5)), 4)
check("index with no rows: the empty item", target("index:15:1:0:3", none), 1)
check("end with no rows: the footer", target("end:0:1:0:3", none), 2)
check("index with nothing", target("index:3:1:0:3", ZnListShape()), nil)
check("offset has no item", target("offset:120:1:0:5", full), nil)
check("offset abc is 0", ZnScrollCommand("offset:abc:1:0:5")?.param, 0)
check("missing seq", ZnScrollCommand("index:15:1:0") == nil, true)
// Offsets kept inside the content: from -padding before to the end.
check("clamp below the start", znClampOffset(-50, before: 8, content: 1000, viewport: 400, after: 8), -8)
check("clamp past the end", znClampOffset(5000, before: 8, content: 1000, viewport: 400, after: 8), 608)
check("clamp short content", znClampOffset(100, before: 0, content: 300, viewport: 400, after: 0), 0)
check("clamp inside", znClampOffset(200, before: 0, content: 1000, viewport: 400, after: 0), 200)

// itemAnimation (Android's animateItem): keyed updates with moves, as UICollectionView applies them. [play] runs them
// on [old] the way performBatchUpdates does (deletes and move sources from the old indices, inserts and move targets
// at the new ones), so each case checks the updates really give [new].
func play(_ old: [String], _ u: ZnListUpdates, _ new: [String]) -> [String] {
    let gone = Set(u.deletes + u.moves.map(\.from))
    var placed = [Int: String]()
    for m in u.moves { placed[m.to] = old[m.from] }
    for i in u.inserts { placed[i] = new[i] }
    var rest = old.enumerated().filter { !gone.contains($0.offset) }.map(\.element).makeIterator()
    return (0..<(old.count - gone.count + placed.count)).compactMap { placed[$0] ?? rest.next() }
}
func updates(_ old: [String], _ new: [String], cap: Int = 300) -> String {
    guard let u = znListUpdates(old, new, cap: cap) else { return "reload" }
    if play(old, u, new) != new { return "WRONG \(play(old, u, new))" }
    return "-\(u.deletes) +\(u.inserts) " + u.moves.map { "\($0.from)>\($0.to)" }.joined(separator: ",")
}
let abc = ["a", "b", "c", "d", "e", "f"]
check("same keys", updates(abc, abc), "-[] +[] ")
check("remove one", updates(abc, ["a", "b", "d", "e", "f"]), "-[2] +[] ")
check("add at the top", updates(abc, ["n"] + abc), "-[] +[0] ")
check("last to top is a move", updates(abc, ["f", "a", "b", "c", "d", "e"]), "-[] +[] 5>0")
check("first to the end is a move", updates(abc, ["b", "c", "d", "e", "f", "a"]), "-[] +[] 0>5")
check("swap pairs are moves", updates(abc, ["b", "a", "d", "c", "f", "e"]).hasPrefix("-[] +[] "), true)
check("swap pairs play right", updates(abc, ["b", "a", "d", "c", "f", "e"]).contains("WRONG"), false)
check("remove, add and move at once", updates(abc, ["f", "a", "x", "c", "d"]).contains("WRONG"), false)
check("all gone", updates(abc, []), "-[0, 1, 2, 3, 4, 5] +[] ")
check("first fill reloads", updates([], abc), "reload")
check("too many changes reload", updates(abc, ["u", "v", "w", "x", "y", "z"], cap: 4), "reload")
let long = (0..<10_000).map { "k\($0)" }
var longMoved = long
longMoved.insert(longMoved.remove(at: 9_000), at: 10)
check("one move in 10,000 rows", updates(long, longMoved), "-[] +[] 9000>10")
// Animate only a change that shows: all before the first row on screen → keep the place instead.
check("insert above the screen", znListUpdates(abc, ["n"] + abc)!.onlyBefore(2), true)
check("insert at the first shown", znListUpdates(abc, ["a", "b", "n", "c", "d", "e", "f"])!.onlyBefore(2), true)
check("insert inside the screen", znListUpdates(abc, ["a", "b", "c", "n", "d", "e", "f"])!.onlyBefore(2), false)
check("remove above the screen", znListUpdates(abc, ["b", "c", "d", "e", "f"])!.onlyBefore(2), true)
check("remove the first shown", znListUpdates(abc, ["a", "b", "d", "e", "f"])!.onlyBefore(2), false)
check("move from below to the top", znListUpdates(abc, ["f", "a", "b", "c", "d", "e"])!.onlyBefore(2), false)

// Drag to reorder (Android's ZnReorder): the order shown after a drop stays until JS's rows change; a second without
// an answer → back to JS's order.
var wait = ZnReorderWait()
check("no wait at first", wait.keepsOrder(at: 4), false)
wait.version = 4
check("JS hasn't answered: keep the drop", wait.keepsOrder(at: 4), true)
check("JS answered: show its rows", wait.keepsOrder(at: 5), false)
check("the answer ends the wait", wait.version, nil)
wait.version = 7
check("a second, no answer: go back", wait.timedOut(at: 7), true)
check("timeout ends the wait", wait.version, nil)
wait.version = 7
check("a second after an answer: nothing", wait.timedOut(at: 8), false)
check("drop on the header: first row", znDropTarget(part: .header, item: 0, rows: 9), 0)
check("drop on the footer: last row", znDropTarget(part: .footer, item: 0, rows: 9), 8)
check("drop past the rows", znDropTarget(part: .rows, item: 12, rows: 9), 8)
check("drop in the rows", znDropTarget(part: .rows, item: 3, rows: 9), 3)

// Image preload (Android's ZnImagePreload / ZnPreloadAhead): the rows ahead in the scroll direction.
check("ahead going down", znPreloadRows(first: 0, last: 5, forward: true, rows: 60, cols: 1), Array(6..<14))
check("ahead going up", znPreloadRows(first: 20, last: 26, forward: false, rows: 60, cols: 1), Array((12...19).reversed()))
check("ahead near the end", znPreloadRows(first: 50, last: 57, forward: true, rows: 60, cols: 1), [58, 59])
check("ahead near the start", znPreloadRows(first: 2, last: 9, forward: false, rows: 60, cols: 1), [1, 0])
check("ahead in a 3-column grid", znPreloadRows(first: 0, last: 2, forward: true, rows: 40, cols: 3), Array(9..<18))
var book = ZnPreloadBook()
check("want a url", book.want("https://x/1", owner: 1), true)
check("not twice", book.want("https://x/1", owner: 1), false)
for i in 2...30 { _ = book.want("https://x/\(i)", owner: i < 20 ? 1 : 2) }
check("24 waiting or running at most", book.pending, 24)
check("3 run at once", book.next(), ["https://x/1", "https://x/2", "https://x/3"])
check("no more while 3 run", book.next(), [])
book.finished("https://x/1", ok: true)
check("done is not asked again", book.want("https://x/1", owner: 1), false)
check("the next one starts", book.next(), ["https://x/4"])
check("on screen while running is early", book.onScreen("https://x/2"), true)
check("on screen while waiting is early", book.onScreen("https://x/10"), true)
check("on screen when not asked", book.onScreen("https://y/1"), false)
check("a list leaving stops its running ones", Set(book.drop(owner: 1)), ["https://x/2", "https://x/3", "https://x/4"])
check("its waiting ones are gone", book.isWaitingOrRunning("https://x/12"), false)
check("another list's stay", book.isWaitingOrRunning("https://x/20"), true)
check("keep: rows still there stay", book.drop(owner: 2, keep: { $0 != "https://x/21" }), [])
check("keep: a gone row is dropped", book.isWaitingOrRunning("https://x/21"), false)
var small = ZnPreloadBook()
small.doneKeep = 8
for i in 0..<20 { _ = small.want("https://z/\(i)", owner: 0); _ = small.next(); small.finished("https://z/\(i)", ok: true) }
check("old done ones are forgotten", small.isKnown("https://z/0"), false)
check("new done ones are kept", small.isKnown("https://z/19"), true)
check("remote src", [znIsRemoteSrc("https://a"), znIsRemoteSrc("HTTP://a"), znIsRemoteSrc("asset:x.png"), znIsRemoteSrc("zn://file/a")], [true, true, false, false])

print(failures == 0 ? "ios list logic: \(count) checks passed" : "ios list logic: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
