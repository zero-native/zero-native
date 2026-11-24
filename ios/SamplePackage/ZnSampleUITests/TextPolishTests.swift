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

    /// returnKeyType "next": focus moves to the next field in reading order, passing over a read-only one (iOS only:
    /// Compose can focus a readOnly field); a multiline field with "next" does the same; "done" closes the keyboard.
    /// Before, every Return closed the keyboard.
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
    /// On its own screen (route textPolishLinesLab): Android throws on it until ZnTemplate.kt maps 0.
    func testNumberOfLinesZero() {
        launch("textPolishLinesLab", ready: "tp-lines-title")
        let text = id("tp-lines0")
        XCTAssertTrue(appears(text, timeout: 5))
        XCTAssertGreaterThan(text.frame.height, 40, "numberOfLines 0 is \(text.frame.height) pt tall")
    }

    /// "next" in a List goes on into the rows below its edge (a UICollectionView hasn't made them yet; Compose's
    /// LazyColumn lays them out for the focus search): r1 to r8 in a List that shows about three rows, before the
    /// fields below the List (§10's notes, which took the focus from r4). After the last row: the field below the List,
    /// keyboard up. It closed at the last row that showed.
    func testReturnKeyNextInList() {
        open()
        let row = { (n: Int) in self.app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "Row r\(n) (next)")).firstMatch }
        let label = id("tp-focus")
        reveal(row(1)).tap()
        waitLabel(label, "focus r1 submits 0")
        for n in 2...8 {
            app.typeText("\n")
            waitLabel(label, "focus r\(n) submits 0")
        }
        XCTAssertTrue(focused(row(8)), "r8 has no keyboard focus")
        app.typeText("\n")
        eventually("a field below the List takes the focus after the last row") { self.focused(self.id("tp-row-note")) }
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard closed")
    }

    /// onSubmitEditing that focuses a field by its ref, on a field with "next" (ZeroBill's forms): JS's field wins
    /// (E → G, F passed over), and when it is the next field anyway (F → G) G takes focus once.
    func testNextWithRefFocus() {
        open()
        let label = id("tp-focus")
        let g = id("tp-jump")
        reveal(id("tp-jump-e")).tap()
        waitLabel(label, "focus E submits 0")
        app.typeText("\n")
        waitLabel(label, "focus G submits 0")
        waitLabel(g, "G focused 1")
        reveal(id("tp-jump-f")).tap()
        waitLabel(label, "focus F submits 0")
        app.typeText("\n")
        waitLabel(label, "focus G submits 0")
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        waitLabel(g, "G focused 2")
        XCTAssertTrue(focused(id("tp-jump-g")), "G has no keyboard focus")
    }

    /// Multiline fields capped by maxHeight where ZeroBill has them: the chat composer (flex 1 in a Row aligned to the
    /// bottom, maxHeight 120, 11 pt padding), List rows (maxHeight 70, 8 pt padding) and a Modal's review box (maxHeight
    /// 112, 12 pt padding, the line under it stays under it).
    func testMultilineCapsInComposerRowsAndModal() {
        open()
        let chat = reveal(id("tp-chat"), hittable: false)
        chat.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "no keyboard")
        type(chat, "a\nb\nc\nd\ne\nf\ng")
        eventually("the composer has \"g\"") { (chat.value as? String)?.hasSuffix("g") == true }
        XCTAssertLessThanOrEqual(chat.frame.height, 98.5, "the composer's text view is \(chat.frame.height) pt tall")
        XCTAssertGreaterThan(chat.frame.height, 80, "the composer didn't grow (\(chat.frame.height) pt)")
        // The composer is 120 pt (its cap) and Send stays at the bottom of the Row (alignItems flex-end): Send's bottom
        // is 120 pt below the composer's top (its text view's top less 11 pt padding). From the top: a scrolling text
        // view reads a few points short at the bottom to XCUITest (93.7 for 98, 2026-11-24; the screenshot shows 98).
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        let send = id("tp-chat-send")
        XCTAssertEqual(send.frame.maxY, chat.frame.minY - 11 + 120, accuracy: 1.5, "Send isn't at the composer's bottom (chat \(chat.frame), send \(send.frame))")

        let notes = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", "tp-row-note"))
        reveal(id("tp-under-list-notes"), hittable: false)
        XCTAssertGreaterThanOrEqual(notes.count, 1)
        for i in 0..<notes.count {
            XCTAssertLessThanOrEqual(notes.element(boundBy: i).frame.height, 54.5, "row note \(i) is \(notes.element(boundBy: i).frame.height) pt tall")
        }

        reveal(id("tp-open-review")).tap()
        let review = id("tp-review")
        XCTAssertTrue(appears(review, timeout: 5))
        review.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        type(review, "1\n2\n3\n4\n5\n6")
        eventually("the review has \"6\"") { (review.value as? String)?.hasSuffix("6") == true }
        XCTAssertLessThanOrEqual(review.frame.height, 88.5, "the review box's text view is \(review.frame.height) pt tall")
        XCTAssertGreaterThanOrEqual(id("tp-under-review").frame.minY, review.frame.maxY, "the line under the review box is under its text")
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
