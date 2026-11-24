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
    /// tap at its drawn centre, and the field still focuses.
    func testTapsOn3DTurnedViews() {
        reveal(id("turned-card")).tap()
        status("turned 1")
        id("tilted-card").tap()
        status("tilted 1")
        // Near the turned card's far edge (drawn narrower than laid out): still the card.
        id("turned-card").coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).tap()
        status("turned 2")
        reveal(id("turned-field")).tap()
        status("turned field focused")
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
