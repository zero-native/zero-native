// App-level events from the system to JS, as android/runtime sends them (ZnAppState.kt, ZnWindow.kt, the Activity's
// configuration and memory callbacks): COLOR_SCHEME (14) at start and on change, APP_STATE (11) "active" /
// "background", LOW_MEMORY (15), KEYBOARD (18) `{ visible, height }` once per show or hide (not per frame), when the
// keyboard starts to move, as Android sends it.
import UIKit
#if SWIFT_PACKAGE
import ZnHost
#endif

@MainActor
final class ZnSystemEvents {
    static let shared = ZnSystemEvents()
    private let host = ZNHost.shared
    private var started = false
    private var scheme: String?
    private var state: String?
    private var keyboard = ""
    /// The keyboard's height now (points), for code that lays out over it.
    private(set) var keyboardHeight: CGFloat = 0

    /// Once JS has run its main script: the colour scheme now, then changes.
    /// A new JS runtime (an update applied in place): the colour scheme and app state again, as at the first start.
    private func resend() {
        guard started else { return }
        let lastScheme = scheme
        scheme = nil
        colorSchemeChanged(UIScreen.main.traitCollection.userInterfaceStyle)
        if scheme == nil { scheme = lastScheme }
        if state == "background" { host.dispatchEvent(0, event: UInt16(ZnAppEvent.appState), string: "background") }  // START says active
    }

    /// Again after a new JS runtime's main script: resend.
    func start() {
        guard !started else { return resend() }
        started = true
        colorSchemeChanged(UIScreen.main.traitCollection.userInterfaceStyle)
        state = UIApplication.shared.applicationState == .background ? "background" : "active"  // START says active
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.appState("active") }
        }
        // "background" as soon as the user can't touch the app: Control Center, a call, the app switcher, as Android
        // sends it on pause (a see-through window on top).
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.appState("background") }
        }
        nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.host.dispatchEvent(0, event: UInt16(ZnAppEvent.lowMemory)) }
        }
        // When the keyboard starts to move (as Android sends its target height), not when it has arrived. The height
        // is how much of the screen it covers, so a hardware keyboard (the on-screen one stays below the screen)
        // and a hide are 0.
        nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { n in
            let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
            let screen = UIScreen.main.bounds
            let covered = end.isEmpty || !end.intersects(screen) ? 0 : max(0, screen.maxY - end.minY)
            let duration = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
            MainActor.assumeIsolated {
                // The screen (keyboard: "resize") shrinks above the keyboard as it moves; the focused field rides up.
                if covered > 0 { ZnFieldFocus.followKeyboard(duration: duration) }
                self.keyboardChanged(height: covered)
            }
        }
        // SwiftUI's motion ends a little after the keyboard's: follow a little longer.
        nc.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ZnFieldFocus.followKeyboard(duration: 0) }
        }
    }

    func colorSchemeChanged(_ style: UIUserInterfaceStyle) {
        // In the background iOS draws the app in light and in dark for the app switcher's snapshots: not a change
        // of the setting (found 2026-11-08: JS got light, then dark). The scheme is read again on becoming active.
        guard started, state != "background" else { return }
        let next = style == .dark ? "dark" : "light"
        guard next != scheme else { return }
        scheme = next
        print("zn t=\(ZnDebug.ms()) colorScheme → JS \(next)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.colorScheme), string: next)
    }

    private func appState(_ next: String) {
        guard next != state else { return }
        state = next
        print("zn t=\(ZnDebug.ms()) appState → JS \(next)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.appState), string: next)
        if next == "active" { colorSchemeChanged(UIScreen.main.traitCollection.userInterfaceStyle) }
    }

    private func keyboardChanged(height: CGFloat) {
        keyboardHeight = height
        // Written by hand: a dictionary's key order changes from run to run, and the same keyboard must give the
        // same text (found 2026-11-08: phone pad → number pad, both 291 pt, reached JS twice).
        let text = "{\"visible\":\(height > 0),\"height\":\((Double(height) * 10).rounded() / 10)}"
        guard text != keyboard else { return }
        keyboard = text
        print("zn t=\(ZnDebug.ms()) keyboard → JS \(text)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.keyboard), string: text)
    }
}
