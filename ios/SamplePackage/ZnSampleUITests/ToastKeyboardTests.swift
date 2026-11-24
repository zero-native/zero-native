import XCTest

/// The toast rides up and down with the keyboard while it shows (Android pads it by navigationBars ∪ ime on every
/// frame). Before 2026-11-24 its place was fixed when it was shown: a keyboard opening after it covered it, and one
/// closing left it floating a keyboard's height up the screen. Navigation race lab's toast row (NavRaceLab.tsx).
final class ToastKeyboardTests: ZnUITestCase {
    func testToastFollowsKeyboard() {
        launch("navRaceLab", until: { self.text("Navigation race") })
        let field = app.textFields["A field for the keyboard"].firstMatch
        let keyboard = app.keyboards.firstMatch
        let toast = text("Saved")
        // The keyboard comes up while the toast shows: the toast moves above it.
        app.buttons["Toast"].firstMatch.tap()
        XCTAssertTrue(appears(toast, timeout: 2), "no toast")
        let low = toast.frame
        field.tap()
        guard appears(keyboard, timeout: 3) else {
            // A hardware keyboard on the simulator (I/O > Keyboard > Connect Hardware Keyboard): nothing to follow.
            return print("no on-screen keyboard; skipped")
        }
        eventually("the toast sits above the keyboard (toast \(toast.frame), keyboard \(keyboard.frame))") {
            toast.exists && toast.frame.maxY <= keyboard.frame.minY && toast.frame.minY < low.minY - 100
        }
        // Wait for this toast to go, then show one over the keyboard and close the keyboard: it comes back down.
        eventually("the first toast goes", timeout: 6) { !toast.exists }
        app.buttons["Toast"].firstMatch.tap()
        XCTAssertTrue(appears(toast, timeout: 2), "no second toast")
        app.buttons["Hide keyboard"].firstMatch.tap()
        eventually("the toast is back near the bottom (toast \(toast.frame), first \(low))") {
            toast.exists && abs(toast.frame.minY - low.minY) < 2
        }
    }
}
