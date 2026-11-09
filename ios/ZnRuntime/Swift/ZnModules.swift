// Native modules on iOS: the counterpart of android/runtime's ZnModules.kt (ARCHITECTURE §15.1,
// docs/native-modules.md). Same contract, so a module's JS side is one file for both platforms:
// - JS `callNative(module, method, args)` → C++ → `ZnModules.call` on the JS thread → the module, on a background
//   queue (or the main thread for UI work) → the answer goes back as app event 7 (JSON) or 9 (with bytes).
// - Exactly one answer per call; a second one is logged and dropped. A cancelled call's answer is dropped.
// - Unknown module or method: "unavailable". A wrong argument (typed readers below): "invalid_args". A thrown error:
//   "failed". A module older than the JS needs (`__v`): "unavailable".
// - Module events go to JS as app event 8, only while JS listens (`onListenerCount`); `latestOnly` events keep only
//   the newest value while JS is busy.
// - `constants()`: values JS reads synchronously (`nativeConstants(name)`), set once before the main script.
// The JS thread and the main thread never wait for a module.
import Foundation

/// A wrong or missing argument: JS gets NativeError("invalid_args", ...).
struct ZnInvalidArgs: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

/// One call from JS to a native module. Finish it exactly once with `resolve` / `resolveBytes` / `reject`, from any
/// thread. `isCancelled` turns true if JS gives up; long work should check it, or stop in `onCancel`.
final class ZnCall: @unchecked Sendable {
    let args: [String: Any]
    /// Binary input from JS (`callNative(..., { bytes })`), or nil.
    let bytes: Data?
    private let id: UInt32
    private let what: String
    private let lock = NSLock()
    private var done = false
    private var cancelled = false
    private var hooks: [() -> Void] = []

    init(id: UInt32, what: String, args: [String: Any], bytes: Data?) {
        self.id = id; self.what = what; self.args = args; self.bytes = bytes
    }

    var isCancelled: Bool { lock.withLock { cancelled } }

    /// `value`: nil, Bool, a number, String, [Any] or [String: Any] (anything JSONSerialization takes).
    func resolve(_ value: Any? = nil) {
        guard let json = ZnModules.json(value) else { return reject("failed", "\(what): the answer is not JSON") }
        finish { ZNHost.shared.answerCall(self.id, ok: true, valueJson: json, code: nil, message: nil) }
    }

    /// Answers with binary data: JS gets `{ value, bytes }`, `bytes` a Uint8Array (no base64).
    func resolveBytes(_ value: Any?, _ data: Data) {
        guard let json = ZnModules.json(value) else { return reject("failed", "\(what): the answer is not JSON") }
        finish { ZNHost.shared.answerCall(self.id, valueJson: json, bytes: data) }
    }

    /// `code`: "invalid_args", "failed", "unavailable", or the module's own; JS gets NativeError(code, message).
    func reject(_ code: String, _ message: String) {
        finish { ZNHost.shared.answerCall(self.id, ok: false, valueJson: nil, code: code, message: message) }
    }

    /// Runs `block` (once, on any thread) if JS cancels this call; at once if it already did.
    func onCancel(_ block: @escaping () -> Void) {
        let now: Bool = lock.withLock {
            if !cancelled { hooks.append(block) }
            return cancelled
        }
        if now { block() }
    }

    func cancel() {
        let run: [() -> Void] = lock.withLock {
            cancelled = true
            defer { hooks = [] }
            return hooks
        }
        run.forEach { $0() }
    }

    private func finish(_ send: () -> Void) {
        let first: Bool = lock.withLock {
            defer { done = true }
            return !done
        }
        guard first else { return ZnDebug.log.warning("\(self.what, privacy: .public) answered twice; the second answer is ignored") }
        ZnModules.finished(id, self)
        if isCancelled || id == 0 { return }  // JS gave up on it (or wants no answer)
        send()
    }

    // MARK: Typed arguments, as ZnModules.kt: the plain form rejects a missing value; the OrNil form gives nil for a
    // missing value or a JS null. A wrong type rejects in both (a number is not a string; 1.5 is not an int).

    private func arg(_ name: String) -> Any? { args[name].flatMap { $0 is NSNull ? nil : $0 } }
    private func wrong(_ name: String, _ type: String, _ v: Any) -> ZnInvalidArgs { ZnInvalidArgs("\"\(name)\" must be \(type), got \(v)") }
    private static func isBool(_ v: Any) -> Bool { (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false }

    func stringOrNil(_ name: String) throws -> String? {
        guard let v = arg(name) else { return nil }
        guard let s = v as? String else { throw wrong(name, "a string", v) }
        return s
    }
    func boolOrNil(_ name: String) throws -> Bool? {
        guard let v = arg(name) else { return nil }
        guard Self.isBool(v), let b = v as? Bool else { throw wrong(name, "a boolean", v) }
        return b
    }
    func doubleOrNil(_ name: String) throws -> Double? {
        guard let v = arg(name) else { return nil }
        guard !Self.isBool(v), let n = v as? NSNumber else { throw wrong(name, "a number", v) }
        return n.doubleValue
    }
    func intOrNil(_ name: String) throws -> Int? {
        guard let d = try doubleOrNil(name) else { return nil }
        guard d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { throw wrong(name, "a whole number", d) }
        return Int(d)
    }
    func string(_ name: String) throws -> String { try stringOrNil(name) ?? { throw ZnInvalidArgs("\"\(name)\" is missing") }() }
    func bool(_ name: String) throws -> Bool { try boolOrNil(name) ?? { throw ZnInvalidArgs("\"\(name)\" is missing") }() }
    func double(_ name: String) throws -> Double { try doubleOrNil(name) ?? { throw ZnInvalidArgs("\"\(name)\" is missing") }() }
    func int(_ name: String) throws -> Int { try intOrNil(name) ?? { throw ZnInvalidArgs("\"\(name)\" is missing") }() }
}

/// A native module JS can call. Most modules extend `ZnModuleBase`.
protocol ZnModule: AnyObject {
    var name: String { get }
    /// Raised when the module gains methods or changes behaviour; JS declares the lowest version it needs (`__v`).
    var version: Int { get }
    func runsOnMain(_ method: String) -> Bool
    func call(_ method: String, _ call: ZnCall) throws
    /// How many JS listeners `event` has now (main thread). Start or stop the source accordingly.
    func onListenerCount(_ event: String, _ count: Int)
    /// Values JS reads synchronously (`nativeConstants(name)`). JS thread, before the main script: keep it cheap.
    func constants() -> [String: Any]?
}

/// A module as a table of named functions (ZnModuleBase in ZnModules.kt):
///
///     final class DeviceModule: ZnModuleBase {
///         init() {
///             super.init("Device", version: 1)
///             function("info") { $0.resolve(["model": "iPhone"]) }
///             function("open", onMain: true) { call in ... }
///         }
///     }
class ZnModuleBase: ZnModule, @unchecked Sendable {
    let name: String
    let version: Int
    private var fns: [String: (onMain: Bool, body: (ZnCall) throws -> Void)] = [:]

    init(_ name: String, version: Int = 1) {
        self.name = name
        self.version = version
    }

    func function(_ method: String, onMain: Bool = false, _ body: @escaping (ZnCall) throws -> Void) {
        fns[method] = (onMain, body)
    }

    func runsOnMain(_ method: String) -> Bool { fns[method]?.onMain ?? false }

    func call(_ method: String, _ call: ZnCall) throws {
        guard let fn = fns[method] else { return call.reject("unavailable", "\(name) has no method \"\(method)\"") }
        try fn.body(call)
    }

    func onListenerCount(_ event: String, _ count: Int) {}
    func constants() -> [String: Any]? { nil }

    /// Sends `event` to JS listeners. `latestOnly`: while JS is busy, only the newest value is delivered.
    func emit(_ event: String, _ payload: Any? = nil, latestOnly: Bool = false) {
        ZnModules.emit(name, event, payload, latestOnly: latestOnly)
    }
}

enum ZnModules {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var modules: [String: ZnModule] = [:]
    nonisolated(unsafe) private static var active: [UInt32: ZnCall] = [:]
    nonisolated(unsafe) private static var latest: [String: String] = [:]
    private static let work = DispatchQueue(label: "zn-call", qos: .userInitiated, attributes: .concurrent)

    /// Registers a module (built-in ones in `installBuiltIns`; an app's own before the app starts).
    static func register(_ m: ZnModule) { lock.withLock { modules[m.name] = m } }

    /// A module of this name is registered (built-in or a plugin's).
    static func has(_ name: String) -> Bool { lock.withLock { modules[name] != nil } }

    /// The built-in modules, and the host's call and cancel paths. Main thread, before JS starts.
    @MainActor static func install() {
        for m: ZnModule in [ZnPlatformFacts(), ZnOs(), ZnNetInfo(), ZnSecureStore(), ZnClipboard(), ZnFetch.shared,
                             ZnKeyboard(), ZnVibration(), ZnToast(), ZnAlert(), ZnPermissions(), ZnSplash.Module(), ZnLaunch(), ZnUpdatesOff(), ZnTasks()] where !has(m.name) {
            register(m)
        }
        let host = ZNHost.shared
        host.onNativeCall = { module, method, argsJson, id, bytes in
            call(module, method, argsJson, id, bytes)
            return true
        }
        host.onCancelCall = { id in
            let c = lock.withLock { active.removeValue(forKey: id) }
            c?.cancel()
        }
        if let json = constantsJson() { host.setGlobalString("__zn_constants", value: json) }
    }

    /// Every module's constants as one JSON object (module name → its object), or nil if none gives any.
    static func constantsJson() -> String? {
        var all: [String: Any] = [:]
        for m in lock.withLock({ Array(modules.values) }) {
            if let c = m.constants() { all[m.name] = c }
        }
        return all.isEmpty ? nil : json(all)
    }

    static func json(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return "null" }
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func finished(_ id: UInt32, _ call: ZnCall) {
        lock.withLock { if active[id] === call { active[id] = nil } }
    }

    /// JS thread.
    private static func call(_ module: String, _ method: String, _ argsJson: String, _ id: UInt32, _ bytes: Data?) {
        let m = lock.withLock { modules[module] }
        let parsed = argsJson.isEmpty ? [:] : (try? JSONSerialization.jsonObject(with: Data(argsJson.utf8))) as? [String: Any]
        // Internal: how many JS listeners an event has (no reply).
        if method == "__listeners" {
            guard let m, let parsed else { return }
            let event = parsed["event"] as? String ?? "", count = (parsed["count"] as? NSNumber)?.intValue ?? 0
            DispatchQueue.main.async { m.onListenerCount(event, count) }
            return
        }
        guard var args = parsed else {
            return ZnCall(id: id, what: "\(module).\(method)", args: [:], bytes: nil).reject("invalid_args", "arguments are not a JSON object")
        }
        let needs = (args.removeValue(forKey: "__v") as? NSNumber)?.intValue ?? 1
        let call = ZnCall(id: id, what: "\(module).\(method)", args: args, bytes: bytes)
        guard let m else { return call.reject("unavailable", "no native module \"\(module)\" in this app (iOS)") }
        guard m.version >= needs else {
            return call.reject("unavailable", "this app has \(module) v\(m.version); the code needs v\(needs)")
        }
        if id != 0 { lock.withLock { active[id] = call } }
        let run = {
            if call.isCancelled { return }
            do {
                try m.call(method, call)
            } catch let e as ZnInvalidArgs {
                call.reject("invalid_args", "\(module).\(method): \(e.description)")
            } catch {
                ZnDebug.log.error("\(module, privacy: .public).\(method, privacy: .public) threw: \(error, privacy: .public)")
                call.reject("failed", "\(module).\(method) failed: \(error.localizedDescription)")
            }
        }
        if m.runsOnMain(method) { DispatchQueue.main.async(execute: run) } else { work.async(execute: run) }
    }

    /// Sends a module event to JS (any thread), app event 8.
    static func emit(_ module: String, _ event: String, _ payload: Any?, latestOnly: Bool) {
        let body: [String: Any] = ["module": module, "event": event, "payload": payload ?? NSNull()]
        guard let text = json(body) else { return ZnDebug.log.error("\(module, privacy: .public).\(event, privacy: .public): payload is not JSON") }
        let host = ZNHost.shared
        guard latestOnly else { return host.dispatchEvent(0, event: 8, string: text) }
        let key = "\(module)\u{0}\(event)"
        // One delivery is queued at a time per event; it takes whatever is newest when the JS thread gets to it.
        let first = lock.withLock { latest.updateValue(text, forKey: key) == nil }
        if first { host.dispatchEvent(0, event: 8, stringFrom: { lock.withLock { latest.removeValue(forKey: key) } }) }
    }
}

/// No methods: `nativeConstants("Platform")` tells JS it runs on iOS before any of its code runs, so `Platform.OS`
/// is right even at the top level of a file (Android sends no such constants: JS's default there is "android").
final class ZnPlatformFacts: ZnModuleBase, @unchecked Sendable {
    init() { super.init("Platform") }
    override func constants() -> [String: Any]? { ["os": "ios", "release": znIosVersion()] }
}
