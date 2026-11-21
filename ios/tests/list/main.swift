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

print(failures == 0 ? "ios list logic: \(count) checks passed" : "ios list logic: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
