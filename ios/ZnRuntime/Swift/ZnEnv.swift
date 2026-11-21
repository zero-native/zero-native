// SwiftUI environment values shared by several parts of the renderer, kept in one file so each part reads the same
// key (touch, impressions, shared elements, gestures), and the one text-size scale the drawn text and JS both use.
import SwiftUI
import UIKit

extension EnvironmentValues {
    /// Inside an element with pointerEvents "none", or the children of "box-only" (Android's LocalTouchOff): nothing
    /// here takes a tap. SwiftUI's allowsHitTesting(false) is set too; this hides the UIKit touch views (Pressables, a
    /// tappable Text) from ZnTouchControl's inner-Pressable check, and TextField boxes from it.
    @Entry var znTouchOff = false
    /// The back-stack entry (screen instance id) this view is drawn in; 0 outside a screen. Impressions and shared
    /// elements count under it, as Android's keys count under the screen's entry.
    @Entry var znEntry: UInt32 = 0
    /// How many gesture nodes are around this view (+1 per node with a gesture): the inner one wins a touch first.
    @Entry var znGestureDepth = 0
}

/// The phone's text size setting as a scale (Android's fontScale): large (the default) is 1, the biggest accessibility
/// size about 3.1, the small ones below 1. The same number for the drawn text and for JS's PixelRatio.getFontScale().
func znContentSizeScale(_ category: UIContentSizeCategory) -> CGFloat {
    UIFontMetrics.default.scaledValue(for: 100, compatibleWith: UITraitCollection(preferredContentSizeCategory: category)) / 100
}
