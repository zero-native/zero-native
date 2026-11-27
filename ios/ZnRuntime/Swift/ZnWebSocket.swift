// The built-in WebSocket module on iOS (the browser WebSocket API; JS side: packages/core/src/websocket.ts), on our
// own RFC 6455 client over NWConnection (ZnWebSocketConnection.swift, ZnWebSocketWire.swift). Same calls, events and
// rules as android/runtime's ZnWebSocket.kt (docs/fetch.md §8):
// - `connect`, `send` and `close` run on the main thread only to keep the order JS called them in; each is handed to
//   one serial queue, which is also every connection's queue, so all socket state lives on that queue.
// - Events: open {id, protocol}, message {id, data}, closing {id, code, reason}, close {id, code, reason, wasClean},
//   error {id, message}. One close per socket.
// - Text frames only (v1): a binary frame gives error, then we close with 1003. A message over 1 MB (UTF-8 bytes)
//   from the server gives error, then we close with 1009 (its bytes are never kept); `send` of more rejects "too_large".
// - A ping every 10 s (OkHttp's pingInterval on Android): with no pong by the next ping, error, then close 1006. A
//   ping that iOS held up (the app was suspended) gets a fresh one instead: no false failure on return.
// - The server's close: answered at once, then closing and close with its code (clean), as OkHttp.
// - Our own close: the close frame, then we wait for the server's answer up to 60 s (as OkHttp); the server's answer
//   gives close with its code, clean; none in 60 s, or the connection dropped first, gives error, then close 1006.
// - The handshake sends fetch's User-Agent, no cookies.
// - A JS reset (dev reload, OTA restart) cancels every socket; late events of those sockets are dropped. JS ids also
//   start at a random number in each JS runtime.
// Not URLSessionWebSocketTask: it lost the messages and the close that came in one read with the server's FIN (see
// ZnWebSocketWire.swift). Known differences: no proxy, pins or interceptors (iOS fetch has none either). The 15 s
// connect limit also covers TLS and waiting for the 101 (OkHttp: only the TCP connect). See docs/fetch.md §8.
import Foundation

final class ZnWebSocket: ZnModuleBase, @unchecked Sendable {
    static let shared = ZnWebSocket()
    private static let maxMessageSize = 1_048_576  // 1 MB cap in UTF-8 bytes, as Android (second-opinions 161)
    private static let pingInterval = 10.0
    /// How long we wait for the server's answer to our close, as OkHttp.
    private static let closeTimeout = 60.0
    /// As Android's CONNECT_TIMEOUT_MS; on iOS it covers TLS and waiting for the 101 too.
    private static let connectTimeout = 15.0

    /// One socket, as JS knows it. Touched on `work` only.
    private final class Entry {
        let id: Int
        let epoch: Int
        let conn: ZnWsConnection
        /// The handshake is done. Before that, a close from JS cancels the connect (what browsers do).
        var open = false
        /// We already sent JS an error for this socket (binary frame, message too big) and started closing it.
        var gaveUp = false
        /// We sent our close frame, with this code.
        var closeSent: Int?
        var awaitingPong = false
        var pongs = 0
        /// When the last ping went out (`now()`).
        var pingSentAt: UInt64 = 0
        var pingTimer: DispatchSourceTimer?
        var closeTimer: DispatchSourceTimer?
        var connectTimer: DispatchSourceTimer?
        init(id: Int, epoch: Int, conn: ZnWsConnection) {
            self.id = id; self.epoch = epoch; self.conn = conn
        }
        func stopTimers() {
            pingTimer?.cancel(); pingTimer = nil
            closeTimer?.cancel(); closeTimer = nil
            connectTimer?.cancel(); connectTimer = nil
        }
    }

    /// All socket state lives here: calls, the connections' callbacks and the timers run on it, one at a time.
    private let work = DispatchQueue(label: "zn-websocket")
    private var sockets: [Int: Entry] = [:]  // by JS id; `work` only
    private let lock = NSLock()
    /// Goes up on each JS reset (under `lock`). Work queued by an older JS is dropped.
    private var epochValue = 0
    private var epoch: Int { lock.withLock { epochValue } }

    private init() {
        super.init("WebSocket", version: 1)
        function("connect", onMain: true) { [unowned self] call in
            let id = try call.int("id"), url = try call.string("url")
            let protocols = (call.args["protocols"] as? [Any] ?? []).compactMap { $0 as? String }
            let e = self.epoch
            self.work.async { self.connect(call, e, id, url, protocols) }
        }
        function("send", onMain: true) { [unowned self] call in
            let id = try call.int("id"), data = try call.string("data")
            let e = self.epoch
            self.work.async { self.send(call, e, id, data) }
        }
        function("close", onMain: true) { [unowned self] call in
            let id = try call.int("id")
            let code = try call.intOrNil("code") ?? 1000
            let reason = try call.stringOrNil("reason") ?? ""
            // true: JS called close() while CONNECTING. Older JS doesn't send it; then `Entry.open` decides.
            let abort = try call.boolOrNil("abort") ?? false
            let e = self.epoch
            self.work.async { self.close(call, e, id, code, reason, abort) }
        }
    }

    // MARK: Calls (on `work`)

    private func connect(_ call: ZnCall, _ e: Int, _ id: Int, _ raw: String, _ protocols: [String]) {
        guard e == epoch else { return }  // the JS that asked is gone
        guard let url = URL(string: raw), let target = ZnWsWire.target(url),
              let conn = ZnWsConnection(url: url, protocols: protocols, userAgent: ZnFetch.userAgent,
                                        maxMessage: Self.maxMessageSize, queue: work) else {
            return call.reject("invalid_url", "Invalid WebSocket URL: \(raw)")
        }
        if !target.tls, !Self.cleartextAllowed(target.host) {
            // As OkHttp: the call succeeds, then the socket fails (error, close 1006).
            call.resolve()
            let message = "plain ws:// to \(target.host) is blocked by App Transport Security. Use wss://, or allow this host in the app's Info.plist (NSAppTransportSecurity, debug only)"
            emit("error", ["id": id, "message": message])
            return emit("close", ["id": id, "code": 1006, "reason": message, "wasClean": false])
        }
        let entry = Entry(id: id, epoch: e, conn: conn)
        // The same id twice would be a JS bug: don't leak the old socket.
        if let old = sockets.updateValue(entry, forKey: id) { drop(old) }
        conn.onOpen = { [weak self, weak entry] proto in
            guard let self, let entry, self.live(entry) else { return }
            self.didOpen(entry, proto)
        }
        conn.onEvent = { [weak self, weak entry] event in
            guard let self, let entry, self.live(entry) else { return }
            self.didReceive(entry, event)
        }
        conn.onEnd = { [weak self, weak entry] failure in
            guard let self, let entry, self.live(entry) else { return }
            // Ended with no close frame from the server (OkHttp: an EOF before the server's close is onFailure).
            self.fail(entry, failure?.message ?? "the connection closed without a close frame")
        }
        entry.connectTimer = timer(Self.connectTimeout, entry) { [weak self] entry in
            if !entry.open { self?.fail(entry, "The request timed out.") }
        }
        conn.start()
        call.resolve()
    }

    private func send(_ call: ZnCall, _ e: Int, _ id: Int, _ data: String) {
        guard e == epoch else { return }
        if data.utf8.count > Self.maxMessageSize {
            return call.reject("too_large", "Message exceeds 1 MB limit (second-opinions 161)")
        }
        guard let entry = sockets[id] else { return call.reject("not_found", "WebSocket \(id) not found or already closed") }
        // As OkHttp: nothing is sent after our close frame.
        guard entry.closeSent == nil else { return call.reject("send_failed", "Failed to enqueue WebSocket message") }
        entry.conn.sendText(data)
        call.resolve()  // queued, as on Android
    }

    private func close(_ call: ZnCall, _ e: Int, _ id: Int, _ code: Int, _ reason: String, _ abort: Bool) {
        guard e == epoch else { return }
        // No entry: the socket already closed or failed (its close event is on the way), or connect failed (JS already
        // closed itself). Calls run in order, so a close can't come before its connect.
        if let entry = sockets[id] {
            if abort || !entry.open || !Self.canSend(code) || reason.utf8.count > 123 {
                fail(entry, "Canceled")  // still connecting: fail it (browsers give error, then close 1006)
            } else if entry.closeSent == nil {
                sendClose(entry, code, reason)
            }
        }
        call.resolve()
    }

    // MARK: Socket events (on `work`)

    /// Our entry is still the live one (not cleared by a JS reset, not replaced).
    private func live(_ entry: Entry) -> Bool { sockets[entry.id] === entry && entry.epoch == epoch }

    private func didOpen(_ entry: Entry, _ proto: String) {
        entry.open = true
        entry.connectTimer?.cancel(); entry.connectTimer = nil
        emit("open", ["id": entry.id, "protocol": proto])
        startPings(entry)
    }

    private func didReceive(_ entry: Entry, _ event: ZnWsEvent) {
        switch event {
        case .text(let text):
            if !entry.gaveUp { emit("message", ["id": entry.id, "data": text]) }
        case .binary:
            // v1 is text frames only: a binary frame is reported once as an error event (second-opinions 161), then we
            // close with 1003 ("Unsupported Data"), so JS sees error → close, like in a browser.
            if !entry.gaveUp { giveUp(entry, 1003, "Unsupported Data", "binary WebSocket frames are not supported in zero-native v1") }
        case .tooBig:
            if !entry.gaveUp { giveUp(entry, 1009, "Message too big", "Message received from server exceeds 1 MB limit") }
        case .ping(let payload):
            if entry.closeSent == nil { entry.conn.sendPong(payload) }
        case .pong:
            // Any pong counts, an older ping's too (as OkHttp).
            entry.awaitingPong = false
            entry.pongs += 1
        case .close(let code, let reason):
            // The server's close (or its answer to ours). 1005: it sent no code (RFC 6455 §7.1.5).
            let shown = code ?? 1005
            emit("closing", ["id": entry.id, "code": shown, "reason": reason])
            finish(entry)
            if entry.closeSent == nil {
                // Answered at once with its code, as OkHttp (1000 for one we may not send back).
                entry.conn.answerCloseAndEnd(code.flatMap { Self.canSend($0) ? $0 : nil } ?? 1000)
            } else {
                entry.conn.cancel()
            }
            emit("close", ["id": entry.id, "code": shown, "reason": reason, "wasClean": true])
        }
    }

    // MARK: Pings and closing

    /// A ping every 10 s; no pong by the next one fails the socket (OkHttp's pingInterval).
    private func startPings(_ entry: Entry) {
        let t = DispatchSource.makeTimerSource(queue: work)
        t.schedule(deadline: .now() + Self.pingInterval, repeating: Self.pingInterval)
        t.setEventHandler { [weak self, weak entry] in
            guard let self, let entry, self.live(entry) else { return }
            // Much later than 10 s after the last ping: iOS suspended the app in between. Its pong may be waiting to be
            // read right behind this timer, so don't fail on it: send a fresh ping and give that one the full 10 s.
            let late = Self.now() - entry.pingSentAt > UInt64(Self.pingInterval * 1.5 * 1e9)
            if entry.awaitingPong && !late {
                let ms = Int(Self.pingInterval * 1000)
                return self.fail(entry, "sent ping but didn't receive pong within \(ms)ms (after \(entry.pongs) successful ping/pongs)")
            }
            if entry.awaitingPong { Self.debugLog("\(entry.id): ping timer late (app was suspended): a fresh ping") }
            // After our close frame nothing else is sent; the close timer watches the socket then.
            guard entry.closeSent == nil else { return }
            entry.awaitingPong = true
            entry.pingSentAt = Self.now()
            entry.conn.sendPing()
        }
        entry.pingTimer = t
        t.resume()
    }

    /// Sends our close frame, then waits for the server's answer (`didReceive` .close) up to 60 s, as OkHttp.
    private func sendClose(_ entry: Entry, _ code: Int, _ reason: String) {
        entry.closeSent = code
        entry.awaitingPong = false
        entry.conn.sendClose(code, reason)
        entry.closeTimer = timer(Self.closeTimeout, entry) { [weak self] entry in
            self?.fail(entry, "the server didn't answer our close within \(Int(Self.closeTimeout)) s")
        }
    }

    private func giveUp(_ entry: Entry, _ code: Int, _ closeReason: String, _ message: String) {
        entry.gaveUp = true
        emit("error", ["id": entry.id, "message": message])
        if entry.closeSent == nil { sendClose(entry, code, closeReason) }
    }

    /// The socket failed: error, then close 1006 (OkHttp's onFailure).
    private func fail(_ entry: Entry, _ message: String) {
        finish(entry)
        entry.conn.cancel()
        emit("error", ["id": entry.id, "message": message])
        emit("close", ["id": entry.id, "code": 1006, "reason": message, "wasClean": false])
    }

    /// The socket is over: out of the map, timers stopped. Later events of its connection are dropped.
    private func finish(_ entry: Entry) {
        entry.stopTimers()
        if sockets[entry.id] === entry { sockets[entry.id] = nil }
    }

    private func drop(_ entry: Entry) {
        finish(entry)
        entry.conn.cancel()
    }

    /// A one-shot timer on `work` for a live entry.
    private func timer(_ seconds: Double, _ entry: Entry, _ body: @escaping (Entry) -> Void) -> DispatchSourceTimer {
        let t = DispatchSource.makeTimerSource(queue: work)
        t.schedule(deadline: .now() + seconds)
        t.setEventHandler { [weak self, weak entry] in
            guard let self, let entry, self.live(entry) else { return }
            body(entry)
        }
        t.resume()
        return t
    }

    /// Time that keeps counting while the app is suspended or the phone sleeps, in ns.
    private static func now() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

    /// Plain ws:// to this host is allowed by the app's App Transport Security settings. ATS doesn't check our
    /// connections (nor did it check WebSocket tasks: ws://example.com opened with only NSAllowsLocalNetworking,
    /// 2026-11-21), so we apply the rules fetch gets: always for IP addresses, names with no dot and .local names; else
    /// NSAllowsArbitraryLoads or an NSExceptionDomains entry with NSExceptionAllowsInsecureHTTPLoads. As in ATS,
    /// NSAllowsArbitraryLoads counts only when none of NSAllowsLocalNetworking, NSAllowsArbitraryLoadsInWebContent,
    /// NSAllowsArbitraryLoadsForMedia is there. Android's cleartext policy refuses it too.
    private static func cleartextAllowed(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        if !h.contains(".") || h.hasSuffix(".local") || h.contains(":") || h.allSatisfy({ $0.isNumber || $0 == "." }) { return true }
        guard let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any] else { return false }
        let overrides = ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsInWebContent", "NSAllowsArbitraryLoadsForMedia"]
        if ats["NSAllowsArbitraryLoads"] as? Bool == true, !overrides.contains(where: { ats[$0] != nil }) { return true }
        for (domain, value) in ats["NSExceptionDomains"] as? [String: Any] ?? [:] {
            guard let rule = value as? [String: Any], rule["NSExceptionAllowsInsecureHTTPLoads"] as? Bool == true else { continue }
            let d = domain.lowercased()
            if h == d || (rule["NSIncludesSubdomains"] as? Bool == true && h.hasSuffix("." + d)) { return true }
        }
        return false
    }

    /// A close code we may put in our own close frame (RFC 6455 §7.4; the same rule OkHttp checks).
    private static func canSend(_ code: Int) -> Bool {
        (1000...4999).contains(code) && !(1004...1006).contains(code) && !(1015...2999).contains(code)
    }

    private static func debugLog(_ line: String) {
        #if DEBUG
        print("zn websocket \(line)")
        #endif
    }

    // MARK: JS reset

    /// JS reset (dev reload, OTA restart), main thread. Every socket is cancelled at once (no close handshake: the JS
    /// that would hear it is gone), and the map is cleared, so late events of these sockets are dropped.
    func reset() {
        lock.withLock { epochValue += 1 }
        work.async { [self] in
            let old = Array(sockets.values)
            sockets = [:]
            for entry in old {
                entry.stopTimers()
                entry.conn.cancel()
            }
        }
    }
}
