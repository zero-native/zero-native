import XCTest

/// The checks lab (route checksLab, examples/sample/src/ChecksLab.tsx): checks that had no screen before (open items
/// 2026-11-24, "built but never run"). Each action writes "status: ..." into checks-status.
final class ChecksLabTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        launch("checksLab", ready: "checks-status")
    }

    private func status(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("checks-status"), "status: \(s)", file: file, line: line)
    }

    /// Motion text (v.format) groups by en-IN by default: 12,34,567; the minus before the prefix; standard 1,234,567.
    func testMotionTextGrouping() {
        waitLabel(id("lakh-in"), "₹12,34,567")
        waitLabel(id("lakh-minus"), "-₹1,23,456.50")
        waitLabel(id("lakh-standard"), "1,234,567")
        reveal(id("lakh-up")).tap()
        status("lakh up")
        waitLabel(id("lakh-in"), "₹9,87,65,432")
    }

    /// A Pressable turned 40° about Y (the depth effect), one tilted about X, and a field turned with them: each takes a
    /// tap at its drawn centre, the turned card not a tap past its drawn far edge, and the field still focuses.
    func testTapsOn3DTurnedViews() {
        reveal(id("turned-card")).tap()
        status("turned 1")
        id("tilted-card").tap()
        status("tilted 1")
        // Near the turned card's far edge (drawn narrower than laid out): still the card.
        id("turned-card").coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).tap()
        status("turned 2")
        // Inside the laid-out 130 pt but past the drawn far edge (about 41 pt from the centre at 40° and camera 8: the
        // laid-out edge is at 65): not the card. This tap fails if hit testing goes by the laid-out rect.
        id("turned-card").coordinate(withNormalizedOffset: CGVector(dx: 0.06, dy: 0.5)).tap()
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertEqual(id("checks-status").label, "status: turned 2", "a tap outside the drawn card pressed it")
        // The near edge is drawn wider than laid out (about 64 pt): a tap at 0.94 (57 pt) is still the card.
        id("turned-card").coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.5)).tap()
        status("turned 3")
        reveal(id("turned-field")).tap()
        status("turned field focused")
    }

    /// Reorder in a sideways List and in an inverted List with rows of mixed heights: a long press picks the first
    /// item up, a drag past two others drops it there (JS hears onReorder 0 → 2 and the order line follows).
    func testReorderSidewaysAndInverted() {
        let chips = reveal(id("chips-list"))
        let chai = chips.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 30, dy: 0))
        // Chai (65 pt), Groceries (105), Rent (67), 8 pt apart: 175 pt right is past Rent's middle, before Fuel's.
        chai.press(forDuration: 0.8, thenDragTo: chai.withOffset(CGVector(dx: 175, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.4)
        status("reorder chips 0 → 2")
        waitLabel(id("chips-order"), "chips: Groceries, Rent, Chai, Fuel and tolls, Gym, Books")
        let rows = reveal(id("rows-list"))
        // Inverted: row 1 (44 pt) is at the bottom, rows 2 (100) and 3 (60) above it, 6 pt apart: 190 pt up is past
        // row 3's middle, before row 4's.
        let r1 = rows.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 0, dy: -28))
        r1.press(forDuration: 0.8, thenDragTo: r1.withOffset(CGVector(dx: 0, dy: -190)), withVelocity: .slow, thenHoldForDuration: 0.4)
        status("reorder rows 0 → 2")
        waitLabel(id("rows-order"), "rows: r2, r3, r1, r4, r5, r6")
    }

    /// A NativeView's box found by testID takes its own tap; a box with pointerEvents none lets the tap through to the
    /// Pressable under it (the native view in it gets nothing).
    func testNativeViewTestIDAndPointerEvents() {
        let withID = reveal(id("native-with-id"))
        withID.tap()
        status("view event 1")
        reveal(id("under-native")).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        status("under 1")
    }
}
