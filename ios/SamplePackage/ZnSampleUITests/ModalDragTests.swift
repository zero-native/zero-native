import XCTest

/// Drag down to close a "modal" route (examples/sample/src/ModalDragLab.tsx; ZnNavHost.swift dismissPan). Far or fast
/// closes it, a short slow drag springs back, a list scrolls first and hands the pull over at its top, a screen that
/// wants Back asks JS and stays, and secure and see-through modals close the same way. "stack N" on the lab is
/// nav.depth() each time it gets focus again ("focused N"): JS's stack after a close.
final class ModalDragTests: ZnUITestCase {
    /// Launches the lab, taps [button] and waits for [title] with the slide up ended. Returns the lab's "stack N".
    @discardableResult
    private func open(_ button: String, title: String = "Drag me down", launching: Bool = true) -> String {
        if launching { launch("modalDragLab", until: { self.text("Modal drag lab") }) }
        let stack = id("md-stack").label
        app.buttons[button].firstMatch.tap()
        XCTAssertTrue(appears(text(title), timeout: 5), "\(button): no \(title)")
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        return stack
    }

    /// A drag at [x] from [y0] to [y1] (fractions of the screen), at [velocity] points a second, held [hold] s at
    /// the end (then let go with no speed: only the distance counts).
    private func drag(from y0: CGFloat, to y1: CGFloat, velocity: CGFloat, hold: TimeInterval, x: CGFloat = 0.5) {
        let a = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y0))
        let b = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y1))
        a.press(forDuration: 0.05, thenDragTo: b, withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: hold)
    }

    /// The modal closed: the lab is back with JS's stack as before ([stack]) and has had focus [focused] times.
    private func closed(_ title: String = "Drag me down", stack: String, focused: Int, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(appears(id("md-focused"), timeout: 5), "the lab didn't come back", file: file, line: line)
        waitLabel(id("md-focused"), "focused \(focused)", file: file, line: line)
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        XCTAssertFalse(text(title).exists, "\(title) came back", file: file, line: line)
        XCTAssertEqual(id("md-stack").label, stack, "JS's stack", file: file, line: line)
    }

    func testDragDownCloses() {
        // A quick flick, a fifth of the screen: closes by its speed.
        var stack = open("Open modal")
        drag(from: 0.4, to: 0.6, velocity: 2500, hold: 0)
        closed(stack: stack, focused: 2)
        // A slow drag past a third, held still before letting go: closes by its distance.
        stack = open("Open modal", launching: false)
        drag(from: 0.3, to: 0.75, velocity: 500, hold: 0.4)
        closed(stack: stack, focused: 3)
        // The lab still opens and closes it as before (JS and native agree on the stack).
        stack = open("Open modal", launching: false)
        app.buttons["Close"].firstMatch.tap()
        closed(stack: stack, focused: 4)
    }

    func testShortDragSpringsBack() {
        let stack = open("Open modal")
        let title = text("Drag me down")
        let y0 = title.frame.minY
        drag(from: 0.4, to: 0.5, velocity: 300, hold: 0.4)
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(title.exists, "a short drag closed the modal")
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "the modal didn't spring back")
        XCTAssertFalse(id("md-focused").exists, "the lab shows")
        app.buttons["Close"].firstMatch.tap()
        closed(stack: stack, focused: 2)
    }

    func testListScrollsThenHandsOverAtItsTop() {
        let stack = open("With a list")
        let title = text("Drag me down")
        let row = text("Row 1")
        XCTAssertTrue(appears(row, timeout: 2))
        let t0 = title.frame.minY, r0 = row.frame.minY
        // Up at its top: the list scrolls (the drag down gives way at once).
        drag(from: 0.85, to: 0.6, velocity: 600, hold: 0.3)
        eventually("the list scrolled (Row 1 at \(row.frame.minY), was \(r0))") { row.frame.minY < r0 - 120 }
        XCTAssertEqual(title.frame.minY, t0, accuracy: 1, "the modal moved")
        // Down, less than it scrolled: only the list moves, and the modal stays.
        let r1 = row.frame.minY
        drag(from: 0.55, to: 0.62, velocity: 300, hold: 0.3)
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        XCTAssertGreaterThan(row.frame.minY, r1 + 30, "the list didn't scroll back")
        XCTAssertLessThan(row.frame.minY, r0 - 20, "the list is at its top already")
        XCTAssertTrue(title.exists, "the modal closed while the list could still scroll")
        XCTAssertEqual(title.frame.minY, t0, accuracy: 1, "the modal moved while the list could still scroll")
        // Down, more than is left, quickly: the list reaches its top and hands the pull over; the modal closes.
        drag(from: 0.45, to: 0.97, velocity: 1500, hold: 0)
        closed(stack: stack, focused: 2)
        // Again, with the list at its top from the start: a pull down on the list closes it.
        let again = open("With a list", launching: false)
        drag(from: 0.6, to: 0.9, velocity: 2000, hold: 0)
        closed(stack: again, focused: 3)
    }

    func testScreenThatWantsBackAsksJS() {
        let stack = open("Wants Back")
        let title = text("Drag me down")
        XCTAssertTrue(appears(text("back asked 0"), timeout: 2))
        let y0 = title.frame.minY
        drag(from: 0.4, to: 0.8, velocity: 1500, hold: 0)
        XCTAssertTrue(appears(text("back asked 1"), timeout: 3), "JS wasn't asked once (\(id("md-back-asked").label))")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(title.exists, "the screen left (its handler keeps it)")
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "the screen moved")
        XCTAssertTrue(text("back asked 1").exists, "JS was asked again")
        app.buttons["Close"].firstMatch.tap()
        closed(stack: stack, focused: 2)
    }

    func testSecureAndSeeThroughClose() {
        let stack = open("Secure")
        drag(from: 0.4, to: 0.85, velocity: 1500, hold: 0)
        closed(stack: stack, focused: 2)
        // The see-through card: the lab stays drawn under it; a drag down on the card takes it away.
        let under = open("See-through", title: "See-through card", launching: false)
        XCTAssertTrue(text("Modal drag lab").exists, "the lab isn't drawn under the see-through card")
        let card = text("See-through card")
        let y = card.frame.midY / app.frame.height
        drag(from: y, to: min(y + 0.15, 0.98), velocity: 2000, hold: 0)
        eventually("the card left") { !card.exists }
        closed("See-through card", stack: under, focused: 3)
    }
}
