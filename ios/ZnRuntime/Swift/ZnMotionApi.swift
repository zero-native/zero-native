// The native extension point for motion (Android: ZnMotionApi.kt; docs/gestures-and-motion-v1.md §2.10, D8): what a
// plugin uses for work a formula can't express (custom physics, an audio level, a video's position). Main thread
// only, like all motion.
//
// - Values: JS makes the id (core `nativeMotion((id) => callNative("MyPlugin", "start", { id }))`); the plugin gets a
//   Handle with `value(id)` and sets it from its own events, or each frame with `onFrame`. JS binds it like any motion
//   value. When JS drops it, the plugin's `onDispose` runs.
// - Drivers: a custom curve for `v.to(x, { driver: "physics.orbit", params })`, registered once with `registerDriver`
//   (usually in the plugin's `register`). An unknown driver fails the command with invalid_args, as on Android.
// - Native view props: a motion value in `<NativeView props>` reaches the view as a reference ("\u{0}m<id>");
//   `reader` turns it into a function to read now. UIKit views aren't redrawn by SwiftUI, so ZnViewScope also has
//   `onMotion(name) { v in ... }`, called on each frame the value changes (ZnPlugins.swift).
//
// Rules: what runs each frame must not allocate; never block the main thread. In the app binary, never from OTA.
// Foundation only (the Mac unit suite ios/tests/motion runs it with the engine).
import Foundation

@MainActor
public enum ZnMotionApi {
    /// A plugin's motion value.
    @MainActor
    public final class Handle {
        let v: ZnMotionValue
        init(_ v: ZnMotionValue) { self.v = v }

        /// The value now. Setting it moves everything bound to it in the same frame. NaN / infinity are ignored.
        public var value: Float {
            get { v.value }
            set { v.value = newValue }
        }

        /// Called once when JS drops the value (its screen closed) or the JS reloads.
        public func onDispose(_ block: @escaping @MainActor () -> Void) {
            v.onDispose = { MainActor.assumeIsolated { block() } }
        }
    }

    /// The value JS made with id [id] for this plugin (core nativeMotion), made here if JS hasn't sent it yet.
    /// [initial] is used only when it is made here.
    public static func value(_ id: Int, initial: Float = 0) -> Handle {
        let e = ZnMotionEngine.shared
        if let v = e.find(id) as? ZnMotionValue { return Handle(v) }
        if let v = try? e.putValue(id, initial) { return Handle(v) }
        // A window id (1-15) can't be a plugin's: a value nothing binds, so the plugin's code still runs.
        print("zn: ZnMotionApi.value(\(id)): ids 1-\(ZnMotionEngine.envLast) are the window values; nothing follows this one")
        return Handle(ZnMotionValue(id: id, initial))
    }

    /// What `onFrame` gives back: `cancel()` stops the calls.
    @MainActor
    public final class FrameToken {
        fileprivate var on = true
        public var isActive: Bool { on }

        public func cancel() {
            guard on else { return }
            on = false
            ZnMotionEngine.shared.removeOnFrame(self)
            ZnMotionApi.frames[ObjectIdentifier(self)] = nil
        }
    }

    /// Frame calls that run until they end: kept here, so a plugin that drops its token keeps its frames (as a Job).
    fileprivate static var frames: [ObjectIdentifier: FrameToken] = [:]

    /// Calls [block] once per frame with the frame time (ns, CACurrentMediaTime's base) until it returns false or the
    /// token is cancelled. For physics that steps each frame. Must not allocate.
    @discardableResult
    public static func onFrame(_ block: @escaping @MainActor (_ frameNanos: Int64) -> Bool) -> FrameToken {
        let t = FrameToken()
        frames[ObjectIdentifier(t)] = t
        ZnMotionEngine.shared.onFrame(t) { [weak t] now in
            MainActor.assumeIsolated {
                guard let t, t.on else { return false }
                if block(now) { return true }
                t.cancel()
                return false
            }
        }
        return t
    }

    /// Registers a custom curve under [name] ("plugin.name"), usually in the plugin's `register`. [make] is called on
    /// each `v.to(x, { driver: name, params })` with where it starts, where it goes, the speed it has, and JS's params.
    public static func registerDriver(_ name: String, _ make: @escaping ZnMotionDriverFactory) {
        ZnMotionDrivers.register(name, make)
    }

    /// For a native view: a prop that JS gave as a motion value ("\u{0}m<id>" in the props JSON) as a function to read
    /// it now; nil when it isn't one. A value JS hasn't made yet reads 0 until it comes; a dropped one keeps its last
    /// value (ZnMotionEngine.ref).
    public static func reader(_ prop: Any?) -> (() -> Float)? {
        guard let s = prop as? String, s.hasPrefix(ZnMotionEngine.refPrefix) else { return nil }
        let e = ZnMotionEngine.shared
        return { e.ref(s)?.read(nil) ?? 0 }
    }
}

/// ZnViewScope.onMotion's watches for one native view: each motion prop's reader and the last value given to the view,
/// checked on the frames where motion values moved (ZnMotionEngine.onDirty), so a still value costs nothing.
@MainActor
final class ZnMotionPropWatch {
    private struct Watch {
        let apply: @MainActor (Float) -> Void
        var read: (() -> Float)?
        var last: Float = .nan
    }
    private var watches: [String: Watch] = [:]
    private var subscribed = false

    /// Watches prop [name] in [props] (and in later props, through `update`).
    func add(_ name: String, _ props: [String: Any], _ apply: @escaping @MainActor (Float) -> Void) {
        watches[name] = Watch(apply: apply, read: ZnMotionApi.reader(props[name]))
        if !subscribed {
            subscribed = true
            ZnMotionEngine.shared.onDirty(self) { [weak self] in MainActor.assumeIsolated { self?.check() } }
        }
        check()
    }

    /// New props: each watched prop may now be another value, a plain number, or gone.
    func update(_ props: [String: Any]) {
        for name in Array(watches.keys) {
            let raw = props[name]
            watches[name]!.read = ZnMotionApi.reader(raw)
            if watches[name]!.read == nil { watches[name]!.last = .nan }
        }
        check()
    }

    /// Whether prop [name] follows a motion value now.
    func follows(_ name: String) -> Bool { watches[name]?.read != nil }

    private func check() {
        for (name, w) in watches {
            guard let read = w.read else { continue }
            let v = read()
            if v == w.last { continue }
            watches[name]!.last = v
            w.apply(v)
        }
    }
}
