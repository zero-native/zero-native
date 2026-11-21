// The useElementMotion() values a node fills (motionSlot: its box, pressed, scroll; ZnMotionUi.kt). A pass-through for
// now; applied inside ZnPaintLayers before ZnLayer, next to the gesture.
import SwiftUI

struct ZnElementProbe: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View { content }
}
