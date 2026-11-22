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
// - Upload: iOS's own picker (photos, camera, files). A script in our own world (the page's scripts can't reach it)
//   stops file inputs when `fileUpload` is false or the page's host isn't allowed, and sends "upload" with the count
//   (0: cancelled or stopped), as Android. On iOS 18.4 and later native stops them too (the open-panel gate below),
//   so a page can't get round the script (showPicker(), a closed shadow root); before 18.4 the script is the only
//   check, and a closed shadow root's input or showPicker() with uploads off opens the picker.
// - Paused / resumed: a screen pushed on top, the app in the background, or another controller presented over the
//   page (Android's other Activity). Media is suspended while paused. A presentation that leaves the page in the window
//   is noticed by UIKit's tint dimming, so one that doesn't dim (.overFullScreen, a custom one) doesn't pause it. A
//   swipe back waits for its end: a cancelled one changes nothing.
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
    private static let uploadHandler = "znUpload"
    private static let uploadWorld = WKContentWorld.world(name: "zn-upload")
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
    private var waitingSwipe = false  // a swipe back is under way: the page's state waits for its end
    // The app's html is what is on screen (it committed and no other page has since; a #fragment or pushState keeps it).
    private var inlineNav: WKNavigation?
    private weak var inlineItem: WKBackForwardListItem?
    private var inlineShown = false
    // iOS 18.4 and later: the uiDelegate while uploads are refused, which answers WebKit's open panel with nothing.
    private lazy var uploadGate = UploadGate(self)
    private var lastRefusal = -Double.infinity

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
        web?.configuration.userContentController.removeScriptMessageHandler(forName: Self.uploadHandler, contentWorld: Self.uploadWorld)
    }

    private func makeWebView() {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .default()
        c.preferences.isFraudulentWebsiteWarningEnabled = true
        c.preferences.javaScriptCanOpenWindowsAutomatically = false
        c.allowsInlineMediaPlayback = true
        // A weak box: the content controller keeps its handler alive, which would keep this view alive.
        c.userContentController.add(WeakHandler(self), name: Self.bridge)
        c.userContentController.add(WeakHandler(self), contentWorld: Self.uploadWorld, name: Self.uploadHandler)
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
            w.observe(\.url) { [weak self] _, _ in self?.emitNav(); self?.setUploadGate() },
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
            setUploadGate()
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

    /// `window.ZeroNative` in frames whose origin is allowed (the rules go in as JSON), and the upload watch.
    private func setScripts() {
        let ucc = web.configuration.userContentController
        ucc.removeAllUserScripts()
        let json = WebViewRules.scriptRules(policy)
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
        ucc.addUserScript(WKUserScript(source: WebViewRules.uploadScript(json, allowed: fileUpload, handler: Self.uploadHandler),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: false, in: Self.uploadWorld))
    }

    /// iOS 18.4 and later: while uploads are refused the uiDelegate is the gate, which answers WebKit's open panel with
    /// no files. WebKit looks once, when the delegate is set, at whether it answers the open panel, and answering it
    /// replaces Safari's own picker, so the page itself is the delegate while uploads are allowed.
    private func setUploadGate() {
        guard #available(iOS 18.4, *) else { return }
        let refuse = WebViewRules.refusesUploads(fileUpload: fileUpload, page: web.url?.absoluteString, policy)
        let want: WKUIDelegate = refuse ? uploadGate : self
        if web.uiDelegate !== want { web.uiDelegate = want }
    }

    /// The gate answered a picker the script didn't stop (showPicker(), a closed shadow root): 0, as the script would.
    fileprivate func uploadRefused() {
        print("zn webview: a file picker refused (uploads off or host not allowed)")
        lastRefusal = CACurrentMediaTime() * 1000
        scope.emit("upload", ["count": 0])
    }

    private func load(url: String?, html: String?, baseUrl: String?, headers: [String: String]) {
        lastError = nil
        replyOpen = false
        if let html {
            if let b = baseUrl, !policy.allowsPage(b) { return refuseLoad(b) }
            inline = true
            inlineShown = false
            inlineNav = web.loadHTMLString(html, baseURL: baseUrl.flatMap(URL.init(string:)))
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

    // In front, as Android's lifecycle ON_RESUME / ON_PAUSE: the page is in the window (a full-screen presentation
    // takes it out), its screen is the top of the stack, the app is not in the background, and no other controller is
    // presented over it (a page sheet: the App Store sheet, a picker, Safari; Android's other Activity). zero-native's
    // own Sheet and Modal are layers, not presentations, and an alert is a dialog: neither pauses, as Android's
    // Dialogs don't.

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { pages.add(scope.id, self) }
        updateFront()
    }

    /// UIKit dims the tint of the views under a presented sheet and gives it back when the sheet goes: the moment to
    /// look again.
    override func tintColorDidChange() {
        super.tintColorDidChange()
        updateFront()
    }

    @objc private func appActive() { updateFront() }
    @objc private func appInactive() { setFront(false) }

    private func updateFront() {
        let (top, nav) = topScreen()
        // A swipe back: the stack's top is already the screen under it, and the user can still let go. Android keeps
        // the screen under a predictive back STARTED, not RESUMED: so the state waits for the end, and a cancelled
        // swipe changes nothing.
        if let co = nav?.transitionCoordinator, co.isInteractive {
            if !waitingSwipe {
                waitingSwipe = true
                let queued = co.animate(alongsideTransition: nil) { [weak self] _ in
                    self?.waitingSwipe = false
                    self?.updateFront()
                }
                if !queued { waitingSwipe = false } else { return }
            } else {
                return
            }
        }
        setFront(window != nil && UIApplication.shared.applicationState != .background && top && !coveredByPresentation())
    }

    /// The page's screen is the navigation stack's top one, and that stack. A push moves the covered screen's view out
    /// of the window, into UIKit's transition and out again; the stack's top changes at once, so the page pauses once,
    /// not three times.
    private func topScreen() -> (Bool, UINavigationController?) {
        var r: UIResponder? = self
        while let n = r, !(n is UIViewController) { r = n.next }
        var vc = r as? UIViewController
        while let c = vc {
            if let nav = c.parent as? UINavigationController { return (nav.topViewController === c, nav) }
            vc = c.parent
        }
        return (true, nil)
    }

    /// Something presented over the window's screens, other than an alert or one on its way out.
    private func coveredByPresentation() -> Bool {
        var p = window?.rootViewController?.presentedViewController
        while let vc = p {
            if !vc.isBeingDismissed && !(vc is UIAlertController) { return true }
            p = vc.presentedViewController
        }
        return false
    }

    /// Android's web.onPause / onResume: media pauses and can't start while paused (WebKit already slows a hidden
    /// page's timers; iOS has no pauseTimers).
    private func setFront(_ front: Bool) {
        guard front != inFront else { return }
        inFront = front
        web.setAllMediaPlaybackSuspended(!front)
        scope.emit(front ? "resumed" : "paused")
    }

    // MARK: What the module calls

    func goBack() -> Bool {
        guard web.canGoBack else { return false }
        web.goBack()
        return true
    }

    func reloadPage() -> Bool {
        // The app's own html, still on screen: WebKit's reload would fetch its baseUrl from the network instead (Android
        // reloads the html). Known from the navigations, not the URL (WebKit adds a "/", a page adds a #fragment).
        if inline, inlineShown || web.url == nil {
            shown = nil
            apply(scope.props)
            return true
        }
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
        if message.name == Self.uploadHandler {
            // Only our upload script's world can post here; the count is still kept sane.
            let n = WebViewRules.uploadCount(message.body)
            // The 0 the page sends for a picker the gate already refused (WebKit fires `cancel`): answered once.
            if n == 0, CACurrentMediaTime() * 1000 - lastRefusal < WebViewRules.refusedEchoMs { return }
            print("zn webview: upload answered with \(n) files")
            scope.emit("upload", ["count": n])
            updateFront()  // the picker is going: look again (a picker's close doesn't always give the tint back first)
            return
        }
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

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        let item = webView.backForwardList.currentItem
        if let n = inlineNav, navigation === n {
            inlineShown = true
            inlineItem = item
        } else {
            inlineShown = item != nil && item === inlineItem  // back to the app's html, or another page
        }
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

/// The uiDelegate while uploads are refused (iOS 18.4 and later): WebKit's open panel gets no files, so no picker
/// opens whatever the page does; window.open goes to the page as before.
private final class UploadGate: NSObject, WKUIDelegate {
    weak var page: ZnWebPage?
    init(_ p: ZnWebPage) { page = p }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        page?.webView(webView, createWebViewWith: configuration, for: action, windowFeatures: windowFeatures)
    }

    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        completionHandler(nil)
        page?.uploadRefused()
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
