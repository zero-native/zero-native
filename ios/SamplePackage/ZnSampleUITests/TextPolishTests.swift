import XCTest

/// The text polish lab (route textPolishLab, examples/sample/src/TextPolishLab.tsx): the text and field fixes of the
/// iOS polish round (2026-11-24), each as Android does it.
final class TextPolishTests: ZnUITestCase {
    private func open() { launch("textPolishLab", ready: "tp-title") }

    /// Each key on its own, about as fast as a person types.
    private func type(_ field: XCUIElement, _ text: String) {
        for ch in text {
            field.typeText(String(ch))
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        }
    }

    private func focused(_ element: XCUIElement) -> Bool { element.value(forKey: "hasKeyboardFocus") as? Bool ?? false }

    /// A multiline field with maxHeight 80 (8 pt padding each side) stops at 64 pt of text and scrolls inside; the line
    /// under it stays below it. It drew all 8 lines (about 150 pt) over the views below.
    func testMultilineMaxHeight() {
        open()
        let note = reveal(id("tp-note"), hittable: false)
        let under = id("tp-under-note")
        XCTAssertLessThanOrEqual(note.frame.height, 65, "the note's text view is \(note.frame.height) pt tall")
        XCTAssertGreaterThanOrEqual(under.frame.minY, note.frame.maxY - 0.5, "the line under the note is under its text")
        // Typing in it keeps it at its height and the text arrives.
        note.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "no keyboard")
        type(note, "\nNine")
        eventually("the note has \"Nine\"") { (note.value as? String)?.contains("Nine") == true }
        XCTAssertLessThanOrEqual(note.frame.height, 65, "after typing the note is \(note.frame.height) pt tall")
    }

    /// returnKeyType "next": focus moves to the next field in reading order, passing over a read-only one; a multiline
    /// field with "next" does the same; "done" closes the keyboard. Before, every Return closed the keyboard.
    func testReturnKeyNext() {
        open()
        let a = reveal(id("tp-next-a"))
        let label = id("tp-focus")
        a.tap()
        waitLabel(label, "focus A submits 0")
        type(a, "x\n")
        waitLabel(label, "focus B submits 1")
        XCTAssertTrue(focused(id("tp-next-b")), "B has no keyboard focus")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard closed")
        id("tp-next-b").typeText("\n")
        waitLabel(label, "focus C submits 1")  // RO (read-only, beside B) passed over
        id("tp-next-c").typeText("\n")
        waitLabel(label, "focus D submits 1")
        XCTAssertFalse((id("tp-next-c").value as? String ?? "").contains("\n"), "Return made a new line in C")
        id("tp-next-d").typeText("\n")
        eventually("the keyboard closes on done") { !self.app.keyboards.firstMatch.exists }
    }

    /// numberOfLines={0} is no limit: the 200 pt wide sentence wraps over three or more lines (it was one line and "…").
    func testNumberOfLinesZero() {
        open()
        let text = reveal(id("tp-lines0"), hittable: false)
        XCTAssertGreaterThan(text.frame.height, 40, "numberOfLines 0 is \(text.frame.height) pt tall")
    }

    /// A field on a hidden tab, or scrolled out of its Scroll, doesn't take the taps of a bigger Pressable drawn
    /// where its box is (the Pressable left the touch to the field's stale box: nothing happened).
    func testHiddenAndClippedFieldsLeaveTaps() {
        open()
        let field = id("tp-tab-field")
        XCTAssertTrue(appears(field, timeout: 5))
        // In screen points: the field leaves the tree with its tab.
        let spot = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: field.frame.midX, dy: field.frame.midY))
        id("tp-tab-b").tap()
        let big = id("tp-big-count")
        waitLabel(big, "big taps 0")
        spot.tap()  // where tab A's field was
        waitLabel(big, "big taps 1")

        // The Scroll's second field lies 33 to 70 pt below its bottom edge, so 19 to 56 pt into the Pay Pressable
        // (14 pt below the Scroll).
        let pay = id("tp-pay")
        print("ZN-CLIP: scroll \(id("tp-clip-scroll").frame) clipped field \(id("tp-clip-b").frame) pay \(pay.frame)")
        pay.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: pay.frame.width / 2, dy: 36)).tap()
        waitLabel(id("tp-pay-count"), "pay taps 1")
    }
}
