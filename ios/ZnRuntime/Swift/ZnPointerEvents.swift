// RN pointerEvents on iOS (registry 15, ZnTouch.kt): which boxes take taps. ZnNodeView applies the two modifiers (the
// node, its children) and ZnPaintLayers asks znStopsTaps whether the node's own box stops taps.
import SwiftUI

/// Does [s] stop taps on its own box (ZnNode in ZnRenderer.kt)? pointerEvents "auto" or "box-only" written, or not
/// written on an absolute layer (ZnNodeSpec.absoluteLayer); never inside pointerEvents "none".
@MainActor func znStopsTaps(_ s: ZnNodeSpec, _ inst: ZnInstance, touchOff: Bool) -> Bool {
    if touchOff { return false }
    let pe = s.pointerEventsNow(inst)
    return pe == Registry.PointerEvents.auto || pe == Registry.PointerEvents.boxOnly ||
        (pe == znPointerEventsUnset && s.absoluteLayer)
}

/// pointerEvents "none" on a node (written, or from a slot): neither it nor anything inside takes a tap, so it goes to
/// what is under it. Pressables inside hide their touch views (znTouchOff), as Android's LocalTouchOff.
struct ZnPointerEventsNone: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        if s.pointerEvents == znPointerEventsUnset && s.pointerEventsSlot < 0 {
            content  // the usual case: nothing written, no slot (never changes at runtime)
        } else {
            let none = s.pointerEventsNow(inst) == Registry.PointerEvents.none
            content.allowsHitTesting(!none).environment(\.znTouchOff, touchOff || none)
        }
    }
}

/// pointerEvents "box-only": the node takes taps, its children don't (Android passes LocalTouchOff to them).
struct ZnPointerEventsKids: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        if s.pointerEvents == znPointerEventsUnset && s.pointerEventsSlot < 0 {
            content
        } else {
            let boxOnly = s.pointerEventsNow(inst) == Registry.PointerEvents.boxOnly
            content.allowsHitTesting(!boxOnly).environment(\.znTouchOff, touchOff || boxOnly)
        }
    }
}
