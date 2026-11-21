// Gestures (Android: ZnGesture.kt): usePan, usePinch, useZoom, useTap... add their functions ("gesture",
// "gestureGroup", "gestureState") to the one Motion module through install, and drop a gesture when JS disposes its
// id. Not on iOS yet (gesture-core, wave 3): these are the hooks the engine already calls.
import Foundation

enum ZnGestures {
    /// Adds the gesture functions to the Motion module (ZnMotionModule.addFunction). None yet.
    @MainActor static func install(_ m: ZnMotionModule) {}

    /// JS dropped [id]: the gesture of that id goes.
    static func dispose(_ id: Int) {}

    /// The JS that made the gestures is gone.
    static func reset() {}
}
