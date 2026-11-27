import XCTest

/// The left-edge back swipe over a sideways scroll view (the navigation race lab's targets have a rail of 12 tiles,
/// examples/sample/src/NavRaceLab.tsx). As Android's system back gesture, a swipe starting within 30 pt of the edge
/// goes back even over the rail; from further in, the rail scrolls. On a screen that wants Back (useBack) the swipe
/// asks JS and the rail under the finger doesn't scroll as well.
final class EdgeSwipeTests: ZnUITestCase {
    /// A drag from [x] (points from the left) to three quarters across, on the rail's line.
    private func drag(fromX x: CGFloat, over rail: XCUIElement) {
        let y = rail.frame.midY
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: x, dy: y))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.75, dy: y)),
                   withVelocity: XCUIGestureVelocity(800), thenHoldForDuration: 0.1)
    }

    func testEdgeSwipeOverRail() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        app.buttons["Push target"].firstMatch.tap()
        let tile = text("Rail 1")
        XCTAssertTrue(appears(tile, timeout: 5))
        // From mid-screen the rail scrolls (a drag to the left: at its start it has nothing to the right).
        let x0 = tile.frame.minX
        let y = tile.frame.midY
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: 300, dy: y)).press(forDuration: 0.05,
            thenDragTo: origin.withOffset(CGVector(dx: 100, dy: y)), withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: 0.2)
        eventually("the rail scrolled left (Rail 1 at \(tile.frame.minX), was \(x0))") { tile.frame.minX < x0 - 50 }
        XCTAssertTrue(text("Race target 1").exists, "a drag from mid-screen left the screen")
        // From the edge, over the rail: back to the lab.
        drag(fromX: 8, over: tile)
        XCTAssertTrue(appears(text("Navigation race"), timeout: 5), "the edge swipe over the rail didn't go back")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertFalse(text("Race target 1").exists, "the target came back")
    }

    func testEdgeSwipeOnScreenThatWantsBack() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        app.buttons["Push wants Back"].firstMatch.tap()
        let tile = text("Rail 1")
        XCTAssertTrue(appears(tile, timeout: 5))
        XCTAssertTrue(appears(text("back asked 0"), timeout: 2))
        // The rail scrolled in first (a drag to the left from mid-screen, held so it doesn't coast), so a drag to the
        // right over it could scroll it back.
        let start = tile.frame.minX
        let y = tile.frame.midY
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: 300, dy: y)).press(forDuration: 0.05,
            thenDragTo: origin.withOffset(CGVector(dx: 100, dy: y)), withVelocity: XCUIGestureVelocity(400), thenHoldForDuration: 0.5)
        eventually("the rail scrolled left (Rail 1 at \(tile.frame.minX), was \(start))") { tile.frame.minX < start - 50 }
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        let x0 = tile.frame.minX
        drag(fromX: 8, over: tile)
        XCTAssertTrue(appears(text("back asked 1"), timeout: 3), "JS wasn't asked once (\(id("nav-race-back-asked").label))")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertTrue(text("Race target 1").exists, "the screen left (its handler keeps it)")
        XCTAssertEqual(tile.frame.minX, x0, accuracy: 1, "the rail scrolled as well")
    }

    /// Quick short flicks from the edge (6 pt in, at 8000 pt/s): the pan lets go 1 to 15 ms after UIKit was asked to
    /// pop, about when UIKit asks for the swipe's interaction. To 60 pt it goes back; to 30 pt (cancelled, under 600
    /// pt/s at the let-go) the screen stays and takes taps. A let-go before UIKit asked keeps the interaction for it
    /// (ZnNavController.backPanned): dropped, UIKit ran the pop without it, to the end even when cancelled.
    func testQuickShortEdgeFlicks() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = app.frame.height * 0.45
        let flick = { (to: CGFloat) in
            origin.withOffset(CGVector(dx: 6, dy: y)).press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: to, dy: y)),
                                                            withVelocity: XCUIGestureVelocity(8000), thenHoldForDuration: 0)
        }
        app.buttons["Push target"].firstMatch.tap()
        XCTAssertTrue(appears(text("Race target 1"), timeout: 5))
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        flick(30)
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertTrue(text("Race target 1").exists, "a short flick went back")
        XCTAssertFalse(text("Navigation race").exists, "the lab shows")
        // The screen takes taps: its Push again pushes the next one, which a longer flick takes back.
        app.buttons["Push again"].firstMatch.tap()
        XCTAssertTrue(appears(text("Race target 2"), timeout: 5), "the screen took no tap after the short flick")
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        flick(60)
        XCTAssertTrue(appears(text("Race target 1"), timeout: 5), "the flick didn't go back")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        XCTAssertFalse(text("Race target 2").exists, "the flicked screen came back")
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(appears(text("Navigation race"), timeout: 5), "Back didn't show the lab")
    }
}
