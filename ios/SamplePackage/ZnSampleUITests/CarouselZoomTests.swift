import XCTest

/// The zoomable photos in a Carousel (route motionMediaLab, examples/sample/src/MotionMediaLab.tsx, part a): a double
/// tap zooms a photo to 2.5x, and a drag soon after moves the photo, not the Carousel's page; at fit the drag turns it.
/// Round 7 (ZnGestureHub.held): a pan held by UIKit for the hub's claim reads "began" and no longer counts as having
/// the touch. Here UIKit gives the zoomed drags' moves to the claim first (it passed 4 of 4 without the fix too); the
/// drag at fit does meet the held pan (ZN_GESTURE_LOG "held for the claim") and must still turn the page. The race
/// itself is ImageViewerTests.testZoomKeepsThePage's. The photos come from picsum.photos (a network is needed).
final class CarouselZoomTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        let app = newApp()
        app.launchEnvironment["ZN_ROUTE"] = "motionMediaLab"
        app.launchEnvironment["ZN_MOTION_ENGINE"] = "1"
        app.launch()
        self.app = app
        XCTAssertTrue(appears(first, timeout: 30), "motionMediaLab: no photo after 30 s")
    }

    /// The Carousel's first photo (each one is read as "Photo").
    private var first: XCUIElement { app.otherElements.matching(NSPredicate(format: "label == %@", "Photo")).firstMatch }

    private var zoomedHint: XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Drag to look around")).firstMatch
    }

    /// Three times: double tap, a short drag at once (inside the zoomed photo's edges), the page stays; double tap out.
    func testDragAfterDoubleTapMovesThePhoto() {
        let home = first.frame.minX
        var zooms = 0
        for round in 1...3 {
            first.doubleTap()
            guard appears(zoomedHint, timeout: 2) else { continue }  // a busy simulator sent the taps too far apart
            zooms += 1
            let start = first.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -100, dy: 0)), withVelocity: 300, thenHoldForDuration: 0.3)
            RunLoop.current.run(until: Date().addingTimeInterval(1))
            XCTAssertEqual(first.frame.minX, home, accuracy: 2, "round \(round): the drag on the zoomed photo turned the page")
            first.doubleTap()
            eventually("round \(round): the photo is back at fit") { !zoomedHint.exists }
        }
        XCTAssertGreaterThan(zooms, 0, "no double tap zoomed the photo")
        // At fit, the same drag turns the page.
        let start = first.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -200, dy: 0)), withVelocity: 300, thenHoldForDuration: 0.1)
        eventually("at fit, the drag didn't turn the page") { first.frame.minX < home - 100 }
    }
}
