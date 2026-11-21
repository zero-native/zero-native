// <Canvas> (registry 24, ZnCanvas.kt): draw commands (commands, commandsSlot). Not drawn on iOS yet: a marker in debug
// builds, nothing in release, as for any component iOS doesn't draw (ZnMissing).
import SwiftUI

struct ZnCanvasView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View { ZnMissing(type: s.type) }
}
