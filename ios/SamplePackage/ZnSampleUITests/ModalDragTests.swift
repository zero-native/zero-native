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
    /// the end. The hold doesn't zero the speed at the let-go: a pan held 0.3 s still ended at 391 pt/s, and a list
    /// coasted on 225 pt after it.
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
        // Down, less than it scrolled (all but about 60 pt, slowly): only the list moves, and the modal stays. How far
        // it scrolled is read from Row 1 once the list has stopped coasting, not a share of the screen: the first drag
        // scrolls it further on a taller phone, about 430 pt on an iPhone 17 Pro, 400 on a 16.
        let r1 = settled(row)
        let list = id("md-list").frame
        let back = max(r0 - r1 - 60, 40)
        drag(CGPoint(x: list.midX, y: list.minY + 20), CGPoint(x: list.midX, y: list.minY + 20 + back), velocity: 300, hold: 0.3)
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        XCTAssertGreaterThan(row.frame.minY, r1 + 30, "the list didn't scroll back")
        XCTAssertLessThan(row.frame.minY, r0 - 20, "the list is at its top already")
        XCTAssertTrue(title.exists, "the modal closed while the list could still scroll")
        XCTAssertEqual(title.frame.minY, t0, accuracy: 1, "the modal moved while the list could still scroll")
        // Down, more than is left, quickly: the list reaches its top and hands the pull over; the modal closes. Past
        // its top the finger still goes over 0.4 of the screen (0.41 on an iPhone 17 Pro), so it closes by its distance
        // whatever the speed at the end (XCUITest slows a drag down before it lets go: its last 40 pt go at 776 pt/s,
        // under the 800 of a flick, and with the list 380 pt down it cancelled at 0.04, on the iPhone 17 Pro).
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

    /// [element]'s top once it has stopped moving (two reads 0.2 s apart within 1 pt): a list coasts on after a drag.
    private func settled(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) -> CGFloat {
        var y = element.frame.minY
        eventually("\(element) stopped moving (at \(y))", file: file, line: line) {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            let now = element.frame.minY
            defer { y = now }
            return abs(now - y) < 1
        }
        return y
    }

    /// A drag from window point [a] to [b] (points), at [velocity], held [hold] s at the end.
    private func drag(_ a: CGPoint, _ b: CGPoint, velocity: CGFloat, hold: TimeInterval) {
        let o = app.coordinate(withNormalizedOffset: .zero)
        o.withOffset(CGVector(dx: a.x, dy: a.y)).press(forDuration: 0.05, thenDragTo: o.withOffset(CGVector(dx: b.x, dy: b.y)),
                                                       withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: hold)
    }

    /// A sideways swipe on a Carousel, straight or a bit diagonal (down as well), pages it and never moves the modal
    /// (2026-11-24 review: the rail handed the pull over at its first move down, and a quick diagonal one closed it).
    func testSidewaysRailNeverMovesTheModal() {
        let stack = open("With a rail")
        let title = text("Drag me down")
        let rail = id("md-rail")
        XCTAssertTrue(appears(rail, timeout: 3))
        let y0 = title.frame.minY
        let r = rail.frame
        drag(CGPoint(x: r.maxX - 30, y: r.midY - 20), CGPoint(x: r.minX + 40, y: r.midY + 30), velocity: 1500, hold: 0)
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(title.exists, "a sideways swipe closed the modal")
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "a diagonal swipe on the rail moved the modal")
        eventually("the rail paged (Card 2 at \(text("Card 2").frame.minX))") { self.text("Card 2").frame.minX < self.app.frame.width / 2 }
        drag(CGPoint(x: r.maxX - 30, y: r.midY), CGPoint(x: r.minX + 40, y: r.midY + 4), velocity: 800, hold: 0.3)
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "a slow swipe on the rail moved the modal")
        // A drag down on the rail still closes the modal (the rail waits for it to fail).
        drag(CGPoint(x: r.midX, y: r.minY + 10), CGPoint(x: r.midX, y: r.minY + 10 + app.frame.height * 0.3), velocity: 2000, hold: 0)
        closed(stack: stack, focused: 2)
    }

    /// A pull down on a Scroll with pull to refresh refreshes it; the modal stays (as UIKit's sheet).
    func testPullToRefreshKeepsTheModal() {
        let stack = open("Pull to refresh")
        let title = text("Drag me down")
        let item = text("Item 1")
        XCTAssertTrue(appears(item, timeout: 3))
        XCTAssertTrue(appears(text("refreshed 0"), timeout: 2))
        let y0 = title.frame.minY
        let f = item.frame
        // 320 pt, well past UIKit's line: a 220 pt drag pulled the content 92 to 93 pt, right at the line (it refreshed at
        // 92 on an iPhone 16, at 94 and not 93 on a 17 Pro, whose Scroll is taller), so it failed there every time.
        // (Kept on the screen on a short phone: there the Scroll is shorter and so is UIKit's line.)
        drag(CGPoint(x: f.midX, y: f.minY), CGPoint(x: f.midX, y: min(f.minY + 320, app.frame.maxY - 20)), velocity: 600, hold: 0.4)
        XCTAssertTrue(appears(text("refreshed 1"), timeout: 5), "no refresh (\(id("md-refreshed").label))")
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        XCTAssertTrue(title.exists, "the pull closed the modal")
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "the pull moved the modal")
        app.buttons["Close"].firstMatch.tap()
        closed(stack: stack, focused: 2)
    }

    /// An inverted list (a chat) opens at its bottom: a pull down scrolls back through it first; the modal stays.
    func testInvertedListScrollsFirst() {
        let stack = open("Inverted list")
        let title = text("Drag me down")
        let newest = text("Message 1")
        XCTAssertTrue(appears(newest, timeout: 3))
        let y0 = title.frame.minY, m0 = newest.frame.minY
        let chat = id("md-chat").frame
        drag(CGPoint(x: chat.midX, y: chat.minY + 40), CGPoint(x: chat.midX, y: chat.minY + 240), velocity: 500, hold: 0.4)
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        XCTAssertTrue(title.exists, "the pull closed the modal")
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "the pull moved the modal")
        XCTAssertTrue(!newest.exists || newest.frame.minY > m0 + 100, "the chat didn't scroll back (Message 1 at \(newest.frame.minY), was \(m0))")
        app.buttons["Close"].firstMatch.tap()
        closed(stack: stack, focused: 2)
    }

    /// A zn pan (usePan, up and down) takes a drag that starts on it: the modal doesn't follow, even a quick one.
    func testZnPanKeepsItsDrag() {
        let stack = open("With a pan")
        let title = text("Drag me down")
        let chip = text("Pan me")
        XCTAssertTrue(appears(chip, timeout: 3))
        let y0 = title.frame.minY
        let f = chip.frame
        drag(CGPoint(x: f.midX, y: f.midY), CGPoint(x: f.midX, y: f.midY + 200), velocity: 1500, hold: 0)
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(title.exists, "the drag on the pan closed the modal")
        XCTAssertEqual(title.frame.minY, y0, accuracy: 1, "the drag on the pan moved the modal")
        app.buttons["Close"].firstMatch.tap()
        closed(stack: stack, focused: 2)
    }

    /// JS's nav.back() while a drag is held: let go short (it springs back), JS's pop then runs and the lab shows;
    /// let go far, the drag's own pop closes it. Either way JS's stack is the lab's again (2026-11-24 review: a JS pop
    /// queued during the drag was given the spent drag and dropped).
    func testJSBackDuringAHeldDrag() {
        var stack = open("Open modal")
        app.buttons["Back in 2 s"].firstMatch.tap()
        drag(from: 0.4, to: 0.5, velocity: 300, hold: 3)
        closed(stack: stack, focused: 2)
        stack = open("Open modal", launching: false)
        app.buttons["Back in 2 s"].firstMatch.tap()
        drag(from: 0.3, to: 0.8, velocity: 500, hold: 3)
        closed(stack: stack, focused: 3)
        // The lab and its modal still work after both.
        stack = open("Open modal", launching: false)
        drag(from: 0.4, to: 0.6, velocity: 2500, hold: 0)
        closed(stack: stack, focused: 4)
    }

    /// JS pushes while a drag is held, and the drag then closes the page: native and JS end on the new page over the
    /// lab, and its Close shows the lab (as NavRaceTests.testPushDuringSwipe for the edge swipe).
    func testJSPushDuringAHeldDrag() {
        let stack = open("Open modal")
        app.buttons["Push in 2 s"].firstMatch.tap()
        drag(from: 0.3, to: 0.8, velocity: 500, hold: 3)
        let second = text("Second page")
        XCTAssertTrue(appears(second, timeout: 5), "the push during the drag isn't shown")
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertTrue(second.exists, "the second page went")
        XCTAssertFalse(text("Drag me down").exists, "the dragged page still shows")
        XCTAssertFalse(id("md-focused").exists, "the lab shows")
        app.buttons["Close"].firstMatch.tap()
        closed("Second page", stack: stack, focused: 2)
    }

    /// A drag down on a screen that pushed in from the side does nothing (its Back is the edge swipe).
    func testPushRouteIgnoresTheDragDown() {
        launch("modalDragLab", until: { self.text("Modal drag lab") })
        app.buttons["Open modal"].firstMatch.tap()
        XCTAssertTrue(appears(text("Drag me down"), timeout: 5))
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(appears(id("md-focused"), timeout: 5))
        waitLabel(id("md-focused"), "focused 2")
        let stack = id("md-stack").label
        let y0 = text("Modal drag lab").frame.minY
        drag(from: 0.3, to: 0.8, velocity: 2500, hold: 0)
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(text("Modal drag lab").exists, "the lab left")
        XCTAssertEqual(text("Modal drag lab").frame.minY, y0, accuracy: 1, "the lab moved")
        XCTAssertEqual(id("md-stack").label, stack)
        XCTAssertEqual(id("md-focused").label, "focused 2")
    }

    /// A drag down on a see-through card's backdrop (it lets the touch through to the lab below) takes the card away
    /// too; the lab under it doesn't move.
    func testSeeThroughBackdropDrag() {
        let stack = open("See-through", title: "See-through card")
        let card = text("See-through card")
        let lab = text("Modal drag lab")
        let l0 = lab.frame.minY
        drag(from: 0.15, to: 0.4, velocity: 2000, hold: 0)
        eventually("the card left") { !card.exists }
        XCTAssertEqual(lab.frame.minY, l0, accuracy: 1, "the lab under the card moved")
        closed("See-through card", stack: stack, focused: 2)
    }
}
