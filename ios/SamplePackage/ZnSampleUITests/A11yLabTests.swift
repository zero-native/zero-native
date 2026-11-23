import XCTest

/// The accessibility lab (route a11yLab, examples/sample/src/A11yLab.tsx): labels from props and signals, disabled,
/// long press, roles, hidden boxes, pictures and fields. Each action writes "a11y-lab: ..." into a11y-status.
final class A11yLabTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        launch("a11yLab", ready: "a11y-status")
    }

    private func status(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("a11y-status"), "a11y-lab: \(s)", file: file, line: line)
    }

    func testPressableLabels() {
        let pay = id("a11y-pay")
        XCTAssertEqual(pay.elementType, .button)
        XCTAssertEqual(pay.label, "Pay 499 rupees")
        pay.tap()
        status("pay pressed")

        // A label from a signal follows it.
        let counter = id("a11y-count")
        XCTAssertEqual(counter.label, "Tapped 0 times")
        counter.tap()
        waitLabel(counter, "Tapped 1 times")
        counter.tap()
        waitLabel(counter, "Tapped 2 times")

        // A label that goes away: the button reads its own text again.
        let maybe = id("a11y-maybe")
        XCTAssertEqual(maybe.label, "Named button")
        maybe.tap()
        eventually("own text (it is \"\(maybe.label)\")") { maybe.label.contains("Own text") }
    }

    func testDisabledPressable() {
        let order = id("a11y-order")
        XCTAssertFalse(order.isEnabled)
        order.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(id("a11y-status").label, "a11y-lab: ready", "a disabled Pressable pressed")
        id("a11y-enable").tap()
        eventually("enabled") { order.isEnabled }
        order.tap()
        status("order placed")
    }

    func testLongPress() {
        let hold = id("a11y-hold")
        hold.tap()
        status("hold pressed")
        reveal(id("a11y-arm")).tap()
        eventually("armed") { self.id("a11y-arm").label.contains("Disarm") }
        hold.press(forDuration: 1.0)
        status("hold long-pressed")
    }

    func testRoles() {
        // role link: a link, not a button; role text: plain text; both still take taps.
        let link = reveal(id("a11y-link"))
        XCTAssertEqual(link.elementType, .link)
        link.tap()
        status("link pressed")
        let textRole = id("a11y-text-role")
        XCTAssertNotEqual(textRole.elementType, .button)
        textRole.tap()
        status("text role pressed")
        // A header Box with a label reads the label.
        XCTAssertEqual(id("a11y-header-box").label, "Wallet")
    }

    func testTappableTexts() {
        let link = reveal(id("a11y-text-link"))
        // One element each (before, an empty one carried the testID and VoiceOver stopped on it).
        XCTAssertEqual(count("a11y-text-link"), 1)
        XCTAssertEqual(count("a11y-text-none"), 1)
        XCTAssertEqual(link.elementType, .link)
        XCTAssertEqual(link.label, "Privacy policy")
        link.tap()
        status("text link pressed")
        let none = reveal(id("a11y-text-none"))
        XCTAssertNotEqual(none.elementType, .button)
        none.tap()
        status("text none pressed")
    }

    func testControls() {
        let sw = reveal(id("a11y-switch"))
        XCTAssertEqual(sw.label, "Notifications")
        XCTAssertEqual(sw.value as? String, "0")
        // A Switch inside a Pressable row: on iOS the row takes the tap and the Switch stays as it was. Which of the
        // two should win is open (A53: Android fires both; innermost wins on both is the recommendation): change this
        // when Pavan decides.
        sw.tap()
        status("row pressed")
        XCTAssertEqual(sw.value as? String, "0", "A53: the Switch inside the row turned")
        let check = id("a11y-check")
        XCTAssertEqual(check.label, "Save this card")
        XCTAssertEqual(check.value as? String, "1")
        check.tap()
        waitValue(check, "0")
        // The row around the Switch is its own button, read by its label.
        let row = id("a11y-row")
        XCTAssertEqual(row.elementType, .button)
        XCTAssertEqual(row.label, "Notifications")
        // A Switch in a labelled box: the box is read first, the Switch stays its own.
        XCTAssertEqual(id("a11y-box-ctl").label, "Card settings")
        let boxSwitch = id("a11y-box-switch")
        XCTAssertEqual(boxSwitch.value as? String, "1")
        boxSwitch.tap()
        waitValue(boxSwitch, "0")
    }

    func testHiddenAndPictures() {
        // accessibilityHidden: the box and its text are gone, even with a testID.
        XCTAssertEqual(count("a11y-hidden"), 0)
        XCTAssertFalse(text("Hidden from screen readers").exists)
        // A labelled box is one element read by its label.
        XCTAssertEqual(id("a11y-card").label, "Cashback 40 rupees on your next bill")
        // Pictures: a labelled image is found; an unlabelled one is decorative (skipped, as on Android).
        let image = id("a11y-img-label")
        XCTAssertEqual(image.elementType, .image)
        XCTAssertEqual(image.label, "Store front")
        XCTAssertEqual(count("a11y-img-deco"), 0)
        XCTAssertEqual(id("a11y-icon").label, "Next")
        XCTAssertEqual(id("a11y-chart").label, "Sales, going up")
    }

    func testFields() {
        let phone = reveal(id("a11y-phone"))
        XCTAssertEqual(phone.elementType, .textField)
        XCTAssertEqual(phone.label, "Mobile number")
        phone.tap()
        phone.typeText("9876543210")
        waitValue(phone, "9876543210")

        let name = reveal(id("a11y-name"))
        name.tap()
        name.typeText("Ravi")
        waitValue(name, "Ravi")

        // XCUITest calls the multiline field not hittable (its centre is in it, on screen): tapped by coordinate.
        let note = reveal(id("a11y-note"), hittable: false)
        XCTAssertEqual(note.elementType, .textView)
        note.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        note.typeText("one\ntwo")
        waitValue(note, "one\ntwo")

        // Under pointerEvents="none" the field can't be focused: typing goes nowhere.
        let off = reveal(id("a11y-field-off"), hittable: false)
        off.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(off.value(forKey: "hasKeyboardFocus") as? Bool ?? false, "a field under pointerEvents none took focus")
    }
}
