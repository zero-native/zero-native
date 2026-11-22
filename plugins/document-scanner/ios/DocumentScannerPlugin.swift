// The document scanner's iOS side (plugins/document-scanner, as android/.../DocScanModule.kt and DocScanRules.kt):
// Apple's own document camera (VisionKit's VNDocumentCameraViewController: edges, crop, filters, several pages), as a
// launch through ZnLaunch, so the JS side is the same as on Android.
//
// A scan:
// 1. Before the camera opens, the job (id, tag) is on disk ("zn.docscanner" / "job"), and ZnLaunch has a "waiting" record.
// 2. The camera answers: VisionKit gives the pages as images in memory (not files, as ML Kit does), so they are written at
//    once as our JPEGs (and the PDF, when asked) in ZnHandles.fileDir, the job notes them, then ZnLaunch saves its record
//    and JS hears `result`.
// 3. JS calls `collect` (it describes the files), then acks and calls `forget`.
//
// iOS differences:
// - Nothing to download: getStatus is "available" where VisionKit can scan (a camera), else "unavailable", reason
//   "not_supported" (the simulator). download answers the same and sends it as one `status` event (Android's last
//   one): there is never a "downloading" step. getStatus sends no event, as on Android.
// - VisionKit has no page limit, gallery import or modes: `maxNumDocuments` keeps the first pages. `galleryImport`:
//   an action sheet first (Scan with camera / Choose from Photos / Cancel; Pavan's decision 6), straight to Photos
//   where there is no document camera (DocScanImport.swift: Vision finds the paper, Core Image straightens it).
//   `mode` counts for pages from Photos only ("base" = crop only; "filter" and "full" add Core Image's document
//   filter); with the camera VisionKit's own filter bar lets the user choose.
// - A kill while the camera is open: the pages were only in memory, so the scan is "lost" (Android can bring ML Kit's
//   answer back).
// - What the scan has up (the action sheet, the picker, the camera) can be closed with no answer: ZnPopups closes what
//   was presented over a Sheet or Modal that closes (its S5 rule), and that calls no handler. A watch (twice a second,
//   only while it is up), the next scanDocument and the app's return to the front notice it: the scan ends as a cancel
//   (resultCode 0), so it is never stuck "busy".
// - getStatus says "unavailable" where there is no document camera (the simulator) even though a galleryImport scan
//   works there: every iPhone iOS 17 runs on has one.
// - Debug builds with no camera (the simulator, where VisionKit opens but can't capture): ZN_DOCSCAN_FAKE=<pages> (or "cancel") makes a fake scan of
//   drawn pages, through the same files, job and launch, so the lab can be checked without a camera.
import AVFoundation
import PDFKit
import UIKit
import VisionKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

public struct DocumentScannerPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.module(DocScanModule())
    }
}

final class DocScanModule: ZnModuleBase, @unchecked Sendable {
    private static let key = "docscanner", store = "zn.docscanner", jobKey = "job"
    private let queue = DispatchQueue(label: "zn-docscan")
    // Main thread only: the scan whose camera is open.
    private var open: (id: String, options: DocScanRules.Options)?
    private var count = 0
    private lazy var delegate = CameraDelegate(self)
    // Main thread only: the Photos picker's delegate while it is open.
    private var importer: DocScanImport?
    // Main thread only: the controller the scan has up (the action sheet, the picker, the camera) until it answers, and
    // the watch that notices it went away with no answer.
    private weak var shown: UIViewController?
    private var uiUp = false
    private var watch: Timer?
    private var goneTicks = 0

    private static var fake: String? {
        #if DEBUG
        guard AVCaptureDevice.default(for: .video) == nil else { return nil }  // the simulator: VisionKit opens, can't capture
        return ProcessInfo.processInfo.environment["ZN_DOCSCAN_FAKE"]
        #else
        return nil
        #endif
    }

    private static var status: [String: Any] {
        VNDocumentCameraViewController.isSupported || fake != nil ? ["status": "available"] : ["status": "unavailable", "reason": "not_supported"]
    }

    init() {
        super.init("DocumentScanner", version: 1)
        function("getStatus") { call in call.resolve(Self.status) }
        // Nothing to download on iOS: the end comes at once, as Android's last `status` event (DocScanModule.kt
        // endDownload: the event, then the answer), so a JS onStatus listener waiting for the end hears it.
        function("download") { call in
            let now = Self.status
            self.emit("status", now)
            call.resolve(now)
        }
        function("scanDocument", onMain: true) { call in
            let options = try DocScanRules.options(call.args)
            let tag = try DocScanRules.tag(call.args["tag"] as? String)
            MainActor.assumeIsolated { self.scan(call, options, tag) }
        }
        function("collect") { call in
            guard let id = call.args["id"] as? String else { throw ZnInvalidArgs("\"id\" must be a string") }
            self.queue.async { call.resolve(self.collect(id)) }
        }
        // JS has acked this launch. The files stay until cleanup or the 7-day trim removes them.
        function("forget") { call in
            guard let id = call.args["id"] as? String else { throw ZnInvalidArgs("\"id\" must be a string") }
            if Self.read()?.id == id {
                ZNStorage.remove(Self.store, key: Self.jobKey)
                ZNStorage.flush(Self.store)
            }
            call.resolve(true)
        }
        function("cleanup") { call in
            let age = max((call.args["olderThanMs"] as? NSNumber)?.doubleValue ?? DocScanRules.dayMs, 0)
            let keep = Set((call.args["keep"] as? [String] ?? []).compactMap { ZnHandles.fileOf($0)?.lastPathComponent })
            self.queue.async { call.resolve(self.trim(age, keep)) }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.uiGone() == true { self?.dropGone() } }
        }
    }

    private static func read() -> DocScanJob? { DocScanJob.from(ZNStorage.string(store, key: jobKey)) }

    private static func write(_ job: DocScanJob) {
        guard let json = ZnModules.json(job.json) else { return }
        ZNStorage.set(store, key: jobKey, string: json)
        ZNStorage.flush(store)
    }

    // MARK: A scan

    @MainActor private func scan(_ call: ZnCall, _ options: DocScanRules.Options, _ tag: String?) {
        let camera = VNDocumentCameraViewController.isSupported || Self.fake != nil
        guard let source = DocScanRules.source(gallery: options.gallery, camera: camera) else {
            return call.resolve(["launched": false, "reason": "not_supported", "unavailable": true])
        }
        if uiGone() { dropGone() }  // closed with no answer: that scan is over
        if open != nil { return call.resolve(["launched": false, "reason": "busy"]) }
        guard let top = znTopController() else { return call.resolve(["launched": false, "reason": "no_activity"]) }
        count += 1
        let id = "\(Int(Date().timeIntervalSince1970 * 1000))-\(count)"
        let before = ZNStorage.string(Self.store, key: Self.jobKey)
        Self.write(DocScanJob(id: id, tag: tag))
        let started = ZnLaunch.start(Self.key, id: id)
        guard started.launched else {  // a refused launch must not wipe a result still waiting for JS
            if let before { ZNStorage.set(Self.store, key: Self.jobKey, string: before) } else { ZNStorage.remove(Self.store, key: Self.jobKey) }
            ZNStorage.flush(Self.store)
            return call.resolve(["launched": false, "reason": started.reason ?? "failed", "id": id])
        }
        open = (id, options)
        call.resolve(["launched": true, "id": id])
        switch source {
        case .camera: openCamera(top)
        case .photos: openPhotos(top, options)
        case .ask: ask(top, options)
        }
    }

    /// Pavan's decision 6: with galleryImport, an action sheet first (VisionKit's camera has no import button). Cancel
    /// ends the scan as the camera's cancel does (resultCode 0).
    @MainActor private func ask(_ top: UIViewController, _ options: DocScanRules.Options) {
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Scan with camera", style: .default) { _ in self.uiAnswered(); self.openCamera(top) })
        sheet.addAction(UIAlertAction(title: "Choose from Photos", style: .default) { _ in self.uiAnswered(); self.openPhotos(top, options) })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.answer(pages: nil) })
        if let pop = sheet.popoverPresentationController {  // iPad: a popover in the middle, no arrow
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        show(sheet, over: top)
    }

    @MainActor private func openPhotos(_ top: UIViewController, _ options: DocScanRules.Options) {
        let (me, picker) = DocScanImport.make(options: options, picked: { [weak self] in self?.uiAnswered() }) { [weak self] pages in
            self?.importer = nil
            self?.answer(pages: pages)
        }
        importer = me
        show(picker, over: top)
    }

    // MARK: What the scan has up

    @MainActor private func show(_ vc: UIViewController, over top: UIViewController) {
        shown = vc
        uiUp = true
        goneTicks = 0
        top.present(vc, animated: true)
        if watch == nil {
            watch = Timer.scheduledTimer(withTimeInterval: DocScanRules.watchSeconds, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        }
    }

    /// It answered (a button, a pick, the camera's delegate): nothing to watch until the next one is up.
    @MainActor private func uiAnswered() {
        uiUp = false
        shown = nil
        watch?.invalidate()
        watch = nil
    }

    /// The scan's controller is gone (or no longer presented) and it never answered.
    @MainActor private func uiGone() -> Bool {
        guard open != nil, uiUp else { return false }
        guard let s = shown else { return true }
        return DocScanRules.gone(presented: s.presentingViewController != nil, appearing: s.isBeingPresented)
    }

    /// Gone on two ticks in a row: an action's handler runs just after the action sheet has gone.
    @MainActor private func tick() {
        goneTicks = uiGone() ? goneTicks + 1 : 0
        if goneTicks >= 2 { dropGone() }
    }

    @MainActor private func dropGone() {
        print("zn docscanner: the \(shown.map { "\(type(of: $0))" } ?? "scan's controller") went away with no answer: cancelled")
        importer = nil
        answer(pages: nil)
    }

    @MainActor private func openCamera(_ top: UIViewController) {
        if let fake = Self.fake {
            print("zn docscanner: no document camera; a fake scan (ZN_DOCSCAN_FAKE=\(fake))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if fake == "cancel" { return self.answer(pages: nil) }
                self.answer(pages: (0..<max(Int(fake) ?? 2, 1)).map { DocScanPage(image: Self.fakePage($0)) })
            }
            return
        }
        let camera = VNDocumentCameraViewController()
        camera.delegate = delegate
        camera.modalPresentationStyle = .fullScreen
        show(camera, over: top)
    }

    /// VisionKit's delegate must be an NSObject: this one forwards to the module.
    private final class CameraDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
        weak var module: DocScanModule?
        init(_ m: DocScanModule) { module = m }

        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let pages = (0..<scan.pageCount).map { DocScanPage(image: scan.imageOfPage(at: $0)) }
            c.dismiss(animated: true)
            MainActor.assumeIsolated { module?.answer(pages: pages) }
        }

        func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) {
            c.dismiss(animated: true)
            MainActor.assumeIsolated { module?.answer(pages: nil) }
        }

        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError error: Error) {
            print("zn docscanner: the camera failed: \((error as NSError).code)")
            c.dismiss(animated: true)
            MainActor.assumeIsolated { module?.answer(pages: nil, code: 1) }
        }
    }

    /// The camera's answer: the files are written, the job notes them, then ZnLaunch tells JS. nil pages: cancelled.
    @MainActor fileprivate func answer(pages images: [DocScanPage]?, code: Int = 0) {
        uiAnswered()
        guard let (id, options) = open else { return }
        open = nil
        guard var images, !images.isEmpty else { return finish(id, code: code, pages: [], pdf: nil, pdfPages: 0) }
        if let limit = options.pageLimit { images = Array(images.prefix(limit)) }
        queue.async {
            var pages: [String] = [], pdf: String?
            do {
                if options.jpeg {
                    for (i, img) in images.enumerated() {
                        let name = DocScanRules.pageName(id, i)
                        // Pages from Photos are JPEG already (encoded once); the camera's are encoded here.
                        guard let data = img.jpeg ?? img.image.jpegData(compressionQuality: DocScanRules.jpegQuality) else {
                            throw DocScanFailure(code: "write_failed")
                        }
                        try Self.put(data, name)
                        pages.append(name)
                    }
                }
                if options.pdf {
                    let doc = PDFDocument()
                    for (i, img) in images.enumerated() { if let p = PDFPage(image: img.image) { doc.insert(p, at: i) } }
                    guard let data = doc.dataRepresentation() else { throw DocScanFailure(code: "write_failed") }
                    try Self.put(data, DocScanRules.pdfName(id))
                    pdf = DocScanRules.pdfName(id)
                }
            } catch {
                print("zn docscanner: the files can't be written: \((error as? DocScanFailure)?.code ?? "write_failed")")
                pages = []
                pdf = nil
            }
            let count = pdf == nil ? 0 : images.count
            DispatchQueue.main.async { self.finish(id, code: -1, pages: pages, pdf: pdf, pdfPages: count) }
        }
    }

    @MainActor private func finish(_ id: String, code: Int, pages: [String], pdf: String?, pdfPages: Int) {
        guard var job = Self.read(), job.id == id, job.resultCode == nil else { return }
        job.resultCode = code
        job.pages = pages
        job.pdf = pdf
        job.pdfPages = pdfPages
        Self.write(job)
        print("zn docscanner: result \(code), \(pages.count) pages, pdf \(pdf != nil)")
        ZnLaunch.finish(Self.key, id: id, resultCode: code, extras: ["pages": pages.count, "pdf": pdf != nil])
    }

    /// Writes a whole file: a dot part first, then its name, so a handle never names a half-written file.
    private static func put(_ data: Data, _ name: String) throws {
        let dir = ZnHandles.fileDir
        let part = dir.appendingPathComponent(DocScanRules.partName(name)), target = dir.appendingPathComponent(name)
        do {
            try data.write(to: part)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: part, to: target)
        } catch {
            try? FileManager.default.removeItem(at: part)
            throw DocScanFailure(code: (error as NSError).code == NSFileWriteOutOfSpaceError ? "no_space" : "write_failed")
        }
    }

    // MARK: collect and cleanup (the plugin's queue)

    private func collect(_ id: String) -> [String: Any] {
        let job = Self.read()
        var base: [String: Any] = ["id": id, "pages": [Any](), "pdf": NSNull(), "scannedImages": [Any]()]
        if let job, job.id == id, let tag = job.tag { base["tag"] = tag }
        switch DocScanRules.collect(job, id) {
        case .lost: return base.merging(["status": "lost"]) { $1 }
        case .cancel: return base.merging(["status": "cancel"]) { $1 }
        case .empty: return base.merging(["status": "failed", "reason": "no_file"]) { $1 }
        case .files: break
        }
        let dir = ZnHandles.fileDir
        var pages: [[String: Any]] = []
        for name in job!.pages {
            let url = dir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path), let handle = ZnHandles.file(url) else {
                return base.merging(["status": "failed", "reason": "access_lost"]) { $1 }  // cleared since: scan again
            }
            let size = UIImage(contentsOfFile: url.path).map { ($0.size.width * $0.scale, $0.size.height * $0.scale) } ?? (0, 0)
            pages.append(["handle": handle, "uri": url.absoluteString, "width": Int(size.0), "height": Int(size.1), "size": Self.bytes(url)])
        }
        base["pages"] = pages
        if let name = job!.pdf {
            let url = dir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path), let handle = ZnHandles.file(url) else {
                return base.merging(["status": "failed", "reason": "access_lost", "pages": [Any]()]) { $1 }
            }
            base["pdf"] = ["handle": handle, "uri": url.absoluteString, "pageCount": job!.pdfPages, "size": Self.bytes(url)]
        }
        _ = trim(DocScanRules.keepMs, [])
        return base.merging(["status": "success"]) { $1 }
    }

    private static func bytes(_ url: URL) -> Int64 {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
    }

    /// Our files only (the `docscanner-` names), never one of the open job.
    private func trim(_ maxAgeMs: Double, _ keep: Set<String>) -> [String: Any] {
        let fm = FileManager.default, dir = ZnHandles.fileDir
        let urls = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let files = urls.compactMap { u -> (String, Double)? in
            guard let d = try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return nil }
            return (u.lastPathComponent, d.timeIntervalSince1970 * 1000)
        }
        let openJob = Self.read().flatMap { $0.resultCode == nil ? $0.id : nil }
        let names = Set(DocScanRules.toDelete(files, now: Date().timeIntervalSince1970 * 1000, maxAgeMs: maxAgeMs, keep: keep, openJob: openJob))
        var deleted = 0, bytes: Int64 = 0
        for u in urls where names.contains(u.lastPathComponent) {
            let size = Self.bytes(u)
            if (try? fm.removeItem(at: u)) != nil { deleted += 1; bytes += size }
        }
        if deleted > 0 { print("zn docscanner: cleanup removed \(deleted) files") }
        return ["deleted": deleted, "bytes": bytes]
    }

    /// A page for the debug fake: a white sheet with its number and some lines.
    private static func fakePage(_ i: Int) -> UIImage {
        let size = CGSize(width: 1240, height: 1754)
        return UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let title = "Fake page \(i + 1)" as NSString
            title.draw(at: CGPoint(x: 100, y: 120), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 72), .foregroundColor: UIColor.black])
            UIColor.gray.setFill()
            for row in 0..<12 { ctx.fill(CGRect(x: 100, y: 300 + row * 100, width: 1000, height: 20)) }
        }
    }
}

struct DocScanFailure: Error { let code: String }

/// A scanned page: its picture, and its JPEG when it was made as one (pages from Photos), so it isn't encoded twice.
struct DocScanPage {
    let image: UIImage
    var jpeg: Data?
}
