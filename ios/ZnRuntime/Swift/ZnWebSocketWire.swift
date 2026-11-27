// The WebSocket wire format (RFC 6455) for ZnWebSocket: the handshake we send and the check of the server's answer,
// our frames (masked, as a client must), and a reader that turns the server's bytes into messages. Foundation and
// CryptoKit only, so the Mac tests (ios/tests/websocket) build it with no simulator.
//
// Why our own and not URLSessionWebSocketTask: when the server's 101, its first frames, its close and the TCP FIN
// reach the phone in one read (a server that closes in its open handler, on Wi-Fi), URLSession drops everything after
// the 101 and fails with ENODATA ("No message available on STREAM"): JS got close 1006 instead of the server's code,
// and none of the messages (Pavan's iPhone 11, 2026-11-27; on the Mac with the test server's /ws-closenow too).
import CryptoKit
import Foundation

enum ZnWsWire {
    /// Biggest handshake answer we read (status line and headers); OkHttp has no fixed cap, real ones are < 1 KB.
    static let maxHeadSize = 64 * 1024

    /// A fresh Sec-WebSocket-Key: 16 random bytes, base64.
    static func newKey() -> String {
        var g = SystemRandomNumberGenerator()
        return Data((0..<16).map { _ in UInt8.random(in: 0...255, using: &g) }).base64EncodedString()
    }

    /// The Sec-WebSocket-Accept a server must answer for [key].
    static func accept(_ key: String) -> String {
        Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    }

    /// Host and port to connect to, and TLS, for a ws:// or wss:// URL. Nil for anything else.
    static func target(_ url: URL) -> (host: String, port: Int, tls: Bool)? {
        guard let scheme = url.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
              let host = url.host, !host.isEmpty else { return nil }
        let tls = scheme == "wss"
        return (host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), url.port ?? (tls ? 443 : 80), tls)
    }

    /// The handshake request. No cookies, no Origin (as OkHttp).
    static func request(_ url: URL, key: String, protocols: [String], userAgent: String) -> Data {
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = c?.percentEncodedPath ?? "/"
        if path.isEmpty { path = "/" }
        if let q = c?.percentEncodedQuery { path += "?" + q }
        let t = target(url)
        var host = t?.host ?? ""
        if host.contains(":") { host = "[\(host)]" }  // an IPv6 address
        if let t, t.port != (t.tls ? 443 : 80) { host += ":\(t.port)" }
        var lines = [
            "GET \(path) HTTP/1.1", "Host: \(host)", "Upgrade: websocket", "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)", "Sec-WebSocket-Version: 13", "User-Agent: \(userAgent)",
        ]
        if !protocols.isEmpty { lines.append("Sec-WebSocket-Protocol: \(protocols.joined(separator: ", "))") }
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    /// Where the answer's head ends (just past the blank line) in [bytes], or nil when it hasn't all come yet.
    static func headEnd(_ bytes: [UInt8]) -> Int? {
        guard bytes.count >= 4 else { return nil }
        for i in 0...(bytes.count - 4) where bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10 {
            return i + 4
        }
        return nil
    }

    struct Answer {
        var status: Int
        /// The server's reason phrase ("Not Found").
        var reason: String
        /// Header names in lower case; a header sent twice keeps the last value.
        var headers: [String: String]
    }

    /// Reads the answer's head (status line and headers, without the blank line or with it).
    static func parseAnswer(_ head: [UInt8]) -> Answer? {
        let text = String(decoding: head, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let status = lines.removeFirst().split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
        guard status.count >= 2, status[0].hasPrefix("HTTP/"), let code = Int(status[1]) else { return nil }
        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] =
                line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        return Answer(status: code, reason: status.count > 2 ? String(status[2]) : "", headers: headers)
    }

    /// The protocol the server chose ("" for none), or the error JS gets. The messages are OkHttp's.
    static func check(_ a: Answer, key: String, offered: [String]) -> Result<String, ZnWsFailure> {
        guard a.status == 101 else {
            return .failure(ZnWsFailure("Expected HTTP 101 response but was '\(a.status) \(a.reason)'"))
        }
        let upgrade = a.headers["upgrade"] ?? "null", connection = a.headers["connection"] ?? "null"
        guard upgrade.lowercased() == "websocket" else {
            return .failure(ZnWsFailure("Expected 'Upgrade' header value 'websocket' but was '\(upgrade)'"))
        }
        guard connection.lowercased().split(separator: ",").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "upgrade" }) else {
            return .failure(ZnWsFailure("Expected 'Connection' header value 'Upgrade' but was '\(connection)'"))
        }
        let want = accept(key), got = a.headers["sec-websocket-accept"] ?? "null"
        guard got == want else {
            return .failure(ZnWsFailure("Expected 'Sec-WebSocket-Accept' header value '\(want)' but was '\(got)'"))
        }
        let proto = a.headers["sec-websocket-protocol"] ?? ""
        // RFC 6455 §4.1: a protocol we didn't offer fails the connection (browsers do too).
        guard proto.isEmpty || offered.contains(proto) else {
            return .failure(ZnWsFailure("The server chose the protocol '\(proto)', which was not offered"))
        }
        // We offer no extensions, so the server may not use any (RFC 6455 §4.1).
        if let ext = a.headers["sec-websocket-extensions"], !ext.isEmpty {
            return .failure(ZnWsFailure("The server used the extension '\(ext)', which was not offered"))
        }
        return .success(proto)
    }

    static let opText: UInt8 = 0x1, opBinary: UInt8 = 0x2, opClose: UInt8 = 0x8, opPing: UInt8 = 0x9, opPong: UInt8 = 0xA

    /// One whole frame from us (FIN set), masked with [mask] (a fresh random one per frame, RFC 6455 §5.3).
    static func frame(_ op: UInt8, _ payload: Data, mask: UInt32 = UInt32.random(in: 0...UInt32.max)) -> Data {
        let n = payload.count
        var out = Data(capacity: n + 14)
        out.append(0x80 | op)
        if n < 126 {
            out.append(0x80 | UInt8(n))
        } else if n <= 0xFFFF {
            out.append(0x80 | 126)
            out.append(UInt8(n >> 8)); out.append(UInt8(n & 0xFF))
        } else {
            out.append(0x80 | 127)
            for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((UInt64(n) >> UInt64(shift)) & 0xFF)) }
        }
        let m = [UInt8(mask >> 24), UInt8((mask >> 16) & 0xFF), UInt8((mask >> 8) & 0xFF), UInt8(mask & 0xFF)]
        out.append(contentsOf: m)
        let start = out.count
        out.append(payload)
        out.withUnsafeMutableBytes { raw in
            let p = raw.bindMemory(to: UInt8.self)
            for i in 0..<n { p[start + i] ^= m[i & 3] }
        }
        return out
    }

    /// A close frame's payload: the code, then the reason (at most 123 bytes, checked by the caller).
    static func closePayload(_ code: Int?, _ reason: String) -> Data {
        guard let code else { return Data() }
        var d = Data([UInt8((code >> 8) & 0xFF), UInt8(code & 0xFF)])
        d.append(Data(reason.utf8))
        return d
    }
}

/// Why a socket failed: the text JS gets in its error event (and the 1006 close's reason).
struct ZnWsFailure: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

/// What the server sent, one whole message (or control frame) at a time.
enum ZnWsEvent: Equatable {
    case text(String)
    /// A binary message, at its first frame (v1 refuses them; its bytes are skipped, not kept).
    case binary
    /// A text message over the size limit in UTF-8 bytes, as soon as a frame header says so. Its bytes are skipped.
    case tooBig
    case ping(Data)
    case pong
    /// The server's close frame: its code (nil when it sent none: JS gets 1005) and reason.
    case close(Int?, String)
}

/// Turns the server's bytes into events, in order. Feed it each read as it comes; nothing is lost when the last read
/// also ended the connection. A protocol error stops it (the caller fails the socket with 1002).
struct ZnWsReader {
    let maxMessage: Int
    private var buf: [UInt8] = []
    private var at = 0
    /// The text message being put together from its frames, and its bytes so far.
    private var messageOp: UInt8?
    private var message: [UInt8] = []
    /// Bytes still to skip of a frame we dropped (too big), and whether its message's frames are still coming.
    private var skipping = 0
    private var droppingMessage = false
    /// The close frame came: nothing after it is read (RFC 6455 §5.5.1).
    private(set) var closed = false

    init(maxMessage: Int) { self.maxMessage = maxMessage }

    mutating func feed<S: Sequence>(_ bytes: S) where S.Element == UInt8 {
        if at > 0 && at >= buf.count / 2 { buf.removeFirst(at); at = 0 }
        buf.append(contentsOf: bytes)
    }

    /// The next event, nil when more bytes are needed.
    mutating func next() throws -> ZnWsEvent? {
        while !closed {
            if skipping > 0 {
                let n = min(skipping, buf.count - at)
                at += n; skipping -= n
                if skipping > 0 { return nil }
            }
            let avail = buf.count - at
            guard avail >= 2 else { return nil }
            let b0 = buf[at], b1 = buf[at + 1]
            let fin = b0 & 0x80 != 0, op = b0 & 0x0F
            guard b0 & 0x70 == 0 else { throw ZnWsFailure("Unexpected rsv bits set in a frame from the server") }
            guard b1 & 0x80 == 0 else { throw ZnWsFailure("Server-sent frames must not be masked") }
            var len = Int(b1 & 0x7F), head = 2
            if len == 126 {
                guard avail >= 4 else { return nil }
                len = Int(buf[at + 2]) << 8 | Int(buf[at + 3]); head = 4
            } else if len == 127 {
                guard avail >= 10 else { return nil }
                var v: UInt64 = 0
                for i in 0..<8 { v = v << 8 | UInt64(buf[at + 2 + i]) }
                guard v <= UInt64(Int32.max) else { throw ZnWsFailure("Frame length \(v) is too big") }
                len = Int(v); head = 10
            }
            let control = op & 0x8 != 0
            if control {
                guard fin, len <= 125 else { throw ZnWsFailure("Control frames must be final and at most 125 bytes") }
                guard avail >= head + len else { return nil }
                let payload = Array(buf[(at + head)..<(at + head + len)])
                at += head + len
                switch op {
                case ZnWsWire.opPing: return .ping(Data(payload))
                case ZnWsWire.opPong: return .pong
                case ZnWsWire.opClose:
                    closed = true
                    if payload.isEmpty { return .close(nil, "") }
                    guard payload.count >= 2 else { throw ZnWsFailure("A close frame with a 1-byte payload") }
                    return .close(Int(payload[0]) << 8 | Int(payload[1]), String(decoding: payload[2...], as: UTF8.self))
                default: throw ZnWsFailure("Unknown control opcode: \(op)")
                }
            }
            // A data frame: the first of a message (text or binary) or a continuation.
            switch op {
            case 0:
                guard messageOp != nil || droppingMessage else { throw ZnWsFailure("A continuation frame with no message to continue") }
            case ZnWsWire.opText, ZnWsWire.opBinary:
                guard messageOp == nil && !droppingMessage else { throw ZnWsFailure("A new message before the last one ended") }
            default: throw ZnWsFailure("Unknown opcode: \(op)")
            }
            if droppingMessage {
                // The rest of a message we already reported as too big: skip it.
                at += head; skipping = len
                if fin { droppingMessage = false }
                continue
            }
            if op == ZnWsWire.opBinary {
                // Refused at its first frame, whatever its size: its bytes are skipped as they come.
                at += head; skipping = len
                droppingMessage = !fin
                return .binary
            }
            if (op == 0 ? message.count : 0) + len > maxMessage {
                // Never kept: reported at once, its bytes skipped as they come.
                at += head; skipping = len
                messageOp = nil; message = []
                droppingMessage = !fin
                return .tooBig
            }
            // Nothing changes until the whole frame is here (the next call reads this header again).
            guard avail >= head + len else { return nil }
            if op != 0 { messageOp = op; message = [] }
            message.append(contentsOf: buf[(at + head)..<(at + head + len)])
            at += head + len
            guard fin else { continue }
            messageOp = nil
            defer { message = [] }
            // Not valid UTF-8: replaced with U+FFFD, as OkHttp's readUtf8 does.
            return .text(String(decoding: message, as: UTF8.self))
        }
        return nil
    }
}
