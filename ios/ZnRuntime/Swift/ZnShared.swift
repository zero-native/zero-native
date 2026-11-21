// Shared elements between two screens (sharedTag, ZnShared.kt). A pass-through for now; applied in ZnNodeView on the
// node's box inside the margin.
import SwiftUI

struct ZnSharedProbe: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View { content }
}
