// The gesture a node handles (gestureSlot, ZnGesture.kt). A pass-through for now; applied inside ZnPaintLayers before
// ZnLayer, so its touch area moves, scales and turns with the node.
import SwiftUI

struct ZnGestureModifier: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View { content }
}
