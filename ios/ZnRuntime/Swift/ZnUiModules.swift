// Built-in modules that show something or talk to the user, each the counterpart of the android/runtime module with
// the same name (JS: packages/core/src/keyboard.ts, text-field.ts, vibration.ts, toast.ts, alert.ts,
// permissions.ts, splash.ts). Main-thread work runs with `onMain: true`.
import AVFoundation
import AudioToolbox
import Contacts
import CoreLocation
import UIKit
import UserNotifications

// MARK: - Keyboard (ZnKeyboard.kt)

/// `Keyboard.dismiss()`, and a `<TextField ref>`'s focus / blur / clear. Fields with a ref attach themselves by
/// (instance, ref event id) while they exist.
final class ZnKeyboard: ZnModuleBase, @unchecked Sendable {
    private final class Weak { weak var view: UIView?; init(_ v: UIView) { view = v } }
    nonisolated(unsafe) private static var fields: [UInt64: Weak] = [:]  // main thread only

    private static func key(_ inst: UInt32, _ id: Int) -> UInt64 { UInt64(inst) << 32 | UInt64(UInt32(truncatingIfNeeded: id)) }

    /// Main thread, from the field's makeUIView.
    static func attach(_ view: UIView, _ inst: UInt32, _ id: Int) {
        fields = fields.filter { $0.value.view != nil }
        fields[key(inst, id)] = Weak(view)
    }

    /// The field a call names, or nil after the call was rejected (not on screen: closed, or scrolled away).
    private func field(_ call: ZnCall) throws -> UIView? {
        let inst = UInt32(truncatingIfNeeded: try call.int("inst")), id = try call.int("id")
        guard let v = Self.fields[Self.key(inst, id)]?.view, v.window != nil else {
            call.reject("not_shown", "this TextField is not on screen")
            return nil
        }
        return v
    }

    init() {
        super.init("Keyboard", version: 2)
        function("dismiss", onMain: true) { call in
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            call.resolve()
        }
        function("focus", onMain: true) { call in
            guard let v = try self.field(call) else { return }
            call.resolve(v.becomeFirstResponder())
        }
        function("blur", onMain: true) { call in
            guard let v = try self.field(call) else { return }
            // Only this field's focus: blur() on a field that doesn't have it changes nothing, as in React Native.
            let had = v.isFirstResponder
            if had { v.resignFirstResponder() }
            call.resolve(had)
        }
        function("clear", onMain: true) { call in
            guard let v = try self.field(call) else { return }
            // As if the user deleted the text: the field sends onChangeText(""), so a controlled value follows.
            if let f = v as? UITextField {
                f.text = ""
                f.sendActions(for: .editingChanged)
            } else if let t = v as? UITextView {
                t.text = ""
                t.delegate?.textViewDidChange?(t)
            }
            call.resolve(true)
        }
    }
}

// MARK: - Vibration (ZnVibration.kt)

/// RN's Vibration on iOS: iOS has one system buzz (~0.4 s) and no length, as in React Native on iOS. A pattern
/// [wait, buzz, wait, buzz, ...] buzzes once at the start of each buzz step longer than 0; `repeat` plays it again
/// until `cancel`. Answers false on the simulator (no motor).
final class ZnVibration: ZnModuleBase, @unchecked Sendable {
    private var generation = 0  // main thread; a new vibrate or cancel stops the pattern before it

    init() {
        super.init("Vibration", version: 1)
        function("vibrate", onMain: true) { call in
            guard let pattern = call.args["pattern"] as? [NSNumber] else { throw ZnInvalidArgs("\"pattern\" must be an array of ms") }
            let ms = pattern.map { max(0, $0.doubleValue) }
            let repeatIt = try call.boolOrNil("repeat") ?? false
            self.generation += 1
            #if targetEnvironment(simulator)
            return call.resolve(false)
            #else
            let buzzes = ms.indices.filter { $0 % 2 == 1 && ms[$0] > 0 }
            guard !buzzes.isEmpty else { return call.resolve(false) }
            self.play(ms, generation: self.generation, again: repeatIt)
            call.resolve(true)
            #endif
        }
        function("cancel", onMain: true) { call in
            self.generation += 1
            call.resolve(true)
        }
    }

    private func play(_ ms: [Double], generation: Int, again: Bool) {
        var at = 0.0
        for (i, step) in ms.enumerated() {
            if i % 2 == 1 && step > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + at / 1000) { [weak self] in
                    guard self?.generation == generation else { return }
                    AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                }
            }
            at += step
        }
        guard again, at > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + at / 1000) { [weak self] in
            guard let self, self.generation == generation else { return }
            self.play(ms, generation: generation, again: true)
        }
    }
}

// MARK: - Toast (ZnToast.kt)

/// zero-native's own toast (iOS has none): a dark pill near the bottom, above the home indicator and the keyboard,
/// over every screen (it stays through navigation). "short" 2 s, "long" 3.5 s; a new toast replaces the one showing.
final class ZnToast: ZnModuleBase, @unchecked Sendable {
    private weak var showing: UIView?

    init() {
        super.init("Toast", version: 1)
        function("show", onMain: true) { call in
            let message = try call.string("message")
            let long = try call.stringOrNil("duration") == "long"
            MainActor.assumeIsolated { self.show(message, seconds: long ? 3.5 : 2) }
            call.resolve()
        }
    }

    @MainActor private func show(_ message: String, seconds: Double) {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { return print("zn toast: no key window") }
        showing?.removeFromSuperview()
        let label = UILabel()
        label.text = message
        label.numberOfLines = 0
        label.textColor = .white
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.textAlignment = .center
        let pill = UIView()
        pill.backgroundColor = UIColor(white: 0.13, alpha: 0.92)
        pill.layer.cornerRadius = 18
        pill.isUserInteractionEnabled = false
        pill.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)
        window.addSubview(pill)
        let bottom = max(window.safeAreaInsets.bottom, ZnSystemEvents.shared.keyboardHeight) + 24
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -16),
            label.topAnchor.constraint(equalTo: pill.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -10),
            pill.centerXAnchor.constraint(equalTo: window.centerXAnchor),
            pill.leadingAnchor.constraint(greaterThanOrEqualTo: window.leadingAnchor, constant: 24),
            pill.bottomAnchor.constraint(equalTo: window.bottomAnchor, constant: -bottom),
        ])
        showing = pill
        pill.alpha = 0
        // The fade-out starts after the fade-in: started together, UIKit sets alpha 0 at once and the toast never shows.
        UIView.animate(withDuration: 0.2) { pill.alpha = 1 } completion: { _ in
            UIView.animate(withDuration: 0.25, delay: seconds, options: []) { pill.alpha = 0 } completion: { _ in
                pill.removeFromSuperview()
            }
        }
        UIAccessibility.post(notification: .announcement, argument: message)
    }
}

// MARK: - Alert (ZnAlert.kt)

/// RN's Alert.alert as a UIAlertController. Answers `{ index }` of the tapped button. Button styles (cancel,
/// destructive) come from JS's `styles`. `cancelable` is Android-only, as in React Native: an iOS alert closes only
/// through a button.
final class ZnAlert: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Alert", version: 1)
        function("show", onMain: true) { call in
            let title = try call.stringOrNil("title") ?? ""
            let message = try call.stringOrNil("message")
            let buttons = call.args["buttons"] as? [String] ?? ["OK"]
            let styles = call.args["styles"] as? [String] ?? []
            guard let top = MainActor.assumeIsolated({ znTopController() }) else { return call.reject("no_activity", "no screen to show an alert on") }
            let alert = UIAlertController(title: title.isEmpty ? nil : title, message: message, preferredStyle: .alert)
            for (i, text) in buttons.enumerated() {
                let style: UIAlertAction.Style = switch styles[safe: i] {
                case "cancel": .cancel
                case "destructive": .destructive
                default: .default
                }
                alert.addAction(UIAlertAction(title: text, style: style) { _ in call.resolve(["index": i]) })
            }
            top.present(alert, animated: true)
        }
    }
}

// MARK: - Permissions (ZnPermissions.kt)

/// "granted", "denied" (not asked yet: a request shows the dialog) or "blocked" (refused: iOS never asks again, only
/// Settings can change it). Names: camera, microphone, location (+ "location.precise"), notifications, contacts.
/// A permission whose Info.plist usage text is missing is "not_declared" (iOS would end the app if asked). An Android
/// name (`android.permission.X`) is "denied" here: it has no iOS meaning.
final class ZnPermissions: ZnModuleBase, @unchecked Sendable {
    private static let usageKeys = [
        "camera": "NSCameraUsageDescription", "microphone": "NSMicrophoneUsageDescription",
        "location": "NSLocationWhenInUseUsageDescription", "contacts": "NSContactsUsageDescription",
    ]
    private var busy = false  // main thread
    private var location: CLLocationManager?
    private var locationAsked: (() -> Void)?
    private lazy var locationDelegate = LocationDelegate { [weak self] m in self?.authorizationChanged(m) }

    /// CLLocationManager's delegate must be an NSObject: this one only forwards.
    private final class LocationDelegate: NSObject, CLLocationManagerDelegate {
        let changed: (CLLocationManager) -> Void
        init(_ changed: @escaping (CLLocationManager) -> Void) { self.changed = changed }
        private func authorizationChanged(_ m: CLLocationManager) { changed(m) }
    }

    init() {
        super.init("Permissions", version: 1)
        function("status", onMain: true) { call in
            let names = try self.names(call)
            self.answer(names) { call.resolve($0) }
        }
        function("request", onMain: true) { call in
            let names = try self.names(call)
            let missing = names.filter { n in Self.usageKeys[n].map { Bundle.main.object(forInfoDictionaryKey: $0) == nil } ?? false }
            if !missing.isEmpty {
                return call.reject("not_declared", "no usage text in Info.plist for: \(missing.map { Self.usageKeys[$0]! }.joined(separator: ", "))")
            }
            if self.busy { return call.reject("busy", "a permission request is open") }
            self.busy = true
            self.askEach(names[...]) {
                self.busy = false
                self.answer(names) { call.resolve($0) }
            }
        }
    }

    private func names(_ call: ZnCall) throws -> [String] {
        guard let names = call.args["names"] as? [String] else { throw ZnInvalidArgs("\"names\" must be an array of strings") }
        for n in names where Self.usageKeys[n] == nil && n != "notifications" && !n.hasPrefix("android.permission.") {
            throw ZnInvalidArgs("unknown permission \"\(n)\"")
        }
        return names
    }

    /// Shows iOS's dialog for each name not asked yet, one after another.
    private func askEach(_ names: ArraySlice<String>, then done: @escaping () -> Void) {
        guard let name = names.first else { return done() }
        let next = { DispatchQueue.main.async { self.askEach(names.dropFirst(), then: done) } }
        switch name {
        case "camera", "microphone":
            let type: AVMediaType = name == "camera" ? .video : .audio
            guard AVCaptureDevice.authorizationStatus(for: type) == .notDetermined else { return next() }
            AVCaptureDevice.requestAccess(for: type) { _ in next() }
        case "contacts":
            guard CNContactStore.authorizationStatus(for: .contacts) == .notDetermined else { return next() }
            CNContactStore().requestAccess(for: .contacts) { _, _ in next() }
        case "notifications":
            UNUserNotificationCenter.current().getNotificationSettings { s in
                guard s.authorizationStatus == .notDetermined else { return next() }
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in next() }
            }
        case "location":
            let m = location ?? CLLocationManager()
            location = m
            m.delegate = locationDelegate
            guard m.authorizationStatus == .notDetermined else { return next() }
            locationAsked = next
            m.requestWhenInUseAuthorization()
        default:
            next()
        }
    }

    private func authorizationChanged(_ m: CLLocationManager) {
        guard m.authorizationStatus != .notDetermined, let done = locationAsked else { return }
        locationAsked = nil
        done()
    }

    private static func state(granted: Bool, notDetermined: Bool) -> String {
        granted ? "granted" : notDetermined ? "denied" : "blocked"
    }

    /// Each name's state now (main thread; notifications are read asynchronously).
    private func answer(_ names: [String], _ done: @escaping ([String: String]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                var out: [String: String] = [:]
                for n in names {
                    switch n {
                    case "camera", "microphone":
                        let s = AVCaptureDevice.authorizationStatus(for: n == "camera" ? .video : .audio)
                        out[n] = Self.state(granted: s == .authorized, notDetermined: s == .notDetermined)
                    case "contacts":
                        let s = CNContactStore.authorizationStatus(for: .contacts)
                        let granted = s == .authorized || s.rawValue == 4  // 4: .limited (iOS 18)
                        out[n] = Self.state(granted: granted, notDetermined: s == .notDetermined)
                    case "notifications":
                        let s = settings.authorizationStatus
                        out[n] = Self.state(granted: [.authorized, .provisional, .ephemeral].contains(s), notDetermined: s == .notDetermined)
                    case "location":
                        let m = self.location ?? CLLocationManager()
                        let s = m.authorizationStatus
                        let granted = s == .authorizedWhenInUse || s == .authorizedAlways
                        out[n] = Self.state(granted: granted, notDetermined: s == .notDetermined)
                        out["location.precise"] = granted && m.accuracyAuthorization == .fullAccuracy ? "granted"
                            : granted ? "blocked" : out[n]  // approximate only: precise needs Settings (or a temporary ask)
                    default:
                        out[n] = "denied"
                    }
                }
                done(out)
            }
        }
    }
}

// MARK: - Splash (ZnSplash.kt)

/// iOS shows the first screen's skeleton at once instead of holding a launch screen (ARCHITECTURE §8.1), so there is
/// no splash to hold: as Android's contract says for an app that doesn't hold it, "nothing happens".
final class ZnSplash: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Splash", version: 1)
        function("hold") { call in call.resolve(false) }
        function("release") { call in call.resolve(false) }
    }
}
