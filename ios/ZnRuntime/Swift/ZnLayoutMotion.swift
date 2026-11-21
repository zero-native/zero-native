// animateLayout: a node glides to a new size or place (ZnMotionUi.kt znAnimateLayout). A pass-through for now; applied
// right after ZnSizeFrame, so it sees the node's laid-out box.
import SwiftUI

struct ZnAnimateLayout: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View { content }
}
