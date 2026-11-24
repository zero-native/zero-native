import XCTest

/// A second push or back while a slide is still under way (examples/sample/src/NavRaceLab.tsx). Before 2026-11-24 the
/// first slide's didShow took JS's queued push for a swipe back: JS lost the screen (FORCED_BACK), its instance was
/// released, and native then showed it blank white.
final class NavRaceTests: ZnUITestCase {
    /// Real taps: "Push again" on a new screen, then Back twice. XCUITest waits for the app's animations to end before
    /// each tap, so these come after the slides (a smoke test); the race itself is testRaceSweep's.
    func testTapWhileSlidingIn() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        for round in 1...3 {
            app.buttons["Push target"].firstMatch.tap()
            let again = app.buttons["Push again"].firstMatch
            XCTAssertTrue(appears(again, timeout: 5))
            again.tap()
            XCTAssertTrue(appears(text("Race target 2"), timeout: 5), "round \(round): no step 2")
            RunLoop.current.run(until: Date().addingTimeInterval(1.2))
            XCTAssertTrue(text("Race target 2").exists, "round \(round): step 2 gone")
            app.buttons["Back"].firstMatch.tap()
            if app.buttons["Back"].firstMatch.exists { app.buttons["Back"].firstMatch.tap() }
            XCTAssertTrue(appears(text("Navigation race"), timeout: 5), "round \(round): the lab didn't come back")
            RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        }
    }

    /// The lab's race, stepwise (12 cases at 50, 300 and 600 ms): after each case JS's stack is right ("ok") and native
    /// shows the screen JS has on top (only the shown screen's elements are there; a blank screen has none).
    func testRaceSweep() {
        launch("navRaceLab", params: #"{"stepwise":true}"#, until: { self.text("Navigation race") })
        app.buttons["Run race"].firstMatch.tap()
        let wait = id("nav-race-wait")
        for n in 1...12 {
            eventually("case \(n) waits (the screen native shows has the lab's wait text)", timeout: 15) {
                wait.exists && wait.label.hasPrefix("case \(n) ")
            }
            let label = wait.label
            XCTAssertTrue(label.contains(" ok "), "JS's stack: \(label)")
            let shows = label.components(separatedBy: " expects ").last ?? ""
            XCTAssertTrue(text(shows).exists, "native doesn't show \(shows): \(label)")
            if shows == "Navigation race" {
                XCTAssertFalse(raceTargets().firstMatch.exists, "a target still shows over the lab: \(label)")
            } else {
                XCTAssertFalse(text("Navigation race").exists, "\(label), the lab shows")
                XCTAssertEqual(raceTargets().count, 1, "\(label): another target shows too")
            }
            app.buttons["Next case"].firstMatch.tap()
        }
        XCTAssertTrue(appears(text("result: 12/12"), timeout: 10), "the race didn't end 12/12")
    }

    /// JS pushes while a back swipe is held, and the swipe then finishes: native and JS both end on the new screen
    /// over the lab, and Back from it shows the lab (before the fix, the swiped-off screen came back blank under it).
    func testPushDuringSwipe() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        app.buttons["Push target"].firstMatch.tap()
        XCTAssertTrue(appears(text("Race target 1"), timeout: 5))
        app.buttons["Push in 2 s"].firstMatch.tap()
        // From the left edge to three quarters across, held there for 3 s (the push comes meanwhile), let go: past
        // half, so the swipe finishes.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.6)).withOffset(CGVector(dx: 8, dy: 0))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.6))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: XCUIGestureVelocity(400), thenHoldForDuration: 3)
        XCTAssertTrue(appears(text("Race target 9"), timeout: 5), "the push during the swipe isn't shown")
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertTrue(text("Race target 9").exists, "step 9 gone")
        XCTAssertEqual(raceTargets().count, 1, "another target shows with step 9")
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(appears(text("Navigation race"), timeout: 5), "Back from step 9 didn't show the lab")
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertTrue(text("Navigation race").exists, "the lab didn't stay")
        XCTAssertFalse(raceTargets().firstMatch.exists, "a target still shows")
    }

    /// The "Race target N" texts on screen.
    private func raceTargets() -> XCUIElementQuery {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Race target "))
    }
}
