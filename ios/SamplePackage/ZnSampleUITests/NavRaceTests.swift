import XCTest

/// A second push or back while a slide is still under way (examples/sample/src/NavRaceLab.tsx). Before 2026-11-24 the
/// first slide's didShow took JS's queued push for a swipe back: JS lost the screen (FORCED_BACK), its instance was
/// released, and native then showed it blank white.
final class NavRaceTests: ZnUITestCase {
    /// Real taps: "Push again" on a screen while it is still sliding in, several times in a row.
    func testTapWhileSlidingIn() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        for round in 1...4 {
            app.buttons["Push target"].firstMatch.tap()
            // Tapped as soon as XCUITest finds the button: the screen is still sliding in.
            let again = app.buttons["Push again"].firstMatch
            XCTAssertTrue(appears(again, timeout: 5))
            again.tap()
            // Step 2 is drawn (not a blank screen), and stays after the slides end.
            XCTAssertTrue(appears(text("Race target 2"), timeout: 5), "round \(round): no step 2")
            RunLoop.current.run(until: Date().addingTimeInterval(1.2))
            XCTAssertTrue(text("Race target 2").exists, "round \(round): step 2 gone")
            // Back twice, the second while the first slide runs.
            app.buttons["Back"].firstMatch.tap()
            if app.buttons["Back"].firstMatch.exists { app.buttons["Back"].firstMatch.tap() }
            XCTAssertTrue(appears(text("Navigation race"), timeout: 5), "round \(round): the lab didn't come back")
            RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        }
    }

    /// The lab's sweep: push / back right after another change, at 0 to 900 ms, every case keeps JS's stack.
    func testRaceSweep() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        app.buttons["Run race"].firstMatch.tap()
        let result = id("nav-race-result")
        // About 140 s: 44 cases, each waiting for its slides to end.
        eventually("the sweep ends (\(result.label))", timeout: 220) { result.label.contains("/") }
        XCTAssertEqual(result.label, "result: 44/44")
    }
}
