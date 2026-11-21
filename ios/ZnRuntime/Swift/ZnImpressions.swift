// Impressions (useImpressions, impressionKey): which keyed elements are on screen. A pass-through for now; applied in
// ZnNodeView inside the margin, outside the shared-element probe.
import SwiftUI

struct ZnImpressionProbe: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View { content }
}
