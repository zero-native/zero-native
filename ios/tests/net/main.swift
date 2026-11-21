// fetch's plain rules on the Mac (ZnNetRules.swift): tools/ios-unit-test.ts builds this with sources.txt. The
// throttle cases are android/runtime's ZnFetchTest.kt (ProgressThrottler); the multipart layout is OkHttp's
// MultipartBody (what Android sends). Argument: a scratch folder.
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func checkThrows(_ name: String, _ want: ZnMultipartError, line: Int = #line, _ body: () throws -> Void) {
    count += 1
    do {
        try body()
        failures += 1
        print("FAIL \(name) (line \(line)): no error, want \(want)")
    } catch let e as ZnMultipartError {
        if e != want {
            failures += 1
            print("FAIL \(name) (line \(line)): got \(e), want \(want)")
        }
    } catch {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(error), want \(want)")
    }
}

struct Pair: Equatable, CustomStringConvertible {
    let loaded: Int64, total: Int64
    var description: String { "\(loaded)/\(total)" }
}

let work = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory())
    .appendingPathComponent("net", isDirectory: true)
try? FileManager.default.removeItem(at: work)
try! FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

// MARK: Throttle (ZnFetchTest.progressThrottlerLimitsEventsTo100msAndFinishesOnce)

do {
    var now = 1.0
    var emitted: [Pair] = []
    let t = ZnProgressThrottle(minInterval: 0.1, clock: { now }) { emitted.append(Pair(loaded: $0, total: $1)) }
    t.update(10, 100)
    check("first event goes out", emitted, [Pair(loaded: 10, total: 100)])
    now = 1.05
    t.update(30, 100)
    check("50 ms later: held", emitted.count, 1)
    now = 1.11
    t.update(60, 100)
    check("110 ms later: goes out", emitted.last, Pair(loaded: 60, total: 100))
    t.finish(100, 100)
    check("finish sends the final count", emitted.last, Pair(loaded: 100, total: 100))
    check("three events", emitted.count, 3)
    t.finish(100, 100)
    check("finish again: no copy", emitted.count, 3)
}

// The first event goes out whatever the clock says (Android's starts at 0 with elapsedRealtime; ours at -infinity).
do {
    var emitted: [Pair] = []
    let t = ZnProgressThrottle(clock: { 0 }) { emitted.append(Pair(loaded: $0, total: $1)) }
    t.update(5, -1)
    check("first event at clock 0", emitted, [Pair(loaded: 5, total: -1)])
}

// Unknown size (uploadProgressWithUnknownLengthEndsWithBytesWritten): every event has total -1, the last the bytes.
do {
    var emitted: [Pair] = []
    let t = ZnProgressThrottle(clock: { 1 }) { emitted.append(Pair(loaded: $0, total: $1)) }
    for loaded in [8192, 16384, 16484] as [Int64] { t.update(loaded, -1) }
    t.finish(16484, -1)
    check("unknown size: last is the bytes", emitted.last, Pair(loaded: 16484, total: -1))
    check("unknown size: total -1 throughout", emitted.allSatisfy { $0.total == -1 }, true)
}

// An empty body: only finish(0, 0), which goes out once (CountingRequestBody.onDone(0, 0)).
do {
    var emitted: [Pair] = []
    let t = ZnProgressThrottle { emitted.append(Pair(loaded: $0, total: $1)) }
    t.finish(0, 0)
    check("empty body: one 0/0", emitted, [Pair(loaded: 0, total: 0)])
}

// MARK: Multipart layout

/// byte i of a lab file is i % 251 (as tools/fetch-test-server.ts --files makes them).
func makeFile(_ name: String, _ size: Int) -> URL {
    let url = work.appendingPathComponent(name)
    FileManager.default.createFile(atPath: url.path, contents: nil)
    let h = try! FileHandle(forWritingTo: url)
    var at = 0
    let piece = 1 << 20
    while at < size {
        let n = min(piece, size - at)
        autoreleasepool {
            var d = Data(count: n)
            d.withUnsafeMutableBytes { (b: UnsafeMutableRawBufferPointer) in
                for i in 0..<n { b[i] = UInt8((at + i) % 251) }
            }
            try! h.write(contentsOf: d)
        }
        at += n
    }
    try! h.close()
    return url
}

let threeMB = 3 * 1024 * 1024 + 17  // not a multiple of the copy size
let photo = makeFile("photo 1.jpg", threeMB)
let bodyURL = work.appendingPathComponent("body.multipart")
let boundary = "zn-TEST"

do {
    let parts: [[Any]] = [
        ["storeId", "42"],
        ["receipt", photo.absoluteString, "photo 1.jpg", "image/jpeg"],
        ["note", "नमस्ते"],
    ]
    let n = try ZnMultipart.write(parts: parts, boundary: boundary, to: bodyURL)
    let got = try Data(contentsOf: bodyURL)
    var want = Data()
    func add(_ s: String) { want.append(Data(s.utf8)) }
    add("--zn-TEST\r\nContent-Disposition: form-data; name=\"storeId\"\r\nContent-Length: 2\r\n\r\n42\r\n")
    add("--zn-TEST\r\nContent-Disposition: form-data; name=\"receipt\"; filename=\"photo 1.jpg\"\r\nContent-Type: image/jpeg\r\n")
    add("Content-Length: \(threeMB)\r\n\r\n")
    want.append(try Data(contentsOf: photo))
    add("\r\n")
    add("--zn-TEST\r\nContent-Disposition: form-data; name=\"note\"\r\nContent-Length: 18\r\n\r\nनमस्ते\r\n")
    add("--zn-TEST--\r\n")
    check("layout: byte for byte", got == want, true)
    check("layout: returned length", n, Int64(want.count))
    check("layout: length is the file's", Int64((try FileManager.default.attributesOfItem(atPath: bodyURL.path)[.size] as! NSNumber).int64Value), n)
} catch {
    failures += 1
    print("FAIL layout: \(error)")
}

// Header injection: " CR LF in a name or file name are escaped as OkHttp does; a bad type is left out.
do {
    let parts: [[Any]] = [
        ["a\"b", "x"],
        ["f", photo.absoluteString, "evil\".jpg\r\nX-Evil: 1", "text/plain\r\nX-Evil: 2"],
    ]
    _ = try ZnMultipart.write(parts: parts, boundary: boundary, to: bodyURL)
    let text = String(decoding: try Data(contentsOf: bodyURL).prefix(400), as: UTF8.self)
    check("escaped name", text.contains("name=\"a%22b\"\r\n"), true)
    check("escaped filename", text.contains("filename=\"evil%22.jpg%0D%0AX-Evil: 1\"\r\n"), true)
    check("no injected header", text.contains("\r\nX-Evil"), false)
    check("bad type left out", text.contains("Content-Type"), false)
} catch {
    failures += 1
    print("FAIL escaping: \(error)")
}

check("quoted plain", ZnMultipart.quoted("receipt.jpg"), "\"receipt.jpg\"")
check("quoted unicode", ZnMultipart.quoted("बिल.pdf"), "\"बिल.pdf\"")
check("type jpeg", ZnMultipart.isMediaType("image/jpeg"), true)
check("type with charset", ZnMultipart.isMediaType("text/plain; charset=utf-8"), true)
check("type vendor", ZnMultipart.isMediaType("application/vnd.api+json"), true)
check("type no slash", ZnMultipart.isMediaType("jpeg"), false)
check("type empty", ZnMultipart.isMediaType(""), false)
check("type CRLF", ZnMultipart.isMediaType("image/jpeg\r\nX: 1"), false)
check("type non-ASCII", ZnMultipart.isMediaType("image/jpég"), false)

// Part URIs.
checkThrows("content:// refused", .invalid("form part \"f\": content:// is an Android content URI; on iOS pass the file:// uri the plugin gave")) {
    _ = try ZnMultipart.write(parts: [["f", "content://media/external/images/1", "a.jpg", "image/jpeg"]], boundary: boundary, to: bodyURL)
}
check("refused: no file left", FileManager.default.fileExists(atPath: bodyURL.path), false)
checkThrows("http refused", .invalid("form part \"f\": needs a file:// uri on iOS, got \"https://x.test/a.jpg\"")) {
    _ = try ZnMultipart.write(parts: [["f", "https://x.test/a.jpg", "a.jpg", "image/jpeg"]], boundary: boundary, to: bodyURL)
}
do {
    let missing = work.appendingPathComponent("gone.jpg")
    _ = try ZnMultipart.write(parts: [["f", missing.absoluteString, "gone.jpg", "image/jpeg"]], boundary: boundary, to: bodyURL)
    failures += 1
    print("FAIL missing file: no error")
} catch let e as ZnMultipartError {
    count += 1
    if case .invalid(let m) = e, m.hasPrefix("form part \"f\": can't read \(work.path)/gone.jpg") {} else {
        failures += 1
        print("FAIL missing file: \(e)")
    }
}
do {
    _ = try ZnMultipart.write(parts: [["f", work.absoluteString, "dir", "image/jpeg"]], boundary: boundary, to: bodyURL)
    failures += 1
    print("FAIL a folder: no error")
} catch let e as ZnMultipartError {
    count += 1
    if case .invalid = e {} else { failures += 1; print("FAIL a folder: \(e)") }
}
checkThrows("no name", .invalid("a form part has no name")) {
    _ = try ZnMultipart.write(parts: [[42, "x"]], boundary: boundary, to: bodyURL)
}
// A path with a space that JS didn't percent-encode.
do {
    let raw = "file://" + photo.path
    check("raw space in path", try ZnMultipart.fileURL(raw, part: "f").path, photo.path)
    check("encoded space", try ZnMultipart.fileURL(photo.absoluteString, part: "f").path, photo.path)
} catch {
    failures += 1
    print("FAIL file urls: \(error)")
}

// Cancel during the copy: stops between pieces and removes the half-written body.
do {
    var asked = 0
    checkThrows("cancel stops the copy", .cancelled) {
        _ = try ZnMultipart.write(parts: [["f", photo.absoluteString, "p.jpg", "image/jpeg"]], boundary: boundary, to: bodyURL,
                                  isCancelled: { asked += 1; return asked > 2 })
    }
    check("cancel: asked between pieces", asked, 3)
    check("cancel: no file left", FileManager.default.fileExists(atPath: bodyURL.path), false)
}

check("out of space (Cocoa)", ZnMultipart.outOfSpace(NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)), true)
check("out of space (POSIX, under)", ZnMultipart.outOfSpace(NSError(domain: NSCocoaErrorDomain, code: 512,
    userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))])), true)
check("other write error", ZnMultipart.outOfSpace(NSError(domain: NSCocoaErrorDomain, code: 512)), false)

// Memory: a 100 MB file is copied in pieces; the peak resident size grows by far less than the file.
func peakRSS() -> Int64 {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return Int64(u.ru_maxrss)  // bytes on macOS
}
do {
    let big = makeFile("big.bin", 100_000_000)
    let before = peakRSS()
    let n = try ZnMultipart.write(parts: [["video", big.absoluteString, "big.bin", "video/mp4"]], boundary: boundary, to: bodyURL)
    let grew = peakRSS() - before
    check("100 MB: length", n > 100_000_000, true)
    count += 1
    if grew > 20_000_000 {
        failures += 1
        print("FAIL 100 MB: peak memory grew by \(grew / 1_000_000) MB")
    } else {
        print("100 MB form body written; peak memory grew by \(grew / 1_000) KB")
    }
    try? FileManager.default.removeItem(at: big)
} catch {
    failures += 1
    print("FAIL 100 MB: \(error)")
}

// MARK: Network key (what a "network change" is)

check("offline", znNetworkKey(satisfied: false, interfaces: ["wifi-en0"], gateways: ["192.168.1.1:0"]), "offline")
let wifiA = znNetworkKey(satisfied: true, interfaces: ["wifi-en0", "cellular-pdp_ip0"], gateways: ["192.168.1.1:0"])
check("first interface counts", wifiA, "wifi-en0|192.168.1.1:0")
check("gateway order doesn't matter",
      znNetworkKey(satisfied: true, interfaces: ["wifi-en0"], gateways: ["b", "a"]),
      znNetworkKey(satisfied: true, interfaces: ["wifi-en0"], gateways: ["a", "b"]))
check("to cellular is a change", znNetworkKey(satisfied: true, interfaces: ["cellular-pdp_ip0"], gateways: []) != wifiA, true)
check("another Wi-Fi is a change", znNetworkKey(satisfied: true, interfaces: ["wifi-en0"], gateways: ["10.0.0.1:0"]) != wifiA, true)
check("same path: no change", znNetworkKey(satisfied: true, interfaces: ["wifi-en0", "cellular-pdp_ip0"], gateways: ["192.168.1.1:0"]), wifiA)

try? FileManager.default.removeItem(at: work)
print(failures == 0 ? "net: all \(count) checks passed" : "net: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
