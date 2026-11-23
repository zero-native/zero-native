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
        let app = XCUIApplication()
        app.launchEnvironment["ZN_ROUTE"] = route
        if let params { app.launchEnvironment["ZN_PARAMS"] = params }
        app.launchArguments += arguments
        app.launch()
        self.app = app
        if ready.isEmpty { sleep(3); return app }  // DumpTests with no id to wait for
        XCTAssertTrue(id(ready).waitForExistence(timeout: 30), "\(route): no \"\(ready)\" after 30 s", file: file, line: line)
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

    /// Swipes the screen up until [element] can be tapped (a long Scroll's lower parts), at most [swipes] times.
    @discardableResult
    func reveal(_ element: XCUIElement, swipes: Int = 12, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: 5), "no \(element)", file: file, line: line)
        var left = swipes
        while !element.isHittable && left > 0 {
            app.swipeUp()
            left -= 1
        }
        XCTAssertTrue(element.isHittable, "\(element) can't be tapped after \(swipes) swipes", file: file, line: line)
        return element
    }

    /// Prints the app's accessibility tree (what XCUITest sees) to the test log.
    func dump() { print(app.debugDescription) }
}
