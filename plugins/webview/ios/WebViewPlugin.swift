// The webview plugin's iOS side (plugins/webview, as android/.../WebViewPage.kt, WebViewRules.kt and WebViewModule.kt):
// WKWebView in the `webview.page` view and the "WebView" module, with the same props, events and rules. A page is outside
// input: every rule falls to "refuse" when something can't be read.
//
// iOS differences:
// - The bridge: a WKScriptMessageHandler plus a small script that makes `window.ZeroNative` (postMessage, onmessage,
//   addEventListener("message")) only in frames whose origin is allowed. Native checks the sender's origin again, and
//   answers only the main frame of the page that last sent a message (Android's reply proxy).
// - Links, form posts, redirects and window.open all pass WKWebView's navigation policy (decide); a main-frame answer
//   from a host not allowed is cut off too (the last net).
// - thirdPartyCookies: WebKit always blocks third-party cookies (ITP); the prop can't turn them on.
// - Upload: iOS's own picker (photos, camera, files); `fileUpload: false` disables file inputs by script. No "upload" event.
// - renderGone: WebKit ended the page's process (crashed false: iOS doesn't say why). debugRenderer: no public way to kill
//   it, so it answers false.
// - backInPage: the in-page back swipe (WKWebView's own gesture) and controller.back(); iOS has no Back button.
import UIKit
import WebKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

public struct WebViewPlugin: ZnPlugin {
    public init(inspect: Bool = false) {
        self.inspect = inspect
    }

    public var inspect = false

    public func register(_ r: ZnPluginRegistry) {
        let pages = WebViewPages(inspect: inspect)
        r.module(WebViewModule(pages))
        r.view("webview.page") { scope in ZnWebPage(scope, pages) }
    }
}

/// The rules (WebViewRules.kt), apart from WebKit.
enum WebViewRules {
    static let maxMessageChars = 64 * 1024
    static let maxUrlChars = 8 * 1024
    static let leaveGapMs = 800.0
    static let never: Set<String> = ["intent", "android-app", "javascript", "file", "content", "data", "blob", "about", "filesystem", "chrome", "view-source"]
    static let frameOnly: Set<String> = ["about", "data", "blob"]

    struct Url { let scheme: String; let host: String?; let port: Int }

    private static func letter(_ c: Character) -> Bool { c.isASCII && c.isLetter }
    private static func digit(_ c: Character) -> Bool { ("0"..."9").contains(c) }

    /// Strict on purpose: a backslash, a space or an `@` in the host part is refused.
    static func parseUrl(_ raw: String) -> Url? {
        if raw.count > maxUrlChars || raw.unicodeScalars.contains(where: { $0.value <= 0x20 || $0 == "\\" || $0.value == 0x7f }) { return nil }
        guard let colon = raw.firstIndex(of: ":"), colon != raw.startIndex else { return nil }
        let scheme = raw[..<colon].lowercased()
        guard let first = scheme.first, letter(first), scheme.allSatisfy({ letter($0) || digit($0) || "+-.".contains($0) }) else { return nil }
        let rest = raw[raw.index(after: colon)...]
        guard rest.hasPrefix("//") else { return Url(scheme: scheme, host: nil, port: -1) }
        let authority = rest.dropFirst(2).prefix { !"/?#".contains($0) }
        if authority.contains("@") { return Url(scheme: scheme, host: nil, port: -1) }
        let hp = authority.lowercased()
        let portAt = hp.lastIndex(of: ":")
        let host = portAt.map { String(hp[..<$0]) } ?? hp
        var port = -1
        if let at = portAt {
            let text = hp[hp.index(after: at)...]
            if !text.isEmpty {
                guard text.allSatisfy(digit), let p = Int(text), (1...65535).contains(p) else { return nil }
                port = p
            }
        }
        if host.isEmpty || !host.allSatisfy({ letter($0) || digit($0) || ".-_".contains($0) }) { return Url(scheme: scheme, host: nil, port: -1) }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { port = -1 }
        return Url(scheme: scheme, host: host, port: port)
    }

    struct HostRule {
        let scheme: String, host: String, port: Int, wild: Bool
        func matches(_ u: Url) -> Bool {
            guard let h = u.host else { return false }
            return u.scheme == scheme && u.port == port && (wild ? h.hasSuffix(".\(host)") : h == host)
        }
    }

    static func hostRule(_ raw: String, localHttp: Bool) -> HostRule? {
        let text = raw.trimmingCharacters(in: .whitespaces).lowercased()
        let parts = text.components(separatedBy: "://")
        let scheme = parts.count > 1 ? parts[0] : "https"
        let rest = parts.count > 1 ? parts.dropFirst().joined(separator: "://") : text
        let wild = rest.hasPrefix("*.")
        let plain = wild ? String(rest.dropFirst(2)) : rest
        if plain.contains(where: { "/?#*".contains($0) }) { return nil }
        guard let url = parseUrl("\(scheme)://\(plain)"), let host = url.host else { return nil }
        switch scheme {
        case "https": break
        case "http": if !localHttp || wild || !["localhost", "127.0.0.1"].contains(host) { return nil }
        default: return nil
        }
        if wild && (!host.contains(".") || (host.split(separator: ".").last ?? "").allSatisfy(digit)) { return nil }
        return HostRule(scheme: scheme, host: host, port: url.port, wild: wild)
    }

    struct Policy {
        let hosts: [HostRule]
        let leaveSchemes: Set<String>
        let refused: [String]
        func allowsPage(_ url: String?) -> Bool {
            guard let url, let u = parseUrl(url) else { return false }
            return hosts.contains { $0.matches(u) }
        }
    }

    static let none = Policy(hosts: [], leaveSchemes: [], refused: [])

    static func policy(_ hosts: [String], _ leaveSchemes: [String], localHttp: Bool) -> Policy {
        var rules: [HostRule] = [], refused: [String] = []
        for raw in hosts { if let r = hostRule(raw, localHttp: localHttp) { rules.append(r) } else { refused.append(raw) } }
        var schemes: [String] = []
        for raw in leaveSchemes {
            var s = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if s.hasSuffix(":") { s.removeLast() }
            if s.isEmpty || never.contains(s) || !letter(s.first!) || !s.allSatisfy({ letter($0) || digit($0) || "+-.".contains($0) }) {
                refused.append(raw)
            } else if !schemes.contains(s) { schemes.append(s) }
        }
        return Policy(hosts: rules, leaveSchemes: Set(schemes), refused: refused)
    }

    enum Action { case stay, leave, refuse }

    static func decide(_ url: String, mainFrame: Bool, _ policy: Policy) -> (Action, String?) {
        guard let u = parseUrl(url) else { return (.refuse, "bad_url") }
        let web = u.scheme == "https" || u.scheme == "http"
        if !mainFrame { return web || frameOnly.contains(u.scheme) ? (.stay, nil) : (.refuse, "frame") }
        if never.contains(u.scheme) { return (.refuse, "scheme") }
        if web && policy.allowsPage(url) { return (.stay, nil) }
        if policy.leaveSchemes.contains(u.scheme) { return (.leave, nil) }
        return (.refuse, web ? "host" : "scheme")
    }

    static func pageMayShow(_ url: String?, _ policy: Policy, inline: Bool) -> Bool {
        guard let url, let u = parseUrl(url) else { return false }
        if url == "about:blank" { return true }
        if inline && (u.scheme == "data" || u.scheme == "about") { return true }
        return policy.allowsPage(url)
    }

    static func short(_ url: String?) -> String { String((url ?? "").prefix(2048)) }
    static func hostOf(_ url: String?) -> String { url.flatMap(parseUrl).map { $0.host ?? $0.scheme } ?? "?" }

    static var debug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}

/// The views on screen, by view id. Main thread.
final class WebViewPages {
    let inspect: Bool
    private var pages: [String: ZnWebPage] = [:]
    init(inspect: Bool) { self.inspect = inspect }
    func add(_ id: String, _ p: ZnWebPage) { pages[id] = p }
    func remove(_ id: String, _ p: ZnWebPage) { if pages[id] === p { pages.removeValue(forKey: id) } }
    func get(_ id: String) -> ZnWebPage? { pages[id] }
}

/// Commands for a view, by its id. No `evaluate`: postMessage does the job, and the page chooses what it listens to.
final class WebViewModule: ZnModuleBase, @unchecked Sendable {
    init(_ pages: WebViewPages) {
        super.init("WebView", version: 1)
        func page(_ call: ZnCall) -> ZnWebPage? { MainActor.assumeIsolated { pages.get(call.args["view"] as? String ?? "") } }
        function("goBack", onMain: true) { call in call.resolve(page(call)?.goBack() ?? false) }
        function("reload", onMain: true) { call in call.resolve(page(call)?.reloadPage() ?? false) }
        function("postMessage", onMain: true) { call in
            guard let text = call.args["text"] as? String else { throw ZnInvalidArgs("\"text\" must be a string") }
            call.resolve(page(call)?.postMessage(text) ?? ["sent": false, "reason": "no_view"])
        }
        function("openLink", onMain: true) { call in
            guard let url = call.args["url"] as? String else { throw ZnInvalidArgs("\"url\" must be a string") }
            guard let p = page(call) else { return call.resolve(["opened": false, "reason": "no_view"]) }
            p.openLink(url) { call.resolve($0) }
        }
        function("clearCookies", onMain: true) { call in
            WKWebsiteDataStore.default().removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: .distantPast) { call.resolve(true) }
        }
        function("clearStorage", onMain: true) { call in
            var types = WKWebsiteDataStore.allWebsiteDataTypes()
            types.remove(WKWebsiteDataTypeCookies)
            WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { call.resolve(true) }
        }
        function("debugRenderer", onMain: true) { call in
            guard WebViewRules.debug else { return call.reject("debug_only", "debugRenderer is for debug builds only") }
            call.resolve(false)  // WebKit has no public way to end a page's process
        }
    }
}

/// `webview.page`: one WKWebView and everything that hangs on it. Main thread.
final class ZnWebPage: UIView, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static let bridge = "zeroNative"
    private let scope: ZnViewScope
    private let pages: WebViewPages
    private var web: WKWebView!
    private var policy = WebViewRules.none
    private var inline = false
    private var specKey: String?
    private var shown: String?
    private var replyOpen = false  // the main frame of the page on screen sent a message
    /// History entries whose page sent a message: going back to one restores that same page (WebKit's back-forward
    /// cache), which won't send its first message again.
    private var repliedItems = Set<ObjectIdentifier>()
    private var lastLeave = -Double.infinity
    private var lastError: [String: Any]?
    private var observers: [NSKeyValueObservation] = []
    private var fileUpload = true
    private var inFront = false

    init(_ scope: ZnViewScope, _ pages: WebViewPages) {
        self.scope = scope
        self.pages = pages
        super.init(frame: .zero)
        makeWebView()
        scope.onProps = { [weak self] p in self?.apply(p) }
        apply(scope.props)
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(appActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(appInactive), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        web?.configuration.userContentController.removeScriptMessageHandler(forName: Self.bridge)
    }

    private func makeWebView() {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .default()
        c.preferences.isFraudulentWebsiteWarningEnabled = true
        c.preferences.javaScriptCanOpenWindowsAutomatically = false
        c.allowsInlineMediaPlayback = true
        // A weak box: the content controller keeps its handler alive, which would keep this view alive.
        c.userContentController.add(WeakHandler(self), name: Self.bridge)
        let w = WKWebView(frame: bounds, configuration: c)
        w.navigationDelegate = self
        w.uiDelegate = self
        #if DEBUG
        if pages.inspect, #available(iOS 16.4, *) { w.isInspectable = true }
        #endif
        w.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(w)
        web = w
        observers = [
            w.observe(\.estimatedProgress) { [weak self] w, _ in self?.scope.emit("progress", Int((w.estimatedProgress * 100).rounded())) },
            w.observe(\.title) { [weak self] w, _ in self?.scope.emit("title", w.title ?? "") },
            w.observe(\.url) { [weak self] _, _ in self?.emitNav() },
            w.observe(\.canGoBack) { [weak self] _, _ in self?.emitNav() },
        ]
    }

    // MARK: Props

    private func apply(_ p: [String: Any]) {
        let hosts = (p["allowedHosts"] as? [String] ?? []).filter { !$0.isEmpty }
        let schemes = (p["leaveSchemes"] as? [String] ?? []).filter { !$0.isEmpty }
        let js = p["javaScript"] as? Bool ?? true
        fileUpload = p["fileUpload"] as? Bool ?? true
        let backInPage = p["backInPage"] as? Bool ?? true
        let key = "\(hosts)|\(schemes)|\(js)|\(fileUpload)|\(backInPage)|\(p["thirdPartyCookies"] as? Bool ?? false)"
        if key != specKey {
            specKey = key
            policy = WebViewRules.policy(hosts, schemes, localHttp: WebViewRules.debug)
            web.configuration.defaultWebpagePreferences.allowsContentJavaScript = js
            web.allowsBackForwardNavigationGestures = backInPage
            setScripts()
            pages.add(scope.id, self)
            scope.emit("ready", ["view": scope.id, "bridge": !policy.hosts.isEmpty, "refused": policy.refused])
        }
        let headers = p["headers"] as? [String: String] ?? [:]
        let source = "\(p["url"] as? String ?? "")|\(p["html"] as? String ?? "")|\(p["baseUrl"] as? String ?? "")|\(headers.sorted { $0.key < $1.key })"
        if source != shown {
            shown = source
            load(url: p["url"] as? String, html: p["html"] as? String, baseUrl: p["baseUrl"] as? String, headers: headers)
        }
    }

    /// `window.ZeroNative` in frames whose origin is allowed (the rules go in as JSON), and file inputs off when asked.
    private func setScripts() {
        let ucc = web.configuration.userContentController
        ucc.removeAllUserScripts()
        let rules = policy.hosts.map { ["s": $0.scheme, "h": $0.host, "p": $0.port, "w": $0.wild] as [String: Any] }
        let json = (try? JSONSerialization.data(withJSONObject: rules)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let bridge = """
        (function(){
          if (window.ZeroNative) return;
          var rules = \(json);
          var l = window.location, scheme = l.protocol.replace(':',''), host = l.hostname.toLowerCase();
          var port = l.port ? parseInt(l.port, 10) : -1;
          if ((scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)) port = -1;
          var ok = rules.some(function(r){ return r.s === scheme && r.p === port && (r.w ? host.endsWith('.' + r.h) : host === r.h); });
          if (!ok) return;
          var listeners = [];
          var api = {
            onmessage: null,
            postMessage: function(text){ window.webkit.messageHandlers.\(Self.bridge).postMessage(String(text)); },
            addEventListener: function(type, f){ if (type === 'message' && typeof f === 'function') listeners.push(f); },
            removeEventListener: function(type, f){ listeners = listeners.filter(function(x){ return x !== f; }); }
          };
          Object.defineProperty(window, 'ZeroNative', { value: api, writable: false, configurable: false });
          Object.defineProperty(window, '__znDeliver', { value: function(text){
            var e = { data: text };
            if (typeof api.onmessage === 'function') api.onmessage(e);
            listeners.slice().forEach(function(f){ f(e); });
          }, writable: false, configurable: false });
        })();
        """
        ucc.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        if !fileUpload {
            let noFiles = """
            document.addEventListener('click', function(e){
              var t = e.target; if (t && t.tagName === 'INPUT' && t.type === 'file') { e.preventDefault(); e.stopPropagation(); }
            }, true);
            """
            ucc.addUserScript(WKUserScript(source: noFiles, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
    }

    private func load(url: String?, html: String?, baseUrl: String?, headers: [String: String]) {
        lastError = nil
        replyOpen = false
        if let html {
            if let b = baseUrl, !policy.allowsPage(b) { return refuseLoad(b) }
            inline = true
            web.loadHTMLString(html, baseURL: baseUrl.flatMap(URL.init(string:)))
        } else if let url {
            guard policy.allowsPage(url), let u = URL(string: url) else { return refuseLoad(url) }
            inline = false
            var r = URLRequest(url: u)
            for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
            web.load(r)
        }
    }

    private func refuseLoad(_ url: String) {
        print("zn webview: \(WebViewRules.hostOf(url)) is not on the allowed list; not loaded")
        scope.emit("loadError", ["kind": "blocked", "url": WebViewRules.short(url), "description": "host not allowed"])
    }

    // MARK: Screen and app state

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { pages.add(scope.id, self) }
        setFront(window != nil && UIApplication.shared.applicationState != .background)
    }

    @objc private func appActive() { setFront(window != nil) }
    @objc private func appInactive() { setFront(false) }

    private func setFront(_ front: Bool) {
        guard front != inFront else { return }
        inFront = front
        scope.emit(front ? "resumed" : "paused")
    }

    // MARK: What the module calls

    func goBack() -> Bool {
        guard web.canGoBack else { return false }
        web.goBack()
        return true
    }

    func reloadPage() -> Bool {
        if web.url == nil, let s = shown, !s.hasPrefix("|") || s.count > 3 {
            shown = nil  // after the page's process ended: load it again from the props
            apply(scope.props)
            return true
        }
        web.reload()
        return true
    }

    func postMessage(_ text: String) -> [String: Any] {
        if text.count > WebViewRules.maxMessageChars { return ["sent": false, "reason": "too_long"] }
        guard replyOpen, policy.allowsPage(web.url?.absoluteString) else { return ["sent": false, "reason": "no_page"] }
        guard let data = try? JSONSerialization.data(withJSONObject: [text]), let arg = String(data: data, encoding: .utf8) else {
            return ["sent": false, "reason": "no_page"]
        }
        // In the page's main frame only; the text goes in as a JSON string, never as code.
        web.evaluateJavaScript("window.__znDeliver && window.__znDeliver(\(arg)[0]);", completionHandler: nil)
        return ["sent": true]
    }

    /// Checked again here: JS can only open what the rule allows.
    func openLink(_ url: String, _ done: @escaping ([String: Any]) -> Void) {
        guard WebViewRules.decide(url, mainFrame: true, policy).0 == .leave, let u = URL(string: url) else {
            return done(["opened": false, "reason": "refused"])
        }
        UIApplication.shared.open(u, options: [:]) { ok in done(ok ? ["opened": true] : ["opened": false, "reason": "no_app"]) }
    }

    // MARK: The bridge

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        let o = message.frameInfo.securityOrigin
        let origin = "\(o.protocol)://\(o.host)\(o.port > 0 ? ":\(o.port)" : "")"
        guard policy.allowsPage(origin) else {
            print("zn webview: a message from \(WebViewRules.hostOf(origin)) dropped")
            return
        }
        guard let text = message.body as? String, text.count <= WebViewRules.maxMessageChars else {
            print("zn webview: a message that is not text, or too long, dropped")
            return
        }
        if message.frameInfo.isMainFrame {
            replyOpen = true
            if let item = web.backForwardList.currentItem { repliedItems.insert(ObjectIdentifier(item)) }
        }
        scope.emit("message", ["text": text, "origin": origin, "mainFrame": message.frameInfo.isMainFrame])
    }

    // MARK: Navigation

    private func mayShow(_ url: String?) -> Bool { WebViewRules.pageMayShow(url, policy, inline: inline) }

    private func emitRefused(_ url: String, _ reason: String?) {
        print("zn webview: link to \(WebViewRules.hostOf(url)) refused: \(reason ?? "scheme")")
        scope.emit("linkRefused", ["url": WebViewRules.short(url), "reason": reason ?? "scheme"])
    }

    private func emitNav() {
        scope.emit("nav", ["canGoBack": web.canGoBack, "url": WebViewRules.short(web.url?.absoluteString)])
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url?.absoluteString ?? ""
        let main = action.targetFrame?.isMainFrame ?? true
        if url == "about:blank" || (inline && main && action.navigationType == .other && action.request.url?.scheme == "about") {
            return decisionHandler(.allow)
        }
        let (what, reason) = WebViewRules.decide(url, mainFrame: main, policy)
        switch what {
        case .stay: decisionHandler(.allow)
        case .refuse:
            emitRefused(url, reason)
            decisionHandler(.cancel)
        case .leave:
            let now = CACurrentMediaTime() * 1000
            if now - lastLeave >= WebViewRules.leaveGapMs {
                lastLeave = now
                // Only a question to JS: the page can't open another app by itself.
                scope.emit("linkOutside", ["url": url, "scheme": url.split(separator: ":").first.map { $0.lowercased() } ?? "",
                                           "gesture": action.navigationType == .linkActivated])
            } else {
                print("zn webview: link out dropped: too soon after the last one")
            }
            decisionHandler(.cancel)
        }
    }

    /// The last net: a main-frame answer from a host not allowed is cut off. Also reads the HTTP status.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard response.isForMainFrame else { return decisionHandler(.allow) }
        let url = response.response.url?.absoluteString
        if !mayShow(url) {
            emitRefused(url ?? "", "host")
            return decisionHandler(.cancel)
        }
        if let http = response.response as? HTTPURLResponse {
            if http.statusCode >= 400 {
                lastError = ["kind": "http", "status": http.statusCode, "description": HTTPURLResponse.localizedString(forStatusCode: http.statusCode)]
                scope.emit("loadError", lastError!.merging(["url": WebViewRules.short(url)]) { $1 })
            }
        }
        decisionHandler(.allow)
    }

    /// window.open and target=_blank: in this view, through the same rules.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, let url = action.request.url {
            let (what, reason) = WebViewRules.decide(url.absoluteString, mainFrame: true, policy)
            if what == .stay { webView.load(action.request) } else if what == .refuse { emitRefused(url.absoluteString, reason) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        replyOpen = false
        lastError = nil
        scope.emit("loadStart", ["url": WebViewRules.short(webView.url?.absoluteString)])
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let item = webView.backForwardList.currentItem, repliedItems.contains(ObjectIdentifier(item)) { replyOpen = true }
        // As on Android: a status only when the page failed.
        scope.emit("loadFinish", ["url": WebViewRules.short(webView.url?.absoluteString), "ok": lastError == nil,
                                  "status": lastError?["status"] ?? NSNull(), "title": webView.title ?? "", "canGoBack": webView.canGoBack])
        emitNav()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }

    private func failed(_ error: Error) {
        let e = error as NSError
        // Cancelled (ours, or a new page) and "frame load interrupted" (a policy cancel) are not errors.
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        let ssl = e.domain == NSURLErrorDomain && (NSURLErrorServerCertificateHasBadDate...NSURLErrorSecureConnectionFailed).contains(e.code)
        let url = (e.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) ?? web.url?.absoluteString
        lastError = ["kind": ssl ? "ssl" : "network", "code": e.code, "description": ssl ? "bad certificate" : e.localizedDescription]
        scope.emit("loadError", lastError!.merging(["url": WebViewRules.short(url)]) { $1 })
    }

    /// Never past a bad certificate: the default handling, with no option to proceed.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.performDefaultHandling, nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        print("zn webview: the page's process ended")
        replyOpen = false
        scope.emit("renderGone", ["crashed": false])
    }
}

/// Holds the page weakly for WKUserContentController, which keeps its handlers alive.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
