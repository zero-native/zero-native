import XCTest

/// ComponentsScreen (route components, examples/sample/src/ComponentsScreen.tsx): Switch, Checkbox, Progress, Toast,
/// a Sheet, and its accessibility card (label, role none, hidden), found by their "comp-..." testIDs.
final class ComponentsTests: ZnUITestCase {
    override func setUp() {
        super.setUp()
        launch("components", ready: "comp-title")
    }

    func testTitleAndHeaders() {
        XCTAssertEqual(id("comp-title").label, "Components & a11y")
        // Section headers (accessibilityRole="header") are read as their text.
        for header in ["Controlled Switch", "Controlled Checkbox", "Progress Bar", "Accessibility & Font Scaling"] {
            XCTAssertTrue(text(header).exists, "no header \"\(header)\"")
        }
        // The back arrow reads its accessibilityLabel, not "←".
        XCTAssertEqual(id("comp-back").label, "Back to dev menu")
        XCTAssertEqual(id("comp-back").elementType, .button)
    }

    func testSwitches() {
        let sw = id("comp-switch")
        let state = id("comp-switch-state")
        XCTAssertEqual(sw.value as? String, "0")
        XCTAssertEqual(state.label, "State: OFF (inactive)")
        sw.tap()
        waitValue(sw, "1")
        waitLabel(state, "State: ON (active)")
        sw.tap()
        waitValue(sw, "0")
        waitLabel(state, "State: OFF (inactive)")

        // JS ignores the tap: the value it gives stays false, so the Switch stays off.
        let ignored = id("comp-switch-ignored")
        ignored.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(ignored.value as? String, "0")

        // JS sets the value 300 ms after the tap.
        let delayed = id("comp-switch-delayed")
        delayed.tap()
        waitValue(delayed, "1", timeout: 3)

        // Disabled: dimmed (not enabled), and a tap changes nothing.
        let off = id("comp-switch-off-disabled"), on = id("comp-switch-on-disabled")
        XCTAssertFalse(off.isEnabled)
        XCTAssertFalse(on.isEnabled)
        XCTAssertEqual(off.value as? String, "0")
        XCTAssertEqual(on.value as? String, "1")
        off.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(off.value as? String, "0")
    }

    func testCheckboxes() {
        let box = id("comp-check")
        let state = id("comp-check-state")
        XCTAssertEqual(box.value as? String, "0")
        XCTAssertEqual(state.label, "State: Unchecked")
        box.tap()
        waitValue(box, "1")
        waitLabel(state, "State: Checked")

        let ignored = id("comp-check-ignored")
        ignored.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(ignored.value as? String, "0")

        XCTAssertFalse(id("comp-check-off-disabled").isEnabled)
        XCTAssertFalse(id("comp-check-on-disabled").isEnabled)
        XCTAssertEqual(id("comp-check-on-disabled").value as? String, "1")
    }

    func testProgressButtons() {
        let label = id("comp-progress-label")
        XCTAssertEqual(label.label, "Determinate (Value: 40%)")
        for (button, percent) in [("comp-progress-75", 75), ("comp-progress-10", 10), ("comp-progress-100", 100)] {
            id(button).tap()
            waitLabel(label, "Determinate (Value: \(percent)%)")
        }
    }

    func testToastAndSheet() {
        reveal(id("comp-toast-short")).tap()
        XCTAssertTrue(appears(text("Changes saved successfully"), timeout: 3), "no toast")

        // The sheet draws in its own window; a toast from inside it must still show.
        reveal(id("comp-sheet-open")).tap()
        let title = id("comp-sheet-title")
        XCTAssertTrue(appears(title, timeout: 3), "the sheet didn't open")
        XCTAssertEqual(title.label, "UPI ID: store@upi")
        id("comp-sheet-copy").tap()
        XCTAssertTrue(appears(text("UPI ID copied"), timeout: 3), "no toast from the sheet")

        // Its content grows and shrinks.
        XCTAssertFalse(id("comp-sheet-lines").exists)
        id("comp-sheet-more").tap()
        XCTAssertTrue(appears(id("comp-sheet-lines"), timeout: 3))
        id("comp-sheet-more").tap()
        eventually("the extra lines go") { !self.id("comp-sheet-lines").exists }

        // Dragged down from its title to the bottom of the screen, it closes (onDismiss sets visible false). Slowly:
        // XCUITest's quicker drags (400 px/s, its plain drag, swipeDown) left it open every time, while a slow one
        // closed it every time (2026-11-24; a hand's quick flick closes it).
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: bottom, withVelocity: .slow, thenHoldForDuration: 0)
        eventually("the sheet closes", timeout: 5) { !title.exists }
    }

    func testAccessibilityCard() {
        // accessibilityLabel replaces the Pressable's own texts; testID is its identifier.
        let labelled = reveal(id("comp-a11y-label"))
        XCTAssertEqual(labelled.label, "Custom accessibility label for TalkBack")
        XCTAssertEqual(labelled.elementType, .button)
        XCTAssertTrue(app.buttons["Custom accessibility label for TalkBack"].exists)

        // accessibilityRole="none": not a button, but a tap still runs onPress.
        let none = reveal(id("comp-role-none"))
        XCTAssertNotEqual(none.elementType, .button)
        XCTAssertEqual(app.buttons.matching(identifier: "comp-role-none").count, 0)
        none.tap()
        XCTAssertTrue(appears(text("Tapped role:none pressable"), timeout: 3), "role none didn't press")

        // accessibilityHidden: neither the card (even with a testID) nor its text is there.
        XCTAssertEqual(count("comp-hidden"), 0)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "accessibilityHidden: true")).count, 0)

        // A labelled picture is an image read by its label.
        let picture = id("comp-image-fallback")
        XCTAssertEqual(picture.elementType, .image)
        XCTAssertEqual(picture.label, "Fallback demo image")
    }

    func testTestIDsAreUnique() {
        // Each testID marks one element: SwiftUI must not copy a container's identifier onto its children.
        for testID in ["comp-scroll", "comp-switch", "comp-check", "comp-progress-75", "comp-a11y-label", "comp-role-none",
                       "comp-font-uncapped", "comp-font-spans"] {
            XCTAssertEqual(count(testID), 1, testID)
        }
    }
}

/// Opening a screen from the Dev hub and going back (nav.push / nav.back).
final class NavigationTests: ZnUITestCase {
    private var componentsEntry: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Components & a11y")).firstMatch
    }

    func testOpenComponentsAndBack() {
        launch("dev", until: { self.componentsEntry })
        let entry = componentsEntry
        reveal(entry).tap()
        XCTAssertTrue(appears(id("comp-title"), timeout: 5), "Components didn't open")
        id("comp-back").tap()
        eventually("back on the Dev screen") { !self.id("comp-title").exists && entry.exists }
    }
}
