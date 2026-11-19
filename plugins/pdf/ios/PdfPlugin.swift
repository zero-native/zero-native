// The pdf plugin's iOS side (plugins/pdf, as android/.../PdfModule.kt, PdfRules.kt, PdfViewer.kt and PdfPreview.kt):
// downloads into ZnHandles.fileDir (handles `zn://file/pdf-….pdf`), the "pdf.view" viewer and the "pdf.preview" card,
// with the same calls, answers, events and rules as Android.
//
// iOS differences:
// - Drawing is Apple's PDFKit (PDFView for the viewer: scroll, pinch, sharp at any zoom, its own memory handling), so
//   Android's bitmap budget, sharp layer and low-memory trim have no iOS counterpart. A double tap zooms to 2.5x and back.
// - Downloads use URLSession; redirects are followed by hand as on Android (5 at most, the app's headers only to the
//   same origin, https only; debug builds also take http to localhost).
import CommonCrypto
import PDFKit
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

public struct PdfPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        let views = PdfViews()
        r.module(PdfModule(views))
        r.view("pdf.view") { scope in ZnPdfViewer(scope, views) }
        r.view("pdf.preview") { scope in ZnPdfPreview(scope) }
    }
}

/// The pdf rules (PdfRules.kt), apart from UIKit.
enum PdfRules {
    static let defaultMaxBytes: Int64 = 20 * 1024 * 1024
    static let maxBytes: Int64 = 100 * 1024 * 1024
    static let keepMs: Double = 7 * 24 * 3600 * 1000
    static let maxZoomCap = 10.0
    static let doubleTapZoom = 2.5
    static let maxRedirects = 5
    private static let prefix = "pdf-", partPrefix = ".pdf-"

    /// The file for url + key (SHA-256, the first 16 bytes): the same name as on Android.
    static func fileName(_ url: String, _ key: String?) -> String {
        let data = Data("\(url)\n\(key ?? "")".utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &digest) }
        return prefix + digest.prefix(16).map { String(format: "%02x", $0) }.joined() + ".pdf"
    }

    /// A dot name: a handle can never point at a half-written file.
    static func partName(_ name: String) -> String { ".\(name).part" }
    static func ours(_ name: String) -> Bool { name.hasPrefix(prefix) || name.hasPrefix(partPrefix) }

    static func urlAllowed(_ url: String, debug: Bool) -> Bool {
        guard let c = URLComponents(string: url), let host = c.host, !host.isEmpty else { return false }
        if c.user != nil || c.password != nil { return false }
        switch c.scheme?.lowercased() {
        case "https": return true
        case "http": return debug && (host == "localhost" || host == "127.0.0.1")
        default: return false
        }
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int { u.port ?? (u.scheme?.lowercased() == "https" ? 443 : 80) }
        return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased() && port(a) == port(b)
    }

    /// `%PDF-` in the first 1024 bytes.
    static func looksLikePdf(_ head: Data) -> Bool {
        let magic = Data("%PDF-".utf8)
        return head.prefix(1024).range(of: magic) != nil
    }

    static func maxZoom(_ asked: Double?) -> Double {
        guard let a = asked, !a.isNaN else { return 5 }
        return min(max(a, 1), maxZoomCap)
    }

    /// Files of this plugin older than maxAgeMs, except keep.
    static func toDelete(_ files: [(name: String, modified: Double)], now: Double, maxAgeMs: Double, keep: (String) -> Bool) -> [String] {
        files.filter { ours($0.name) && !keep($0.name) && now - $0.modified >= maxAgeMs }.map(\.name)
    }

    static var debug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}

/// Why there is no PDF: `code` reaches JS as `reason`.
struct PdfFailure: Error { let code: String }

/// Opens and checks PDFs on one queue. PDFKit is thread-safe enough for opening; drawing stays on the main thread.
enum PdfDocs {
    static let queue = DispatchQueue(label: "zn-pdf")

    /// The open document, or a failure: not_found, password, broken.
    static func open(_ url: URL) -> Result<PDFDocument, PdfFailure> {
        guard FileManager.default.fileExists(atPath: url.path) else { return .failure(PdfFailure(code: "not_found")) }
        guard let doc = PDFDocument(url: url) else { return .failure(PdfFailure(code: "broken")) }
        if doc.isLocked { return .failure(PdfFailure(code: "password")) }
        guard doc.pageCount > 0, doc.page(at: 0) != nil else { return .failure(PdfFailure(code: "broken")) }
        return .success(doc)
    }

    static func size(_ page: PDFPage) -> CGSize {
        let b = page.bounds(for: .mediaBox)
        // A page turned by 90° shows sideways: its width is the box's height.
        return page.rotation % 180 == 0 ? b.size : CGSize(width: b.height, height: b.width)
    }

    static func describe(_ url: URL, _ doc: PDFDocument, cached: Bool) -> [String: Any] {
        let first = size(doc.page(at: 0)!)
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
        return ["status": "ok", "handle": ZnHandles.file(url) ?? "", "uri": url.absoluteString, "size": bytes,
                "pages": doc.pageCount, "width": Double(first.width), "height": Double(first.height), "cached": cached]
    }

    static func failed(_ reason: String, _ status: Int? = nil) -> [String: Any] {
        var o: [String: Any] = ["status": "failed", "reason": reason]
        if let status { o["httpStatus"] = status }
        return o
    }

    static func loadJson(_ view: String, _ doc: PDFDocument) -> [String: Any] {
        let first = size(doc.page(at: 0)!)
        return ["view": view, "pages": doc.pageCount, "width": Double(first.width), "height": Double(first.height)]
    }
}

/// The PDF viewers on screen, by view id (for debugZoom). Main thread.
final class PdfViews {
    private var live: [String: ZnPdfViewer] = [:]
    func add(_ id: String, _ v: ZnPdfViewer) { live[id] = v }
    func remove(_ id: String, _ v: ZnPdfViewer) { if live[id] === v { live.removeValue(forKey: id) } }
    func zoom(_ id: String, _ scale: Double) -> Bool { live[id]?.zoom(to: scale) ?? false }
}

// MARK: - The module: download, open, cleanup

final class PdfModule: ZnModuleBase, @unchecked Sendable {
    private let views: PdfViews
    private let downloads = PdfDownloads()

    init(_ views: PdfViews) {
        self.views = views
        super.init("Pdf", version: 1)
        function("download") { call in
            guard let url = call.args["url"] as? String else { throw ZnInvalidArgs("\"url\" must be a string") }
            let key = call.args["key"] as? String
            let max = min(max((call.args["maxBytes"] as? NSNumber)?.int64Value ?? PdfRules.defaultMaxBytes, 1), PdfRules.maxBytes)
            let headers = call.args["headers"] as? [String: String] ?? [:]
            guard PdfRules.urlAllowed(url, debug: PdfRules.debug), let u = URL(string: url) else {
                return call.resolve(PdfDocs.failed("not_allowed"))
            }
            self.downloads.start(call, url: u, name: PdfRules.fileName(url, key), headers: headers, maxBytes: max)
        }
        function("open") { call in
            guard let file = ZnHandles.fileOf(call.args["handle"] as? String ?? "") else { return call.resolve(PdfDocs.failed("not_found")) }
            PdfDocs.queue.async {
                switch PdfDocs.open(file) {
                case .success(let doc): call.resolve(PdfDocs.describe(file, doc, cached: true))
                case .failure(let f): call.resolve(PdfDocs.failed(f.code))
                }
            }
        }
        function("cleanup") { call in
            let age = max((call.args["olderThanMs"] as? NSNumber)?.doubleValue ?? PdfRules.keepMs, 0)
            let keep = Set((call.args["keep"] as? [String] ?? []).compactMap { ZnHandles.fileOf($0)?.lastPathComponent })
            let busy = self.downloads.busyNames()
            PdfDocs.queue.async { call.resolve(Self.cleanup(age, keep: keep.union(busy))) }
        }
        // Debug builds: a test can't pinch, so it zooms this way.
        function("debugZoom", onMain: true) { call in
            guard PdfRules.debug else { return call.reject("debug_only", "debugZoom is for debug builds only") }
            let scale = (call.args["scale"] as? NSNumber)?.doubleValue ?? 2
            call.resolve(views.zoom(call.args["view"] as? String ?? "", scale))
        }
    }

    private static func cleanup(_ age: Double, keep: Set<String>) -> [String: Any] {
        let fm = FileManager.default
        let dir = ZnHandles.fileDir
        let urls = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey], options: [])) ?? []
        let files = urls.compactMap { u -> (name: String, modified: Double)? in
            guard let d = try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return nil }
            return (u.lastPathComponent, d.timeIntervalSince1970 * 1000)
        }
        let names = Set(PdfRules.toDelete(files, now: Date().timeIntervalSince1970 * 1000, maxAgeMs: age) { keep.contains($0) })
        var deleted = 0, bytes: Int64 = 0
        for u in urls where names.contains(u.lastPathComponent) {
            let size = Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            if (try? fm.removeItem(at: u)) != nil { deleted += 1; bytes += size }
        }
        if deleted > 0 { print("zn pdf: cleanup removed \(deleted) files") }
        return ["deleted": deleted, "bytes": bytes]
    }
}

/// One download per file: a second call for the same file joins the first. Written to a dot name and renamed only once
/// PDFKit has opened it, so a kill in the middle leaves nothing a handle can point at.
final class PdfDownloads: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private final class Job {
        let name: String
        let first: URL
        let headers: [String: String]
        let maxBytes: Int64
        var calls: [ZnCall] = []
        var task: URLSessionDataTask?
        var hops = 0
        var refused: String?  // a redirect the rules refuse
        var out: FileHandle?
        var head = Data()
        var total: Int64 = 0
        var failure: String?
        var gone = false
        init(name: String, first: URL, headers: [String: String], maxBytes: Int64) {
            self.name = name; self.first = first; self.headers = headers; self.maxBytes = maxBytes
        }
        var target: URL { ZnHandles.fileDir.appendingPathComponent(name) }
        var part: URL { ZnHandles.fileDir.appendingPathComponent(PdfRules.partName(name)) }
    }

    private let lock = NSLock()
    private var running: [String: Job] = [:]
    private var byTask: [Int: Job] = [:]  // the session's queue only
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 300
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        return URLSession(configuration: c, delegate: self, delegateQueue: q)
    }()

    func busyNames() -> Set<String> {
        lock.withLock { Set(running.keys.flatMap { [$0, PdfRules.partName($0)] }) }
    }

    func start(_ call: ZnCall, url: URL, name: String, headers: [String: String], maxBytes: Int64) {
        let (job, first): (Job, Bool) = lock.withLock {
            if let j = running[name] { j.calls.append(call); return (j, false) }
            let j = Job(name: name, first: url, headers: headers, maxBytes: maxBytes)
            j.calls.append(call)
            running[name] = j
            return (j, true)
        }
        call.onCancel { [weak self] in self?.leave(job, call) }
        guard first else { return }
        // A file from an earlier time: checked, not trusted. A broken one is downloaded again.
        PdfDocs.queue.async {
            let target = job.target
            if FileManager.default.fileExists(atPath: target.path) {
                if case .success(let doc) = PdfDocs.open(target) {
                    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: target.path)  // cleanup goes by last use
                    return self.finish(job, PdfDocs.describe(target, doc, cached: true))
                }
                try? FileManager.default.removeItem(at: target)
            }
            var r = URLRequest(url: url)
            for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
            let task = self.session.dataTask(with: r)
            self.session.delegateQueue.addOperation {
                job.task = task
                self.byTask[task.taskIdentifier] = job
                if job.gone { return }
                task.resume()
            }
        }
    }

    /// JS stopped waiting (the screen closed). The last one to leave stops the download.
    private func leave(_ job: Job, _ call: ZnCall) {
        let stop: Bool = lock.withLock {
            job.calls.removeAll { $0 === call }
            guard job.calls.isEmpty, !job.gone else { return false }
            job.gone = true
            if running[job.name] === job { running.removeValue(forKey: job.name) }
            return true
        }
        if stop { session.delegateQueue.addOperation { job.task?.cancel() } }
    }

    private func finish(_ job: Job, _ answer: [String: Any]) {
        let calls: [ZnCall] = lock.withLock {
            if running[job.name] === job { running.removeValue(forKey: job.name) }
            job.gone = true
            return job.calls
        }
        calls.forEach { $0.resolve(answer) }
    }

    // MARK: URLSession

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let job = byTask[task.taskIdentifier], let next = request.url else { return completionHandler(nil) }
        job.hops += 1
        if job.hops > PdfRules.maxRedirects { return completionHandler(nil) }  // the 3xx itself comes back: "http"
        guard PdfRules.urlAllowed(next.absoluteString, debug: PdfRules.debug) else {
            job.refused = "not_allowed"
            return completionHandler(nil)
        }
        var r = URLRequest(url: next)
        if PdfRules.sameOrigin(job.first, next) { for (k, v) in job.headers { r.setValue(v, forHTTPHeaderField: k) } }
        completionHandler(r)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let job = byTask[dataTask.taskIdentifier] else { return completionHandler(.cancel) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let refused = job.refused { job.failure = refused; return completionHandler(.cancel) }
        guard (200..<300).contains(status) else {
            print("zn pdf: \(job.first.host ?? "?") answered \(status)")
            job.failure = "http:\(status)"
            return completionHandler(.cancel)
        }
        if response.expectedContentLength > job.maxBytes { job.failure = "too_big"; return completionHandler(.cancel) }
        FileManager.default.createFile(atPath: job.part.path, contents: nil)
        job.out = try? FileHandle(forWritingTo: job.part)
        if job.out == nil { job.failure = "failed"; return completionHandler(.cancel) }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let job = byTask[dataTask.taskIdentifier], job.failure == nil else { return }
        if job.head.count < 1024 {
            job.head.append(data.prefix(1024 - job.head.count))
            if job.head.count == 1024 && !PdfRules.looksLikePdf(job.head) { job.failure = "not_pdf"; return dataTask.cancel() }
        }
        job.total += Int64(data.count)
        if job.total > job.maxBytes { job.failure = "too_big"; return dataTask.cancel() }
        do { try job.out?.write(contentsOf: data) } catch {
            job.failure = (error as NSError).code == NSFileWriteOutOfSpaceError ? "no_space" : "failed"
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let job = byTask.removeValue(forKey: task.taskIdentifier) else { return }
        try? job.out?.close()
        let part = job.part, target = job.target
        func fail(_ reason: String) {
            try? FileManager.default.removeItem(at: part)
            print("zn pdf: a download can't be used: \(reason)")
            if reason.hasPrefix("http:") { return finish(job, PdfDocs.failed("http", Int(reason.dropFirst(5)))) }
            finish(job, PdfDocs.failed(reason))
        }
        if job.gone { try? FileManager.default.removeItem(at: part); return }
        if let f = job.failure { return fail(f) }
        if error != nil {
            print("zn pdf: download from \(job.first.host ?? "?") failed")
            return fail("network")
        }
        guard PdfRules.looksLikePdf(job.head) else { return fail("not_pdf") }
        PdfDocs.queue.async {
            switch PdfDocs.open(part) {
            case .failure(let f): fail(f.code == "not_found" ? "failed" : f.code)
            case .success:
                try? FileManager.default.removeItem(at: target)
                do { try FileManager.default.moveItem(at: part, to: target) } catch { return fail("failed") }
                guard case .success(let doc) = PdfDocs.open(target) else { return fail("failed") }
                self.finish(job, PdfDocs.describe(target, doc, cached: false))
            }
        }
    }
}

// MARK: - Views

private func color(_ raw: Any?, _ fallback: UIColor) -> UIColor {
    guard let s = raw as? String, s.hasPrefix("#"), let v = UInt64(s.dropFirst(), radix: 16) else { return fallback }
    switch s.count {
    case 7: return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    case 9: return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: CGFloat(v >> 24) / 255)
    default: return fallback
    }
}

/// `pdf.view`: every page one under the other; scroll, pinch, double tap.
final class ZnPdfViewer: UIView {
    private let scope: ZnViewScope
    private let views: PdfViews
    private let pdf = PDFView()
    private var source: String?
    private var maxZoom = 5.0
    private var initialPage = 1
    private var token = 0
    private var fit: CGFloat = 0
    private var lastPage = -1
    private var sentZoom = 1.0
    private var zoomTimer: Timer?

    init(_ scope: ZnViewScope, _ views: PdfViews) {
        self.scope = scope
        self.views = views
        super.init(frame: .zero)
        clipsToBounds = true
        pdf.displayMode = .singlePageContinuous
        pdf.displayDirection = .vertical
        pdf.autoScales = true
        pdf.pageShadowsEnabled = false
        pdf.frame = bounds
        addSubview(pdf)
        let tap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        pdf.addGestureRecognizer(tap)
        NotificationCenter.default.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdf)
        NotificationCenter.default.addObserver(self, selector: #selector(scaleChanged), name: .PDFViewScaleChanged, object: pdf)
        scope.onProps = { [weak self] p in self?.apply(p) }
        apply(scope.props)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { views.add(scope.id, self) } else { views.remove(scope.id, self) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        pdf.frame = bounds
        setZoomLimits()
    }

    private func apply(_ p: [String: Any]) {
        maxZoom = PdfRules.maxZoom((p["maxZoom"] as? NSNumber)?.doubleValue)
        let gap = CGFloat(min(max((p["pageGap"] as? NSNumber)?.doubleValue ?? 16, 0), 200))
        pdf.displaysPageBreaks = gap > 0
        pdf.pageBreakMargins = UIEdgeInsets(top: gap / 2, left: 0, bottom: gap / 2, right: 0)
        pdf.backgroundColor = color(p["background"], UIColor(red: 0xE5 / 255, green: 0xE7 / 255, blue: 0xEB / 255, alpha: 1))
        backgroundColor = pdf.backgroundColor
        initialPage = (p["initialPage"] as? NSNumber)?.intValue ?? 1
        setZoomLimits()
        let s = p["source"] as? String
        guard s != source else { return }
        source = s
        open(s)
    }

    private func open(_ s: String?) {
        token += 1
        let mine = token
        pdf.document = nil
        lastPage = -1
        guard let s else { return }
        guard let file = ZnHandles.fileOf(s) else { return scope.emit("error", ["reason": "not_found"]) }
        PdfDocs.queue.async {
            let r = PdfDocs.open(file)
            DispatchQueue.main.async { [weak self] in
                guard let self, mine == self.token else { return }
                switch r {
                case .failure(let f): self.scope.emit("error", ["reason": f.code])
                case .success(let doc):
                    self.pdf.document = doc
                    self.pdf.autoScales = true
                    self.setZoomLimits()
                    self.scope.emit("load", PdfDocs.loadJson(self.scope.id, doc))
                    if self.initialPage > 1, let page = doc.page(at: min(self.initialPage, doc.pageCount) - 1) { self.pdf.go(to: page) }
                    self.pageChanged()
                }
            }
        }
    }

    /// Zoom 1 is the page as wide as the view; at most maxZoom times that.
    private func setZoomLimits() {
        guard pdf.document != nil, bounds.width > 0 else { return }
        let f = pdf.scaleFactorForSizeToFit
        guard f > 0 else { return }
        fit = f
        pdf.minScaleFactor = f
        pdf.maxScaleFactor = f * CGFloat(maxZoom)
    }

    @objc private func pageChanged() {
        guard let doc = pdf.document, let page = pdf.currentPage else { return }
        let i = doc.index(for: page)
        guard i != lastPage else { return }
        lastPage = i
        scope.emit("page", ["page": i + 1, "total": doc.pageCount])
    }

    /// Reported once the zoom rests (150 ms, as on Android); 1 is the page as wide as the view.
    @objc private func scaleChanged() {
        zoomTimer?.invalidate()
        zoomTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { [weak self] _ in
            guard let self, self.fit > 0 else { return }
            let z = Double(self.pdf.scaleFactor / self.fit)
            if abs(z - self.sentZoom) > 0.001 {
                self.sentZoom = z
                self.scope.emit("zoom", ["scale": (z * 1000).rounded() / 1000])
            }
        }
    }

    @objc private func doubleTap(_ g: UITapGestureRecognizer) {
        guard fit > 0 else { return }
        let zoomed = pdf.scaleFactor > fit * 1.01
        _ = zoom(to: zoomed ? 1 : min(PdfRules.doubleTapZoom, maxZoom))
    }

    /// Zooms to `scale` (1: as wide as the view) around the middle.
    func zoom(to scale: Double) -> Bool {
        guard fit > 0 else { return false }
        pdf.autoScales = false
        pdf.scaleFactor = fit * CGFloat(min(max(scale, 1), maxZoom))
        return true
    }
}

/// `pdf.preview`: one page, no touch (a tap goes to what is around it).
final class ZnPdfPreview: UIView {
    private let scope: ZnViewScope
    private var source: String?
    private var pageNumber = 1
    private var contain = false
    private var doc: PDFDocument?
    private var token = 0

    init(_ scope: ZnViewScope) {
        self.scope = scope
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        contentMode = .redraw
        clipsToBounds = true
        isAccessibilityElement = true
        accessibilityLabel = "PDF preview"
        scope.onProps = { [weak self] p in self?.apply(p) }
        apply(scope.props)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func apply(_ p: [String: Any]) {
        backgroundColor = color(p["background"], .white)
        pageNumber = max((p["page"] as? NSNumber)?.intValue ?? 1, 1)
        contain = p["fit"] as? String == "contain"
        let s = p["source"] as? String
        if s != source {
            source = s
            open(s)
        }
        setNeedsDisplay()
    }

    private func open(_ s: String?) {
        token += 1
        let mine = token
        doc = nil
        guard let s else { return }
        guard let file = ZnHandles.fileOf(s) else { return scope.emit("error", ["reason": "not_found"]) }
        PdfDocs.queue.async {
            let r = PdfDocs.open(file)
            DispatchQueue.main.async { [weak self] in
                guard let self, mine == self.token else { return }
                switch r {
                case .failure(let f): self.scope.emit("error", ["reason": f.code])
                case .success(let d):
                    self.doc = d
                    self.scope.emit("load", PdfDocs.loadJson(self.scope.id, d))
                    self.setNeedsDisplay()
                }
            }
        }
    }

    override func draw(_ rect: CGRect) {
        guard let doc, let ctx = UIGraphicsGetCurrentContext() else { return }
        let index = min(pageNumber, doc.pageCount) - 1
        guard let page = doc.page(at: index) else { return scope.emit("error", ["reason": "page", "page": index + 1]) }
        let size = PdfDocs.size(page)
        guard size.width > 0, size.height > 0 else { return }
        // width: as wide as the box, from the top. contain: all of it, in the middle (PdfRules.previewPlace).
        let byWidth = bounds.width / size.width
        let scale = contain ? min(byWidth, bounds.height / size.height) : byWidth
        let x = contain ? (bounds.width - size.width * scale) / 2 : 0
        let y = contain ? (bounds.height - size.height * scale) / 2 : 0
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(x: x, y: y, width: size.width * scale, height: size.height * scale))
        ctx.saveGState()
        // PDF space is y-up: flip into the box, then let PDFKit apply the page's rotation and crop.
        ctx.translateBy(x: x, y: y + size.height * scale)
        ctx.scaleBy(x: scale, y: -scale)
        page.draw(with: .mediaBox, to: ctx)
        ctx.restoreGState()
    }
}
