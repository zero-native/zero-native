// Checking and installing a downloaded bundle on iOS (android/runtime ZnOtaInstall.kt `extract` and `buildFromPatch`,
// docs/ota.md §3.5, docs/ota-patches.md §3, §6). Foundation and Compression only (no UIKit), so ios/tests/ota checks it
// on the Mac.
//
// Nothing is trusted unless it was signed: the pointer, the manifest, then the zip's SHA, then every file's SHA and
// the bundle's own SHA. A bundle built from a patch zip goes through the same checks, so a patch weakens nothing.
import Compression
import Foundation

/// A zip file's entries, read from its central directory (the zips tools/ota makes: fflate, stored or deflated, no
/// zip64, no encryption). Only what OTA needs: find an entry, stream its bytes out.
final class ZnZip {
    struct Entry {
        let name: String
        let method: UInt16
        let compressedSize: Int64
        let size: Int64
        let localHeaderOffset: Int64
    }

    private let handle: FileHandle
    private(set) var entries: [String: Entry] = [:]
    /// The error code for a bad zip: "bundle" for a bundle zip, "patch" for a patch zip.
    private let code: String

    init(_ url: URL, code: String = "bundle") throws {
        self.code = code
        handle = try FileHandle(forReadingFrom: url)
        let length = try handle.seekToEnd()
        // The end-of-central-directory record is in the last 22 bytes + up to 64 KB of comment.
        let tailSize = min(length, 22 + 65_535)
        try handle.seek(toOffset: length - tailSize)
        let tail = try handle.read(upToCount: Int(tailSize)) ?? Data()
        let bytes = [UInt8](tail)
        var eocd = -1
        if bytes.count >= 22 {
            for i in stride(from: bytes.count - 22, through: 0, by: -1)
                where bytes[i] == 0x50 && bytes[i + 1] == 0x4b && bytes[i + 2] == 0x05 && bytes[i + 3] == 0x06 {
                eocd = i
                break
            }
        }
        guard eocd >= 0 else { throw ZnOtaError(code, "not a zip (no end record)") }
        let count = Int(Self.u16(bytes, eocd + 10))
        let cdSize = Int64(Self.u32(bytes, eocd + 12))
        let cdOffset = Int64(Self.u32(bytes, eocd + 16))
        guard cdOffset + cdSize <= length, count < 100_000 else { throw ZnOtaError(code, "bad zip directory") }
        try handle.seek(toOffset: UInt64(cdOffset))
        let cd = [UInt8](try handle.read(upToCount: Int(cdSize)) ?? Data())
        var p = 0
        for _ in 0..<count {
            guard p + 46 <= cd.count, Self.u32(cd, p) == 0x0201_4b50 else { throw ZnOtaError(code, "bad zip directory entry") }
            let flags = Self.u16(cd, p + 8)
            let method = Self.u16(cd, p + 10)
            let compressed = Int64(Self.u32(cd, p + 20))
            let size = Int64(Self.u32(cd, p + 24))
            let nameLen = Int(Self.u16(cd, p + 28))
            let extraLen = Int(Self.u16(cd, p + 30))
            let commentLen = Int(Self.u16(cd, p + 32))
            let offset = Int64(Self.u32(cd, p + 42))
            guard p + 46 + nameLen <= cd.count else { throw ZnOtaError(code, "bad zip directory entry") }
            let name = String(decoding: cd[(p + 46)..<(p + 46 + nameLen)], as: UTF8.self)
            if flags & 1 != 0 { throw ZnOtaError(code, "\(name) is encrypted") }
            if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF { throw ZnOtaError(code, "zip64 isn't read here (\(name))") }
            entries[name] = Entry(name: name, method: method, compressedSize: compressed, size: size, localHeaderOffset: offset)
            p += 46 + nameLen + extraLen + commentLen
        }
    }

    deinit { try? handle.close() }

    /// Streams [entry]'s bytes to [sink] in parts (inflated when deflated). Stops with an error past [limit] bytes;
    /// [what] names the entry in that error ("the patch for main.hbc": "… is bigger than its limit of …").
    func read(_ entry: Entry, limit: Int64, what: String? = nil, _ sink: (Data) throws -> Void) throws {
        try handle.seek(toOffset: UInt64(entry.localHeaderOffset))
        let header = [UInt8](try handle.read(upToCount: 30) ?? Data())
        guard header.count == 30, Self.u32(header, 0) == 0x0403_4b50 else { throw ZnOtaError(code, "bad zip entry \(entry.name)") }
        let skip = UInt64(Self.u16(header, 26)) + UInt64(Self.u16(header, 28))
        try handle.seek(toOffset: UInt64(entry.localHeaderOffset) + 30 + skip)
        var left = entry.compressedSize
        var written: Int64 = 0
        func emit(_ d: Data) throws {
            written += Int64(d.count)
            if written > limit {
                throw ZnOtaError(code, what.map { "\($0) is bigger than its limit of \(limit) bytes" } ?? "\(entry.name) is bigger than its listed \(limit) bytes")
            }
            try sink(d)
        }
        switch entry.method {
        case 0:
            while left > 0 {
                let chunk = try handle.read(upToCount: Int(min(left, 64 * 1024))) ?? Data()
                if chunk.isEmpty { throw ZnOtaError(code, "\(entry.name) is cut short") }
                left -= Int64(chunk.count)
                try emit(chunk)
            }
        case 8:
            // Raw deflate (RFC 1951): Compression's ZLIB algorithm is exactly that (no zlib header).
            let out = UnsafeMutablePointer<UInt8>.allocate(capacity: 64 * 1024)
            defer { out.deallocate() }
            var stream = compression_stream(dst_ptr: out, dst_size: 0, src_ptr: UnsafePointer(out), src_size: 0, state: nil)
            guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
                throw ZnOtaError(code, "can't start inflating \(entry.name)")
            }
            defer { compression_stream_destroy(&stream) }
            var done = false
            while !done {
                let input = left > 0 ? (try handle.read(upToCount: Int(min(left, 64 * 1024))) ?? Data()) : Data()
                if left > 0 && input.isEmpty { throw ZnOtaError(code, "\(entry.name) is cut short") }
                left -= Int64(input.count)
                let last = left == 0
                try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                    stream.src_ptr = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(out)
                    stream.src_size = input.count
                    repeat {
                        stream.dst_ptr = out
                        stream.dst_size = 64 * 1024
                        let status = compression_stream_process(&stream, last ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
                        let produced = 64 * 1024 - stream.dst_size
                        if produced > 0 { try emit(Data(bytes: out, count: produced)) }
                        switch status {
                        case COMPRESSION_STATUS_END: done = true
                        case COMPRESSION_STATUS_OK: break
                        default: throw ZnOtaError(code, "\(entry.name) doesn't inflate")
                        }
                    } while !done && (stream.src_size > 0 || stream.dst_size == 0)
                }
                if last && !done && stream.src_size == 0 && stream.dst_size > 0 {
                    throw ZnOtaError(code, "\(entry.name) ends early")
                }
            }
        default:
            throw ZnOtaError(code, "\(entry.name) uses zip method \(entry.method)")
        }
    }

    private static func u16(_ b: [UInt8], _ i: Int) -> UInt16 { UInt16(b[i]) | UInt16(b[i + 1]) << 8 }
    private static func u32(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
    }
}

enum ZnOtaInstall {
    /// Unzips the bundle [zip] (its SHA already checked against [m]) into the new folder [dest]. `zn-bundle.json` is
    /// read first and must name the manifest's bundle; then only the files it lists are written, each stopped at its
    /// listed size and checked against its listed SHA-256 (no zip bombs; no paths outside [dest]: names were checked
    /// when parsing). Finally the bundle's SHA and needs must equal the signed manifest's. Throws ZnOtaError.
    static func extract(zip: URL, manifest m: ZnOtaSigned.Manifest, dest: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path) { throw ZnOtaError("install", "\(dest.path) already exists") }
        let z = try ZnZip(zip)
        let (infoData, info, listed) = try readInfo(z, m, "bundle")
        var checked: [String: (size: Int64, sha: String)] = [:]
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        for (name, size) in info.files {
            guard let entry = z.entries[name] else { throw ZnOtaError("bundle", "the zip has no \(name)") }
            let out = try outFile(dest, name)
            checked[name] = (size, try writeChecked(to: out, name: name, size: size, listedSha: listed[name]!, code: "bundle") {
                try z.read(entry, limit: size, $0)
            })
        }
        try finish(checked, info, infoData, m, dest, "bundle")
    }

    /// Reads `zn-bundle.json` from [z]; it must name the manifest's app, id and serial, and the same needs, and list a
    /// SHA-256 for every file. Returns its bytes, what it says and each file's listed SHA-256. Problems throw
    /// ZnOtaError with [code].
    private static func readInfo(_ z: ZnZip, _ m: ZnOtaSigned.Manifest, _ code: String) throws
        -> (Data, ZnBundleRules.Info, [String: String]) {
        let infoName = ZnBundleRules.infoFile
        guard let infoEntry = z.entries[infoName] else { throw ZnOtaError(code, "the zip has no \(infoName)") }
        if infoEntry.size > 1_000_000 { throw ZnOtaError(code, "\(infoName) is too big") }
        var infoData = Data()
        try z.read(infoEntry, limit: 1_000_000) { infoData.append($0) }
        let info: ZnBundleRules.Info
        do {
            info = try ZnBundleRules.parseInfo(String(decoding: infoData, as: UTF8.self))
        } catch {
            throw ZnOtaError(code, "bad \(infoName): \(error)")
        }
        if info.app != m.app || info.id != m.id || info.serial != m.serial {
            throw ZnOtaError(code, "the zip holds \(info.app)/\(info.id) #\(info.serial), the manifest says \(m.app)/\(m.id) #\(m.serial)")
        }
        guard let req = info.requires else { throw ZnOtaError(code, "the zip's \(infoName) has no requires") }
        if ZnOtaSignature.requiresLine(req) != ZnOtaSignature.requiresLine(m.requires) {
            throw ZnOtaError(code, "the zip's needs differ from the signed manifest's")
        }
        let files = (try? ZnJSON.obj(try ZnJSON.object(infoData), "files")) ?? [:]
        var listed: [String: String] = [:]
        for name in info.files.keys {
            guard let sha = (files[name] as? [String: Any])?["sha256"] as? String else {
                throw ZnOtaError(code, "\(infoName) has no sha256 for \(name)")
            }
            listed[name] = sha
        }
        return (infoData, info, listed)
    }

    /// The file [name] in [dest], its folder made.
    private static func outFile(_ dest: URL, _ name: String) throws -> URL {
        let out = dest.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        return out
    }

    /// Writes what [source] hands its sink to [out], stopped past [size] bytes; it must be exactly [size] bytes and
    /// match [listedSha]. Returns its SHA-256. Problems throw ZnOtaError with [code].
    private static func writeChecked(to out: URL, name: String, size: Int64, listedSha: String, code: String,
                                     _ source: ((Data) throws -> Void) throws -> Void) throws -> String {
        FileManager.default.createFile(atPath: out.path, contents: nil)
        let h = try FileHandle(forWritingTo: out)
        defer { try? h.close() }
        var hasher = SHA256Stream()
        var written: Int64 = 0
        try source { chunk in
            written += Int64(chunk.count)
            if written > size { throw ZnOtaError(code, "\(name) is bigger than its listed \(size) bytes") }
            hasher.update(chunk)
            try h.write(contentsOf: chunk)
        }
        try h.synchronize()
        let sha = hasher.hex()
        if written != size { throw ZnOtaError(code, "\(name) is \(written) bytes, listed \(size)") }
        if sha != listedSha { throw ZnOtaError(code, "\(name) doesn't match its SHA-256") }
        return sha
    }

    /// The last step of a build: the files made ([checked]: name → size and SHA) must give the signed bundle SHA, and so
    /// must `zn-bundle.json`. Then `zn-bundle.json` is written into [dest].
    private static func finish(_ checked: [String: (size: Int64, sha: String)], _ info: ZnBundleRules.Info, _ infoData: Data,
                               _ m: ZnOtaSigned.Manifest, _ dest: URL, _ code: String) throws {
        if ZnOtaFiles.bundleSha256(checked) != m.bundleSha256 || info.sha256 != m.bundleSha256 {
            throw ZnOtaError(code, "the bundle's files don't match the signed bundle SHA-256")
        }
        try infoData.write(to: dest.appendingPathComponent(ZnBundleRules.infoFile))
    }

    // MARK: Building a bundle from a patch zip (docs/ota-patches.md §3, §6)

    /// The patch zip's own file: what it patches, and how each new file is made.
    static let patchFile = "zn-patch.json"
    /// A patch entry may unpack to at most 2 × the listed size of the file it makes, plus this.
    private static let patchSlack: Int64 = 1 << 20
    /// An old file read into memory for a patch (largest today: main.hbc, 1.6 MB). Bigger: refused.
    private static let maxBaseFile: Int64 = 64 << 20
    /// The most a patch entry is ever read to (Android's ByteArray limit, so both phones read the same).
    private static let maxRead = Int64(Int32.max) - 16

    /// Builds bundle [m] into the new folder [dest] from the patch zip [patchZip] (its SHA already checked against the
    /// check's `patch`) and the base bundle [fromId] whose bundle SHA is [fromSha256]. [base] gives a file of the base
    /// bundle by name, or nil if it has none: a downloaded bundle's folder or the app's own bundle.
    ///
    /// The same checks as extract, so a patch weakens nothing: `zn-bundle.json` must name the manifest's bundle;
    /// `zn-patch.json` must be from [fromSha256] to [m], and list exactly the files of `zn-bundle.json`; every file made
    /// (copy, patch or zip) is stopped at its listed size and checked against its listed SHA-256; then the bundle's SHA
    /// must equal the signed manifest's. File names go through ZnBundleRules.isSafePath, so nothing is read or written
    /// outside a bundle. Throws ZnOtaError with code "patch" (or "install").
    ///
    /// iOS also checks the file list against the signed bundle SHA before it makes any file (Android: only at the end),
    /// so every size a patch makes is signed and a patch zip can never ask for a huge file.
    static func buildFromPatch(patchZip: URL, manifest m: ZnOtaSigned.Manifest, fromId: String, fromSha256: String,
                               base: (String) -> URL?, dest: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: dest.path) { throw ZnOtaError("install", "\(dest.path) already exists") }
        let z: ZnZip
        do {
            z = try ZnZip(patchZip, code: "patch")
        } catch {
            throw ZnOtaError("patch", "the patch zip can't be read (\((error as? ZnOtaError)?.message ?? "\(error)"))")
        }
        guard let planEntry = z.entries[patchFile] else { throw ZnOtaError("patch", "the patch zip has no \(patchFile)") }
        var patchData = Data()
        try z.read(planEntry, limit: 1_000_000, what: patchFile) { patchData.append($0) }
        let p: [String: Any]
        do { p = try ZnJSON.object(patchData) } catch { throw ZnOtaError("patch", "bad \(patchFile): \(error)") }
        let format = p["format"] as? String ?? ""
        if format != ZnBsPatch.format {
            throw ZnOtaError("patch", "\(patchFile) has format \"\(format)\", this app reads \(ZnBsPatch.format)")
        }
        // The base is matched by its bundle SHA only: the server makes one patch per base SHA, and two bundles with the
        // same SHA (an Android and an iOS store build of the same JS) have different ids. Same SHA = same files, so the
        // id in zn-patch.json is only for people reading it.
        let from = p["from"] as? [String: Any]
        let to = p["to"] as? [String: Any]
        if from?["sha256"] as? String != fromSha256 {
            throw ZnOtaError("patch", "\(patchFile) is from \(from?["id"] as? String ?? "?") with another SHA-256 than the base \(fromId)")
        }
        if to?["id"] as? String != m.id || to?["sha256"] as? String != m.bundleSha256 {
            throw ZnOtaError("patch", "\(patchFile) is to \(to?["id"] as? String ?? "?"), the manifest says \(m.id) (or its SHA-256 differs)")
        }
        let (infoData, info, listed) = try readInfo(z, m, "patch")
        var signed: [String: (size: Int64, sha: String)] = [:]
        for (name, size) in info.files { signed[name] = (size, listed[name]!) }
        if ZnOtaFiles.bundleSha256(signed) != m.bundleSha256 || info.sha256 != m.bundleSha256 {
            throw ZnOtaError("patch", "the bundle's files don't match the signed bundle SHA-256")
        }
        guard let specs = p["files"] as? [String: Any] else { throw ZnOtaError("patch", "\(patchFile) has no files") }
        if let extra = specs.keys.sorted().first(where: { info.files[$0] == nil }) {
            throw ZnOtaError("patch", "\(patchFile) has \(extra), which \(ZnBundleRules.infoFile) doesn't list")
        }
        if let missing = info.files.keys.sorted().first(where: { specs[$0] == nil }) {
            throw ZnOtaError("patch", "\(patchFile) doesn't say how to make \(missing)")
        }

        var checked: [String: (size: Int64, sha: String)] = [:]
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        for name in info.files.keys.sorted() {
            let size = info.files[name]!
            guard let spec = specs[name] as? [String: Any] else { throw ZnOtaError("patch", "\(patchFile): \(name) isn't an object") }
            let how = ["copy", "patch", "zip"].filter { spec[$0] != nil }
            if how.count != 1 {
                throw ZnOtaError("patch", "\(patchFile): \(name) needs one of copy, patch or zip, it has \(how.isEmpty ? "none" : how.joined(separator: ", "))")
            }
            let sha = listed[name]!
            let out = try outFile(dest, name)
            switch how[0] {
            case "copy":
                let b = try safeName(spec["copy"], name)
                guard let file = base(b) else { throw ZnOtaError("patch", "the base \(fromId) has no \(b) (to copy as \(name))") }
                checked[name] = (size, try writeChecked(to: out, name: name, size: size, listedSha: sha, code: "patch") { sink in
                    let h = try FileHandle(forReadingFrom: file)
                    defer { try? h.close() }
                    while let chunk = try h.read(upToCount: 64 * 1024), !chunk.isEmpty { try sink(chunk) }
                })
            case "zip":
                let entry = try patchEntry(z, spec["zip"], name)
                checked[name] = (size, try writeChecked(to: out, name: name, size: size, listedSha: sha, code: "patch") {
                    try z.read(entry, limit: size, $0)
                })
            default:
                let entry = try patchEntry(z, spec["patch"], name)
                let b = try safeName(spec["base"], name)
                guard let file = base(b) else { throw ZnOtaError("patch", "the base \(fromId) has no \(b) (to patch into \(name))") }
                if ZnBundleRules.fileSize(file) > maxBaseFile {
                    throw ZnOtaError("patch", "the base file \(b) is bigger than its limit of \(maxBaseFile) bytes")
                }
                let old = try Data(contentsOf: file, options: .mappedIfSafe)
                // §6: a patch entry may unpack to at most 2 × the file's listed size + 1 MiB.
                let limit = size > (maxRead - patchSlack) / 2 ? maxRead : 2 * size + patchSlack
                var patch = Data()
                try z.read(entry, limit: limit, what: "the patch for \(name)") { patch.append($0) }
                let made: Data
                do {
                    made = try ZnBsPatch.apply(old: old, patch: patch, expectSize: size)
                } catch let e as ZnOtaError {
                    throw ZnOtaError("patch", "the patch for \(name): \(e.message)")
                }
                checked[name] = (size, try writeChecked(to: out, name: name, size: size, listedSha: sha, code: "patch") { try $0(made) })
            }
        }
        try finish(checked, info, infoData, m, dest, "patch")
    }

    /// The entry [entryName] of the patch zip (for new file [forName]); the name must pass safeName.
    private static func patchEntry(_ z: ZnZip, _ entryName: Any?, _ forName: String) throws -> ZnZip.Entry {
        let n = try safeName(entryName, forName)
        guard let e = z.entries[n] else { throw ZnOtaError("patch", "the patch zip has no \(n) (for \(forName))") }
        return e
    }

    /// [n] if it is a plain relative path (ZnBundleRules.isSafePath: no leading "/", "..", empty part or backslash).
    private static func safeName(_ n: Any?, _ forName: String) throws -> String {
        let s = n as? String ?? ""
        if !ZnBundleRules.isSafePath(s) { throw ZnOtaError("patch", "\(patchFile): bad path \"\(s)\" for \(forName)") }
        return s
    }
}

import CryptoKit

/// SHA-256 over parts, as hex.
struct SHA256Stream {
    private var h = SHA256()
    mutating func update(_ d: Data) { h.update(data: d) }
    func hex() -> String { ZnOtaFiles.hex(h.finalize()) }
}
