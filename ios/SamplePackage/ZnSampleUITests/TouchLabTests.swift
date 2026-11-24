import XCTest

/// The touch lab (route touchLab, examples/sample/src/TouchLab.tsx): who takes a tap where Pressables, scrolls and
/// overlays meet, as Compose's hit test (ZnTouchControl.hitTest, ZnPressInner.swift). Each press writes
/// "status: ..." into touch-status.
final class TouchLabTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        launch("touchLab", ready: "touch-status")
    }

    private func status(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("touch-status"), "status: \(s)", file: file, line: line)
    }

    private func at(_ e: XCUIElement, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        e.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    /// A drag across [e] from right to left, held [hold] s before it moves (0.05: a swipe; 0.5: a hold, then a drag).
    private func swipeLeft(_ e: XCUIElement, hold: TimeInterval = 0.05) {
        at(e, 0.85, 0.5).press(forDuration: hold, thenDragTo: at(e, 0.15, 0.5), withVelocity: .default, thenHoldForDuration: 0.1)
    }

    func testFixedButtonOverClippedChips() {
        // Chips of the Scroll above go on under Pay (clipped away): Pay takes a tap over them, on its left (a chip
        // under it) as on its right.
        let pay = id("pay")
        at(pay, 0.08, 0.3).tap()
        status("pay")
        at(id("chips"), 0.08, 0.6).tap()  // a chip in view: the chip
        eventually("a chip") { id("touch-status").label.hasPrefix("status: chip") }
        at(pay, 0.92, 0.7).tap()
        status("pay")
    }

    func testBackdropOverSmallButtons() {
        // OVER is drawn on top of under-0..3: it takes the tap, not the smaller button under it.
        id("under-0").tap()
        status("over")
        at(id("over"), 0.95, 0.5).tap()
        status("over")
    }

    func testScrollInsideCardSwipes() {
        // The rail's chips are inside the card's one element: its onScrollEndDrag says where it ended.
        let rail = at(id("rail-card"), 0.5, 0.72)
        rail.withOffset(CGVector(dx: 120, dy: 0)).press(forDuration: 0.05, thenDragTo: rail.withOffset(CGVector(dx: -120, dy: 0)),
                                                         withVelocity: .default, thenHoldForDuration: 0.1)
        waitLabel(id("touch-scroll"), "scrolled: rail moved")
        XCTAssertEqual(id("touch-status").label, "status: ready", "the swipe pressed the card")
        // Held first (the press begins), then dragged: the scroll cancels it, no onPress.
        rail.withOffset(CGVector(dx: 120, dy: 0)).press(forDuration: 0.5, thenDragTo: rail.withOffset(CGVector(dx: -120, dy: 0)),
                                                         withVelocity: .default, thenHoldForDuration: 0.1)
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(id("touch-status").label, "status: ready", "the drag after a hold pressed the card")
        // A tap on the rail presses the card, as on Android.
        rail.tap()
        status("rail card")
    }

    func testCarouselInsideCardSwipes() {
        swipeLeft(id("carousel-card"))
        status("page 1")
        id("carousel-card").tap()
        status("carousel card")
    }

    func testListInsideCardSwipes() {
        swipeLeft(id("list-card"))
        waitLabel(id("touch-scroll"), "scrolled: list moved")
        XCTAssertEqual(id("touch-status").label, "status: ready", "the swipe pressed the card")
        id("list-card").tap()
        status("list card")
    }

    func testQuickTapInScroll() {
        // A quick tap inside a Scroll (UIKit hands its start and end over at once) still presses: onPress here, the
        // ripple and pressScale checked by eye / video (ZnPressState.minShown).
        id("quick-card").tap()
        status("quick card")
    }
}
