// The native side of the global `fetch` on iOS (docs/fetch.md; JS side: packages/core/src/fetch.ts), on URLSession.
// Same call and answer as android/runtime's ZnFetch.kt: `Fetch.send` with the request head as JSON and the body as
// bytes; the answer is the response head plus the whole body as bytes. The same rules, done the URLSession way:
// - One shared session at a time. Cookies and the HTTP cache are off (ARCHITECTURE §14). When the network changes
//   (Wi-Fi to cellular, another Wi-Fi), new calls get a new session with no pooled connections, as Android's freshPool;
//   calls already running finish on the old one.
// - `timeout` limits the whole call (our own timer: URLRequest's timeout is an idle timeout). With `timeout: 0`, a
//   call still fails after 60 s without a byte either way.
// - Redirects: followed, but never from HTTPS to HTTP, and `Authorization` is dropped when the host changes (URLSession
//   would keep it). "error" rejects; "manual" returns the 3xx.
// - The body is refused past `maxBodySize` (early when Content-Length says so).
// - Errors get Android's codes (offline, dns, timeout, tls, cleartext_blocked, ...).
// - onUploadProgress / onDownloadProgress: the events `uploadProgress` / `downloadProgress` {id, loaded, total},
//   throttled as Android (ZnProgressThrottle in ZnNetRules.swift).
// - A FormData body is written to a file first (ZnMultipart, file parts copied in small pieces) and uploaded from it,
//   so a big file never enters memory. content:// parts are refused (an Android URI).
// - Observers (plugins: the Performance plugin's network traces): `ZnFetch.addObserver` hears each call start and end,
//   as Android's ZnFetch.addInterceptor, but they only watch: they can't change a request or an answer.
// Known difference: URLSession joins repeated headers into one (`Set-Cookie: a, b`). Set-Cookie is split again here;
// other repeated headers stay joined with ", " (which is what the HTTP spec allows for them).
import Foundation
import Network
import UIKit
import os

/// What a fetch observer hears as a call starts: the URL JS asked for (query and all; an observer that passes it on
/// trims it) and the method.
public struct ZnFetchStart {
    public let url: URL
    public let method: String
}

/// What a fetch observer hears as the call ends. [status]: the response's code, nil when none came. [requestBytes]: the
/// body sent (nil: no body). [responseBytes]: the body received, unzipped (nil when no response came). [error]: the
/// code JS gets (`timeout`, `offline`, ..., `aborted` when JS gave up), nil when the call answered.
public struct ZnFetchEnd {
    public let status: Int?
    public let requestBytes: Int64?
    public let responseBytes: Int64?
    public let contentType: String?
    public let error: String?
}

/// A fetch observer: called as each call starts (on the calling thread); what it returns is called once as that call
/// ends (on fetch's own queue). nil: this call isn't watched. Both must be quick: every call waits for them.
public typealias ZnFetchObserver = (ZnFetchStart) -> ((ZnFetchEnd) -> Void)?

public final class ZnFetch: ZnModuleBase, @unchecked Sendable {
    static let shared = ZnFetch()
    private static let frameworkVersion = "0.1.0"
    private static let defaultTimeoutMs = 30_000.0
    private static let idleTimeoutS = 60.0
    private static let defaultMaxBody = 10_000_000
    /// Set by the network stack only (same list as fetch.ts; checked again for direct module callers).
    private static let transportHeaders: Set<String> = [
        "accept-encoding", "connection", "content-length", "expect", "host", "keep-alive", "proxy-connection", "te",
        "trailer", "transfer-encoding", "upgrade",
    ]
    private static let needsBody: Set<String> = ["POST", "PUT", "PATCH", "PROPPATCH", "REPORT"]
    private static let log = Logger(subsystem: "dev.zeronative", category: "zn")

    /// One request in flight. Touched on the session's delegate queue only (serial).
    private final class Task {
        let call: ZnCall
        let where_: String
        let redirect: String
        let maxBody: Int
        /// When the call began (before a form body was written): the logged ms count from here.
        let t0: Date
        var body = Data()
        var redirects = 0
        var response: HTTPURLResponse?
        /// Set when we end the task ourselves (timeout, too large, redirect rule): the error to give instead.
        var ours: (code: String, message: String)?
        var timer: DispatchWorkItem?
        /// Progress (only when JS asked, with a reqId). up / down send the events; a total of -1 = unknown.
        var up: ZnProgressThrottle?
        var down: ZnProgressThrottle?
        var upLoaded: Int64 = 0
        var upTotal: Int64 = 0
        var upDone = false
        var downTotal: Int64 = -1
        /// The form body's file (removed when the task ends).
        var upload: URL?
        /// The body's size (nil: none), and the observers waiting for the end.
        var sentBytes: Int64?
        var ends: [(ZnFetchEnd) -> Void] = []
        init(call: ZnCall, where_: String, redirect: String, maxBody: Int, t0: Date) {
            self.call = call; self.where_ = where_; self.redirect = redirect; self.maxBody = maxBody; self.t0 = t0
        }
    }

    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "zn-fetch"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private var tasks: [ObjectIdentifier: Task] = [:]  // delegate queue only; by task object (ids are per session)
    /// The session new calls use; replaced by freshSession. Read and written under sessionLock only.
    private var current: URLSession!
    private let sessionLock = NSLock()
    private func makeSession() -> URLSession {
        let c = URLSessionConfiguration.default
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpMaximumConnectionsPerHost = 10  // as Android's dispatcher (default 6 here)
        c.waitsForConnectivity = false  // offline fails at once, as on Android
        c.timeoutIntervalForResource = 7 * 24 * 3600  // our own timer limits the whole call
        return URLSession(configuration: c, delegate: SessionDelegate(self), delegateQueue: queue)
    }

    /// Whether the phone has a network now: tells "offline" from "dns" / "connect" failures.
    private let path = NWPathMonitor()
    /// Written on the path queue, read on the delegate queue: under sessionLock.
    private var onlineNow = true
    private var online: Bool { sessionLock.withLock { onlineNow } }
    /// The network the pooled connections belong to (znNetworkKey); the path queue only.
    private var pathKey: String?
    /// Where form bodies are written before they are uploaded.
    private static let uploadDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("zn-fetch-upload", isDirectory: true)

    /// The User-Agent of fetch and of the WebSocket handshake. A static let: made once, safely from any thread.
    static let userAgent: String = {
        let b = Bundle.main
        let ascii = { (s: String) in String(s.unicodeScalars.filter { $0.value >= 0x20 && $0.value <= 0x7e }.map(Character.init)) }
        let name = (b.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "")
            .filter { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }
        let version = b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let os = znIosVersion()
        return "\(name.isEmpty ? (b.bundleIdentifier ?? "app") : name)/\(ascii(version)) (iOS \(ascii(os))) zero-native/\(ZnFetch.frameworkVersion)"
    }()

    private init() {
        super.init("Fetch")
        // Made here, before any call: calls run on several background threads at once, and a lazy session made there
        // could be made several times (found 2026-11-08: four fetches started together got four sessions, whose task
        // ids all began at 1, so their answers overwrote each other and three calls never answered).
        current = makeSession()
        path.pathUpdateHandler = { [weak self] p in self?.pathChanged(p) }
        path.start(queue: DispatchQueue(label: "zn-fetch-path"))
        function("send") { [unowned self] call in try self.send(call) }
        #if DEBUG
        // For the fetch lab (/dev/fetch): what a network change does, on a simulator that can't change networks.
        function("debugFreshSession") { [unowned self] call in
            self.freshSession("debugFreshSession")
            call.resolve(true)
        }
        #endif
        // Form bodies left by an earlier run (killed during an upload). Only files from before now: this run's first
        // upload may already be writing there.
        let started = Date()
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            let files = (try? fm.contentsOfDirectory(at: Self.uploadDir, includingPropertiesForKeys: [.creationDateKey])) ?? []
            for f in files where ((try? f.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast) < started {
                try? fm.removeItem(at: f)
            }
        }
    }

    // MARK: Observers

    private static let observersLock = NSLock()
    nonisolated(unsafe) private static var observers: [ZnFetchObserver] = []

    /// Adds an observer (Android's ZnFetch.addInterceptor, watching only). Any thread, any time: it hears the calls that
    /// start after it was added. Register plugins before the first fetch, as on Android.
    public static func addObserver(_ observer: @escaping ZnFetchObserver) {
        observersLock.withLock { observers.append(observer) }
    }

    /// The ends of the observers that watch this call (none: no observer, or none wants it).
    private static func observe(_ url: URL, _ method: String) -> [(ZnFetchEnd) -> Void] {
        let list = observersLock.withLock { observers }
        if list.isEmpty { return [] }
        let start = ZnFetchStart(url: url, method: method)
        return list.compactMap { $0(start) }
    }

    private static func tell(_ ends: [(ZnFetchEnd) -> Void], status: Int? = nil, sent: Int64? = nil, received: Int64? = nil,
                             type: String? = nil, error: String?) {
        if ends.isEmpty { return }
        let end = ZnFetchEnd(status: status, requestBytes: sent, responseBytes: received, contentType: type, error: error)
        for e in ends { e(end) }
    }

    // MARK: Network changes

    private func pathChanged(_ p: NWPath) {
        sessionLock.withLock { onlineNow = p.status == .satisfied }
        let key = znNetworkKey(p)
        let before = pathKey
        pathKey = key
        if before != key { debugLog("network: \(before ?? "(first)") → \(key)") }
        if let why = znFlushReason(before: before, after: key) { freshSession(why) }
    }

    /// New calls get a new session (an empty connection pool); the old one ends when its calls have answered. Pooled
    /// HTTP/2 connections of the old network would otherwise take new calls and hang until they time out.
    func freshSession(_ why: String) {
        sessionLock.withLock {
            let old = current!
            current = makeSession()
            // After any task made on the old session is started (send makes and queues it under this lock).
            queue.addOperation { old.finishTasksAndInvalidate() }
        }
        // Always logged, as Android's Log.i (ZnDebug.log is main-actor only; this runs on the path queue).
        Self.log.notice("fetch: \(why, privacy: .public): new calls use new connections")
    }

    // MARK: One request

    private func send(_ call: ZnCall) throws {
        let t0 = Date()
        let a = call.args
        let method = (a["method"] as? String ?? "GET").uppercased()
        let raw = a["url"] as? String ?? ""
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false else {
            return call.reject("invalid_request", "\"\(raw)\" is not a valid http(s) URL")
        }
        var bare = URLComponents(url: url, resolvingAgainstBaseURL: false)
        bare?.query = nil
        bare?.fragment = nil
        let where_ = "\(method) \(bare?.string ?? raw)"  // for messages: no query (tokens)
        let timeoutMs = (a["timeout"] as? NSNumber)?.doubleValue ?? Self.defaultTimeoutMs
        let maxBody = (a["maxBodySize"] as? NSNumber)?.intValue ?? Self.defaultMaxBody
        let redirect = a["redirect"] as? String ?? "follow"
        let reqId = (a["reqId"] as? NSNumber)?.intValue
        let trackUp = reqId != nil && (a["uploadProgress"] as? Bool ?? false)
        let trackDown = reqId != nil && (a["downloadProgress"] as? Bool ?? false)
        // `timeout` covers writing a form body too (as OkHttp's callTimeout covers writing it).
        let deadline = timeoutMs > 0 ? t0.addingTimeInterval(timeoutMs / 1000) : nil
        let timeoutMessage = "Network request failed (timeout): \(where_): no complete answer within \(Int(timeoutMs)) ms"

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeoutMs == 0 ? Self.idleTimeoutS : max(timeoutMs / 1000, Self.idleTimeoutS)
        var hasAgent = false, hasAccept = false
        let flat = a["headers"] as? [String] ?? []
        for i in stride(from: 0, to: flat.count - 1, by: 2) {
            let name = flat[i], lower = name.lowercased()
            if Self.transportHeaders.contains(lower) { continue }
            if lower == "user-agent" { hasAgent = true }
            if lower == "accept" { hasAccept = true }
            request.addValue(flat[i + 1], forHTTPHeaderField: name)
        }
        if !hasAgent { request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent") }
        if !hasAccept { request.setValue("*/*", forHTTPHeaderField: "Accept") }
        // From here every way out tells the observers once (writing a form body counts, as Android streams it).
        let ends = Self.observe(url, method)
        var upload: URL?
        var upTotal: Int64 = -1
        if let form = a["form"] as? [[Any]] {
            let boundary = "zn-" + UUID().uuidString
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            let file = Self.uploadDir.appendingPathComponent(UUID().uuidString + ".multipart")
            do {
                try FileManager.default.createDirectory(at: Self.uploadDir, withIntermediateDirectories: true)
                upTotal = try ZnMultipart.write(parts: form, boundary: boundary, to: file,
                                                isCancelled: { call.isCancelled || deadline.map { Date() >= $0 } == true })
            } catch let e as ZnMultipartError {
                var invalid = false
                if case .invalid = e { invalid = true }
                Self.tell(ends, error: e == .cancelled ? (call.isCancelled ? "aborted" : "timeout") : (invalid ? "invalid_request" : "failed"))
                if e == .cancelled {
                    if call.isCancelled { return }
                    debugLog("\(where_) → failed (timeout) in \(Int(Date().timeIntervalSince(t0) * 1000)) ms (writing the form body)")
                    return call.reject("timeout", "\(timeoutMessage) (still writing the form body)")
                }
                if case .invalid = e { return call.reject("invalid_request", "\(where_): \(e.message)") }
                return call.reject("failed", "\(where_): \(e.message)")
            } catch {
                Self.tell(ends, error: "failed")
                return call.reject("failed", "\(where_): can't write the form body: \(error.localizedDescription)")
            }
            upload = file
        } else if let bytes = call.bytes {
            request.httpBody = bytes
            upTotal = Int64(bytes.count)
        } else if Self.needsBody.contains(method) {
            request.httpBody = Data()
            upTotal = 0
        }

        let state = Task(call: call, where_: where_, redirect: redirect, maxBody: maxBody, t0: t0)
        state.upload = upload
        state.sentBytes = upTotal >= 0 ? upTotal : nil
        state.ends = ends
        // No body (a GET): no upload events, as Android.
        if trackUp, let reqId, upTotal >= 0 {
            state.upTotal = upTotal
            state.up = ZnProgressThrottle { [weak self] loaded, total in
                if !call.isCancelled { self?.emit("uploadProgress", ["id": reqId, "loaded": loaded, "total": total]) }
            }
        }
        if trackDown, let reqId {
            state.down = ZnProgressThrottle { [weak self] loaded, total in
                if !call.isCancelled { self?.emit("downloadProgress", ["id": reqId, "loaded": loaded, "total": total]) }
            }
        }
        // Made and queued under the lock: freshSession then can't end this task's session before it starts.
        let task: URLSessionTask = sessionLock.withLock {
            let task = upload.map { current.uploadTask(with: request, fromFile: $0) } ?? current.dataTask(with: request)
            queue.addOperation { self.start(task, state, deadline, timeoutMessage) }
            return task
        }
        call.onCancel { task.cancel() }
    }

    /// Delegate queue: the task is ours from here, with its whole-call timer (what is left of `timeout` after the form
    /// body was written).
    private func start(_ task: URLSessionTask, _ state: Task, _ deadline: Date?, _ timeoutMessage: String) {
        tasks[ObjectIdentifier(task)] = state
        if let deadline {
            let timer = DispatchWorkItem { [weak self] in
                self?.queue.addOperation {
                    guard state.ours == nil, self?.tasks[ObjectIdentifier(task)] != nil else { return }
                    state.ours = ("timeout", timeoutMessage)
                    task.cancel()
                }
            }
            state.timer = timer
            DispatchQueue.global().asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSinceNow), execute: timer)
        }
        task.resume()
    }

    /// The body was sent (an answer came, or the call ended well): the last upload event, once. A body that is
    /// empty gets no didSendBodyData, so this is its only event (0 / 0), as Android's CountingRequestBody.
    private func uploadDone(_ t: Task) {
        guard let up = t.up, !t.upDone else { return }
        t.upDone = true
        up.finish(t.upLoaded, t.upTotal)
    }

    // MARK: URLSession delegate (delegate queue)

    func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let t = tasks[ObjectIdentifier(task)] else { return completionHandler(nil) }
        switch t.redirect {
        case "error":
            t.ours = ("redirect_not_allowed", "\(t.where_): got a \(response.statusCode) redirect, and redirect is \"error\"")
            completionHandler(nil)
            task.cancel()
        case "manual":
            completionHandler(nil)  // the 3xx is the answer
        default:
            let from = task.currentRequest?.url ?? response.url
            if from?.scheme == "https", newRequest.url?.scheme == "http" {
                t.ours = ("insecure_redirect", "\(t.where_): refused a redirect from HTTPS to plain HTTP (\(newRequest.url?.absoluteString ?? ""))")
                completionHandler(nil)
                task.cancel()
                return
            }
            var next = newRequest
            if from?.host?.lowercased() != next.url?.host?.lowercased() || from?.port != next.url?.port {
                next.setValue(nil, forHTTPHeaderField: "Authorization")
            }
            t.redirects += 1
            completionHandler(next)
        }
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let t = tasks[ObjectIdentifier(dataTask)] else { return completionHandler(.cancel) }
        t.response = response as? HTTPURLResponse
        uploadDone(t)
        // URLSession unzips gzip / br itself and then counts the unzipped bytes: the declared length (of the zipped
        // body) is not the total. OkHttp drops Content-Length when it unzips, so Android says -1 too.
        let encoding = (t.response?.value(forHTTPHeaderField: "Content-Encoding") ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        t.downTotal = encoding.isEmpty || encoding == "identity" ? response.expectedContentLength : -1
        if response.expectedContentLength > Int64(t.maxBody) {
            t.ours = ("too_large", "\(t.where_): the body is \(response.expectedContentLength) bytes; maxBodySize is \(t.maxBody)")
            return completionHandler(.cancel)
        }
        completionHandler(.allow)
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let t = tasks[ObjectIdentifier(dataTask)], t.ours == nil else { return }
        t.body.append(data)
        if t.body.count > t.maxBody {
            t.ours = ("too_large", "\(t.where_): the body is over maxBodySize (\(t.maxBody) bytes)")
            return dataTask.cancel()
        }
        t.down?.update(Int64(t.body.count), t.downTotal)
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didSendBodyData sent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend expected: Int64) {
        guard let t = tasks[ObjectIdentifier(task)], t.ours == nil, let up = t.up else { return }
        // A body sent again (URLSession retrying on a new connection) counts again from 0, as on Android.
        t.upTotal = expected == NSURLSessionTransferSizeUnknown ? -1 : expected
        t.upLoaded = totalBytesSent
        up.update(totalBytesSent, t.upTotal)
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let t = tasks.removeValue(forKey: ObjectIdentifier(task)) else { return }
        t.timer?.cancel()
        if let file = t.upload { try? FileManager.default.removeItem(at: file) }
        if !t.ends.isEmpty { tellEnd(t, task, error) }
        let ms = Int(Date().timeIntervalSince(t.t0) * 1000)
        if t.call.isCancelled { return }  // JS aborted; nobody is waiting for this answer
        if let ours = t.ours {
            debugLog("\(t.where_) → failed (\(ours.code)) in \(ms) ms")
            return t.call.reject(ours.code, ours.message)
        }
        // "manual" ends a redirect with no error and the 3xx as the response.
        if let error, !(t.redirect == "manual" && t.response != nil && (error as NSError).code == NSURLErrorCancelled) {
            let code = Self.errorCode(error as NSError, online: online)
            debugLog("\(t.where_) → failed (\(code)) in \(ms) ms")
            let reason = code == "cleartext_blocked"
                ? "plain HTTP is blocked by App Transport Security. Use https://, or allow this host in the app's Info.plist (NSAppTransportSecurity, debug only)"
                : error.localizedDescription
            return t.call.reject(code, "Network request failed (\(code)): \(t.where_): \(reason)")
        }
        guard let r = t.response else { return t.call.reject("connection_lost", "Network request failed (connection_lost): \(t.where_): no response") }
        var headers: [String] = []
        for (k, v) in r.allHeaderFields {
            let name = "\(k)", value = "\(v)"
            if name.lowercased() == "set-cookie" {
                for one in Self.splitSetCookie(value) { headers += [name, one] }
            } else {
                headers += [name, value]
            }
        }
        var answerURL = URLComponents(url: r.url ?? task.originalRequest?.url ?? URL(string: "about:blank")!, resolvingAgainstBaseURL: false)
        answerURL?.fragment = nil
        let head: [String: Any] = [
            "status": r.statusCode,
            "statusText": "",  // URLSession doesn't give the reason phrase (HTTP/2 has none either)
            "url": answerURL?.string ?? "",
            "redirected": t.redirects > 0,
            "headers": headers,
        ]
        uploadDone(t)
        t.down?.finish(Int64(t.body.count), t.downTotal)
        debugLog("\(t.where_) → \(r.statusCode) in \(ms) ms (\(t.body.count) B)")
        t.call.resolveBytes(head, t.body)
    }

    /// The observers hear how the call ended (before JS does): the code JS gets, or nil when it answered.
    private func tellEnd(_ t: Task, _ task: URLSessionTask, _ error: Error?) {
        let manualEnd = t.redirect == "manual" && t.response != nil && (error as NSError?)?.code == NSURLErrorCancelled
        let code: String? = t.call.isCancelled ? "aborted"
            : t.ours?.code ?? ((error == nil || manualEnd) ? (t.response == nil ? "connection_lost" : nil)
                : Self.errorCode(error! as NSError, online: online))
        let r = t.response
        Self.tell(t.ends, status: r?.statusCode, sent: t.sentBytes, received: r.map { _ in Int64(t.body.count) },
                  type: r?.value(forHTTPHeaderField: "Content-Type"), error: code)
    }

    /// URLSession's delegate must be an NSObject; it only forwards to the methods above (the session keeps it).
    private final class SessionDelegate: NSObject, URLSessionDataDelegate {
        unowned let fetch: ZnFetch
        init(_ fetch: ZnFetch) { self.fetch = fetch }
        func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            fetch.urlSession(s, task: task, willPerformHTTPRedirection: response, newRequest: newRequest, completionHandler: completionHandler)
        }
        func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            fetch.urlSession(s, dataTask: dataTask, didReceive: response, completionHandler: completionHandler)
        }
        func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            fetch.urlSession(s, dataTask: dataTask, didReceive: data)
        }
        func urlSession(_ s: URLSession, task: URLSessionTask, didSendBodyData sent: Int64, totalBytesSent: Int64,
                        totalBytesExpectedToSend expected: Int64) {
            fetch.urlSession(s, task: task, didSendBodyData: sent, totalBytesSent: totalBytesSent, totalBytesExpectedToSend: expected)
        }
        func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            fetch.urlSession(s, task: task, didCompleteWithError: error)
        }
    }

    /// "a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT, b=2" → the two cookies: a comma starts a new cookie only when a
    /// `name=` follows it (an Expires date has a comma too).
    static func splitSetCookie(_ joined: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: ",\\s*(?=[^;,=\\s]+=)") else { return [joined] }
        var out: [String] = []
        var start = joined.startIndex
        for m in re.matches(in: joined, range: NSRange(joined.startIndex..., in: joined)) {
            guard let r = Range(m.range, in: joined) else { continue }
            out.append(String(joined[start..<r.lowerBound]).trimmingCharacters(in: .whitespaces))
            start = r.upperBound
        }
        out.append(String(joined[start...]).trimmingCharacters(in: .whitespaces))
        return out.filter { !$0.isEmpty }
    }

    /// A URLSession failure → the error code JS gets (FetchErrorCode in fetch.ts), as Android's errorCode.
    static func errorCode(_ e: NSError, online: Bool) -> String {
        guard e.domain == NSURLErrorDomain else { return online ? "connection_lost" : "offline" }
        switch e.code {
        case NSURLErrorTimedOut: return "timeout"
        case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff: return "offline"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return online ? "dns" : "offline"
        case NSURLErrorAppTransportSecurityRequiresSecureConnection: return "cleartext_blocked"
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid,
             NSURLErrorClientCertificateRejected, NSURLErrorClientCertificateRequired: return "tls"
        case NSURLErrorCannotConnectToHost: return online ? "connect" : "offline"
        case NSURLErrorHTTPTooManyRedirects: return "too_many_redirects"
        default: return online ? "connection_lost" : "offline"
        }
    }

    private func debugLog(_ line: String) {
        #if DEBUG
        print("zn fetch \(line)")
        #endif
    }
}
