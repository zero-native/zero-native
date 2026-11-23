import XCTest

/// Not a check: prints a route's accessibility tree, to see what a new test can find. Run it alone with
/// `tools/ios-ui-test.ts --only DumpTests --dump <route> [--ready <testID>]`; in a normal run it is skipped.
final class DumpTests: ZnUITestCase {
    func testDump() throws {
        let env = ProcessInfo.processInfo.environment
        guard let route = env["ZN_UI_DUMP_ROUTE"], !route.isEmpty else { throw XCTSkip("no ZN_UI_DUMP_ROUTE") }
        launch(route, ready: env["ZN_UI_DUMP_READY"] ?? "")
        dump()
    }
}
