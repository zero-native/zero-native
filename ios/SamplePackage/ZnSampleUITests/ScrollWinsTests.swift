import XCTest

/// The List around a gesture takes the touch at its own slop (routes scrollWinsLab and scrollWinsLongLab,
/// examples/sample/src/ScrollWinsLab.tsx), as Compose's scroll consumes at its slop and the row inside gives up. Round 7
/// review: ZnGestureHub gives a pan that UIKit holds for the hub's claim one event of grace (a zoomed photo may claim in
/// it), then counts it as having the touch. Without that, a row whose own rule never fails on an up or down move (a
/// pan with only activeOffsetX, a long press with maxDistance 30) held the List still. And a {open && <Sheet>} that its
/// onDismiss removes, closed by a flick (route scrollWinsSheetLab): it slides down and goes, and opens again.
final class ScrollWinsTests: ZnUITestCase {
    private var status: XCUIElement { id("sw-status") }

    /// The number after [word] in the status ("scrolled 120 swipes 0").
    private func number(_ word: String) -> Int {
        let parts = status.label.split(separator: " ")
        guard let i = parts.firstIndex(of: Substring(word)), i + 1 < parts.count else { return -1 }
        return Int(parts[i + 1]) ?? -1
    }

    private func row(_ n: Int, _ what: String) -> XCUIElement { text("Row \(n) · \(what)") }

    /// A short slow drag up from [element], held at the end: [dy] points, about [seconds] in all.
    private func dragUp(_ element: XCUIElement, _ dy: CGFloat, hold: TimeInterval) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -dy)),
                    withVelocity: XCUIGestureVelocity(100), thenHoldForDuration: hold)
    }

    func testSwipeRowsLetTheListScroll() {
        launch("scrollWinsLab", ready: "sw-status")
        waitLabel(status, "scrolled 0 swipes 0")
        // 30 pt up, slowly: past the List's slop (about 10), inside nothing the row fails on.
        dragUp(row(4, "swipe me sideways"), 30, hold: 0.3)
        eventually("the List didn't scroll under a swipe row (\(status.label))") { number("scrolled") >= 8 }
        XCTAssertEqual(number("swipes"), 0, "the row swiped on a drag up")
        // A longer drag up scrolls as far.
        let before = number("scrolled")
        dragUp(row(8, "swipe me sideways"), 200, hold: 0.2)
        eventually("the long drag up didn't scroll (\(status.label))") { number("scrolled") >= before + 150 }
        // The row still swipes sideways.
        let r = row(10, "swipe me sideways")
        let start = r.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -120, dy: 0)), withVelocity: 300, thenHoldForDuration: 0.1)
        eventually("the row didn't swipe sideways (\(status.label))") { number("swipes") == 1 }
    }

    func testLongPressRowsLetTheListScrollAtItsSlop() {
        launch("scrollWinsLongLab", ready: "sw-status")
        waitLabel(status, "scrolled 0 long 0")
        // 25 pt up (inside the long press's 30), then held past its 0.5 s: the List has the touch from its slop, so
        // it scrolls and the long press doesn't start.
        dragUp(row(4, "long press me"), 25, hold: 0.8)
        eventually("the List didn't scroll at its slop (\(status.label))") { number("scrolled") >= 6 }
        XCTAssertEqual(number("long"), 0, "the long press started though the List had the touch")
        // Held still, the long press still starts.
        row(6, "long press me").press(forDuration: 1.0)
        eventually("the long press didn't start (\(status.label))") { number("long") == 1 }
    }

    func testSheetWhoseNodeLeavesInAFlick() {
        launch("scrollWinsSheetLab", ready: "sw-status")
        for round in 1...2 {
            id("sw-open").tap()
            waitLabel(status, "open closes \(round - 1)")
            let sheet = id("sw-sheet")
            XCTAssertTrue(appears(sheet, timeout: 5), "round \(round): no sheet")
            eventually("round \(round): the sheet didn't rise (\(id("sw-progress").label))", timeout: 3) { id("sw-progress").label == "progress 100%" }
            // A flick down on the sheet: onDismiss sets open false, so its node leaves while it slides.
            let start = text("A sheet that leaves the tree").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.02, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 250)), withVelocity: 2500, thenHoldForDuration: 0)
            waitLabel(status, "closed closes \(round)")
            eventually("round \(round): the sheet is still there") { !sheet.exists }
            eventually("round \(round): progress didn't reach 0 (\(id("sw-progress").label))", timeout: 3) { id("sw-progress").label == "progress 0%" }
        }
        // The screen under it takes taps.
        XCTAssertTrue(id("sw-open").isHittable)
    }
}
