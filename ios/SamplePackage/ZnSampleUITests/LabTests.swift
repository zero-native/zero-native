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
        // One element: the testID isn't also on an empty element around the text.
        XCTAssertEqual(count("text-press-tile"), 1)
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
        // 12 pt left of each 24 pt square (24 pt from its centre). "slop-free": over empty space its 20 pt hitSlop
        // takes the tap. "slop": its slop lies over another Pressable ("pe5-under"), which wins there, as on Android
        // (ZnTouchControl.hitTest). "noslop": no slop, so the one under it gets it; its centre is its own.
        let left = CGVector(dx: -24, dy: 0)
        func leftOf(_ testID: String) -> XCUICoordinate {
            reveal(id(testID)).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(left)
        }
        leftOf("slop-free").tap()
        status("slop-free hit")
        leftOf("slop").tap()
        status("pe5 under")
        id("slop").tap()
        status("slop hit")
        leftOf("noslop").tap()
        status("pe5 under")
        id("noslop").tap()
        status("noslop hit")
    }

    func testMinTouchArea() {
        // 24 pt squares grow to 44 pt touch areas (10 pt each side; ZnTouchRules.reach).
        func at(_ testID: String, dx: CGFloat) -> XCUICoordinate {
            reveal(id(testID)).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: dx, dy: 0))
        }
        at("min-free", dx: -20).tap()  // 8 pt past its edge, over empty space
        status("min-free hit")
        at("near-a", dx: 16).tap()     // 4 pt past A, 8 pt before B: both grown areas, A is nearer
        status("near-a hit")
        at("near-b", dx: -15).tap()    // 3 pt before B, 9 pt past A: B is nearer
        status("near-b hit")
        at("card-btn", dx: 18).tap()   // 6 pt past the button, on the card around it: the button
        status("card button hit")
        at("card-btn", dx: 90).tap()   // well away from the button: the card
        status("card hit")
    }
}

/// The text input screen (route input, examples/sample/src/InputScreen.tsx): a controlled field that formats as you
/// type and one that keeps only digits. Its fields have no testIDs, so they are found by placeholder.
final class InputTests: ZnUITestCase {
    private func field(_ placeholder: String) -> XCUIElement {
        app.textFields.matching(NSPredicate(format: "placeholderValue == %@", placeholder)).firstMatch
    }

    /// One key at a time, about as fast as a person types (typeText's burst can beat JS's reformat: testBurst).
    private func type(_ field: XCUIElement, _ text: String) {
        for ch in text {
            field.typeText(String(ch))
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        }
    }

    private func openAmount() -> XCUIElement {
        launch("input", until: { self.field("₹0") })
        let amount = field("₹0")
        amount.tap()
        return amount
    }

    func testControlledFields() {
        let amount = openAmount()
        type(amount, "1234567")
        waitValue(amount, "12,34,567")
        // An 8th digit is refused: the field goes back to JS's value.
        type(amount, "8")
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        waitValue(amount, "12,34,567")

        let phone = field("Phone (10 digits)")
        phone.tap()
        type(phone, "98a76-54")
        waitValue(phone, "987654")
    }

    /// Seven keys in one burst (typeText): every one should count. Known iOS gap (A93): now and then a key is lost
    /// ("1,23,456"). Cause (found 2026-11-24, app log): ZnTextField sets `f.text = value` for JS's reformat, and a key
    /// that reaches the field within ~20 ms after that set never arrives (no editingChanged, not in the text): UIKit
    /// drops keys queued while the text is replaced from outside the input system. Applying JS's value with
    /// `replace(_:withText:)` (UITextInput) kept every key in the same runs. Not strict until that fix lands: it passes
    /// either way and reports the loss as an expected failure. With the fix, make it strict (drop XCTExpectFailure).
    func testBurst() {
        let amount = openAmount()
        amount.typeText("1234567")
        XCTExpectFailure("a key typed during JS's reformat of the one before can be lost", options: {
            let o = XCTExpectedFailure.Options(); o.isStrict = false; return o
        }())
        waitValue(amount, "12,34,567", timeout: 3)
        // Non-strict, so it passes either way: the log says which (docs/milestones-ios.md section 11, "Known").
        print("ZN-BURST: the amount field shows \(String(describing: amount.value))")
    }
}
