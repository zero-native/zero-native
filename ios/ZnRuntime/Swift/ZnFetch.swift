// The native side of the global `fetch` on iOS (docs/fetch.md; JS side: packages/core/src/fetch.ts), on URLSession.
// Same call and answer as android/runtime's ZnFetch.kt: `Fetch.send` with the request head as JSON and the body as
// bytes; the answer is the response head plus the whole body as bytes. The same rules, done the URLSession way:
// - One shared session, made on the first fetch. Cookies and the HTTP cache are off (ARCHITECTURE §14).
// - `timeout` limits the whole call (our own timer: URLRequest's timeout is an idle timeout). With `timeout: 0`, a
//   call still fails after 60 s without a byte either way.
// - Redirects: followed, but never from HTTPS to HTTP, and `Authorization` is dropped when the host changes (URLSession
//   would keep it). "error" rejects; "manual" returns the 3xx.
// - The body is refused past `maxBodySize` (early when Content-Length says so).
// - Errors get Android's codes (offline, dns, timeout, tls, cleartext_blocked, ...).
// Known difference: URLSession joins repeated headers into one (`Set-Cookie: a, b`). Set-Cookie is split again here;
// other repeated headers stay joined with ", " (which is what the HTTP spec allows for them).
import Foundation
import Network
import UIKit

final class ZnFetch: ZnModuleBase, @unchecked Sendable {
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

    /// One request in flight. Touched on the session's delegate queue only (serial).
    private final class Task {
        let call: ZnCall
        let where_: String
        let redirect: String
        let maxBody: Int
        let t0 = Date()
        var body = Data()
        var redirects = 0
        var response: HTTPURLResponse?
        /// Set when we end the task ourselves (timeout, too large, redirect rule): the error to give instead.
        var ours: (code: String, message: String)?
        var timer: DispatchWorkItem?
        init(call: ZnCall, where_: String, redirect: String, maxBody: Int) {
            self.call = call; self.where_ = where_; self.redirect = redirect; self.maxBody = maxBody
        }
    }

    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "zn-fetch"
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private var tasks: [ObjectIdentifier: Task] = [:]  // delegate queue only; by task object (ids are per session)
    private lazy var session: URLSession = {
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
    }()

    /// Whether the phone has a network now: tells "offline" from "dns" / "connect" failures.
    private let path = NWPathMonitor()
    private var online = true

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
        path.pathUpdateHandler = { [weak self] p in self?.online = p.status == .satisfied }
        path.start(queue: DispatchQueue(label: "zn-fetch-path"))
        function("send") { [unowned self] call in try self.send(call) }
        // Made here, once: calls run on several background threads at once, and a lazy property made there could be
        // made several times (found 2026-11-08: four fetches started together got four sessions, whose task ids all
        // began at 1, so their answers overwrote each other and three calls never answered).
        _ = session
    }

    // MARK: One request

    private func send(_ call: ZnCall) throws {
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
        if let form = a["form"] as? [[Any]] {
            let boundary = "zn-" + UUID().uuidString
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.multipart(form, boundary)
        } else if let bytes = call.bytes {
            request.httpBody = bytes
        } else if Self.needsBody.contains(method) {
            request.httpBody = Data()
        }

        let task = session.dataTask(with: request)
        let state = Task(call: call, where_: where_, redirect: redirect, maxBody: maxBody)
        queue.addOperation {
            self.tasks[ObjectIdentifier(task)] = state
            if timeoutMs > 0 {
                let timer = DispatchWorkItem { [weak self] in
                    self?.queue.addOperation {
                        guard state.ours == nil, self?.tasks[ObjectIdentifier(task)] != nil else { return }
                        state.ours = ("timeout", "Network request failed (timeout): \(where_): no complete answer within \(Int(timeoutMs)) ms")
                        task.cancel()
                    }
                }
                state.timer = timer
                DispatchQueue.global().asyncAfter(deadline: .now() + timeoutMs / 1000, execute: timer)
            }
            task.resume()
        }
        call.onCancel { task.cancel() }
    }

    /// multipart/form-data from FormData parts: [name, value] or [name, file URL, file name, type].
    private static func multipart(_ parts: [[Any]], _ boundary: String) throws -> Data {
        var d = Data()
        func add(_ s: String) { d.append(Data(s.utf8)) }
        for p in parts {
            guard let name = p.first as? String else { throw ZnInvalidArgs("a form part has no name") }
            add("--\(boundary)\r\n")
            if p.count == 2 {
                add("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(p[1] as? String ?? "")\r\n")
            } else {
                guard let uri = p[1] as? String, let fileURL = URL(string: uri), fileURL.isFileURL else {
                    throw ZnInvalidArgs("form part \"\(name)\": only file:// URLs on iOS")
                }
                let file = p.count > 2 ? p[2] as? String ?? "file" : "file"
                let type = p.count > 3 ? p[3] as? String ?? "application/octet-stream" : "application/octet-stream"
                add("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(file)\"\r\nContent-Type: \(type)\r\n\r\n")
                d.append(try Data(contentsOf: fileURL))
                add("\r\n")
            }
        }
        add("--\(boundary)--\r\n")
        return d
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
            dataTask.cancel()
        }
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let t = tasks.removeValue(forKey: ObjectIdentifier(task)) else { return }
        t.timer?.cancel()
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
        debugLog("\(t.where_) → \(r.statusCode) in \(ms) ms (\(t.body.count) B)")
        t.call.resolveBytes(head, t.body)
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
