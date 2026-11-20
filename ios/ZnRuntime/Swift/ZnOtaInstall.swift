// Checking and installing a downloaded bundle on iOS (android/runtime ZnOtaInstall.kt `extract`, docs/ota.md §3.5).
// Foundation and Compression only (no UIKit), so ios/tests/ota checks it on the Mac.
//
// Nothing is trusted unless it was signed: the pointer, the manifest, then the zip's SHA, then every file's SHA and
// the bundle's own SHA. Patches (Android's ZnBsPatch) are not on iOS yet: the check says it reads none, so the server
// sends full zips (docs/ota.md, docs/ota-patches.md).
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

    init(_ url: URL) throws {
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
        guard eocd >= 0 else { throw ZnOtaError("bundle", "not a zip (no end record)") }
        let count = Int(Self.u16(bytes, eocd + 10))
        let cdSize = Int64(Self.u32(bytes, eocd + 12))
        let cdOffset = Int64(Self.u32(bytes, eocd + 16))
        guard cdOffset + cdSize <= length, count < 100_000 else { throw ZnOtaError("bundle", "bad zip directory") }
        try handle.seek(toOffset: UInt64(cdOffset))
        let cd = [UInt8](try handle.read(upToCount: Int(cdSize)) ?? Data())
        var p = 0
        for _ in 0..<count {
            guard p + 46 <= cd.count, Self.u32(cd, p) == 0x0201_4b50 else { throw ZnOtaError("bundle", "bad zip directory entry") }
            let flags = Self.u16(cd, p + 8)
            let method = Self.u16(cd, p + 10)
            let compressed = Int64(Self.u32(cd, p + 20))
            let size = Int64(Self.u32(cd, p + 24))
            let nameLen = Int(Self.u16(cd, p + 28))
            let extraLen = Int(Self.u16(cd, p + 30))
            let commentLen = Int(Self.u16(cd, p + 32))
            let offset = Int64(Self.u32(cd, p + 42))
            guard p + 46 + nameLen <= cd.count else { throw ZnOtaError("bundle", "bad zip directory entry") }
            let name = String(decoding: cd[(p + 46)..<(p + 46 + nameLen)], as: UTF8.self)
            if flags & 1 != 0 { throw ZnOtaError("bundle", "\(name) is encrypted") }
            if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF { throw ZnOtaError("bundle", "zip64 isn't read here (\(name))") }
            entries[name] = Entry(name: name, method: method, compressedSize: compressed, size: size, localHeaderOffset: offset)
            p += 46 + nameLen + extraLen + commentLen
        }
    }

    deinit { try? handle.close() }

    /// Streams [entry]'s bytes to [sink] in parts (inflated when deflated). Stops with an error past [limit] bytes.
    func read(_ entry: Entry, limit: Int64, _ sink: (Data) throws -> Void) throws {
        try handle.seek(toOffset: UInt64(entry.localHeaderOffset))
        let header = [UInt8](try handle.read(upToCount: 30) ?? Data())
        guard header.count == 30, Self.u32(header, 0) == 0x0403_4b50 else { throw ZnOtaError("bundle", "bad zip entry \(entry.name)") }
        let skip = UInt64(Self.u16(header, 26)) + UInt64(Self.u16(header, 28))
        try handle.seek(toOffset: UInt64(entry.localHeaderOffset) + 30 + skip)
        var left = entry.compressedSize
        var written: Int64 = 0
        func emit(_ d: Data) throws {
            written += Int64(d.count)
            if written > limit { throw ZnOtaError("bundle", "\(entry.name) is bigger than its listed \(limit) bytes") }
            try sink(d)
        }
        switch entry.method {
        case 0:
            while left > 0 {
                let chunk = try handle.read(upToCount: Int(min(left, 64 * 1024))) ?? Data()
                if chunk.isEmpty { throw ZnOtaError("bundle", "\(entry.name) is cut short") }
                left -= Int64(chunk.count)
                try emit(chunk)
            }
        case 8:
            // Raw deflate (RFC 1951): Compression's ZLIB algorithm is exactly that (no zlib header).
            let out = UnsafeMutablePointer<UInt8>.allocate(capacity: 64 * 1024)
            defer { out.deallocate() }
            var stream = compression_stream(dst_ptr: out, dst_size: 0, src_ptr: UnsafePointer(out), src_size: 0, state: nil)
            guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
                throw ZnOtaError("bundle", "can't start inflating \(entry.name)")
            }
            defer { compression_stream_destroy(&stream) }
            var done = false
            while !done {
                let input = left > 0 ? (try handle.read(upToCount: Int(min(left, 64 * 1024))) ?? Data()) : Data()
                if left > 0 && input.isEmpty { throw ZnOtaError("bundle", "\(entry.name) is cut short") }
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
                        default: throw ZnOtaError("bundle", "\(entry.name) doesn't inflate")
                        }
                    } while !done && (stream.src_size > 0 || stream.dst_size == 0)
                }
                if last && !done && stream.src_size == 0 && stream.dst_size > 0 {
                    throw ZnOtaError("bundle", "\(entry.name) ends early")
                }
            }
        default:
            throw ZnOtaError("bundle", "\(entry.name) uses zip method \(entry.method)")
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
        let infoName = ZnBundleRules.infoFile
        guard let infoEntry = z.entries[infoName] else { throw ZnOtaError("bundle", "the zip has no \(infoName)") }
        if infoEntry.size > 1_000_000 { throw ZnOtaError("bundle", "\(infoName) is too big") }
        var infoData = Data()
        try z.read(infoEntry, limit: 1_000_000) { infoData.append($0) }
        let infoText = String(decoding: infoData, as: UTF8.self)
        let info: ZnBundleRules.Info
        do {
            info = try ZnBundleRules.parseInfo(infoText)
        } catch {
            throw ZnOtaError("bundle", "bad \(infoName): \(error)")
        }
        if info.app != m.app || info.id != m.id || info.serial != m.serial {
            throw ZnOtaError("bundle", "the zip holds \(info.app)/\(info.id) #\(info.serial), the manifest says \(m.app)/\(m.id) #\(m.serial)")
        }
        guard let req = info.requires else { throw ZnOtaError("bundle", "the zip's \(infoName) has no requires") }
        if ZnOtaSignature.requiresLine(req) != ZnOtaSignature.requiresLine(m.requires) {
            throw ZnOtaError("bundle", "the zip's needs differ from the signed manifest's")
        }
        let listed = (try? ZnJSON.obj(try ZnJSON.object(infoData), "files")) ?? [:]
        var checked: [String: (size: Int64, sha: String)] = [:]
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        for (name, size) in info.files {
            guard let entry = z.entries[name] else { throw ZnOtaError("bundle", "the zip has no \(name)") }
            guard let listedSha = (listed[name] as? [String: Any])?["sha256"] as? String else {
                throw ZnOtaError("bundle", "\(infoName) has no sha256 for \(name)")
            }
            let out = dest.appendingPathComponent(name)
            try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
            checked[name] = (size, try writeChecked(z, entry, to: out, name: name, size: size, listedSha: listedSha))
        }
        if ZnOtaFiles.bundleSha256(checked) != m.bundleSha256 || info.sha256 != m.bundleSha256 {
            throw ZnOtaError("bundle", "the bundle's files don't match the signed bundle SHA-256")
        }
        try infoData.write(to: dest.appendingPathComponent(infoName))
    }

    /// Writes [entry] to [out], stopped at [size] bytes; it must be exactly [size] bytes and match [listedSha].
    private static func writeChecked(_ z: ZnZip, _ entry: ZnZip.Entry, to out: URL, name: String, size: Int64,
                                     listedSha: String) throws -> String {
        FileManager.default.createFile(atPath: out.path, contents: nil)
        let h = try FileHandle(forWritingTo: out)
        defer { try? h.close() }
        var hasher = SHA256Stream()
        var written: Int64 = 0
        try z.read(entry, limit: size) { chunk in
            written += Int64(chunk.count)
            hasher.update(chunk)
            try h.write(contentsOf: chunk)
        }
        try h.synchronize()
        let sha = hasher.hex()
        if written != size { throw ZnOtaError("bundle", "\(name) is \(written) bytes, listed \(size)") }
        if sha != listedSha { throw ZnOtaError("bundle", "\(name) doesn't match its SHA-256") }
        return sha
    }
}

import CryptoKit

/// SHA-256 over parts, as hex.
struct SHA256Stream {
    private var h = SHA256()
    mutating func update(_ d: Data) { h.update(data: d) }
    func hex() -> String { ZnOtaFiles.hex(h.finalize()) }
}
