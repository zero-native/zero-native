// The document scanner's rules with no UIKit in them (android/.../DocScanRules.kt), so a Mac unit suite checks them
// (ios/tests/plugins/document-scanner, bun run tools/ios-unit-test.ts plugins/document-scanner). Foundation only.
import Foundation
#if SWIFT_PACKAGE
import ZnRuntime
#endif

/// One scan's record (DocScanJob in DocScanRules.kt). `pages` and `pdf` are our own file names here.
struct DocScanJob: Equatable {
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

    /// ML Kit's modes. With the camera VisionKit's own filter bar lets the user choose, so they count only for pages
    /// from Photos: "base" = crop only, "filter" = crop and Core Image's document filter. ML Kit's "full" (also stain
    /// and finger removal) has no Apple equivalent, so it is "filter".
    enum Mode: String { case full, filter, base }

    struct Options: Equatable {
        let pageLimit: Int?
        let jpeg: Bool
        let pdf: Bool
        var gallery = false
        var mode = Mode.full
    }

    static func options(_ args: [String: Any]) throws -> Options {
        let limit = (args["maxNumDocuments"] as? NSNumber)?.intValue
        if let l = limit, !(1...maxPages).contains(l) { throw ZnInvalidArgs("\"maxNumDocuments\" must be 1 to \(maxPages)") }
        let formats = args["formats"] as? [String] ?? ["jpeg"]
        if formats.isEmpty { throw ZnInvalidArgs("\"formats\" must have \"jpeg\", \"pdf\" or both") }
        for f in formats where f != "jpeg" && f != "pdf" { throw ZnInvalidArgs("\"formats\" can't have \"\(f)\": only \"jpeg\" and \"pdf\"") }
        var mode = Mode.full
        if let m = args["mode"] as? String {
            guard let known = Mode(rawValue: m) else { throw ZnInvalidArgs("\"mode\" must be \"full\", \"filter\" or \"base\", got \"\(m)\"") }
            mode = known
        }
        return Options(pageLimit: limit, jpeg: formats.contains("jpeg"), pdf: formats.contains("pdf"),
                       gallery: args["galleryImport"] as? Bool ?? false, mode: mode)
    }

    static func tag(_ t: String?) throws -> String? {
        if let t, t.count > 200 { throw ZnInvalidArgs("\"tag\" must be 200 characters or fewer") }
        return t
    }

    // MARK: Camera or Photos (Pavan's decision 6: an action sheet)

    enum Source: Equatable { case camera, photos, ask }

    /// Where a scan's pages come from. nil: nowhere (no document camera and no gallery import): "not_supported".
    /// galleryImport with a camera asks (Camera / Photos); with no camera (the simulator) it goes to Photos at once.
    static func source(gallery: Bool, camera: Bool) -> Source? {
        switch (gallery, camera) {
        case (true, true): return .ask
        case (true, false): return .photos
        case (false, true): return .camera
        case (false, false): return nil
        }
    }

    /// How many photos the picker lets the user choose: the page limit, else ML Kit's 100.
    static func pickLimit(_ pageLimit: Int?) -> Int { pageLimit ?? maxPages }

    /// Core Image's document filter on a page from Photos.
    static func enhance(_ mode: Mode) -> Bool { mode != .base }

    /// A photo is read at most this big on its long side (memory: one page at a time, never a 48 MP original).
    static let maxSide = 4096

    /// The document Vision found counts only above this confidence; else the page is the whole photo.
    static let minConfidence: Float = 0.5

    static func useCorners(_ confidence: Float) -> Bool { confidence > minConfidence }

    /// Vision's corners (0 to 1, from the bottom left) in pixels of a w x h picture, also from the bottom left as Core
    /// Image counts. A corner outside the picture is pulled back to its edge.
    static func corners(_ normalized: [(Double, Double)], width: Double, height: Double) -> [(Double, Double)] {
        normalized.map { (min(max($0.0, 0), 1) * width, min(max($0.1, 0), 1) * height) }
    }

    // MARK: Collect, names and cleanup

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
