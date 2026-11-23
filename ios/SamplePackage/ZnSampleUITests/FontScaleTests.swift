import XCTest

/// Dynamic Type and maxFontScale on ComponentsScreen's "maxFontScale comparison": the sample launched at a text size
/// (UIKit's launch argument, so the simulator's own setting is left alone). Both texts are 15 pt and about as long;
/// the capped one stops at 1.15x.
final class FontScaleTests: ZnUITestCase {
    private func heights(_ size: String) -> (uncapped: CGFloat, capped: CGFloat) {
        launch("components", arguments: ["-UIPreferredContentSizeCategoryName", size], ready: "comp-title")
        let uncapped = reveal(id("comp-font-uncapped")), capped = reveal(id("comp-font-capped"))
        return (uncapped.frame.height, capped.frame.height)
    }

    func testDefaultSizeDrawsBothAlike() {
        let h = heights("UICTContentSizeCategoryL")
        XCTAssertGreaterThan(h.capped, 0)
        XCTAssertEqual(h.uncapped / h.capped, 1, accuracy: 0.35, "at the default size: \(h)")
    }

    func testLargestSizeGrowsOnlyTheUncappedText() {
        let h = heights("UICTContentSizeCategoryAccessibilityXXXL")
        XCTAssertGreaterThan(h.uncapped, h.capped * 1.6, "at the largest size: \(h)")
    }
}
