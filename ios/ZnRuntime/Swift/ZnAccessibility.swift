// Accessibility of a node (ZnTemplate.kt accessibilitySemantics): label, hint, role, hidden and testID. A pass-through
// for now; applied after the paint in ZnNodeView.styled, so it covers the box inside the margin, as on Android.
import SwiftUI

struct ZnA11y: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View { content }
}
