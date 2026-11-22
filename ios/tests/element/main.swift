// useElementMotion's plain rules on the Mac (ZnElementRules.swift). The cases follow android/runtime: a List's index /
// offset are Compose's firstVisibleItemIndex / firstVisibleItemScrollOffset over its lazy items (header, empty, rows or
// grid lines, footer); follow by index takes floor(v) and the fraction of its size (ZnRenderer.kt ZnLazyList); a
// Carousel's page is currentPage + currentPageOffsetFraction and follows with scrollToPage(round(v), v - round(v));
// pull is ZnPullMath.progress with the disc's 1.5-line cap (ZnPullRefresh.kt).
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

func pos(_ at: Double, _ starts: [(Int, Double)]) -> [Double]? {
    ZnElementRules.listPosition(at: at, starts: starts.map { (item: $0.0, start: $0.1) }).map { [Double($0.item), $0.offset] }
}

// Flat items: header 0, empty 1 (only with no rows), rows (or grid lines), footer.
let shape = ZnListShape(header: true, empty: true, rows: 10, footer: true, cols: 1)
check("header is 0", shape.flat(.header, 0), 0)
check("first row after the header", shape.flat(.rows, 0), 1)
check("row 9", shape.flat(.rows, 9), 10)
check("footer after the rows", shape.flat(.footer, 0), 11)
let empty = ZnListShape(header: true, empty: true, rows: 0, footer: true, cols: 1)
check("empty item while no rows", empty.flat(.empty, 0), 1)
check("footer after empty", empty.flat(.footer, 0), 2)
let grid = ZnListShape(header: false, empty: false, rows: 7, footer: true, cols: 3)
check("grid footer after 3 lines", grid.flat(.footer, 0), 3)
for f in 0..<shape.total {
    let it = shape.item(f)!
    check("flat \(f) round trip", shape.flat(it.part, it.item), f)
}

// index / offset: the last item starting at or before the scroll position. Rows 48 tall, gap 8: starts 0, 56, 112...
let rows: [(Int, Double)] = [(1, 0), (2, 56), (3, 112), (4, 168)]
check("at rest", pos(0, rows), [1, 0])
check("10 into the first", pos(10, rows), [1, 10])
check("in the gap after the first: still the first", pos(52, rows), [1, 52])
check("exactly at the second", pos(56, rows), [2, 0])
check("half a pixel early counts", pos(55.6, rows), [2, 0])
check("third, 20 in", pos(132, rows), [3, 20])
check("order doesn't matter", pos(132, rows.reversed()), [3, 20])
check("before the first item (a gap at the top): the first, 0 past", pos(0, [(5, 12), (6, 70)]), [5, 0])
check("no items", pos(10, []), nil)

// follow on a List: floor and the fraction; past the end the last item; below 0 the first.
func lf(_ v: Double, _ total: Int) -> [Double]? { ZnElementRules.listFollow(v, total: total).map { [Double($0.item), $0.fraction] } }
check("follow 3.5", lf(3.5, 10), [3, 0.5])
check("follow 0", lf(0, 10), [0, 0])
check("follow below 0", lf(-2, 10), [0, 0])
check("follow past the end", lf(42.25, 10), [9, 1])
check("follow on an empty list", lf(1, 0), nil)
check("follow NaN", lf(.nan, 10), nil)

// Carousel page: offset over (width + gap), kept between the first and the last page.
check("page 0", ZnElementRules.carouselPage(offset: 0, pageWidth: 300, gap: 12, count: 5), 0)
check("page 2.5", ZnElementRules.carouselPage(offset: 780, pageWidth: 300, gap: 12, count: 5), 2.5)
check("page bounce before", ZnElementRules.carouselPage(offset: -40, pageWidth: 300, gap: 12, count: 5), 0)
check("page past the last", ZnElementRules.carouselPage(offset: 5000, pageWidth: 300, gap: 12, count: 5), 4)
check("page with no size", ZnElementRules.carouselPage(offset: 100, pageWidth: 0, gap: 0, count: 5), 0)

// Carousel follow: round(v) and the fraction within ±0.5, kept inside the content.
func cf(_ v: Double, max: Double = 10_000) -> Double? {
    ZnElementRules.carouselFollow(v, pageWidth: 300, gap: 12, count: 5, maxOffset: max)
}
check("follow page 3", cf(3), 936)
check("follow page 2.5 (round up to 3, -0.5)", cf(2.5), 780)
check("follow page 1.25", cf(1.25), 390)
// Past the last page: the last, plus at most half a page (Android's fraction cap), then the content's end.
check("follow page 9 (last + 0.5)", cf(9), 1404)
check("follow page 9 at the content's end", cf(9, max: 1248), 1248)
check("follow kept inside", cf(4, max: 1000), 1000)
check("follow below the start", cf(-1), 0)
check("follow on no pages", ZnElementRules.carouselFollow(1, pageWidth: 300, gap: 12, count: 0, maxOffset: 100), nil)

// pull: distance over the line, capped at 1.5.
check("pull none", ZnElementRules.pull(distance: 0, line: 100), 0)
check("pull half", ZnElementRules.pull(distance: 50, line: 100), 0.5)
check("pull at the line", ZnElementRules.pull(distance: 100, line: 100), 1)
check("pull capped", ZnElementRules.pull(distance: 400, line: 100), 1.5)
check("pull bounce up", ZnElementRules.pull(distance: -20, line: 100), 0)

print(failures == 0 ? "ios element rules: \(count) checks passed" : "ios element rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
