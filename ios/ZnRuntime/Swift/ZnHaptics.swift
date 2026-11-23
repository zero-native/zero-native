// A haptic named in a gesture's options (Android: znHaptic in ZnGesture.kt): light, medium, heavy, selection,
// success, error; "none" or nothing plays nothing, an unknown name plays light (as Android's KEYBOARD_TAP).
// The generators are made once and prepared when a finger lands on a gesture, so the first one isn't late.
import UIKit

@MainActor
enum ZnHaptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private static let selection = UISelectionFeedbackGenerator()
    private static let notice = UINotificationFeedbackGenerator()

    static func play(_ kind: String?) {
        switch kind {
        case nil, "", "none": return
        case "medium": medium.impactOccurred()
        case "heavy": heavy.impactOccurred()
        case "selection": selection.selectionChanged()
        case "success": notice.notificationOccurred(.success)
        case "error": notice.notificationOccurred(.error)
        default: light.impactOccurred()
        }
        #if DEBUG
        if ZnGestureHub.log { print("zn t=\(ZnDebug.ms()) gesture: haptic \(kind!)") }
        #endif
    }

    /// A finger is down on a gesture: the Taptic Engine wakes up (iOS lets it sleep again after a few seconds).
    static func prepare() {
        light.prepare()
        medium.prepare()
        heavy.prepare()
        selection.prepare()
        notice.prepare()
    }
}
