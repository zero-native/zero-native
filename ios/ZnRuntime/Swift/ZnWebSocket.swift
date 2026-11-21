// The built-in WebSocket module on iOS (the browser WebSocket API; JS side: packages/core/src/websocket.ts), on
// URLSessionWebSocketTask. Same calls, events and rules as android/runtime's ZnWebSocket.kt (docs/fetch.md §8):
// - `connect`, `send` and `close` run on the main thread only to keep the order JS called them in; each is handed to
//   one serial queue, which is also the session's delegate queue, so all socket state lives on that queue.
// - Events: open {id, protocol}, message {id, data}, closing {id, code, reason}, close {id, code, reason, wasClean},
//   error {id, message}. One close per socket.
// - Text frames only (v1): a binary frame gives error, then we close with 1003. A message over 1 MB (UTF-8 bytes)
//   from the server gives error, then we close with 1009; `send` of more rejects "too_large".
// - A ping every 10 s (OkHttp's pingInterval on Android): with no pong by the next ping, error, then close 1006.
// - Our own close gets 60 s for the server's answer, then the socket is cut (close 1006), as OkHttp does.
// - The handshake sends fetch's User-Agent. Cookies and the cache are off, as for fetch.
// - A JS reset (dev reload, OTA restart) cancels every socket; late events of those sockets are dropped. JS ids also
//   start at a random number in each JS runtime.
// Known differences: no proxy, pins or interceptors (iOS fetch has none either). Native memory per message is capped
// at 4 MB (OkHttp has no cap); a message past that also gives error, then close 1009.
import Foundation

final class ZnWebSocket: ZnModuleBase, @unchecked Sendable {
    static let shared = ZnWebSocket()
    private static let maxMessageSize = 1_048_576  // 1 MB cap in UTF-8 bytes, as Android (second-opinions 161)
    /// What URLSession reads into memory for one message at most. Above our 1 MB, so the 1 MB rule is our own exact
    /// check (with Android's error); a message past this fails inside URLSession and goes the same way.
    private static let nativeMaxMessageSize = 4 * 1_048_576
    private static let pingInterval = 10.0
    private static let closeTimeout = 60.0
    private static let connectTimeout = 15.0  // as Android's CONNECT_TIMEOUT_MS

    /// One socket, as JS knows it. Touched on `work` only.
    private final class Entry {
        let id: Int
        let epoch: Int
        let task: URLSessionWebSocketTask
        /// URLSession said the socket is open. Before that, a close from JS cancels the connect (what browsers do).
        var open = false
        /// We already sent JS an error for this socket (binary frame, message too big) and started closing it.
        var gaveUp = false
        /// We (or URLSession for us) sent our close frame, with this code and reason.
        var closeSent: Int?
        var closeReason = ""
        var awaitingPong = false
        var pongs = 0
        var pingTimer: DispatchSourceTimer?
        var closeTimer: DispatchSourceTimer?
        init(id: Int, epoch: Int, task: URLSessionWebSocketTask) {
            self.id = id; self.epoch = epoch; self.task = task
        }
        func stopTimers() {
            pingTimer?.cancel(); pingTimer = nil
            closeTimer?.cancel(); closeTimer = nil
        }
    }

    /// All socket state lives here: calls, the session's delegate calls and the timers run on it, one at a time.
    private let work = DispatchQueue(label: "zn-websocket")
    private lazy var queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "zn-websocket"
        q.maxConcurrentOperationCount = 1
        q.underlyingQueue = work
        return q
    }()
    /// Made on `work`, on the first connect.
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpMaximumConnectionsPerHost = 64  // an open socket keeps its connection: the default 6 would make the 7th wait
        c.waitsForConnectivity = false  // offline fails at once, as on Android
        return URLSession(configuration: c, delegate: SessionDelegate(self), delegateQueue: queue)
    }()
    private var sockets: [Int: Entry] = [:]  // by JS id; `work` only
    private var byTask: [ObjectIdentifier: Entry] = [:]  // the same entries, by task; `work` only
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
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "ws" || scheme == "wss",
              url.host?.isEmpty == false else {
            return call.reject("invalid_url", "Invalid WebSocket URL: \(raw)")
        }
        if scheme == "ws", let host = url.host, !Self.cleartextAllowed(host) {
            // As OkHttp: the call succeeds, then the socket fails (error, close 1006).
            call.resolve()
            let message = "plain ws:// to \(host) is blocked by App Transport Security. Use wss://, or allow this host in the app's Info.plist (NSAppTransportSecurity, debug only)"
            emit("error", ["id": id, "message": message])
            return emit("close", ["id": id, "code": 1006, "reason": message, "wasClean": false])
        }
        var request = URLRequest(url: url, timeoutInterval: Self.connectTimeout)
        request.setValue(ZnFetch.userAgent, forHTTPHeaderField: "User-Agent")
        if !protocols.isEmpty { request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol") }
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = Self.nativeMaxMessageSize
        let entry = Entry(id: id, epoch: e, task: task)
        // The same id twice would be a JS bug: don't leak the old socket.
        if let old = sockets.updateValue(entry, forKey: id) { drop(old) }
        byTask[ObjectIdentifier(task)] = entry
        task.resume()
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
        entry.task.send(.string(data)) { error in
            if let error { Self.debugLog("\(id): send failed: \(error.localizedDescription)") }
        }
        call.resolve()  // queued, as on Android
    }

    private func close(_ call: ZnCall, _ e: Int, _ id: Int, _ code: Int, _ reason: String, _ abort: Bool) {
        guard e == epoch else { return }
        // No entry: the socket already closed or failed (its close event is on the way), or connect failed (JS already
        // closed itself). Calls run in order, so a close can't come before its connect.
        if let entry = sockets[id] {
            if abort || !entry.open || !Self.canSend(code) || reason.utf8.count > 123 {
                entry.task.cancel()  // still connecting: fail it (browsers give error, then close 1006)
            } else if entry.closeSent == nil {
                sendClose(entry, code, reason)
            }
        }
        call.resolve()
    }

    // MARK: Socket events (on `work`)

    /// Our entry is still the live one (not cleared by a JS reset, not replaced).
    private func live(_ entry: Entry) -> Bool { sockets[entry.id] === entry && entry.epoch == epoch }

    private func entry(_ task: URLSessionTask) -> Entry? {
        guard let entry = byTask[ObjectIdentifier(task)], live(entry) else { return nil }
        return entry
    }

    fileprivate func didOpen(_ task: URLSessionWebSocketTask, _ proto: String?) {
        guard let entry = entry(task) else { return }
        entry.open = true
        emit("open", ["id": entry.id, "protocol": proto ?? ""])
        receive(entry)
        startPings(entry)
    }

    private func receive(_ entry: Entry) {
        // The answer comes on the delegate queue (`work`).
        entry.task.receive { [weak self, weak entry] result in
            guard let self, let entry, self.live(entry) else { return }
            switch result {
            case .success(let message):
                // Read on after giving up too (and drop what comes), so the server's close is still read.
                defer { self.receive(entry) }
                if entry.gaveUp { return }
                switch message {
                case .string(let text):
                    // URLSession has already read the whole message into memory here: this cap protects JS.
                    if text.utf8.count > Self.maxMessageSize {
                        return self.giveUp(entry, 1009, "Message too big", "Message received from server exceeds 1 MB limit")
                    }
                    self.emit("message", ["id": entry.id, "data": text])
                default:
                    // v1 is text frames only: a binary frame is reported once as an error event (second-opinions 161),
                    // then we close with 1003 ("Unsupported Data"), so JS sees error → close, like in a browser.
                    self.giveUp(entry, 1003, "Unsupported Data", "binary WebSocket frames are not supported in zero-native v1")
                }
            case .failure(let error):
                // Past `maximumMessageSize`, URLSession fails the read (EMSGSIZE) and closes with 1009 itself: report
                // it as a message too big. Any other failure ends the task, and didComplete tells JS.
                let ns = error as NSError
                if Self.isTooBig(ns), !entry.gaveUp {
                    entry.closeSent = 1009
                    entry.closeReason = "Message too big"
                    self.giveUp(entry, 1009, "Message too big", "Message received from server exceeds 1 MB limit")
                }
            }
        }
    }

    /// The server's close frame came. URLSession answers it itself; the close event follows here (OkHttp's onClosed).
    fileprivate func didClose(_ task: URLSessionWebSocketTask, _ code: URLSessionWebSocketTask.CloseCode, _ reason: Data?) {
        guard let entry = entry(task) else { return }
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        emit("closing", ["id": entry.id, "code": code.rawValue, "reason": text])
        finish(entry)
        emit("close", ["id": entry.id, "code": code.rawValue, "reason": text, "wasClean": true])
    }

    fileprivate func didComplete(_ task: URLSessionTask, _ error: Error?) {
        guard let entry = entry(task) else {
            byTask[ObjectIdentifier(task)] = nil
            return
        }
        let ws = entry.task
        // We closed, and the task ended without the server's close frame coming to didClose (or URLSession closed with
        // 1009 for a message past its limit): the close event has the server's code if it came, else ours.
        let ns = error as NSError?
        if let sent = entry.closeSent, ns == nil || (ns!.domain == NSURLErrorDomain && ns!.code == NSURLErrorCancelled) || Self.isTooBig(ns!) {
            let code = ws.closeCode != .invalid ? ws.closeCode.rawValue : sent
            let text = ws.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? entry.closeReason
            finish(entry)
            return emit("close", ["id": entry.id, "code": code, "reason": text, "wasClean": true])
        }
        fail(entry, Self.message(error, task))
    }

    // MARK: Pings and closing

    /// A ping every 10 s; no pong by the next one fails the socket (OkHttp's pingInterval).
    private func startPings(_ entry: Entry) {
        let t = DispatchSource.makeTimerSource(queue: work)
        t.schedule(deadline: .now() + Self.pingInterval, repeating: Self.pingInterval)
        t.setEventHandler { [weak self, weak entry] in
            guard let self, let entry, self.live(entry) else { return }
            if entry.awaitingPong {
                let ms = Int(Self.pingInterval * 1000)
                return self.fail(entry, "sent ping but didn't receive pong within \(ms)ms (after \(entry.pongs) successful ping/pongs)")
            }
            entry.awaitingPong = true
            entry.task.sendPing { [weak entry] error in
                guard let entry, error == nil else { return }  // an error: the socket is ending; didComplete tells
                entry.awaitingPong = false
                entry.pongs += 1
            }
        }
        entry.pingTimer = t
        t.resume()
    }

    /// Sends our close frame. With no answer within 60 s the socket is cut (close 1006), as OkHttp does.
    private func sendClose(_ entry: Entry, _ code: Int, _ reason: String) {
        entry.closeSent = code
        entry.closeReason = reason
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        entry.task.cancel(with: closeCode, reason: reason.isEmpty ? nil : Data(reason.utf8))
        let t = DispatchSource.makeTimerSource(queue: work)
        t.schedule(deadline: .now() + Self.closeTimeout)
        t.setEventHandler { [weak self, weak entry] in
            guard let self, let entry, self.live(entry) else { return }
            self.fail(entry, "the server didn't answer our close within \(Int(Self.closeTimeout)) s")
        }
        entry.closeTimer = t
        t.resume()
    }

    private func giveUp(_ entry: Entry, _ code: Int, _ closeReason: String, _ message: String) {
        entry.gaveUp = true
        emit("error", ["id": entry.id, "message": message])
        if entry.closeSent == nil { sendClose(entry, code, closeReason) }  // set already: URLSession closed it itself
    }

    /// The socket failed: error, then close 1006 (OkHttp's onFailure).
    private func fail(_ entry: Entry, _ message: String) {
        finish(entry)
        entry.task.cancel()
        emit("error", ["id": entry.id, "message": message])
        emit("close", ["id": entry.id, "code": 1006, "reason": message, "wasClean": false])
    }

    /// The socket is over: out of the maps, timers stopped. Later events of its task are dropped.
    private func finish(_ entry: Entry) {
        entry.stopTimers()
        if sockets[entry.id] === entry { sockets[entry.id] = nil }
        byTask[ObjectIdentifier(entry.task)] = nil
    }

    private func drop(_ entry: Entry) {
        finish(entry)
        entry.task.cancel()
    }

    /// URLSession's error for a message past `maximumMessageSize` (it then closes the socket with 1009 itself).
    private static func isTooBig(_ e: NSError) -> Bool { e.domain == NSPOSIXErrorDomain && e.code == Int(EMSGSIZE) }

    /// Plain ws:// to this host is allowed by the app's App Transport Security settings. ATS doesn't check WebSocket
    /// tasks itself (seen 2026-11-21: ws://example.com opened with only NSAllowsLocalNetworking), so we apply the rules
    /// fetch gets: always for IP addresses, names with no dot and .local names; else NSAllowsArbitraryLoads or an
    /// NSExceptionDomains entry with NSExceptionAllowsInsecureHTTPLoads. Android's cleartext policy refuses it too.
    private static func cleartextAllowed(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        if !h.contains(".") || h.hasSuffix(".local") || h.contains(":") || h.allSatisfy({ $0.isNumber || $0 == "." }) { return true }
        guard let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any] else { return false }
        if ats["NSAllowsArbitraryLoads"] as? Bool == true { return true }
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

    /// What JS gets as the error message for a failed socket.
    private static func message(_ error: Error?, _ task: URLSessionTask) -> String {
        guard let error else { return "the connection closed without a close frame" }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorCancelled: return "Canceled"
            case NSURLErrorBadServerResponse:
                // The handshake got an HTTP answer that is not a 101: say which, as OkHttp does.
                if let r = task.response as? HTTPURLResponse, r.statusCode != 101 {
                    return "Expected HTTP 101 response but was '\(r.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: r.statusCode).capitalized)'"
                }
            default: break
            }
        }
        return error.localizedDescription
    }

    private static func debugLog(_ line: String) {
        #if DEBUG
        print("zn websocket \(line)")
        #endif
    }

    // MARK: JS reset

    /// JS reset (dev reload, OTA restart), main thread. Every socket is cancelled at once (no close handshake: the JS
    /// that would hear it is gone), and the maps are cleared, so late events of these sockets are dropped.
    func reset() {
        lock.withLock { epochValue += 1 }
        work.async { [self] in
            let old = Array(sockets.values)
            sockets = [:]
            byTask = [:]
            for entry in old {
                entry.stopTimers()
                entry.task.cancel()
            }
        }
    }

    /// URLSession's delegate must be an NSObject; it only forwards to the methods above (the session keeps it).
    private final class SessionDelegate: NSObject, URLSessionWebSocketDelegate {
        unowned let ws: ZnWebSocket
        init(_ ws: ZnWebSocket) { self.ws = ws }
        func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
            ws.didOpen(webSocketTask, proto)
        }
        func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                        didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            ws.didClose(webSocketTask, code, reason)
        }
        func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            ws.didComplete(task, error)
        }
    }
}
