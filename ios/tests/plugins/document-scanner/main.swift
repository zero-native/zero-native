// The document scanner's rules on the Mac (plugins/document-scanner/ios/DocScanRules.swift), with the cases of
// android's DocScanRulesTest.kt that iOS has (no Play services or download states here: iOS has nothing to download),
// plus the iOS-only ones: Camera or Photos (Pavan's decision 6), the picker's limit, the mode for imported pages, and
// Vision's corners.
import Foundation

/// The runtime's error for bad arguments (ZnModules.swift), which the rules throw.
struct ZnInvalidArgs: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func refused(_ name: String, line: Int = #line, _ body: () throws -> Void) {
    count += 1
    do {
        try body()
        failures += 1
        print("FAIL \(name) (line \(line)): not refused")
    } catch is ZnInvalidArgs {
    } catch {
        failures += 1
        print("FAIL \(name) (line \(line)): \(error)")
    }
}

// A job comes back from disk as it went; a broken record is no job
do {
    let job = DocScanJob(id: "a1", tag: "order-1")
    let done = DocScanJob(id: "a1", tag: "order-1", resultCode: -1, pages: ["docscanner-a1-0.jpg", "docscanner-a1-1.jpg"],
                          pdf: "docscanner-a1.pdf", pdfPages: 2)
    func round(_ j: DocScanJob) -> DocScanJob? {
        DocScanJob.from(String(data: try! JSONSerialization.data(withJSONObject: j.json), encoding: .utf8))
    }
    check("job round trip", round(done), done)
    check("waiting job round trip", round(job), job)
    check("no tag round trip", round(DocScanJob(id: "b")), DocScanJob(id: "b"))
    check("broken json", DocScanJob.from("{"), nil)
    check("no id", DocScanJob.from(#"{"tag":"x"}"#), nil)
    check("nothing saved", DocScanJob.from(nil), nil)

    // collect answers only for its own id, and only once the answer is there
    check("collect nothing", DocScanRules.collect(nil, "a1"), .lost)
    check("collect waiting", DocScanRules.collect(job, "a1"), .lost)
    check("collect other id", DocScanRules.collect(done, "other"), .lost)
    check("collect files", DocScanRules.collect(done, "a1"), .files)
    check("collect cancel", DocScanRules.collect(DocScanJob(id: "a1", resultCode: 0), "a1"), .cancel)
    check("collect failed camera", DocScanRules.collect(DocScanJob(id: "a1", resultCode: 1), "a1"), .cancel)
    check("collect empty", DocScanRules.collect(DocScanJob(id: "a1", resultCode: -1), "a1"), .empty)
    check("collect pdf only", DocScanRules.collect(DocScanJob(id: "a1", resultCode: -1, pdf: "docscanner-a1.pdf", pdfPages: 3), "a1"), .files)
}

// Options, and wrong ones refused (the same messages as Android)
do {
    let d = try! DocScanRules.options([:])
    check("defaults", d, DocScanRules.Options(pageLimit: nil, jpeg: true, pdf: false, gallery: false, mode: .full))
    let all = try! DocScanRules.options(["maxNumDocuments": NSNumber(value: 5), "galleryImport": true, "formats": ["pdf", "jpeg", "pdf"], "mode": "filter"])
    check("all set", all, DocScanRules.Options(pageLimit: 5, jpeg: true, pdf: true, gallery: true, mode: .filter))
    check("base", try! DocScanRules.options(["maxNumDocuments": NSNumber(value: 1), "formats": ["jpeg"], "mode": "base"]).mode, .base)
    check("pdf only", try! DocScanRules.options(["formats": ["pdf"]]).jpeg, false)
    check("gallery false", try! DocScanRules.options(["galleryImport": false]).gallery, false)
    refused("limit 0") { _ = try DocScanRules.options(["maxNumDocuments": NSNumber(value: 0)]) }
    refused("limit 101") { _ = try DocScanRules.options(["maxNumDocuments": NSNumber(value: 101)]) }
    refused("no formats") { _ = try DocScanRules.options(["formats": [String]()]) }
    refused("png") { _ = try DocScanRules.options(["formats": ["png"]]) }
    refused("mode auto") { _ = try DocScanRules.options(["mode": "auto"]) }
    refused("long tag") { _ = try DocScanRules.tag(String(repeating: "x", count: 201)) }
    check("tag", try! DocScanRules.tag("order-1"), "order-1")
    check("no tag", try! DocScanRules.tag(nil), nil)
}

// File names can't name a path, and half files have dot names
check("page name", DocScanRules.pageName("a1", 0), "docscanner-a1-0.jpg")
check("pdf name", DocScanRules.pdfName("a1"), "docscanner-a1.pdf")
check("part name", DocScanRules.partName("docscanner-a1.pdf"), ".docscanner-a1.pdf.part")

// Cleanup takes only our old files, never the open scan's or a kept one
do {
    let day = DocScanRules.dayMs, now = 10 * day
    let files: [(String, Double)] = [
        ("docscanner-old-0.jpg", 0), ("docscanner-old.pdf", 0), (".docscanner-old-1.jpg.part", 0), ("docscanner-open-0.jpg", 0),
        ("docscanner-kept-0.jpg", 0), ("docscanner-new-0.jpg", now), ("media-x-0.jpg", 0),
    ]
    check("old ones", DocScanRules.toDelete(files, now: now, maxAgeMs: DocScanRules.keepMs, keep: ["docscanner-kept-0.jpg"], openJob: "open"),
          ["docscanner-old-0.jpg", "docscanner-old.pdf", ".docscanner-old-1.jpg.part"])
    check("all of ours", DocScanRules.toDelete(files, now: now, maxAgeMs: 0, keep: [], openJob: nil).count, 6)
}

// Camera or Photos: galleryImport asks when there is a camera, goes to Photos when there isn't
check("camera only", DocScanRules.source(gallery: false, camera: true), .camera)
check("ask", DocScanRules.source(gallery: true, camera: true), .ask)
check("photos, no camera", DocScanRules.source(gallery: true, camera: false), .photos)
check("nothing", DocScanRules.source(gallery: false, camera: false), nil)

// The picker's limit, the mode for imported pages, Vision's corners
check("pick limit", DocScanRules.pickLimit(5), 5)
check("pick no limit", DocScanRules.pickLimit(nil), 100)
check("full filters", DocScanRules.enhance(.full), true)
check("filter filters", DocScanRules.enhance(.filter), true)
check("base doesn't", DocScanRules.enhance(.base), false)
check("sure", DocScanRules.useCorners(0.9), true)
check("unsure", DocScanRules.useCorners(0.5), false)
do {
    let c = DocScanRules.corners([(0.1, 0.9), (0.9, 0.9), (1.2, -0.1), (0, 0)], width: 1000, height: 2000)
    check("corner xs", c.map(\.0), [100, 900, 1000, 0])
    check("corner ys", c.map(\.1), [1800, 1800, 0, 0])
}

print(failures == 0 ? "ios document-scanner rules: \(count) checks passed" : "ios document-scanner rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
