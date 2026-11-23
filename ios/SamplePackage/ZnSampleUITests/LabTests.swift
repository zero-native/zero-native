import XCTest

/// The RN props lab (route rnPropsLab, examples/sample/src/RnPropsLab.tsx): containers found by testID, Text
/// onPress / onLongPress, row touchables and hitSlop. Each action writes "status: ..." into rn-status.
final class RnPropsLabTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        launch("rnPropsLab", ready: "rn-status")
    }

    private func status(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("rn-status"), "status: \(s)", file: file, line: line)
    }

    func testContainersByTestID() {
        // A plain container with a testID is one container element (its children keep their own ids).
        XCTAssertEqual(id("fill-stack").elementType, .other)
        XCTAssertEqual(count("fill-stack"), 1)
        XCTAssertTrue(id("fill-all").exists)
        XCTAssertTrue(app.otherElements["fill-stack"].exists)
    }

    func testTextPressAndLongPress() {
        let tile = reveal(id("text-press-tile"))
        tile.tap()
        status("text tapped")
        tile.press(forDuration: 1.0)
        status("text long-pressed")
    }

    func testRowTouchables() {
        let touchable = reveal(id("row-touchable-btn"))
        XCTAssertEqual(touchable.elementType, .button)
        touchable.tap()
        status("row touchable pressed")
        let wrap = reveal(id("row-pressable-wrap"))
        XCTAssertEqual(wrap.elementType, .button)
        wrap.tap()
        status("row pressable wrap-content tapped")
    }

    func testHitSlop() {
        // 12 pt left of each 24 pt square: inside "slop"'s 20 pt hitSlop, outside "noslop" (the Pressable under it gets it).
        let slop = reveal(id("slop"))
        slop.coordinate(withNormalizedOffset: CGVector(dx: -0.5, dy: 0.5)).tap()
        status("slop hit")
        id("noslop").coordinate(withNormalizedOffset: CGVector(dx: -0.5, dy: 0.5)).tap()
        status("pe5 under")
        id("noslop").tap()
        status("noslop hit")
    }
}

/// The text input screen (route input, examples/sample/src/InputScreen.tsx): a controlled field that formats as you
/// type and one that keeps only digits. Its fields have no testIDs, so they are found by placeholder.
final class InputTests: ZnUITestCase {
    private func field(_ placeholder: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "placeholderValue == %@", placeholder)).firstMatch
    }

    func testControlledFields() {
        launch("input", ready: "")
        let amount = field("₹0")
        XCTAssertTrue(amount.waitForExistence(timeout: 30), "no amount field")
        amount.tap()
        amount.typeText("1234567")
        waitValue(amount, "12,34,567")
        // An 8th digit is refused: the field goes back to JS's value.
        amount.typeText("8")
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        waitValue(amount, "12,34,567")

        let phone = field("Phone (10 digits)")
        phone.tap()
        phone.typeText("98a76-54")
        waitValue(phone, "987654")
    }
}
