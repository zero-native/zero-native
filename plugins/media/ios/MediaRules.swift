// The media plugin's rules with no UIKit in them (Android: MediaRules.kt), so the Mac tests can check them
// (ios/tests/plugins/media). Names, limits, the read plan, cleanup and the job on disk are the same as on Android.
import Foundation
import UniformTypeIdentifiers

/// Why one file can't be used. [code] reaches JS.
struct MediaFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String? = nil) {
        self.code = code
        self.message = message ?? code
    }
}

/// Pixels of a crop, on the picture after its rotation.
struct MediaCrop: Equatable {
    let x: Int, y: Int, width: Int, height: Int
}

/// How to turn one picture into the file we keep. [width], [height]: the final size. [turn]: degrees to turn (EXIF's
/// and the app's), after [flip]. [cropX], [cropY]: pixels on the turned picture, before it is made smaller. [scale]:
/// from the turned, cropped picture to the final one. [readSide]: the longest side to decode the file at (ImageIO's
/// thumbnail size; nil: the whole picture), Android's inSampleSize.
struct MediaPlan: Equatable {
    let width: Int, height: Int, turn: Int, flip: Bool, cropX: Int, cropY: Int, scale: Double, readSide: Int?
}

/// A file in the folder, for MediaRules.toDelete.
struct MediaStored {
    let name: String
    let bytes: Int64
    let modified: Double  // ms since 1970
}

enum MediaRules {
    static let defaultMaxSize = 2048
    static let defaultQuality = 85
    static let maxPhotos = 30
    /// A picked file is outside input: a broken provider can hand us a file with no end.
    static let maxBytes: Int64 = 100 * 1024 * 1024
    /// 24 MP is about 96 MB of memory. A bigger picture is read smaller.
    static let maxPixels: Double = 24_000_000

    /// What the folder may hold by itself, checked after each pick (see toDelete).
    static let keepMs: Double = 7 * 24 * 3600 * 1000
    static let keepBytes: Int64 = 256 * 1024 * 1024
    /// A half-done file this old has no job left that wants it.
    static let partKeepMs: Double = 3600 * 1000
    static let dayMs: Double = 24 * 3600 * 1000

    private static let prefix = "media-"
    private static let partPrefix = ".media-"
    private static let knownTypes: [(String, String)] = [
        ("application/pdf", "pdf"), ("image/jpeg", "jpg"), ("image/png", "png"), ("image/webp", "webp"), ("image/heic", "heic"),
        ("image/gif", "gif"), ("text/plain", "txt"), ("text/csv", "csv"), ("application/zip", "zip"),
    ]

    /// Starts with a dot: a handle can't name it, so JS never sees a half-done file.
    static func partName(_ id: String, _ index: Int, _ step: String) -> String { "\(partPrefix)\(id)-\(index).\(step)" }
    static func captureName(_ id: String) -> String { "\(partPrefix)\(id)-camera.jpg" }
    static func fileName(_ id: String, _ index: Int, _ ext: String) -> String { "\(prefix)\(id)-\(index).\(ext)" }

    static func maxSize(_ value: Int?) throws -> Int {
        let v = value ?? defaultMaxSize
        if v < 1 { throw MediaArgs("\"maxSize\" must be at least 1, got \(v)") }
        return v
    }

    static func quality(_ value: Int?) throws -> Int {
        let v = value ?? defaultQuality
        if !(1...100).contains(v) { throw MediaArgs("\"quality\" must be 1 to 100, got \(v)") }
        return v
    }

    static func rotate(_ value: Int?) throws -> Int {
        let r = value ?? 0
        if r % 90 != 0 { throw MediaArgs("\"rotate\" must be a multiple of 90, got \(r)") }
        return ((r % 360) + 360) % 360
    }

    static func mimeOr(_ type: String?, _ fallback: String) -> String {
        guard let type, type.count <= 127,
              type.range(of: "^[A-Za-z0-9*][A-Za-z0-9.+-]*/[A-Za-z0-9*][A-Za-z0-9.+*-]*$", options: .regularExpression) != nil else { return fallback }
        return type.lowercased()
    }

    static func extensionFor(_ mime: String, _ name: String) -> String {
        if let known = knownTypes.first(where: { $0.0 == mime }) { return known.1 }
        let ext = lastExtension(name).lowercased()
        return ext.range(of: "^[a-z0-9]{1,8}$", options: .regularExpression) != nil ? ext : "bin"
    }

    /// The type of a file we kept, when the picker can no longer say.
    static func mimeOf(_ fileName: String) -> String {
        let ext = lastExtension(fileName)
        return knownTypes.first { $0.1 == ext }?.0 ?? "application/octet-stream"
    }

    /// The name the other app gave: only ever shown or sent, never a path on disk here.
    static func displayName(_ name: String?, _ fallback: String) -> String {
        guard let name else { return fallback }
        let cleaned = String(String(name.unicodeScalars.map { s -> Character in
            s.value < 0x20 || s.value == 0x7f || "/\\:".unicodeScalars.contains(s) ? "_" : Character(s)
        }).trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        return cleaned.isEmpty ? fallback : cleaned
    }

    static func withExtension(_ name: String, _ ext: String) -> String {
        guard let dot = name.lastIndex(of: ".") else { return "\(name).\(ext)" }
        return "\(name[..<dot]).\(ext)"
    }

    /// Kotlin's substringAfterLast('.', ""): the text after the last dot, "" without one.
    private static func lastExtension(_ name: String) -> String {
        guard let dot = name.lastIndex(of: ".") else { return "" }
        return String(name[name.index(after: dot)...])
    }

    /// The read for one picture, nil when [crop] isn't inside it. [exifDegrees] and [flip]: the file's orientation.
    /// [rotate]: what the app asks for on top. Android's plan, with ImageIO's thumbnail side in place of inSampleSize:
    /// read at the smallest power-of-two step that still gives the final size, and never over 24 MP.
    static func plan(width: Int, height: Int, exifDegrees: Int, flip: Bool, rotate: Int, crop: MediaCrop?, maxSize: Int) -> MediaPlan? {
        let turn = (exifDegrees + rotate) % 360
        let sideways = turn % 180 != 0
        let shownWidth = sideways ? height : width, shownHeight = sideways ? width : height
        if let c = crop, c.x < 0 || c.y < 0 || c.width < 1 || c.height < 1 ||
            Int64(c.x) + Int64(c.width) > Int64(shownWidth) || Int64(c.y) + Int64(c.height) > Int64(shownHeight) { return nil }
        let cutWidth = crop?.width ?? shownWidth, cutHeight = crop?.height ?? shownHeight
        let pixels = Double(cutWidth) * Double(cutHeight)
        let scale = min(1.0, Double(maxSize) / Double(max(cutWidth, cutHeight)), (maxPixels / pixels).squareRoot())
        var sample = 1
        while Double(sample * 2) * scale <= 1.0 { sample *= 2 }
        while Double(width / sample) * Double(height / sample) > maxPixels { sample *= 2 }
        let side = max(width, height)
        return MediaPlan(width: max(1, Int((Double(cutWidth) * scale).rounded())), height: max(1, Int((Double(cutHeight) * scale).rounded())),
                         turn: turn, flip: flip, cropX: crop?.x ?? 0, cropY: crop?.y ?? 0, scale: scale,
                         readSide: sample > 1 ? max(1, side / sample) : nil)
    }

    /// EXIF orientation (1...8) → (degrees clockwise, mirrored first), as ExifInterface's rotationDegrees / isFlipped.
    static func orientation(_ exif: Int) -> (degrees: Int, flip: Bool) {
        switch exif {
        case 2: return (0, true)    // mirrored
        case 3: return (180, false)
        case 4: return (180, true)  // upside down mirrored
        case 5: return (270, true)  // transpose: mirrored, then three quarter turns
        case 6: return (90, false)
        case 7: return (90, true)   // transverse: mirrored, then a quarter turn
        case 8: return (270, false)
        default: return (0, false)
        }
    }

    /// Which of our files to delete. Other plugins share the folder, so only names we made count. [keep]: never these,
    /// like the job in progress. First what is older than [maxAgeMs], then the oldest until the rest fit in [maxBytes].
    static func toDelete(_ files: [MediaStored], now: Double, maxAgeMs: Double, maxBytes: Int64, keep: (String) -> Bool) -> [String] {
        let ours = files.filter { !keep($0.name) && ($0.name.hasPrefix(prefix) || $0.name.hasPrefix(partPrefix)) }
        let parts = ours.filter { $0.name.hasPrefix(partPrefix) }, finals = ours.filter { !$0.name.hasPrefix(partPrefix) }
        var out = parts.filter { now - $0.modified >= min(partKeepMs, maxAgeMs) }.map(\.name)
        let old = finals.filter { now - $0.modified >= maxAgeMs }, young = finals.filter { now - $0.modified < maxAgeMs }
        out += old.map(\.name)
        var total = young.reduce(Int64(0)) { $0 + $1.bytes }
        for f in young.sorted(by: { $0.modified < $1.modified }) {
            if total <= maxBytes { break }
            out.append(f.name)
            total -= f.bytes
        }
        return out
    }

    /// The picker's types for `pickFile`'s mime types: nil for "*/*" (any file), else what to ask for.
    static func pickTypes(_ mimes: [String]) -> [String]? {
        if mimes.isEmpty || mimes.contains("*/*") { return nil }
        return mimes
    }

    /// Mime types → the document picker's content types. "image/*" and the like are the family's base type; a type or
    /// family iOS doesn't know is a made-up type, which matches no file (as an Android type no app has). Broader than
    /// Android: "application/*" is any file (iOS has no type for every application/ one), and "text/*" is any text,
    /// JSON and XML too (application/ on Android).
    static func contentTypes(_ mimes: [String]) -> [UTType] {
        guard let list = MediaRules.pickTypes(mimes) else { return [.item] }
        let families: [String: UTType] = ["image": .image, "video": .movie, "audio": .audio, "text": .text, "application": .data,
                                          "font": .font, "model": .threeDContent, "message": .message]
        let types = list.compactMap { m -> UTType? in
            if m.hasSuffix("/*"), let family = families[String(m.dropLast(2))] { return family }
            return UTType(mimeType: m) ?? UTType(tag: m, tagClass: .mimeType, conformingTo: .data)
        }
        return types.isEmpty ? [.item] : types
    }

    /// Why the picked item [from] can't be copied, before copying: a package from Files (.pages, .key, .rtfd, a
    /// bundle) is a folder, with no file to hand JS (Android has none): read_failed. Over [maxBytes]: too_big.
    static func refusedCopy(_ from: URL, maxBytes: Int64) -> String? {
        let values = try? from.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
        if values?.isDirectory == true {
            print("zn media: the picked item is a folder (a package), not a file")
            return "read_failed"
        }
        return Int64(values?.fileSize ?? 0) > maxBytes ? "too_big" : nil
    }

    /// The camera opens only with the permission (UIImagePickerController shows a black screen without it). Not asked
    /// yet, or refused: `camera_permission`, and JS asks through Permissions and tries again, as on Android (an iOS
    /// "no" reads as blocked there: camera_blocked). No camera (the simulator): no_app.
    enum CameraStart: Equatable { case open, refuse(String) }

    static func camera(available: Bool, authorized: Bool) -> CameraStart {
        if !available { return .refuse("no_app") }
        return authorized ? .open : .refuse("camera_permission")
    }
}

/// A rule's refusal, as a wrong argument (the module turns it into ZnInvalidArgs).
struct MediaArgs: Error {
    let message: String
    init(_ m: String) { message = m }
}

/// One launch, on disk from before the picker opens until JS forgets it (Android's MediaJob). [parts]: the copies the
/// picker's answer made (dot names in fileDir), with the names and types it gave. Only the newest job exists.
struct MediaJob: Equatable {
    static let photos = "photos", file = "file", camera = "camera"

    var id: String
    var kind: String
    var maxSize = MediaRules.defaultMaxSize
    var quality = MediaRules.defaultQuality
    var max = 1
    var maxBytes = MediaRules.maxBytes
    /// The picker's answer, once it came: -1 OK, 0 cancelled (Android's codes).
    var resultCode: Int?
    var parts: [String] = []
    var names: [String?] = []
    var mimes: [String?] = []
    /// Per part: the reason it couldn't be copied ("too_big", "read_failed"), or nil.
    var failed: [String?] = []

    var json: [String: Any] {
        let opt = { (v: String?) -> Any in v ?? NSNull() }
        return ["id": id, "kind": kind, "maxSize": maxSize, "quality": quality, "max": max, "maxBytes": maxBytes,
                "resultCode": resultCode.map { $0 as Any } ?? NSNull(), "parts": parts, "names": names.map(opt),
                "mimes": mimes.map(opt), "failed": failed.map(opt)]
    }

    /// Written by an app version we can't read: the same as no job, and JS hears "lost".
    static func from(_ text: String?) -> MediaJob? {
        guard let text, let o = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let id = o["id"] as? String, let kind = o["kind"] as? String,
              let maxSize = o["maxSize"] as? Int, let quality = o["quality"] as? Int, let max = o["max"] as? Int,
              let maxBytes = (o["maxBytes"] as? NSNumber)?.int64Value, let parts = o["parts"] as? [String] else { return nil }
        let strings = { (key: String) -> [String?] in
            ((o[key] as? [Any]) ?? []).map { $0 as? String } + Array(repeating: nil, count: Swift.max(0, parts.count - ((o[key] as? [Any])?.count ?? 0)))
        }
        return MediaJob(id: id, kind: kind, maxSize: maxSize, quality: quality, max: max, maxBytes: maxBytes,
                        resultCode: o["resultCode"] as? Int, parts: parts, names: strings("names"), mimes: strings("mimes"),
                        failed: strings("failed"))
    }
}
