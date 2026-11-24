import XCTest

/// The base of the sample's UI tests. Each test launches the sample on one route (ZN_ROUTE, as
/// tools/ios-sample.ts --route; ios/Sample/ZnSampleApp.swift) and finds elements by testID, which is the
/// accessibilityIdentifier on iOS (the resource id on Android).
class ZnUITestCase: XCTestCase {
    var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        app?.terminate()
        super.tearDown()
    }

    /// Starts the sample on [route] and waits until [ready] (a testID) is on screen: the first JS batch has drawn.
    @discardableResult
    func launch(_ route: String, params: String? = nil, arguments: [String] = [], ready: String,
                file: StaticString = #filePath, line: UInt = #line) -> XCUIApplication {
        launch(route, params: params, arguments: arguments, until: { self.id(ready) }, file: file, line: line)
    }

    /// Starts the sample on [route] and waits until the element [until] gives (found once the app runs) is on
    /// screen, for a screen whose first element has no testID (a field found by its placeholder, a hub row by its label).
    @discardableResult
    func launch(_ route: String, params: String? = nil, arguments: [String] = [], until: () -> XCUIElement,
                file: StaticString = #filePath, line: UInt = #line) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["ZN_ROUTE"] = route
        if let params { app.launchEnvironment["ZN_PARAMS"] = params }
        // TEST_RUNNER_ZN_APP_<NAME>=v (the runner's environment; xcodebuild hands it to the tests as ZN_APP_<NAME>):
        // <NAME>=v for the app, e.g. TEST_RUNNER_ZN_APP_ZN_MOTION_ENGINE=0.
        for (k, v) in ProcessInfo.processInfo.environment where k.hasPrefix("ZN_APP_") {
            app.launchEnvironment[String(k.dropFirst("ZN_APP_".count))] = v
        }
        app.launchArguments += arguments
        app.launch()
        self.app = app
        let ready = until()
        XCTAssertTrue(appears(ready, timeout: 30), "\(route): no \(ready) after 30 s", file: file, line: line)
        return app
    }

    /// The element whose testID (accessibilityIdentifier) is exactly [testID], of any type.
    func id(_ testID: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", testID)).firstMatch
    }

    /// How many elements carry [testID] (0 for a hidden one; more than 1 means SwiftUI copied it onto children).
    func count(_ testID: String) -> Int {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", testID)).count
    }

    /// The first static text whose label is exactly [label].
    func text(_ label: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Whether [element] is there within [timeout]: polled every 0.1 s (waitForExistence takes about a second even
    /// for one already there, and the suite waits for hundreds).
    func appears(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while !element.exists {
            if Date() >= end { return false }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return true
    }

    /// Polls [check] every 0.1 s until it holds or [timeout] passes (faster than an XCTNSPredicateExpectation).
    func eventually(_ what: @autoclosure () -> String, timeout: TimeInterval = 5, file: StaticString = #filePath,
                    line: UInt = #line, _ check: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if check() { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        XCTAssertTrue(check(), "not within \(timeout) s: \(what())", file: file, line: line)
    }

    /// Waits until [element]'s label is [expected].
    func waitLabel(_ element: XCUIElement, _ expected: String, timeout: TimeInterval = 5, file: StaticString = #filePath,
                   line: UInt = #line) {
        eventually("label \"\(expected)\" (it is \"\(element.exists ? element.label : "<gone>")\")", timeout: timeout,
                   file: file, line: line) { element.exists && element.label == expected }
    }

    /// Waits until [element]'s value is [expected] (a Switch: "0" / "1").
    func waitValue(_ element: XCUIElement, _ expected: String, timeout: TimeInterval = 5, file: StaticString = #filePath,
                   line: UInt = #line) {
        eventually("value \"\(expected)\" (it is \"\(String(describing: element.value))\")", timeout: timeout,
                   file: file, line: line) { (element.value as? String) == expected }
    }

    /// Scrolls until [element] is on screen and can be tapped: a long Scroll's lower parts (or upper ones, after a
    /// scroll down), above the keyboard while it shows. By drags, each as far as it still needs (at most most of a
    /// screen) and held at the end so nothing flings past it; quicker ones while it is more than two of those away (a quick
    /// one may still go past: near, back and forth for ever on a just-booted simulator, 2026-11-24). A drag that moved nothing
    /// (it began on a nested scroll or a carousel) is tried again in the right gutter, then near the left edge. (A
    /// fast swipeUp() scrolled nothing in the RN props lab, 2026-11-24.) A lazy list's row that doesn't exist yet:
    /// swipes up until it does.
    /// [hittable] false: on screen is enough (a multiline field reads as not hittable: tap its coordinate).
    @discardableResult
    func reveal(_ element: XCUIElement, hittable: Bool = true, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let window = app.windows.firstMatch.frame
        var swipes = 0
        while !element.exists && swipes < 12 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(appears(element, timeout: 5), "no \(element)", file: file, line: line)
        let columns = [window.midX, window.maxX - 8, window.minX + 24]
        var still = 0  // drags in a row that moved nothing: the next column; all of them: covered, or the content's end
        for _ in 0..<40 where still < columns.count {
            let keyboard = app.keyboards.firstMatch
            let top = window.minY + 100
            let bottom = (keyboard.exists ? keyboard.frame.minY : window.maxY) - 40
            let f = element.frame
            if f.minY >= top && f.maxY <= bottom && (!hittable || element.isHittable) { return element }
            // How far the content must move up (down when negative) to put the element in the middle of what shows.
            let move = f.midY - (top + bottom) / 2
            let room = (bottom - top) * 0.8
            let step = max(min(move, room), -room)
            let mid = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: columns[still], dy: (top + bottom) / 2))
            mid.withOffset(CGVector(dx: 0, dy: step / 2))
                .press(forDuration: 0.05, thenDragTo: mid.withOffset(CGVector(dx: 0, dy: -step / 2)),
                       withVelocity: abs(move) > room * 2 ? XCUIGestureVelocity(2500) : .slow, thenHoldForDuration: 0.1)
            still = abs(element.frame.minY - f.minY) < 1 ? still + 1 : 0
        }
        XCTAssertTrue(element.isHittable, "\(element) can't be tapped (frame \(element.frame))", file: file, line: line)
        return element
    }

    /// Prints the app's accessibility tree (what XCUITest sees) to the test log.
    func dump() { print("ZN-DUMP-BEGIN\n\(app.debugDescription)\nZN-DUMP-END") }
}
