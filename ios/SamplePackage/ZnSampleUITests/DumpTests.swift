import XCTest

/// Not a check: prints a route's accessibility tree, to see what a new test can find. Run it alone with
/// `tools/ios-ui-test.ts --only DumpTests --dump <route> [--ready <testID>]`; in a normal run it is skipped.
final class DumpTests: ZnUITestCase {
    func testDump() throws {
        let env = ProcessInfo.processInfo.environment
        guard let route = env["ZN_UI_DUMP_ROUTE"], !route.isEmpty else { throw XCTSkip("no ZN_UI_DUMP_ROUTE") }
        if let ready = env["ZN_UI_DUMP_READY"], !ready.isEmpty {
            launch(route, ready: ready)
        } else {
            // No id to wait for: give the first JS batch a moment to draw.
            launch(route, until: { self.app.windows.firstMatch })
            sleep(3)
        }
        dump()
    }
}
