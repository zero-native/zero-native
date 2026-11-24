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

    /// The lab's sweep: push / back right after another change, at 0 to 700 ms, every case keeps JS's stack. The quick
    /// one (16 cases, about 55 s): tools/ios-ui-test.ts stops a test after 2 minutes; the lab's button alone runs 44.
    func testRaceSweep() {
        launch("navRaceLab", params: #"{"quick":true}"#, until: { self.text("Navigation race") })
        app.buttons["Run race"].firstMatch.tap()
        // The lab is covered most of the time: only existence is asked (reading the label of an element that has just
        // gone fails the test).
        let passed = text("result: 16/16")
        let ended = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "result: ", "/")).firstMatch
        eventually("the sweep ends", timeout: 100) { ended.exists }
        XCTAssertTrue(passed.exists, "not every case kept JS's stack (the app's log has a nav-race FAIL line)")
    }
}
