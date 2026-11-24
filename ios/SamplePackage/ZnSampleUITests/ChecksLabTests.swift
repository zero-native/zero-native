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
        // The element's frame is the drawn card's bounding box (about 60 to 165 pt across; laid out 59 to 189), so
        // offsets go from its right edge, the drawn far edge. 10 pt inside it: still the card.
        let farEdge = id("turned-card").coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
        farEdge.withOffset(CGVector(dx: -10, dy: 0)).tap()
        status("turned 2")
        // 14 pt past it: inside the laid-out 130 pt (24 pt short of its edge) but not on the drawn card, so not pressed.
        // This tap fails if hit testing goes by the laid-out rect (checked by hand too, 2026-11-24).
        farEdge.withOffset(CGVector(dx: 14, dy: 0)).tap()
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertEqual(id("checks-status").label, "status: turned 2", "a tap outside the drawn card pressed it")
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

    /// An inverted List's dropped row shows at its new place once it lands: its cell is hidden while the drag preview
    /// flies there (ZnListReorder.drop) and must come back, also for a drop where it started. Read from the screen's
    /// pixels: the row's grey (#F1F5F9), not the list's white behind a hidden cell. (The preview itself, upright while
    /// dragged, is checked by eye in a recording: XCUITest's drag can't be paused.)
    func testInvertedDropShowsTheRow() {
        let rows = reveal(id("rows-list"))
        let r1 = rows.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 1)).withOffset(CGVector(dx: 0, dy: -28))
        // Picked up and let go where it was (a small move and back): no reorder, the row still shows.
        r1.press(forDuration: 0.8, thenDragTo: r1.withOffset(CGVector(dx: 0, dy: -10)), withVelocity: .slow, thenHoldForDuration: 0.6)
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertEqual(id("rows-order").label, "rows: r1, r2, r3, r4, r5, r6")
        assertRowShows("Row 1 (44)")
        // Moved past two rows: it lands between Row 3 and Row 4 and shows there.
        r1.press(forDuration: 0.8, thenDragTo: r1.withOffset(CGVector(dx: 0, dy: -190)), withVelocity: .slow, thenHoldForDuration: 0.4)
        status("reorder rows 0 → 2")
        Thread.sleep(forTimeInterval: 1.2)
        let row1 = text("Row 1 (44)").frame, row3 = text("Row 3 (60)").frame, row4 = text("Row 4 (120)").frame
        XCTAssertTrue(row4.midY < row1.midY && row1.midY < row3.midY, "Row 1 at \(row1), not between Row 4 \(row4) and Row 3 \(row3)")
        assertRowShows("Row 1 (44)")
    }

    /// The row whose label is [label] is drawn: a pixel near the List's right end, on the label's line, is the row's
    /// grey, not the section's white. (Not just right of the label: a Text's element spans its row's width.)
    private func assertRowShows(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
        let f = text(label).frame, list = id("rows-list").frame
        let shot = XCUIScreen.main.screenshot().image
        guard let cg = shot.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else {
            return XCTFail("no screenshot", file: file, line: line)
        }
        let scale = CGFloat(cg.width) / shot.size.width
        // 20 pt in from the List's right edge (the row has an 8 pt margin and 12 pt padding there), on the label's
        // middle line: the row's own background.
        let x = Int((list.maxX - 20) * scale), y = Int(f.midY * scale)
        let i = y * cg.bytesPerRow + x * (cg.bitsPerPixel / 8)
        let (r, g, b) = (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
        // BGRA or RGBA: the grey's channels are 241, 245, 249 either way round; white is 255, 255, 255.
        XCTAssertTrue(max(r, b) <= 251 && min(r, b) >= 237 && abs(g - 245) <= 4,
                      "\(label): pixel (\(r), \(g), \(b)) at \(x),\(y) is not the row's grey: its cell is hidden", file: file, line: line)
    }

    /// The f) fields: seven keys in one burst into a multiline field JS regroups all count (A93: a key typed during
    /// JS's regroup was put before the last digit, 12,35,674); JS's 6 digits fill a maxLength 4 field (JS's value
    /// isn't cut, as before); a read-only field takes JS's text.
    func testValuesJSPutsInFields() {
        let multi = reveal(id("multi-group"), hittable: false)
        multi.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        multi.typeText("1234567")
        waitValue(multi, "12,34,567", timeout: 3)
        reveal(id("set-values")).tap()
        status("values set")
        waitValue(id("max4"), "123456")
        waitValue(id("ro-js"), "read-only 1")
    }

    /// returnKeyType "next" goes by row order, as Android's focus search: n1 (at the bottom of the inverted List) →
    /// n2 → n3 → n4 (each above the last), then the sideways List after it: s1 → s2 → s3 → s4 (s4 starts past the
    /// List's edge: it is shown, then focused).
    func testNextByRowOrder() {
        ChecksLabTests.nextGoesByRowOrder(self)
    }

    static func nextGoesByRowOrder(_ t: ZnUITestCase) {
        let n1 = t.app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "n1 (next)")).firstMatch
        t.reveal(n1).tap()
        t.waitLabel(t.id("next-focus"), "focus n1")
        for next in ["n2", "n3", "n4", "s1", "s2", "s3", "s4"] {
            t.app.typeText("\n")
            t.waitLabel(t.id("next-focus"), "focus \(next)")
        }
    }
}

/// "next" in a right-to-left layout (forced with -AppleTextDirection / -NSForceRightToLeftWritingDirection, so the
/// sample needn't list an RTL language): still row order, so in the sideways List s2 is left of s1.
final class NextRtlTests: ZnUITestCase {
    func testNextByRowOrderRightToLeft() {
        launch("checksLab", arguments: ["-AppleTextDirection", "YES", "-NSForceRightToLeftWritingDirection", "YES"],
               ready: "checks-status")
        let s1 = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "s1 (next)")).firstMatch
        let s2 = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", "s2 (next)")).firstMatch
        reveal(s1)
        XCTAssertLessThan(s2.frame.midX, s1.frame.midX, "the layout isn't right to left")
        ChecksLabTests.nextGoesByRowOrder(self)
    }
}
