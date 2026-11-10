// OTA's rules on iOS: what a bundle is, whether this app can run it, what is signed, what the safety nets remember.
// A Swift copy of Android's rules (docs/ios-ota-plan-2026-11-10.md, decision 1), kept the same by the same tests:
// android/runtime ZnBundles.kt (Info, Requires, checkBundle, parseInfo), ZnCapabilities.kt, ZnOtaSignature.kt,
// ZnOtaStore.kt, ZnOtaHealth.kt (State, Rules) and ZnOtaInstall.kt (Manifest, Pointer, bundleSha256, writeAtomic).
// Foundation and CryptoKit only (no UIKit): ios/tests/ota runs these rules on the Mac (`bun run ios:ota-test`).
// Change a rule on both phones, with its test on both.
import CryptoKit
import Foundation

/// Why an update was refused or failed. [code] goes to telemetry (`docs/ota.md` §3.7).
struct ZnOtaError: Error, CustomStringConvertible {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    var description: String { "\(code): \(message)" }
}

// MARK: - Bundles (ZnBundles.kt)

enum ZnBundleRules {
    static let infoFile = "zn-bundle.json"
    static let format = 1
    /// Bundle files that are code: a downloaded bundle must have every one the built-in bundle has.
    static let codeSuffixes = [".hbc", ".zn.ui", ".zn.ui.json"]

    /// What `zn-bundle.json` says (tools/bundle-info.ts). [files]: path → size in bytes.
    struct Info: CustomStringConvertible {
        let app: String
        let serial: Int
        let id: String
        let sha256: String
        let files: [String: Int64]
        /// What an app needs to run it; nil in bundles built before step 4.2 (never run from files).
        let requires: Requires?
        var description: String { "\(id) (#\(serial))" }
    }

    /// A bundle's needs (docs/ota.md §3.2). [modules]: native module name → lowest version, on both OSes. [os]: modules
    /// needed on one OS only ("android" / "ios" → name → version), from Android-only or iOS-only plugins
    /// (docs/ota-requires-per-os.md); empty when the bundle has none.
    struct Requires: Equatable {
        let registry: Int
        let bytecode: Int
        let hostApi: Int
        let modules: [String: Int]
        var os: [String: [String: Int]] = [:]

        /// The OSes a bundle's needs can name, in the signed line's order.
        static let oses = ["android", "ios"]
    }

    /// Whether a downloaded bundle may run. [superseded]: nothing is wrong with it, the app's own bundle is the same or
    /// newer (a store update came after this OTA bundle): normal, not reported as a problem.
    enum Check {
        case ok(Info)
        case no(String, superseded: Bool = false)
    }

    static func isBundleId(_ id: String) -> Bool {
        id.range(of: "^[a-z][a-z0-9_.-]*_[0-9]+$", options: .regularExpression) != nil
    }

    /// Parses `zn-bundle.json`. Throws if the format is unknown or a field is missing or wrong.
    static func parseInfo(_ text: String) throws -> Info {
        let json = try ZnJSON.object(Data(text.utf8))
        let format = try ZnJSON.int(json, "format")
        guard format == Self.format else { throw ZnOtaError("bundle", "format \(format), this app reads format \(Self.format)") }
        let files = try ZnJSON.obj(json, "files")
        var sizes: [String: Int64] = [:]
        for (name, value) in files {
            guard isSafePath(name) else { throw ZnOtaError("bundle", "bad file path \"\(name)\"") }
            guard let entry = value as? [String: Any] else { throw ZnOtaError("bundle", "files.\(name) is not an object") }
            sizes[name] = try ZnJSON.int64(entry, "size")
        }
        let serial = try ZnJSON.int(json, "serial")
        guard serial >= 0 else { throw ZnOtaError("bundle", "serial \(serial)") }
        var requires: Requires?
        if let r = json["requires"] as? [String: Any] { requires = try parseRequires(r) }
        return Info(app: try ZnJSON.string(json, "app"), serial: serial, id: try ZnJSON.string(json, "id"),
                    sha256: try ZnJSON.string(json, "sha256"), files: sizes, requires: requires)
    }

    static func parseRequires(_ r: [String: Any]) throws -> Requires {
        func map(_ m: [String: Any]) throws -> [String: Int] {
            var out: [String: Int] = [:]
            for key in m.keys { out[key] = try ZnJSON.int(m, key) }
            return out
        }
        var os: [String: [String: Int]] = [:]
        if let o = r["os"] as? [String: Any] {
            for (name, value) in o {
                guard let m = value as? [String: Any] else { throw ZnOtaError("bundle", "requires.os.\(name) is not an object") }
                os[name] = try map(m)
            }
        }
        return Requires(registry: try ZnJSON.int(r, "registry"), bytecode: try ZnJSON.int(r, "bytecode"),
                        hostApi: try ZnJSON.int(r, "hostApi"), modules: try map(try ZnJSON.obj(r, "modules")), os: os)
    }

    /// A plain relative path: no leading "/", no "..", no empty part (and no backslash).
    static func isSafePath(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix("/") && !name.contains("\\")
            && !name.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == ".." || $0.isEmpty }
    }

    /// Checks downloaded bundle [id] against [builtIn] and this app's [caps]. [folder] maps a bundle id to its folder.
    /// Templates are checked afterwards (TemplateReader refuses ids this app doesn't know).
    static func checkBundle(_ id: String, builtIn: Info, caps: ZnCapabilities, folder: (String) -> URL) -> Check {
        guard isBundleId(id) else { return .no("\"\(id)\" is not a bundle id") }
        let dir = folder(id)
        let infoURL = dir.appendingPathComponent(infoFile)
        guard isFile(infoURL) else { return .no("its folder has no \(infoFile)") }
        let info: Info
        do {
            info = try parseInfo(String(contentsOf: infoURL, encoding: .utf8))
        } catch {
            return .no("its \(infoFile) can't be read (\(error))")
        }
        if info.id != id { return .no("its \(infoFile) says \(info.id)") }
        if info.app != builtIn.app { return .no("it is for app \"\(info.app)\", this app is \"\(builtIn.app)\"") }
        if info.serial <= builtIn.serial { return .no("the built-in bundle #\(builtIn.serial) is the same or newer", superseded: true) }
        let missingCode = builtIn.files.keys.filter { name in codeSuffixes.contains { name.hasSuffix($0) } }
            .filter { info.files[$0] == nil }.sorted()
        if !missingCode.isEmpty { return .no("it has no \(missingCode.joined(separator: ", "))") }
        for (name, size) in info.files {
            let f = dir.appendingPathComponent(name)
            guard isFile(f) else { return .no("\(name) is missing") }
            let length = fileSize(f)
            if length != size { return .no("\(name) is \(length) bytes, \(infoFile) says \(size)") }
        }
        guard let requires = info.requires else { return .no("its \(infoFile) doesn't say what it needs (requires)") }
        if let why = caps.missing(requires) { return .no("this app can't run it: \(why)") }
        return .ok(info)
    }

    static func isFile(_ url: URL) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &dir) && !dir.boolValue
    }

    static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? -1
    }
}

// MARK: - Capabilities (ZnCapabilities.kt)

/// What this app can run (docs/ota.md §3.2): the registry version its renderer knows, the Hermes bytecode format, the
/// host API range of its native side, and its native modules with versions.
struct ZnCapabilities: CustomStringConvertible {
    let registry: Int
    let bytecode: Int
    let hostApi: Int
    let hostApiOldest: Int
    let modules: [String: Int]
    /// This app's OS, for a bundle's per-OS needs (docs/ota-requires-per-os.md §4).
    var os = "ios"

    /// Why this app can't run a bundle that needs [req], or nil if it can: the modules for both OSes, then this OS's own.
    func missing(_ req: ZnBundleRules.Requires) -> String? {
        if req.registry > registry { return "it needs registry v\(req.registry), this app has v\(registry)" }
        if req.bytecode != bytecode { return "its bytecode is format \(req.bytecode), this app's Hermes runs format \(bytecode)" }
        if req.hostApi > hostApi { return "it needs host API v\(req.hostApi), this app has v\(hostApi)" }
        if req.hostApi < hostApiOldest { return "it was built for host API v\(req.hostApi); this app runs v\(hostApiOldest) and newer" }
        for part in [req.modules, req.os[os] ?? [:]] {
            for name in part.keys.sorted() {
                let version = part[name]!
                guard let have = modules[name] else { return "it needs native module \(name), this app doesn't have it" }
                if have < version { return "it needs \(name) v\(version), this app has v\(have)" }
            }
        }
        return nil
    }

    var description: String {
        "\(os), registry v\(registry), bytecode \(bytecode), host API v\(hostApiOldest)–\(hostApi), modules \(modules.sorted { $0.key < $1.key })"
    }
}

// MARK: - Signatures (ZnOtaSignature.kt)

/// OTA signatures on the phone (docs/ota.md §3.3): ECDSA P-256 with SHA-256, DER signatures, public keys as base64 SPKI
/// DER. The signed texts must stay byte-identical to tools/ota/signing.ts and the update server (the fixture test).
/// The app trusts a main key and an offline backup key: an answer signed by either is accepted.
enum ZnOtaSignature {
    static let version = "zn-ota-v1"
    /// The pointer target that means "run the app's own bundle" (the kill switch).
    static let builtIn = "BUILT_IN"

    /// "registry=8;bytecode=99;hostApi=2;modules=Device:1,Fetch:1;android=AdId:1" (modules sorted by name; each OS's own
    /// modules after, Android then iOS, only when it has some: docs/ota-requires-per-os.md §3).
    static func requiresLine(_ r: ZnBundleRules.Requires) -> String {
        // Sorted as Kotlin's `sorted()` on Strings: by UTF-16 code units.
        func list(_ m: [String: Int]) -> String {
            m.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
                .map { "\($0):\(m[$0]!)" }.joined(separator: ",")
        }
        var line = "registry=\(r.registry);bytecode=\(r.bytecode);hostApi=\(r.hostApi);modules=\(list(r.modules))"
        for os in ZnBundleRules.Requires.oses {
            if let m = r.os[os], !m.isEmpty { line += ";\(os)=\(list(m))" }
        }
        return line
    }

    /// What a bundle's signature covers.
    static func bundleText(app: String, id: String, serial: Int, bundleSha256: String, requires: ZnBundleRules.Requires,
                           zipSha256: String, zipSize: Int64) -> String {
        [version, "bundle", app, id, String(serial), bundleSha256, requiresLine(requires), zipSha256, String(zipSize)]
            .joined(separator: "\n")
    }

    /// What a pointer's signature covers: this channel of this app chose [target] (a bundle id or BUILT_IN) at [seq].
    static func pointerText(app: String, channel: String, seq: Int64, target: String) -> String {
        [version, "pointer", app, channel, String(seq), target].joined(separator: "\n")
    }

    /// Which of [publicKeys] (base64 SPKI DER; main first, backup second) signed [text], or -1 if none did (or the
    /// signature or a key can't be read). [signature] is base64 DER.
    static func verify(_ text: String, signature: String, publicKeys: [String]) -> Int {
        guard let sigData = decodeBase64(signature),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: sigData) else { return -1 }
        let data = Data(text.utf8)
        for (i, pk) in publicKeys.enumerated() {
            guard let keyData = decodeBase64(pk), let key = try? P256.Signing.PublicKey(derRepresentation: keyData) else { continue }
            if key.isValidSignature(sig, for: data) { return i }
        }
        return -1
    }

    /// Standard base64 with padding; line breaks and spaces are ignored, anything else that isn't base64 fails.
    static func decodeBase64(_ s: String) -> Data? {
        let clean = s.filter { $0 != "\n" && $0 != "\r" && $0 != " " }
        guard clean.count % 4 == 0 else { return nil }
        return Data(base64Encoded: clean)
    }
}

// MARK: - Store answer (ZnOtaStore.kt)

/// A store update answer from the zn-updates server: [critical] 1 = optional, 2 = forced.
struct ZnStoreUpdate {
    let version: String
    let critical: Int
    let title: String?
    let message: String?
    var forced: Bool { critical == 2 }
}

/// The store update part of the check's answer (docs/zn-updates-server.md §4.6). The phone only keeps it and shows it
/// to JS (`Updates.status().store`); the app shows its own screens. Not signed: a wrong value can't run code.
///
///   { "update": null }                                                  nothing to do
///   { "update": { "version": "1.6.2", "critical": 1, "title"?, "message"? } } 1 = optional, 2 = forced
///   "appStoreId": "123"                                                 iOS only, when the app's store facts have it
enum ZnOtaStore {
    /// Longest text kept for a title or a message.
    static let maxText = 300

    /// The answer as clean JSON text, or nil when it can't be read (then the phone keeps the last good one).
    static func read(_ raw: Any?) -> String? {
        guard let j = raw as? [String: Any] else { return nil }
        var out: [String: Any] = [:]
        switch j["update"] {
        case nil, is NSNull:
            out["update"] = NSNull()
        case let u as [String: Any]:
            let version = u["version"]
            let okVersion: Bool
            if let n = version as? NSNumber, !ZnJSON.isBool(n) { okVersion = n.doubleValue.isFinite && n.doubleValue > 0 }
            else if let s = version as? String { okVersion = !s.trimmingCharacters(in: .whitespaces).isEmpty }
            else { okVersion = false }
            let critical = (u["critical"] as? NSNumber).flatMap { ZnJSON.isBool($0) ? nil : $0 }
            guard okVersion, let critical, critical == 1 || critical == 2 else { return nil }
            var update: [String: Any] = ["version": version!, "critical": critical.intValue]
            if let t = u["title"] as? String, !t.trimmingCharacters(in: .whitespaces).isEmpty { update["title"] = String(t.prefix(maxText)) }
            if let m = u["message"] as? String, !m.trimmingCharacters(in: .whitespaces).isEmpty { update["message"] = String(m.prefix(maxText)) }
            out["update"] = update
        default:
            return nil
        }
        if let id = j["appStoreId"] as? String, !id.trimmingCharacters(in: .whitespaces).isEmpty { out["appStoreId"] = id }
        return ZnJSON.text(out)
    }

    /// A kept answer (the JSON text [read] made) as a [ZnStoreUpdate]; nil when it has no update or can't be read.
    static func update(_ text: String?) -> ZnStoreUpdate? {
        guard let text, let j = try? ZnJSON.object(Data(text.utf8)), let u = j["update"] as? [String: Any] else { return nil }
        let critical = (u["critical"] as? NSNumber)?.intValue ?? 0
        guard critical == 1 || critical == 2 else { return nil }
        let version: String
        if let n = u["version"] as? NSNumber {
            let d = n.doubleValue
            version = d == d.rounded(.down) ? String(Int64(d)) : n.stringValue
        } else if let s = u["version"] as? String {
            version = s
        } else {
            return nil
        }
        let title = (u["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let message = (u["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return ZnStoreUpdate(version: version, critical: critical, title: title, message: message)
    }
}

// MARK: - Manifest and pointer (ZnOtaInstall.kt)

enum ZnOtaSigned {
    /// The signed manifest of a released bundle (tools/ota/core.ts `Manifest`).
    struct Manifest {
        let app: String
        let id: String
        let serial: Int
        let bundleSha256: String
        let requires: ZnBundleRules.Requires
        let zipSha256: String
        let zipSize: Int64
        /// Where to download it, relative to the server (the check's `bundle.url`).
        let url: String
        let signature: String
    }

    /// A signed channel pointer (tools/ota/core.ts `Pointer`). Rollout and priority aren't signed.
    struct Pointer {
        let app: String
        let channel: String
        let seq: Int64
        let target: String
        let priority: String
        let signature: String
    }

    static func parseManifest(_ j: [String: Any]) throws -> Manifest {
        let zip = try ZnJSON.obj(j, "zip")
        return Manifest(app: try ZnJSON.string(j, "app"), id: try ZnJSON.string(j, "id"), serial: try ZnJSON.int(j, "serial"),
                        bundleSha256: try ZnJSON.string(j, "bundleSha256"),
                        requires: try ZnBundleRules.parseRequires(try ZnJSON.obj(j, "requires")),
                        zipSha256: try ZnJSON.string(zip, "sha256"), zipSize: try ZnJSON.int64(zip, "size"),
                        url: j["url"] as? String ?? "", signature: try ZnJSON.string(try ZnJSON.obj(j, "signature"), "value"))
    }

    static func parsePointer(_ j: [String: Any]) throws -> Pointer {
        Pointer(app: try ZnJSON.string(j, "app"), channel: try ZnJSON.string(j, "channel"), seq: try ZnJSON.int64(j, "seq"),
                target: try ZnJSON.string(j, "target"), priority: j["priority"] as? String ?? "normal",
                signature: try ZnJSON.string(try ZnJSON.obj(j, "signature"), "value"))
    }

    static func verify(_ m: Manifest, _ publicKeys: [String]) -> Bool {
        ZnOtaSignature.verify(ZnOtaSignature.bundleText(app: m.app, id: m.id, serial: m.serial, bundleSha256: m.bundleSha256,
                                                        requires: m.requires, zipSha256: m.zipSha256, zipSize: m.zipSize),
                              signature: m.signature, publicKeys: publicKeys) >= 0
    }

    static func verify(_ p: Pointer, _ publicKeys: [String]) -> Bool {
        ZnOtaSignature.verify(ZnOtaSignature.pointerText(app: p.app, channel: p.channel, seq: p.seq, target: p.target),
                              signature: p.signature, publicKeys: publicKeys) >= 0
    }
}

// MARK: - Files

enum ZnOtaFiles {
    static func hex(_ bytes: some Sequence<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

    /// SHA-256 of a file, read in 64 KB parts.
    static func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }
        return hex(hasher.finalize())
    }

    /// The bundle's one SHA-256, as tools/bundle-info.ts makes it: over "name size sha256\n" lines sorted by name.
    static func bundleSha256(_ files: [String: (size: Int64, sha: String)]) -> String {
        let names = files.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        let text = names.map { "\($0) \(files[$0]!.size) \(files[$0]!.sha)\n" }.joined()
        return hex(SHA256.hash(data: Data(text.utf8)))
    }

    /// Writes a small file so readers see the old text or the new one, never half: a temp file, synced, renamed.
    /// [sync] false skips the sync (survives the app being killed, not a power cut).
    static func writeAtomic(_ url: URL, _ text: String, sync: Bool = true) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: nil)
        let h = try FileHandle(forWritingTo: tmp)
        try h.write(contentsOf: Data(text.utf8))
        if sync { try h.synchronize() }
        try h.close()
        guard rename(tmp.path, url.path) == 0 else { throw ZnOtaError("install", "can't write \(url.path) (errno \(errno))") }
    }

    static func readText(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }
}

// MARK: - Safety nets' state (ZnOtaHealth.kt)

enum ZnOtaHealthRules {
    static let error = "error"
    static let watchdog = "watchdog"
    /// Deaths within the window before a bundle is blocked when it isn't sure it crashed.
    static let watchdogLimit = 2
    /// The same for the phone's last good bundle.
    static let lastGoodLimit = 3
    static let crashWindowMs: Int64 = 24 * 60 * 60 * 1000
    static let maxBlocked = 32
    static let maxEvents = 20
    static let maxUnusable = 8
    static let maxMasked = 1024

    /// [stack]: the top JS frames of an error, [sha]: its bundle's SHA-256.
    struct Event {
        let kind: String
        let bundle: String?
        let detail: String?
        let atMs: Int64
        var stack: String? = nil
        var sha: String? = nil
    }

    /// How the process of a pending launch ended. [sure]: a crash mark says it crashed (one is enough to block).
    enum Exit {
        case counts(String, sure: Bool)
        case ignored(String)
    }

    final class State {
        /// The app build this state is for (version + build) and when that build was installed: any new install is seen.
        var appVersion = ""
        var appUpdated: Int64 = -1
        var pending: String?
        var pendingSince: Int64 = 0
        var pendingPid: Int32 = 0
        var crashBundle: String?
        var crashTimes: [Int64] = []
        var lastGood: String?
        /// Bundle id → error or watchdog, oldest first.
        var blocked: [(String, String)] = []
        var guardFails = 0
        var events: [Event] = []
        var unusable: [String] = []

        func isBlocked(_ id: String) -> Bool { blocked.contains { $0.0 == id } }
        func blockedKind(_ id: String) -> String? { blocked.first { $0.0 == id }?.1 }

        func toJson() -> String {
            var o: [String: Any] = [
                "apkVersion": appVersion, "apkUpdated": appUpdated, "pending": pending ?? "", "pendingSince": pendingSince,
                "pendingPid": pendingPid, "crashBundle": crashBundle ?? "", "crashTimes": crashTimes,
                "lastGood": lastGood ?? "", "guardFails": guardFails, "unusable": unusable,
            ]
            var b: [String: String] = [:]
            for (k, v) in blocked { b[k] = v }
            o["blocked"] = b
            o["blockedOrder"] = blocked.map(\.0)
            o["events"] = events.map { e -> [String: Any] in
                var j: [String: Any] = ["kind": e.kind, "bundle": e.bundle ?? "", "detail": e.detail ?? "", "at": e.atMs]
                if let s = e.stack { j["stack"] = s }
                if let s = e.sha { j["sha"] = s }
                return j
            }
            return ZnJSON.text(o) ?? "{}"
        }

        static func fromJson(_ text: String) throws -> State {
            let j = try ZnJSON.object(Data(text.utf8))
            let s = State()
            s.appVersion = j["apkVersion"] as? String ?? ""
            s.appUpdated = (j["apkUpdated"] as? NSNumber)?.int64Value ?? -1
            s.pending = ZnJSON.nonEmpty(j["pending"])
            s.pendingSince = (j["pendingSince"] as? NSNumber)?.int64Value ?? 0
            s.pendingPid = (j["pendingPid"] as? NSNumber)?.int32Value ?? 0
            s.crashBundle = ZnJSON.nonEmpty(j["crashBundle"])
            s.crashTimes = (j["crashTimes"] as? [NSNumber])?.map(\.int64Value) ?? []
            s.lastGood = ZnJSON.nonEmpty(j["lastGood"])
            let b = j["blocked"] as? [String: String] ?? [:]
            let order = j["blockedOrder"] as? [String] ?? b.keys.sorted()
            s.blocked = order.compactMap { id in b[id].map { (id, $0) } }
            s.guardFails = (j["guardFails"] as? NSNumber)?.intValue ?? 0
            s.unusable = j["unusable"] as? [String] ?? []
            s.events = (j["events"] as? [[String: Any]] ?? []).map {
                Event(kind: $0["kind"] as? String ?? "", bundle: ZnJSON.nonEmpty($0["bundle"]), detail: ZnJSON.nonEmpty($0["detail"]),
                      atMs: ($0["at"] as? NSNumber)?.int64Value ?? 0, stack: ZnJSON.nonEmpty($0["stack"]), sha: ZnJSON.nonEmpty($0["sha"]))
            }
            return s
        }
    }

    /// Once per process, before the bundle is chosen: notices a new app install (resets the counts, clears watchdog
    /// blocks and the fuse) and judges a launch the last process left pending ([exit] says how that process ended).
    /// Returns true if the app build changed.
    @discardableResult
    static func atStart(_ s: State, appVersion: String, appUpdated: Int64, now: Int64,
                        exit: (_ since: Int64, _ pid: Int32) -> Exit) -> Bool {
        let first = s.appVersion.isEmpty && s.appUpdated == -1
        let changed = !first && (s.appVersion != appVersion || s.appUpdated != appUpdated)
        if changed {
            let how = s.appVersion == appVersion ? "\(appVersion) installed again" : "\(s.appVersion) → \(appVersion)"
            event(s, "apk_changed", nil, how, now)
            s.pending = nil
            s.crashBundle = nil
            s.crashTimes.removeAll()
            s.guardFails = 0
            s.unusable.removeAll()
            s.blocked.removeAll { $0.1 == watchdog }
        }
        s.appVersion = appVersion
        s.appUpdated = appUpdated
        guard let p = s.pending else { return changed }
        s.pending = nil
        switch exit(s.pendingSince, s.pendingPid) {
        case .ignored:
            break  // not the bundle's fault: the count stays as it was
        case let .counts(reason, sure):
            // The phone's last good bundle ran well here before: one crash may be bad luck (a native SDK).
            let limit = s.lastGood == p ? lastGoodLimit : sure ? 1 : watchdogLimit
            countDeath(s, p, reason, limit: limit, now: now)
        }
        return changed
    }

    /// One more death of [bundle]; times older than the window, or in the future, are dropped. True if now blocked.
    @discardableResult
    static func countDeath(_ s: State, _ bundle: String, _ reason: String, limit: Int, now: Int64) -> Bool {
        if s.crashBundle != bundle { s.crashTimes.removeAll() }
        s.crashBundle = bundle
        s.crashTimes.removeAll { $0 > now || now - $0 >= crashWindowMs }
        s.crashTimes.append(now)
        while s.crashTimes.count > lastGoodLimit { s.crashTimes.removeFirst() }
        let count = s.crashTimes.count
        event(s, "launch_crashed", bundle, "\(reason) (\(count) of \(limit))", now)
        if count < limit { return false }
        block(s, bundle, watchdog)
        let how = count == 1 ? "a launch ended by a crash" : "\(count) launches in 24 h ended by a crash or a freeze"
        s.crashBundle = nil
        s.crashTimes.removeAll()
        event(s, "watchdog_block", bundle, "\(how); last: \(reason)", now)
        return true
    }

    /// [bundle] failed its checks at a start. The event is sent once per bundle.
    static func unusable(_ s: State, _ bundle: String, _ reason: String, now: Int64) {
        guard !s.unusable.contains(bundle) else { return }
        s.unusable.append(bundle)
        while s.unusable.count > maxUnusable { s.unusable.removeFirst() }
        event(s, "bundle_unusable", bundle, reason, now)
    }

    /// [bundle] is older than the app's own bundle (a store update came after it): normal, an info event, once.
    static func superseded(_ s: State, _ bundle: String, _ reason: String, now: Int64) {
        guard !s.unusable.contains(bundle) else { return }
        s.unusable.append(bundle)
        while s.unusable.count > maxUnusable { s.unusable.removeFirst() }
        event(s, "bundle_superseded", bundle, reason, now)
    }

    private static let query = try! NSRegularExpression(pattern: "((?:[a-z][a-z0-9+.-]*:/*|/)[^\\s?#\"']*)\\?[^\\s\"'#]*", options: .caseInsensitive)
    private static let bearer = try! NSRegularExpression(pattern: "\\bbearer\\s+\\S+", options: .caseInsensitive)
    private static let address = try! NSRegularExpression(pattern: "[A-Za-z0-9_.+-]+@[A-Za-z0-9_.-]+")
    private static let digits = try! NSRegularExpression(pattern: "\\d(?:[ -]?\\d){5,}")

    /// Hides what could be private in a JS error's text before it is stored or sent: URL query strings, bearer tokens,
    /// anything like `a@b` (VPAs, emails), and runs of 6 or more digits (with spaces or dashes between them).
    static func mask(_ text: String) -> String {
        var t = String(text.prefix(maxMasked))
        func rep(_ r: NSRegularExpression, _ with: String) {
            t = r.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: with)
        }
        rep(query, "$1?***")
        rep(bearer, "Bearer ***")
        rep(address, "***@***")
        rep(digits, "***")
        return t
    }

    /// True if [mark] (the crash mark file) says process [pid] crashed after [since].
    static func isCrashOf(_ mark: String?, pid: Int32, since: Int64) -> Bool {
        guard let parts = mark?.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " "), parts.count == 2 else { return false }
        return Int32(parts[0]) == pid && (Int64(parts[1]) ?? 0) >= since
    }

    /// A UI launch (or a return to the front) on [bundle], in process [pid].
    static func launch(_ s: State, _ bundle: String, now: Int64, pid: Int32) {
        s.pending = bundle
        s.pendingSince = now
        s.pendingPid = pid
    }

    /// The app went to the background: a death from now on isn't counted. Earlier deaths stay counted.
    static func ended(_ s: State, _ bundle: String) {
        if s.pending == bundle { s.pending = nil }
    }

    /// [bundle] is healthy: it becomes the last good bundle. True if that changed. A blocked bundle never does.
    @discardableResult
    static func healthy(_ s: State, _ bundle: String) -> Bool {
        if s.isBlocked(bundle) || s.lastGood == bundle { return false }
        s.lastGood = bundle
        return true
    }

    /// True if an error screen, a hang or no first screen in time on [bundle] blocks it and rolls back. Not for the
    /// phone's last good bundle: its errors are only reported (an "error" block is forever).
    static func errorsRollBack(_ s: State, _ bundle: String) -> Bool { s.lastGood != bundle }

    /// Blocks [bundle] for [why]; an "error" block is never turned into a "watchdog" one.
    static func block(_ s: State, _ bundle: String, _ why: String) {
        let kind = s.blockedKind(bundle) == error ? error : why
        s.blocked.removeAll { $0.0 == bundle }
        s.blocked.append((bundle, kind))
        while s.blocked.count > maxBlocked { s.blocked.removeFirst() }
        if s.lastGood == bundle { s.lastGood = nil }
        if s.pending == bundle { s.pending = nil }
    }

    static func event(_ s: State, _ kind: String, _ bundle: String?, _ detail: String?, _ now: Int64,
                      stack: String? = nil, sha: String? = nil) {
        s.events.append(Event(kind: kind, bundle: bundle, detail: detail, atMs: now, stack: stack, sha: sha))
        while s.events.count > maxEvents { s.events.removeFirst() }
    }

    /// The startup guard caught an error. True when the fuse is now blown (OTA off until the next app install).
    static func guardFailed(_ s: State) -> Bool {
        s.guardFails += 1
        return fuseBlown(s)
    }

    static func fuseBlown(_ s: State) -> Bool { s.guardFails >= 2 }
}

/// How the OTA client keeps its outcomes while checks fail (Android: ZnOtaOutcomes.kt; second-opinions #217).
enum ZnOtaOutcomeRules {
    /// Keeps at most [max] items, oldest dropped first, but plain ones before serious ones: a serious item goes only
    /// when nothing else is left to drop. The order of what stays doesn't change.
    static func trim<T>(_ items: [T], _ max: Int, serious: (T) -> Bool) -> [T] {
        if items.count <= max { return items }
        var plainToDrop = min(items.count - max, items.filter { !serious($0) }.count)
        var seriousToDrop = items.count - max - plainToDrop
        var kept: [T] = []
        for item in items {
            let isSerious = serious(item)
            if !isSerious && plainToDrop > 0 { plainToDrop -= 1 }
            else if isSerious && seriousToDrop > 0 { seriousToDrop -= 1 }
            else { kept.append(item) }
        }
        return kept
    }
}

// MARK: - JSON helpers

enum ZnJSON {
    static func object(_ data: Data) throws -> [String: Any] {
        guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ZnOtaError("json", "not a JSON object")
        }
        return o
    }

    static func text(_ o: Any) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

    static func obj(_ o: [String: Any], _ key: String) throws -> [String: Any] {
        guard let v = o[key] as? [String: Any] else { throw ZnOtaError("json", "\"\(key)\" is missing or not an object") }
        return v
    }

    static func string(_ o: [String: Any], _ key: String) throws -> String {
        guard let v = o[key] as? String else { throw ZnOtaError("json", "\"\(key)\" is missing or not a string") }
        return v
    }

    static func int64(_ o: [String: Any], _ key: String) throws -> Int64 {
        guard let n = o[key] as? NSNumber, !isBool(n), n.doubleValue == n.doubleValue.rounded(.towardZero) else {
            throw ZnOtaError("json", "\"\(key)\" is missing or not a whole number")
        }
        return n.int64Value
    }

    static func int(_ o: [String: Any], _ key: String) throws -> Int { Int(try int64(o, key)) }

    static func nonEmpty(_ v: Any?) -> String? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return s
    }
}
