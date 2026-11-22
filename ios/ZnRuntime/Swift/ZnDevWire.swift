// `zn dev`'s wire format and its build folders, for ZnDev.swift (debug builds only). Foundation only, so the Mac suite
// (ios/tests/dev) checks it against the frames tools/zn-dev.ts writes.
//
// Both ways: u32 length (big endian, counting the type byte), then u8 type and the body. The same list as Android's
// ZnDev.kt and tools/zn-dev.ts.
#if DEBUG
import Foundation

enum ZnDevWire {
    // Server → phone
    static let build: UInt8 = 1  // u32 header length, header JSON {asset, hash, templates, manifest, hbc}, then bytes
    static let buildFailed: UInt8 = 2  // JSON {message}
    static let errorMapped: UInt8 = 3  // JSON {id, text}
    // Phone → server
    static let hello: UInt8 = 10  // JSON {device, hash, os, bytecode}
    static let error: UInt8 = 11  // JSON {id, text}
    static let reload: UInt8 = 12  // JSON {}: send the current build again

    /// The largest frame taken (a build is a few MB): anything bigger is a broken stream.
    static let maxFrame = 256 << 20

    /// One frame: length, type, body.
    static func frame(_ type: UInt8, _ body: Data) -> Data {
        var out = Data(capacity: 5 + body.count)
        let n = UInt32(body.count + 1)
        out.append(contentsOf: [UInt8(n >> 24), UInt8((n >> 16) & 0xFF), UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF), type])
        out.append(body)
        return out
    }

    static func frame(_ type: UInt8, json: [String: Any]) -> Data {
        frame(type, (try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])) ?? Data("{}".utf8))
    }

    /// A frame's first 5 bytes: the body's length (without the type byte) and the type; nil when it can't be a frame.
    static func head(_ five: Data) -> (body: Int, type: UInt8)? {
        guard five.count == 5 else { return nil }
        let b = [UInt8](five)
        let n = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
        guard n >= 1, n <= maxFrame else { return nil }
        return (n - 1, b[4])
    }

    /// A BUILD frame's body, in its parts.
    struct Build {
        let asset: String
        let hash: String
        let templates: Data
        let manifest: Data
        let hbc: Data
    }

    struct BadFrame: Error, CustomStringConvertible {
        let description: String
    }

    static func parseBuild(_ body: Data) throws -> Build {
        let b = [UInt8](body)
        guard b.count >= 4 else { throw BadFrame(description: "a build frame shorter than its header length") }
        let headerLength = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
        guard 4 + headerLength <= b.count,
              let header = try JSONSerialization.jsonObject(with: Data(b[4 ..< 4 + headerLength])) as? [String: Any],
              let asset = header["asset"] as? String, let hash = header["hash"] as? String,
              let t = (header["templates"] as? NSNumber)?.intValue, let m = (header["manifest"] as? NSNumber)?.intValue,
              let h = (header["hbc"] as? NSNumber)?.intValue, t >= 0, m >= 0, h >= 0 else {
            throw BadFrame(description: "a build frame with a bad header")
        }
        var at = 4 + headerLength
        guard at + t + m + h == b.count else {
            throw BadFrame(description: "a build frame of \(b.count) bytes, its header says \(at + t + m + h)")
        }
        func take(_ n: Int) -> Data {
            defer { at += n }
            return Data(b[at ..< at + n])
        }
        return Build(asset: asset, hash: hash, templates: take(t), manifest: take(m), hbc: take(h))
    }

    /// A hash as a folder name: hex and dashes only (the server sends a sha1).
    static func folderName(_ hash: String) -> String? {
        let ok = !hash.isEmpty && hash.count <= 80 && hash.allSatisfy { $0.isASCII && ($0.isHexDigit || $0 == "-") }
        return ok ? hash : nil
    }

    /// Writes [build] as a bundle folder ZnApp runs (main.zn.ui, main.zn.ui.json, main.hbc) in [root]/<hash>: written
    /// in <hash>.tmp, then moved, so a half-written folder never runs. Other build folders go, except [keep] (the one
    /// running now: its JS file is mapped). Returns the folder.
    static func write(_ build: Build, in root: URL, keep: URL?) throws -> URL {
        guard let name = folderName(build.hash) else { throw BadFrame(description: "a build with a bad hash \(build.hash)") }
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let dir = root.appendingPathComponent(name, isDirectory: true)
        let tmp = root.appendingPathComponent(name + ".tmp", isDirectory: true)
        try? fm.removeItem(at: tmp)
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        // ZnApp reads these three names; the server's asset name is main.zn.ui too.
        try build.templates.write(to: tmp.appendingPathComponent("main.zn.ui"))
        try build.manifest.write(to: tmp.appendingPathComponent("main.zn.ui.json"))
        try build.hbc.write(to: tmp.appendingPathComponent("main.hbc"))
        if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
        try fm.moveItem(at: tmp, to: dir)
        let keepNames = Set([name, keep?.lastPathComponent].compactMap { $0 })
        for old in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where !keepNames.contains(old) {
            try? fm.removeItem(at: root.appendingPathComponent(old))
        }
        return dir
    }
}
#endif
