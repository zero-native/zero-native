// The plain rules of fetch on iOS (ZnFetch.swift), with no UIKit so the Mac tests build them (ios/tests/net):
// - ZnProgressThrottle: Android's ProgressThrottler (ZnFetch.kt), at most one progress event per 100 ms plus a last one.
// - ZnMultipart: a multipart/form-data body written to a file, laid out as OkHttp's MultipartBody (what Android sends):
//   file parts are copied from disk in small pieces, so a 200 MB video never enters memory; URLSession then uploads
//   the file (uploadTask fromFile) and knows its length.
// - znNetworkKey / znFlushReason: what counts as "another network" for the connection flush (Android: another default
//   Network), and when it flushes.
// Foundation and Network only.
import Foundation
import Network

/// At most one event per `minInterval`, then `finish` sends the final count once (unless it was the last one sent).
/// Not thread-safe: one per request, used on fetch's delegate queue only.
final class ZnProgressThrottle {
    private let minInterval: TimeInterval
    private let clock: () -> TimeInterval
    private let onEmit: (_ loaded: Int64, _ total: Int64) -> Void
    private var lastEmit = -Double.infinity
    private var lastLoaded: Int64 = -1

    init(minInterval: TimeInterval = 0.1, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         onEmit: @escaping (_ loaded: Int64, _ total: Int64) -> Void) {
        self.minInterval = minInterval
        self.clock = clock
        self.onEmit = onEmit
    }

    func update(_ loaded: Int64, _ total: Int64) {
        let now = clock()
        if now - lastEmit >= minInterval {
            lastEmit = now
            lastLoaded = loaded
            onEmit(loaded, total)
        }
    }

    func finish(_ loaded: Int64, _ total: Int64) {
        if lastLoaded != loaded {
            lastLoaded = loaded
            onEmit(loaded, total)
        }
    }
}

/// Why a form body could not be written. ZnFetch turns each into a reject code.
enum ZnMultipartError: Error, Equatable {
    /// The part is wrong (JS error): invalid_request.
    case invalid(String)
    /// The disk is full: failed.
    case noSpace(String)
    /// Any other write error: failed.
    case io(String)
    /// JS gave up while the body was written (the file is already removed).
    case cancelled

    var message: String {
        switch self {
        case .invalid(let m), .noSpace(let m), .io(let m): return m
        case .cancelled: return "cancelled"
        }
    }
}

enum ZnMultipart {
    /// The copy size: memory stays at about this much whatever the file's size.
    static let chunk = 256 * 1024

    /// Writes multipart/form-data for FormData parts — [name, value] for text, [name, file URL, file name, type] for a
    /// file — into `to` (made or replaced). Returns the body's length. The layout is OkHttp's: per part
    /// `--boundary`, Content-Disposition (name and filename with `"` CR LF escaped as %22 %0D %0A), Content-Type for a
    /// file (left out when it isn't a valid media type, as OkHttp's toMediaTypeOrNull), Content-Length, a blank line,
    /// the bytes, CRLF; then `--boundary--`. On any error or a cancel the file is removed.
    static func write(parts: [[Any]], boundary: String, to url: URL, isCancelled: () -> Bool = { false }) throws -> Int64 {
        let fm = FileManager.default
        try? fm.removeItem(at: url)
        guard fm.createFile(atPath: url.path, contents: nil) else {
            throw ZnMultipartError.io("can't make the upload file \(url.lastPathComponent) in \(url.deletingLastPathComponent().path)")
        }
        do {
            let out = try FileHandle(forWritingTo: url)
            defer { try? out.close() }
            var written: Int64 = 0
            func put(_ d: Data) throws {
                do {
                    try out.write(contentsOf: d)
                } catch {
                    throw outOfSpace(error) ? ZnMultipartError.noSpace("not enough free space on the phone to send this form (\(written + Int64(d.count)) bytes so far)")
                        : ZnMultipartError.io("can't write the form body: \(error.localizedDescription)")
                }
                written += Int64(d.count)
            }
            func put(_ s: String) throws { try put(Data(s.utf8)) }
            let dash = "--\(boundary)\r\n"
            for p in parts {
                guard let name = p.first as? String else { throw ZnMultipartError.invalid("a form part has no name") }
                if p.count == 2 {
                    let value = Data((p[1] as? String ?? "").utf8)
                    try put(dash + "Content-Disposition: form-data; name=\(quoted(name))\r\nContent-Length: \(value.count)\r\n\r\n")
                    try put(value)
                    try put("\r\n")
                    continue
                }
                let uri = p.count > 1 ? p[1] as? String ?? "" : ""
                let file = try fileURL(uri, part: name)
                let filename = p.count > 2 ? p[2] as? String ?? "file" : "file"
                let type = p.count > 3 ? p[3] as? String : nil
                // A file from the document picker needs this; for our own files it does nothing.
                let scoped = file.startAccessingSecurityScopedResource()
                defer { if scoped { file.stopAccessingSecurityScopedResource() } }
                // open(2), not FileHandle(forReadingFrom:): that one refuses a folder as "doesn't exist".
                let fd = open(file.path, O_RDONLY)
                guard fd >= 0 else {
                    throw ZnMultipartError.invalid("form part \"\(name)\": can't read \(file.path) (\(String(cString: strerror(errno))))")
                }
                let input = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
                defer { try? input.close() }
                // The size of what was opened (a symlink's target; no gap between looking and opening).
                var st = stat()
                guard fstat(input.fileDescriptor, &st) == 0 else {
                    throw ZnMultipartError.io("form part \"\(name)\": can't read the size of \(file.path) (\(String(cString: strerror(errno))))")
                }
                switch st.st_mode & S_IFMT {
                case S_IFREG: break
                case S_IFDIR: throw ZnMultipartError.invalid("form part \"\(name)\": \(file.path) is a folder, not a file")
                default: throw ZnMultipartError.invalid("form part \"\(name)\": \(file.path) is not a plain file")
                }
                let size = Int64(st.st_size)
                var head = dash + "Content-Disposition: form-data; name=\(quoted(name)); filename=\(quoted(filename))\r\n"
                if let type, isMediaType(type) { head += "Content-Type: \(type)\r\n" }
                head += "Content-Length: \(size)\r\n\r\n"
                try put(head)
                var copied: Int64 = 0
                while true {
                    if isCancelled() { throw ZnMultipartError.cancelled }
                    let piece: Data? = try autoreleasepool {
                        do {
                            return try input.read(upToCount: chunk)
                        } catch {
                            throw ZnMultipartError.io("form part \"\(name)\": reading \(file.lastPathComponent) failed: \(error.localizedDescription)")
                        }
                    }
                    guard let piece, !piece.isEmpty else { break }
                    try autoreleasepool { try put(piece) }
                    copied += Int64(piece.count)
                }
                // The Content-Length above must be true, or the server reads the rest of the body wrong.
                if copied != size {
                    throw ZnMultipartError.io("form part \"\(name)\": \(file.lastPathComponent) changed while it was read (\(size) bytes, then \(copied))")
                }
                try put("\r\n")
            }
            try put("--\(boundary)--\r\n")
            if isCancelled() { throw ZnMultipartError.cancelled }
            return written
        } catch {
            try? fm.removeItem(at: url)
            if let e = error as? ZnMultipartError { throw e }
            throw ZnMultipartError.io("can't write the form body: \(error.localizedDescription)")
        }
    }

    /// A part's file: a file:// URL. content:// is Android's ContentResolver, which iOS has no equivalent of.
    static func fileURL(_ uri: String, part name: String) throws -> URL {
        let lower = uri.lowercased()
        if lower.hasPrefix("content://") {
            throw ZnMultipartError.invalid("form part \"\(name)\": content:// is an Android content URI; on iOS pass the file:// uri the plugin gave")
        }
        guard lower.hasPrefix("file://") else {
            throw ZnMultipartError.invalid("form part \"\(name)\": needs a file:// uri on iOS, got \"\(uri)\"")
        }
        if let u = URL(string: uri), u.isFileURL, !u.path.isEmpty { return u }
        // Not percent-encoded (a space in the path): take the path as it is, like Android's lenient Uri.parse.
        let path = String(uri.dropFirst("file://".count))
        guard path.hasPrefix("/") else { throw ZnMultipartError.invalid("form part \"\(name)\": \"\(uri)\" is not a file:// path") }
        return URL(fileURLWithPath: path)
    }

    /// `"value"` with `"`, CR and LF escaped as OkHttp's MultipartBody does, so a file name can't add part headers.
    static func quoted(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\n": out += "%0A"
            case "\r": out += "%0D"
            case "\"": out += "%22"
            default: out.unicodeScalars.append(ch)
            }
        }
        return out + "\""
    }

    /// `type/subtype` with optional parameters, printable ASCII only (roughly what OkHttp's toMediaTypeOrNull takes).
    static func isMediaType(_ s: String) -> Bool {
        guard !s.isEmpty, s.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7e }) else { return false }
        let token = "[A-Za-z0-9!#$%&'*+.^_`|~-]+"
        return s.range(of: "^\(token)/\(token)\\s*(;.*)?$", options: .regularExpression) != nil
    }

    static func outOfSpace(_ e: Error) -> Bool {
        let ns = e as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError { return true }
        if ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOSPC) { return true }
        if let under = ns.userInfo[NSUnderlyingErrorKey] as? Error { return outOfSpace(under) }
        return false
    }
}

/// The network fetch's connections belong to, from a path: its first interface that is not a tunnel (a VPN's utun is
/// "other"; under a VPN, Wi-Fi to cellular is still a change) and its IPv4 gateways (another Wi-Fi keeps the name en0
/// but gets another router), or its IPv6 gateways when it has no IPv4 one (an IPv6 router advertisement arriving on
/// the same Wi-Fi is not a change); "offline" when the path doesn't work.
func znNetworkKey(_ p: NWPath) -> String {
    func kind(_ t: NWInterface.InterfaceType) -> String {
        switch t {
        case .wifi: return "wifi"
        case .cellular: return "cellular"
        case .wiredEthernet: return "ethernet"
        case .loopback: return "loopback"
        case .other: return "other"
        @unknown default: return "other"
        }
    }
    var v4: [String] = [], v6: [String] = []
    for g in p.gateways {
        guard case .hostPort(let host, _) = g else { continue }
        switch host {
        case .ipv4(let a): v4.append("\(a)")
        case .ipv6(let a): v6.append("\(a)")
        default: break
        }
    }
    return znNetworkKey(satisfied: p.status == .satisfied, interfaces: p.availableInterfaces.map { (kind($0.type), $0.name) },
                        ipv4Gateways: v4, ipv6Gateways: v6)
}

/// znNetworkKey's rule on plain values (the Mac tests). A change of key means the pooled connections may be dead.
func znNetworkKey(satisfied: Bool, interfaces: [(type: String, name: String)], ipv4Gateways: [String],
                  ipv6Gateways: [String]) -> String {
    guard satisfied else { return "offline" }
    let first = interfaces.first { $0.type != "other" && $0.type != "loopback" } ?? interfaces.first
    let gateways = ipv4Gateways.isEmpty ? ipv6Gateways : ipv4Gateways
    return "\(first.map { "\($0.type)-\($0.name)" } ?? "none")|\(gateways.sorted().joined(separator: ","))"
}

/// Whether going from network key `before` to `after` flushes the pool, and why; as Android's default-network
/// callback (ZnFetch.kt watchNetwork): no flush for the first path, a flush when the network is lost or another one
/// takes over, and none when a network comes back after "offline" (the loss already flushed).
func znFlushReason(before: String?, after: String) -> String? {
    guard let before, before != after else { return nil }
    if after == "offline" { return "the network was lost" }
    if before == "offline" { return nil }
    return "the default network changed"
}
