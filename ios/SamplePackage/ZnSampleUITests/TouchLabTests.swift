import XCTest

/// The touch lab (route touchLab, examples/sample/src/TouchLab.tsx): who takes a tap where Pressables, scrolls and
/// overlays meet, as Compose's hit test (ZnTouchControl.hitTest, ZnPressInner.swift). Each onPress writes
/// "status: <card>" into touch-status; the cards' press events go into touch-press.
class TouchLabCase: ZnUITestCase {
    func status(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        waitLabel(id("touch-status"), "status: \(s)", file: file, line: line)
    }

    /// The cards' last press events ("rail card in", "rail card out cancelled", "rail card press", ...).
    var presses: String { id("touch-press").label }

    /// Waits until the press events end with [tail] (comma-separated, as the label shows them).
    func pressesEnd(_ tail: String, file: StaticString = #filePath, line: UInt = #line) {
        eventually("press events ending \"\(tail)\" (they are \"\(presses)\")", file: file, line: line) { presses.hasSuffix(tail) }
    }

    func at(_ e: XCUIElement, _ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
        e.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
    }

    /// A drag across [p] from right to left, held [hold] s before it moves (0.05: a swipe; 0.5: a hold, then a drag).
    func swipeLeft(_ p: XCUICoordinate, hold: TimeInterval = 0.05) {
        p.withOffset(CGVector(dx: 120, dy: 0)).press(forDuration: hold, thenDragTo: p.withOffset(CGVector(dx: -120, dy: 0)),
                                                      withVelocity: .default, thenHoldForDuration: 0.1)
    }

    func settle(_ s: TimeInterval = 0.5) { RunLoop.current.run(until: Date().addingTimeInterval(s)) }
}

final class TouchLabTests: TouchLabCase {
    override func setUp() {
        super.setUp()
        launch("touchLab", ready: "touch-status")
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
        swipeLeft(rail)
        waitLabel(id("touch-scroll"), "scrolled: rail moved")
        settle()
        // A swipe that starts at once presses nothing on iOS (UIKit's content delay; Android: in, out cancelled).
        XCTAssertFalse(presses.contains("rail card"), "the swipe pressed the card: \(presses)")
        // Held first (the press begins), then dragged: the scroll cancels it, onPressOut(true) and no onPress.
        swipeLeft(rail, hold: 0.5)
        pressesEnd("rail card in, rail card out cancelled")
        settle()
        XCTAssertFalse(presses.contains("rail card press"), "the drag after a hold pressed the card: \(presses)")
        XCTAssertEqual(id("touch-status").label, "status: ready")
        // A tap on the rail presses the card, as on Android.
        rail.tap()
        status("rail card")
        pressesEnd("rail card in, rail card out lifted, rail card press")
    }

    func testCarouselInsideCardSwipes() {
        swipeLeft(at(id("carousel-card"), 0.5, 0.5))
        status("page 1")
        settle()
        XCTAssertFalse(presses.contains("carousel card press"), "the swipe pressed the card: \(presses)")
        id("carousel-card").tap()
        status("carousel card")
        pressesEnd("carousel card out lifted, carousel card press")
    }

    func testListInsideCardSwipes() {
        swipeLeft(at(id("list-card"), 0.5, 0.5))
        waitLabel(id("touch-scroll"), "scrolled: list moved")
        settle()
        XCTAssertFalse(presses.contains("list card press"), "the swipe pressed the card: \(presses)")
        id("list-card").tap()
        status("list card")
        pressesEnd("list card out lifted, list card press")
    }

    func testQuickTapInScroll() {
        // A quick tap inside a Scroll: UIKit hands its start and end over at once, at the lift. The press look still
        // shows (ZnPressState.minShown): its `pressed` value (the same state as the ripple, pressScale and
        // pressOpacity) rises well above 0; it stayed at 0.0 before.
        at(id("quick-card"), 0.5, 0.5).press(forDuration: 0.05)
        status("quick card")
        let look = id("touch-look")
        eventually("the pressed look shows (it is \"\(look.label)\")") {
            (Double(look.label.replacingOccurrences(of: "pressed look: ", with: "")) ?? 0) >= 0.5
        }
    }
}

/// The lab's other part ({"mode":"more"}): onLongPress on a rail, pointerEvents around a rail, plugin views in cards.
final class TouchLabMoreTests: TouchLabCase {
    override func setUp() {
        super.setUp()
        launch("touchLab", params: #"{"mode":"more"}"#, ready: "touch-status")
    }

    func testLongPressOnRail() {
        let rail = at(id("long-card"), 0.5, 0.7)
        // The press begins after the rail's 150 ms delay, but onLongPress is 0.5 s after the finger went down (it
        // was at 0.65 s): a 0.6 s hold long-presses.
        rail.press(forDuration: 0.6)
        status("long card long")
        XCTAssertFalse(presses.contains("long card press"), "a long press also pressed: \(presses)")
        // A 0.3 s hold is a tap.
        rail.press(forDuration: 0.3)
        status("long card")
        pressesEnd("long card out lifted, long card press")
    }

    /// The rail in [card] takes no touches (pointerEvents): a swipe on it doesn't scroll it, a tap presses the card.
    private func railTakesNoTouches(_ card: String, _ name: String) {
        let rail = at(id(card), 0.5, 0.7)
        swipeLeft(rail)
        settle(1)
        XCTAssertEqual(id("touch-scroll").label, "scrolled: none", "the rail took the swipe")
        rail.tap()
        status(name)
    }

    func testBoxOnlyCardKeepsItsRailsTouches() { railTakesNoTouches("boxonly-card", "box-only card") }

    func testRailInPointerEventsNoneKeepsTheCardsTouches() { railTakesNoTouches("none-card", "none card") }

    func testLottieInCardPresses() {
        // A Lottie view only draws: the card takes the tap, as Android's AndroidView that doesn't handle the down.
        at(id("lottie-card"), 0.5, 0.5).tap()
        status("lottie card")
    }

    func testWebViewInCardTakesTheTouch() {
        settle(1.5)  // the page loads
        at(id("web-card"), 0.5, 0.5).tap()
        settle(1)
        XCTAssertFalse(presses.contains("web card"), "the tap on the WebView pressed its card: \(presses)")
        XCTAssertEqual(id("touch-status").label, "status: ready")
    }
}
