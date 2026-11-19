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
//   "not_supported" (the simulator). download answers the same.
// - VisionKit has no page limit, gallery import or modes: `maxNumDocuments` keeps the first pages, `galleryImport` and
//   `mode` are checked and ignored.
// - A kill while the camera is open: the pages were only in memory, so the scan is "lost" (Android can bring ML Kit's
//   answer back).
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

/// One scan's record (DocScanJob in DocScanRules.kt). `pages` and `pdf` are our own file names here.
struct DocScanJob {
    var id: String
    var tag: String?
    var resultCode: Int?
    var pages: [String] = []
    var pdf: String?
    var pdfPages = 0

    var json: [String: Any] {
        ["id": id, "tag": tag ?? NSNull(), "resultCode": resultCode.map { $0 as Any } ?? NSNull(), "pages": pages,
         "pdf": pdf ?? NSNull(), "pdfPages": pdfPages]
    }

    static func from(_ raw: String?) -> DocScanJob? {
        guard let raw, let o = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any], let id = o["id"] as? String else { return nil }
        return DocScanJob(id: id, tag: o["tag"] as? String, resultCode: (o["resultCode"] as? NSNumber)?.intValue,
                          pages: o["pages"] as? [String] ?? [], pdf: o["pdf"] as? String, pdfPages: (o["pdfPages"] as? NSNumber)?.intValue ?? 0)
    }
}

/// The plugin's rules (DocScanRules.kt), apart from UIKit.
enum DocScanRules {
    static let maxPages = 100
    static let keepMs: Double = 7 * 24 * 3600 * 1000
    static let dayMs: Double = 24 * 3600 * 1000
    static let prefix = "docscanner-"

    struct Options { let pageLimit: Int?; let jpeg: Bool; let pdf: Bool }

    static func options(_ args: [String: Any]) throws -> Options {
        let limit = (args["maxNumDocuments"] as? NSNumber)?.intValue
        if let l = limit, !(1...maxPages).contains(l) { throw ZnInvalidArgs("\"maxNumDocuments\" must be 1 to \(maxPages)") }
        let formats = args["formats"] as? [String] ?? ["jpeg"]
        if formats.isEmpty { throw ZnInvalidArgs("\"formats\" must have \"jpeg\", \"pdf\" or both") }
        for f in formats where f != "jpeg" && f != "pdf" { throw ZnInvalidArgs("\"formats\" can't have \"\(f)\": only \"jpeg\" and \"pdf\"") }
        if let m = args["mode"] as? String, !["full", "filter", "base"].contains(m) {
            throw ZnInvalidArgs("\"mode\" must be \"full\", \"filter\" or \"base\", got \"\(m)\"")
        }
        return Options(pageLimit: limit, jpeg: formats.contains("jpeg"), pdf: formats.contains("pdf"))
    }

    static func tag(_ t: String?) throws -> String? {
        if let t, t.count > 200 { throw ZnInvalidArgs("\"tag\" must be 200 characters or fewer") }
        return t
    }

    enum Collect { case lost, cancel, files, empty }

    static func collect(_ job: DocScanJob?, _ id: String) -> Collect {
        guard let job, job.id == id, let code = job.resultCode else { return .lost }
        if code != -1 { return .cancel }
        return job.pages.isEmpty && job.pdf == nil ? .empty : .files
    }

    static func pageName(_ id: String, _ i: Int) -> String { "\(prefix)\(id)-\(i).jpg" }
    static func pdfName(_ id: String) -> String { "\(prefix)\(id).pdf" }
    static func partName(_ name: String) -> String { ".\(name).part" }

    static func toDelete(_ files: [(String, Double)], now: Double, maxAgeMs: Double, keep: Set<String>, openJob: String?) -> [String] {
        files.filter { name, modified in
            let ours = name.hasPrefix(prefix) || (name.hasPrefix(".\(prefix)") && name.hasSuffix(".part"))
            return ours && !keep.contains(name) && (openJob == nil || !name.contains("\(prefix)\(openJob!)")) && now - modified >= maxAgeMs
        }.map(\.0)
    }
}

final class DocScanModule: ZnModuleBase, @unchecked Sendable {
    private static let key = "docscanner", store = "zn.docscanner", jobKey = "job"
    private let queue = DispatchQueue(label: "zn-docscan")
    // Main thread only: the scan whose camera is open.
    private var open: (id: String, options: DocScanRules.Options)?
    private var count = 0
    private lazy var delegate = CameraDelegate(self)

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
        function("download") { call in call.resolve(Self.status) }  // nothing to download on iOS
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
    }

    private static func read() -> DocScanJob? { DocScanJob.from(ZNStorage.string(store, key: jobKey)) }

    private static func write(_ job: DocScanJob) {
        guard let json = ZnModules.json(job.json) else { return }
        ZNStorage.set(store, key: jobKey, string: json)
        ZNStorage.flush(store)
    }

    // MARK: A scan

    @MainActor private func scan(_ call: ZnCall, _ options: DocScanRules.Options, _ tag: String?) {
        guard VNDocumentCameraViewController.isSupported || Self.fake != nil else {
            return call.resolve(["launched": false, "reason": "not_supported", "unavailable": true])
        }
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
        if let fake = Self.fake {
            print("zn docscanner: no document camera; a fake scan (ZN_DOCSCAN_FAKE=\(fake))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                if fake == "cancel" { return self.answer(images: nil) }
                self.answer(images: (0..<max(Int(fake) ?? 2, 1)).map(Self.fakePage))
            }
            return
        }
        let camera = VNDocumentCameraViewController()
        camera.delegate = delegate
        camera.modalPresentationStyle = .fullScreen
        top.present(camera, animated: true)
    }

    /// VisionKit's delegate must be an NSObject: this one forwards to the module.
    private final class CameraDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
        weak var module: DocScanModule?
        init(_ m: DocScanModule) { module = m }

        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            let images = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
            c.dismiss(animated: true)
            MainActor.assumeIsolated { module?.answer(images: images) }
        }

        func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) {
            c.dismiss(animated: true)
            MainActor.assumeIsolated { module?.answer(images: nil) }
        }

        func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError error: Error) {
            print("zn docscanner: the camera failed: \((error as NSError).code)")
            c.dismiss(animated: true)
            MainActor.assumeIsolated { module?.answer(images: nil, code: 1) }
        }
    }

    /// The camera's answer: the files are written, the job notes them, then ZnLaunch tells JS. nil images: cancelled.
    @MainActor fileprivate func answer(images: [UIImage]?, code: Int = 0) {
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
                        guard let data = img.jpegData(compressionQuality: 0.85) else { throw DocScanFailure(code: "write_failed") }
                        try Self.put(data, name)
                        pages.append(name)
                    }
                }
                if options.pdf {
                    let doc = PDFDocument()
                    for (i, img) in images.enumerated() { if let p = PDFPage(image: img) { doc.insert(p, at: i) } }
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
