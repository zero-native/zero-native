import XCTest

/// The touch fixes lab (route touchFixLab, examples/sample/src/TouchFixLab.tsx): a control inside a Pressable takes
/// its own tap (A53, the innermost wins), a disabled one leaves it to the Pressable around it, and a long press inside a
/// Scroll is timed from the finger, and a Pressable drawn over a control (a dim) keeps the tap. Each action writes
/// "status: ..." into fx-status and adds it to fx-log.
final class TouchFixTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        launch("touchFixLab", ready: "fx-status")
    }

    private func status(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("fx-status"), "status: \(s)", file: file, line: line)
    }

    /// fx-log: every event so far, in order (the lab keeps the last 8). Read after a short wait, so an event that came
    /// with the one a test waited for (the row pressed as well as the Switch turned) is seen too.
    private func log(_ events: [String], file: StaticString = #filePath, line: UInt = #line) {
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        waitLabel(id("fx-log"), "log: " + events.joined(separator: ", "), file: file, line: line)
    }

    private func at(_ e: XCUIElement, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        e.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    func testControlsInsideARow() {
        let sw = id("fx-switch")
        XCTAssertEqual(sw.value as? String, "0")
        sw.tap()
        status("switch on")  // the row would say "switch row"
        waitValue(sw, "1")
        let check = id("fx-check")
        check.tap()
        status("check on")
        waitValue(check, "1")
        // The row's text presses the row; the controls stay as they were.
        at(id("fx-row-switch"), 0.15, 0.5).tap()
        status("switch row")
        at(id("fx-row-check"), 0.15, 0.5).tap()
        status("check row")
        XCTAssertEqual(sw.value as? String, "1")
        XCTAssertEqual(check.value as? String, "1")
        log(["switch on", "check on", "switch row", "check row"])
    }

    func testSwitchInARailInsideACard() {
        let sw = id("fx-rail-switch")
        sw.tap()
        status("rail switch on")  // not "rail card": the card isn't pressed as well
        waitValue(sw, "1")
        // A chip of the rail (no Pressable): the card takes the tap.
        at(id("fx-rail-card"), 0.7, 0.72).tap()
        status("rail card")
        XCTAssertEqual(sw.value as? String, "1")
        log(["rail switch on", "rail card"])
    }

    func testDisabledInsideTakesNoTap() {
        // A disabled Switch in a row: the row takes the tap, the Switch stays on.
        let locked = reveal(id("fx-disabled-switch"))
        XCTAssertEqual(locked.value as? String, "1")
        at(locked, 0.5, 0.5).tap()
        status("disabled switch row")
        XCTAssertEqual(locked.value as? String, "1")
        // A disabled button in a card: the card takes the tap (iOS ate it before, 2026-11-24).
        let apply = reveal(id("fx-disabled-button"))
        at(apply, 0.5, 0.5).tap()
        status("card")
        log(["disabled switch row", "card"])
    }

    func testDimOverASwitchAndAFieldTakesTheTap() {
        // A tap-outside dim drawn over a Switch row and a field: the dim takes the tap (as Android, the topmost takes
        // it). The Switch's and the field's boxes inside the dim's area used to win by size: the dim closed nothing.
        let dim = reveal(id("fx-dim"))
        let sw = id("fx-under-switch")
        XCTAssertEqual(sw.value as? String, "0")
        let swAt = sw.frame, dimAt = dim.frame
        dim.coordinate(withNormalizedOffset: CGVector(dx: (swAt.midX - dimAt.minX) / dimAt.width, dy: (swAt.midY - dimAt.minY) / dimAt.height)).tap()
        status("dim")
        XCTAssertEqual(sw.value as? String, "0", "the Switch under the dim turned")
        let field = id("fx-under-field")
        let fieldAt = field.frame
        dim.coordinate(withNormalizedOffset: CGVector(dx: (fieldAt.midX - dimAt.minX) / dimAt.width, dy: (fieldAt.midY - dimAt.minY) / dimAt.height)).tap()
        log(["dim", "dim"])
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the field under the dim got focus")
    }

    func testSwitchDrawnOverACardTakesItsTap() {
        // A Switch drawn after (over) a tappable card, not inside it: the Switch takes its tap and the card doesn't fire.
        let sw = reveal(id("fx-over-switch"))
        sw.tap()
        status("over switch on")
        waitValue(sw, "1")
        at(id("fx-over-card"), 0.2, 0.5).tap()
        status("over card")
        log(["over switch on", "over card"])
    }

    func testLongPressInScrollFromTheFinger() {
        // Held 0.6 s: onLongPress comes 0.5 s after the finger went down. The press began after UIKit's content delay
        // (~150 ms), so it says ~350 ms from onPressIn. Before, it came 0.5 s after that late press (0.65 s in all):
        // a 0.6 s hold was a tap.
        let card = reveal(id("fx-long"))
        at(card, 0.5, 0.5).press(forDuration: 0.6)
        let st = id("fx-status")
        eventually("a long press (it is \"\(st.label)\")") { st.label.hasPrefix("status: long ") && st.label.hasSuffix("after press in") }
        let ms = Int(st.label.split(separator: " ")[2]) ?? 999
        XCTAssertLessThan(ms, 450, "onLongPress came \(ms) ms after the late press in (timed from the press, not the finger)")
    }
}
