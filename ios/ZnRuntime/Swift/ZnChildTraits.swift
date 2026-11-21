// What a node tells its parent's Layout, set by the node itself as its outermost modifier in ZnNodeView. Later
// layout values a parent reads (sizes from slots, insets) go here, not in the renderer.
import SwiftUI

/// What a child tells its parent's layout, set by the child itself (outermost, so the parent's Layout sees it): its
/// "%" size and, in a Stack, its absolute insets. Read here, a slot's change (an animated `start`) re-places the child
/// without running the parent's body again.
struct ZnChildTraits: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        content
            .layoutValue(key: ZnPercentKey.self, value: s.percentNow(inst))
            .layoutValue(key: ZnAbsoluteKey.self, value: s.absolute ? ZnAbsolute(s, inst) : nil)
    }
}
