// ZnWebSocket's wire format and connection on the Mac (ZnWebSocketWire.swift, ZnWebSocketConnection.swift):
// tools/ios-unit-test.ts builds this with sources.txt. First the plain rules (handshake, our frames, the reader), then
// real sockets against a small server in this program on 127.0.0.1, among them the case that broke on Pavan's iPhone
// (2026-11-27): the server's 101, 50 messages, its close 4001 and the TCP FIN in one TCP segment. URLSession's
// WebSocket task lost all of it there (ENODATA, close 1006, 0 messages); ours must get every message, in order, and
// the close with its code. The same case through URLSessionWebSocketTask is printed for the record (not checked: it
// is a race, lost in about half the runs on this Mac).
import Darwin
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

/// Everything the reader gives for [bytes], fed [chunk] bytes at a time; the failure's text when it throws.
func events(_ bytes: [UInt8], chunk: Int = .max, max: Int = 1_048_576) -> ([ZnWsEvent], String?) {
    var r = ZnWsReader(maxMessage: max)
    var out: [ZnWsEvent] = []
    var at = 0
    repeat {
        let end = Swift.min(bytes.count, at + Swift.max(1, chunk == .max ? bytes.count : chunk))
        r.feed(bytes[at..<end])
        at = end
        do {
            while let e = try r.next() { out.append(e) }
        } catch let f as ZnWsFailure {
            return (out, f.message)
        } catch {
            return (out, "\(error)")
        }
    } while at < bytes.count
    return (out, nil)
}

/// A frame as a server sends it (never masked).
func serverFrame(_ op: UInt8, _ payload: [UInt8], fin: Bool = true) -> [UInt8] {
    var out: [UInt8] = [(fin ? 0x80 : 0) | op]
    let n = payload.count
    if n < 126 { out.append(UInt8(n)) } else if n <= 0xFFFF { out += [126, UInt8(n >> 8), UInt8(n & 0xFF)] } else {
        out.append(127)
        for s in stride(from: 56, through: 0, by: -8) { out.append(UInt8((UInt64(n) >> UInt64(s)) & 0xFF)) }
    }
    return out + payload
}
func text(_ s: String, fin: Bool = true) -> [UInt8] { serverFrame(0x1, Array(s.utf8), fin: fin) }
func closeFrame(_ code: Int, _ reason: String) -> [UInt8] { serverFrame(0x8, [UInt8(code >> 8), UInt8(code & 0xFF)] + Array(reason.utf8)) }

// MARK: The handshake

check("accept: RFC 6455's example", ZnWsWire.accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
check("key: 16 bytes", Data(base64Encoded: ZnWsWire.newKey())?.count, 16)
check("keys differ", ZnWsWire.newKey() == ZnWsWire.newKey(), false)
do {
    let req = String(decoding: ZnWsWire.request(URL(string: "ws://example.com:8788/ws?burst=5&x=%20")!, key: "K",
                                                protocols: ["chat", "v2"], userAgent: "UA/1"), as: UTF8.self)
    check("request", req, "GET /ws?burst=5&x=%20 HTTP/1.1\r\nHost: example.com:8788\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        + "Sec-WebSocket-Key: K\r\nSec-WebSocket-Version: 13\r\nUser-Agent: UA/1\r\nSec-WebSocket-Protocol: chat, v2\r\n\r\n")
    let plain = String(decoding: ZnWsWire.request(URL(string: "wss://echo.example")!, key: "K", protocols: [], userAgent: "UA"), as: UTF8.self)
    check("request: no path, default port, no protocols", plain.hasPrefix("GET / HTTP/1.1\r\nHost: echo.example\r\n"), true)
    check("request: no protocol header", plain.contains("Sec-WebSocket-Protocol"), false)
    let v6 = String(decoding: ZnWsWire.request(URL(string: "ws://[::1]:9000/a")!, key: "K", protocols: [], userAgent: "UA"), as: UTF8.self)
    check("request: IPv6 host", v6.contains("Host: [::1]:9000\r\n"), true)
    check("target: ws", ZnWsWire.target(URL(string: "ws://h/x")!).map { "\($0.host):\($0.port):\($0.tls)" }, "h:80:false")
    check("target: wss", ZnWsWire.target(URL(string: "wss://h/x")!).map { "\($0.host):\($0.port):\($0.tls)" }, "h:443:true")
    check("target: IPv6", ZnWsWire.target(URL(string: "ws://[::1]:9/")!).map { "\($0.host):\($0.port)" }, "::1:9")
    check("target: http refused", ZnWsWire.target(URL(string: "http://h/")!) == nil, true)
}
do {
    let key = "dGhlIHNhbXBsZSBub25jZQ=="
    func answer(_ s: String) -> Result<String, ZnWsFailure>? {
        let bytes = Array(s.utf8)
        guard let end = ZnWsWire.headEnd(bytes), let a = ZnWsWire.parseAnswer(Array(bytes[..<end])) else { return nil }
        return ZnWsWire.check(a, key: key, offered: ["chat"])
    }
    let ok = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
    check("answer: 101", answer(ok + "\r\n"), .success(""))
    check("answer: chosen protocol", answer(ok + "Sec-WebSocket-Protocol: chat\r\n\r\n"), .success("chat"))
    check("answer: header case and spaces", answer("HTTP/1.1 101 OK\r\nupgrade:WebSocket\r\nCONNECTION: keep-alive, Upgrade\r\nsec-websocket-accept:  s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"), .success(""))
    check("answer: 404 with the server's phrase", answer("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
          .failure(ZnWsFailure("Expected HTTP 101 response but was '404 Not Found'")))
    check("answer: wrong accept", answer("HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: nope\r\n\r\n"),
          .failure(ZnWsFailure("Expected 'Sec-WebSocket-Accept' header value 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' but was 'nope'")))
    check("answer: no Upgrade", answer("HTTP/1.1 101 OK\r\nConnection: Upgrade\r\n\r\n"),
          .failure(ZnWsFailure("Expected 'Upgrade' header value 'websocket' but was 'null'")))
    check("answer: a protocol not offered", answer(ok + "Sec-WebSocket-Protocol: other\r\n\r\n"),
          .failure(ZnWsFailure("The server chose the protocol 'other', which was not offered")))
    check("answer: an extension not offered", answer(ok + "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n"),
          .failure(ZnWsFailure("The server used the extension 'permessage-deflate', which was not offered")))
    check("head end: not yet", ZnWsWire.headEnd(Array("HTTP/1.1 101 OK\r\n".utf8)), nil)
    check("head end: with frames after it", ZnWsWire.headEnd(Array("HTTP/1.1 101 OK\r\n\r\n".utf8) + [0x81, 0x00]), 19)
}

// MARK: Our frames

do {
    let f = [UInt8](ZnWsWire.frame(ZnWsWire.opText, Data("Hello".utf8), mask: 0x37FA213D))
    check("frame: RFC 6455's masked Hello", f, [0x81, 0x85, 0x37, 0xFA, 0x21, 0x3D, 0x7F, 0x9F, 0x4D, 0x51, 0x58])
    let mid = [UInt8](ZnWsWire.frame(ZnWsWire.opText, Data(count: 300), mask: 0))
    check("frame: 16-bit length", Array(mid[0..<4]), [0x81, 0xFE, 0x01, 0x2C])
    check("frame: 16-bit length size", mid.count, 4 + 4 + 300)
    let big = [UInt8](ZnWsWire.frame(ZnWsWire.opText, Data(count: 70_000), mask: 0))
    check("frame: 64-bit length", Array(big[0..<10]), [0x81, 0xFF, 0, 0, 0, 0, 0, 0x01, 0x11, 0x70])
    check("frame: close payload", [UInt8](ZnWsWire.closePayload(4321, "later")), [0x10, 0xE1] + Array("later".utf8))
    check("frame: close with no code", ZnWsWire.closePayload(nil, "").count, 0)
    let ping = [UInt8](ZnWsWire.frame(ZnWsWire.opPing, Data(), mask: 1))
    check("frame: empty ping", ping, [0x89, 0x80, 0, 0, 0, 1])
}

// MARK: The reader

do {
    let stream = text("0") + text("1") + closeFrame(4001, "bye")
    let want: [ZnWsEvent] = [.text("0"), .text("1"), .close(4001, "bye")]
    check("reader: messages then close", events(stream).0, want)
    check("reader: a byte at a time", events(stream, chunk: 1).0, want)
    check("reader: nothing after the close", events(stream + text("late")).0, want)
    check("reader: fragments", events(text("नम", fin: false) + serverFrame(0, Array("स्ते".utf8))).0, [.text("नमस्ते")])
    check("reader: ping between fragments", events(text("a", fin: false) + serverFrame(0x9, [7]) + serverFrame(0, Array("b".utf8))).0,
          [.ping(Data([7])), .text("ab")])
    check("reader: pong", events(serverFrame(0xA, [])).0, [.pong])
    check("reader: close with no code", events(serverFrame(0x8, [])).0, [.close(nil, "")])
    check("reader: 1-byte close", events(serverFrame(0x8, [3])).1, "A close frame with a 1-byte payload")
    check("reader: binary at its first frame", events(serverFrame(0x2, [1, 2, 3]) + text("x")).0, [.binary, .text("x")])
    check("reader: fragmented binary skipped", events(serverFrame(0x2, [1], fin: false) + serverFrame(0, [2]) + text("x")).0, [.binary, .text("x")])
    check("reader: masked server frame", events([0x81, 0x80, 0, 0, 0, 0]).1, "Server-sent frames must not be masked")
    check("reader: rsv bits", events([0xC1, 0x00]).1, "Unexpected rsv bits set in a frame from the server")
    check("reader: stray continuation", events(serverFrame(0, [1])).1, "A continuation frame with no message to continue")
    check("reader: new message inside one", events(text("a", fin: false) + text("b")).1, "A new message before the last one ended")
    check("reader: long control frame", events(serverFrame(0x9, [UInt8](repeating: 0, count: 126))).1,
          "Control frames must be final and at most 125 bytes")
    check("reader: unknown opcode", events(serverFrame(0x3, [])).1, "Unknown opcode: 3")
    check("reader: bad UTF-8 replaced", events(serverFrame(0x1, [0x61, 0xFF])).0, [.text("a\u{FFFD}")])
    // The 1 MB rule counts UTF-8 bytes; past it the message is skipped (never kept), and what follows still comes.
    let exact = String(repeating: "x", count: 1_048_576)
    check("reader: exactly 1 MB", events(text(exact)).0, [.text(exact)])
    let over = text(String(repeating: "é", count: 524_289)) + closeFrame(1009, "")
    check("reader: 1 MB + 2 of é, then the close", events(over, chunk: 65_536).0, [.tooBig, .close(1009, "")])
    check("reader: too big across fragments", events(text(String(repeating: "x", count: 1_000_000), fin: false)
        + serverFrame(0, [UInt8](repeating: 0x78, count: 100_000), fin: false) + serverFrame(0, [0x78]) + text("next")).0, [.tooBig, .text("next")])
    check("reader: small cap", events(text("abcd"), max: 3).0, [.tooBig])
}

// MARK: Real sockets

/// A tiny WebSocket server on 127.0.0.1 for these checks, one thread per connection. By path:
/// /closenow: the 101, "0" to "49", close 4001 "bye" and the FIN in one TCP segment (TCP_NOPUSH), then it reads what
///   the client answers (kept in `answers`); /echo: echoes text, answers pings and a close (with the same code).
final class TestServer {
    let fd: Int32
    let port: UInt16
    private let lock = NSLock()
    private var answersValue: [String] = []
    var answers: [String] { lock.withLock { answersValue } }

    init() {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        self.fd = fd
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(fd, 128)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        port = UInt16(bigEndian: addr.sin_port)
        Thread.detachNewThread { [self] in
            while true {
                let fd = self.fd
                let c = accept(fd, nil, nil)
                if c < 0 { return }
                Thread.detachNewThread { self.serve(c) }
            }
        }
    }

    private func readSome(_ c: Int32) -> [UInt8]? {
        var b = [UInt8](repeating: 0, count: 65_536)
        let n = read(c, &b, b.count)
        return n > 0 ? Array(b[0..<n]) : nil
    }

    private func writeAll(_ c: Int32, _ bytes: [UInt8]) {
        var at = 0
        while at < bytes.count {
            let n = bytes[at...].withUnsafeBufferPointer { write(c, $0.baseAddress, $0.count) }
            if n <= 0 { return }
            at += n
        }
    }

    /// The client's frames (masked) in [buf] from [at]: (opcode, payload, bytes used), nil when not all here.
    private func clientFrame(_ buf: [UInt8]) -> (UInt8, [UInt8], Int)? {
        guard buf.count >= 2 else { return nil }
        var len = Int(buf[1] & 0x7F), at = 2
        if len == 126 { guard buf.count >= 4 else { return nil }; len = Int(buf[2]) << 8 | Int(buf[3]); at = 4 }
        if len == 127 { guard buf.count >= 10 else { return nil }; len = 0; for i in 2..<10 { len = len << 8 | Int(buf[i]) }; at = 10 }
        guard buf.count >= at + 4 + len else { return nil }
        let mask = Array(buf[at..<(at + 4)])
        let payload = (0..<len).map { buf[at + 4 + $0] ^ mask[$0 & 3] }
        return (buf[0] & 0x0F, payload, at + 4 + len)
    }

    private func serve(_ c: Int32) {
        defer { close(c) }
        var data: [UInt8] = []
        while ZnWsWire.headEnd(data) == nil {
            guard let more = readSome(c) else { return }
            data += more
        }
        let end = ZnWsWire.headEnd(data)!
        let head = String(decoding: data[..<end], as: UTF8.self)
        data = Array(data[end...])
        let path = head.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        let key = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }?
            .split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? ""
        let hello = Array("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(ZnWsWire.accept(key))\r\n\r\n".utf8)
        if path.hasPrefix("/closenow") {
            var on: Int32 = 1
            setsockopt(c, IPPROTO_TCP, TCP_NOPUSH, &on, socklen_t(MemoryLayout<Int32>.size))
            writeAll(c, hello + (0..<50).flatMap { text(String($0)) } + closeFrame(4001, "bye"))
            shutdown(c, SHUT_WR)  // pushes the held bytes out with the FIN
            while let more = readSome(c) {
                data += more
                if let (op, payload, _) = clientFrame(data), op == 0x8 {
                    let code = payload.count >= 2 ? Int(payload[0]) << 8 | Int(payload[1]) : 1005
                    lock.withLock { answersValue.append("close \(code)") }
                    return
                }
            }
            return
        }
        writeAll(c, hello)
        while true {
            while let (op, payload, used) = clientFrame(data) {
                data.removeFirst(used)
                switch op {
                case 0x1: writeAll(c, serverFrame(0x1, payload))
                case 0x9: writeAll(c, serverFrame(0xA, payload))
                case 0x8:
                    writeAll(c, serverFrame(0x8, Array(payload.prefix(2))))
                    shutdown(c, SHUT_WR)
                    while readSome(c) != nil {}
                    return
                default: break
                }
            }
            guard let more = readSome(c) else { return }
            data += more
        }
    }
}

/// What a connection reported, as one line per event ("open", "text 0", "close 4001 bye", "end nil").
final class Seen {
    private let lock = NSLock()
    private var list: [String] = []
    let done = DispatchSemaphore(value: 0)
    func add(_ s: String, last: Bool = false) {
        lock.withLock { list.append(s) }
        if last { done.signal() }
    }
    var lines: [String] { lock.withLock { list } }
}

let server = TestServer()
let queue = DispatchQueue(label: "ws-test")

/// Opens a connection to [path], runs [then] on open, and waits for its close frame or its end.
func run(_ path: String, wait: Double = 5, _ then: @escaping (ZnWsConnection) -> Void = { _ in }) -> [String] {
    let seen = Seen()
    let conn = ZnWsConnection(url: URL(string: "ws://127.0.0.1:\(server.port)\(path)")!, protocols: [], userAgent: "zn-test",
                              maxMessage: 1_048_576, queue: queue)!
    conn.onOpen = { p in seen.add("open \(p)"); then(conn) }
    conn.onEvent = { e in
        switch e {
        case .text(let t): seen.add("text \(t)")
        case .close(let code, let reason):
            seen.add("close \(code.map(String.init) ?? "none") \(reason)", last: true)
            conn.answerCloseAndEnd(code)
        default: seen.add("\(e)")
        }
    }
    conn.onEnd = { f in seen.add("end \(f?.message ?? "nil")", last: true) }
    queue.async { conn.start() }
    if seen.done.wait(timeout: .now() + wait) == .timedOut { seen.add("timeout") }
    return seen.lines
}

do {
    let want = ["open "] + (0..<50).map { "text \($0)" } + ["close 4001 bye"]
    var passed = 0
    let runs = 20
    for i in 0..<runs {
        let got = run("/closenow")
        if got == want { passed += 1 } else if passed == i { print("closenow run \(i): \(got.prefix(3)) … \(got.suffix(2))") }
    }
    check("one segment (101, 50 messages, close, FIN): every run gets all of it", passed, runs)
    Thread.sleep(forTimeInterval: 0.2)
    check("one segment: the server got our close answer each time", server.answers.filter { $0 == "close 4001" }.count, runs)
}

do {
    let got = run("/echo") { c in c.sendText("नमस्ते 😀"); c.sendPing(); c.sendClose(4321, "later") }
    check("echo, pong, our close answered", got, ["open ", "text नमस्ते 😀", "pong", "close 4321 "])
}

do {
    let refused = ZnWsConnection(url: URL(string: "ws://127.0.0.1:1/")!, protocols: [], userAgent: "zn-test", maxMessage: 10, queue: queue)!
    let seen = Seen()
    refused.onEnd = { f in seen.add("end \(f?.message ?? "nil")", last: true) }
    queue.async { refused.start() }
    _ = seen.done.wait(timeout: .now() + 5)
    check("connection refused", seen.lines, ["end Failed to connect to 127.0.0.1:1"])
}

// For the record: the one-segment case through URLSessionWebSocketTask, what ZnWebSocket used before.
final class TaskWatch: NSObject, URLSessionWebSocketDelegate {
    var messages = 0, code = 0
    let done = DispatchSemaphore(value: 0)
    func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask, didOpenWithProtocol p: String?) { read(t) }
    func read(_ t: URLSessionWebSocketTask) {
        t.receive { r in if case .success = r { self.messages += 1; self.read(t) } }
    }
    func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask, didCloseWith c: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        code = c.rawValue
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { done.signal() }
}
do {
    var lost = 0
    for _ in 0..<10 {
        let w = TaskWatch()
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        let s = URLSession(configuration: .ephemeral, delegate: w, delegateQueue: q)
        s.webSocketTask(with: URL(string: "ws://127.0.0.1:\(server.port)/closenow")!).resume()
        _ = w.done.wait(timeout: .now() + 5)
        q.waitUntilAllOperationsAreFinished()
        if w.messages != 50 || w.code != 4001 { lost += 1 }
        s.invalidateAndCancel()
    }
    print("for the record: URLSessionWebSocketTask lost the one-segment case in \(lost) of 10 runs")
}

print(failures == 0 ? "websocket: all \(count) checks passed" : "websocket: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
