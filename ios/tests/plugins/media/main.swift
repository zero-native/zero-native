// The media plugin on the Mac: its rules (plugins/media/ios/MediaRules.swift, the cases of android's MediaRulesTest.kt)
// and its picture writer (MediaImage.swift) on real files: the EXIF turn and mirror built into the pixels, crops on the
// turned picture, see-through parts made white, no EXIF or location left, and a big picture read smaller.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func fails(_ name: String, _ code: String, line: Int = #line, _ body: () throws -> Void) {
    count += 1
    do {
        try body()
        failures += 1
        print("FAIL \(name) (line \(line)): not refused")
    } catch let f as MediaFailure {
        if f.code != code { failures += 1; print("FAIL \(name) (line \(line)): \(f.code), want \(code)") }
    } catch let a as MediaArgs {
        if code != "args" { failures += 1; print("FAIL \(name) (line \(line)): bad args (\(a.message)), want \(code)") }
    } catch {
        failures += 1
        print("FAIL \(name) (line \(line)): \(error)")
    }
}

// MARK: The plan (MediaRulesTest.kt)

func plan(_ w: Int, _ h: Int, exif: Int = 0, rotate: Int = 0, crop: MediaCrop? = nil, maxSize: Int = 1000) -> MediaPlan? {
    MediaRules.plan(width: w, height: h, exifDegrees: exif, flip: false, rotate: rotate, crop: crop, maxSize: maxSize)
}

if let p = plan(4000, 3000) {
    check("a big photo shrinks to fit", [p.width, p.height], [1000, 750])
    check("read at the final size: a quarter (Android's sample 4)", p.readSide, 1000)
}
check("a small photo is never made bigger", plan(300, 200).map { [$0.width, $0.height] }, [300, 200])
check("a small photo is read whole", plan(300, 200)?.readSide, nil)
check("sideways swaps the sides", plan(4000, 3000, exif: 90).map { [$0.width, $0.height, $0.turn] }, [750, 1000, 90])
check("the app's turn adds to EXIF's", plan(4000, 3000, exif: 90, rotate: 90).map { [$0.width, $0.height, $0.turn] }, [1000, 750, 180])
check("270 + 90 is 0", plan(4000, 3000, exif: 270, rotate: 90)?.turn, 0)
if let p = plan(4000, 3000, exif: 90, crop: MediaCrop(x: 100, y: 200, width: 2900, height: 3800), maxSize: 5000) {
    check("a crop counts on the turned picture", [p.width, p.height, p.cropX, p.cropY], [2900, 3800, 100, 200])
}
check("crop past the side", plan(100, 100, crop: MediaCrop(x: 50, y: 0, width: 51, height: 10)), nil)
check("crop below 0", plan(100, 100, crop: MediaCrop(x: -1, y: 0, width: 10, height: 10)), nil)
check("crop of no width", plan(100, 100, crop: MediaCrop(x: 0, y: 0, width: 0, height: 10)), nil)
check("no overflow", plan(100, 100, crop: MediaCrop(x: Int(Int32.max), y: 0, width: Int(Int32.max), height: 10)), nil)
check("4000 is the short side once turned", plan(4000, 100, exif: 90, crop: MediaCrop(x: 0, y: 0, width: 4000, height: 100)), nil)
check("a crop at the corner", plan(100, 100, crop: MediaCrop(x: 90, y: 90, width: 10, height: 10)) != nil, true)
if let p = plan(6000, 4000, crop: MediaCrop(x: 0, y: 0, width: 1000, height: 1000), maxSize: 1000) {
    check("a crop from a huge photo reads every pixel it needs", [p.width, p.readSide ?? 0], [1000, 0])
}
if let p = plan(20000, 20000, maxSize: 100000) {
    check("a huge picture's output fits in 24 MP", Double(p.width) * Double(p.height) <= MediaRules.maxPixels * 1.001, true)
    let side = Double(p.readSide ?? 20000)
    check("and it is read at 24 MP or less", side * side <= MediaRules.maxPixels, true)
}

// MARK: Arguments, names, types

check("rotate -90", try? MediaRules.rotate(-90), 270)
check("rotate 360", try? MediaRules.rotate(360), 0)
check("rotate nil", try? MediaRules.rotate(nil), 0)
fails("rotate 45", "args") { _ = try MediaRules.rotate(45) }
fails("maxSize 0", "args") { _ = try MediaRules.maxSize(0) }
fails("quality 101", "args") { _ = try MediaRules.quality(101) }
check("default quality", try? MediaRules.quality(nil), MediaRules.defaultQuality)

check("name with slashes", MediaRules.displayName("a/b\\c.pdf", "x"), "a_b_c.pdf")
check("blank name", MediaRules.displayName("   ", "x"), "x")
check("no name", MediaRules.displayName(nil, "x"), "x")
check("long name", MediaRules.displayName(String(repeating: "n", count: 500), "x").count, 120)
check("a colon and a control character", MediaRules.displayName("a:b\u{7}c", "x"), "a_b_c")
check("mime lower case", MediaRules.mimeOr("IMAGE/PNG", "d"), "image/png")
check("mime path", MediaRules.mimeOr("../../etc", "d"), "d")
check("mime any", MediaRules.mimeOr("*/*", "d"), "*/*")
check("mime image any", MediaRules.mimeOr("image/*", "d"), "image/*")
check("mime none", MediaRules.mimeOr(nil, "d"), "d")
check("pdf extension", MediaRules.extensionFor("application/pdf", "ignored.bin"), "pdf")
check("the name's extension", MediaRules.extensionFor("application/whatever", "Report.DOCX"), "docx")
check("a bad extension", MediaRules.extensionFor("application/whatever", "a.../x"), "bin")
check("heic to jpg", MediaRules.withExtension("IMG.heic", "jpg"), "IMG.jpg")
check("no extension yet", MediaRules.withExtension("IMG", "jpg"), "IMG.jpg")
check("type of a kept file", MediaRules.mimeOf("media-a-0.pdf"), "application/pdf")
check("a half-done file starts with a dot", MediaRules.partName("abc", 0, "part").hasPrefix("."), true)
check("the camera's file starts with a dot", MediaRules.captureName("abc").hasPrefix("."), true)
check("a whole file doesn't", MediaRules.fileName("abc", 0, "jpg").hasPrefix("."), false)
check("any file", MediaRules.pickTypes(["*/*"]), nil)
check("no types", MediaRules.pickTypes([]), nil)
check("pdf", MediaRules.pickTypes(["application/pdf"]), ["application/pdf"])

// pickFile's types as the Files picker's content types: a family is its base type; one iOS doesn't know matches no file.
check("any file is .item", MediaRules.contentTypes(["*/*"]), [.item])
check("image family", MediaRules.contentTypes(["image/*"]), [.image])
check("pdf type", MediaRules.contentTypes(["application/pdf"]), [.pdf])
check("3D family", MediaRules.contentTypes(["model/*"]), [.threeDContent])
let unknownFamily = MediaRules.contentTypes(["chemical/*"])
check("an unknown family is one made-up type", unknownFamily.count == 1 && unknownFamily[0].isDynamic, true)
check("it matches no picture", UTType.png.conforms(to: unknownFamily[0]), false)
check("nor any file", UTType.pdf.conforms(to: unknownFamily[0]) || UTType.plainText.conforms(to: unknownFamily[0]), false)
let unknownType = MediaRules.contentTypes(["application/x-zn-none"])
check("an unknown type matches no file", UTType.pdf.conforms(to: unknownType[0]) || UTType.data.conforms(to: unknownType[0]), false)

// EXIF orientations: ExifInterface's rotationDegrees and isFlipped.
check("EXIF 1...8", (1...8).map { MediaRules.orientation($0).degrees }, [0, 0, 180, 180, 270, 90, 90, 270])
check("EXIF mirrors", (1...8).map { MediaRules.orientation($0).flip }, [false, true, false, true, true, false, true, false])

// The camera: only with the permission; JS asks and tries again.
check("camera allowed", MediaRules.camera(available: true, authorized: true), .open)
check("camera not allowed", MediaRules.camera(available: true, authorized: false), .refuse("camera_permission"))
check("no camera", MediaRules.camera(available: false, authorized: true), .refuse("no_app"))

// MARK: Cleanup (MediaRulesTest.kt)

let hour = 3_600_000.0
let now = 1000 * hour
let keepNothing: (String) -> Bool = { _ in false }
let some = [MediaStored(name: "media-a-0.jpg", bytes: 10, modified: now - 200 * hour), MediaStored(name: "media-b-0.jpg", bytes: 10, modified: now),
            MediaStored(name: "lab-1.png", bytes: 10, modified: now - 900 * hour)]
check("old files go, other plugins' stay", MediaRules.toDelete(some, now: now, maxAgeMs: MediaRules.keepMs, maxBytes: .max, keep: keepNothing), ["media-a-0.jpg"])
let three = [MediaStored(name: "media-a-0.jpg", bytes: 60, modified: now - 3), MediaStored(name: "media-b-0.jpg", bytes: 60, modified: now - 2),
             MediaStored(name: "media-c-0.jpg", bytes: 60, modified: now - 1)]
check("the oldest go when the folder is too big", MediaRules.toDelete(three, now: now, maxAgeMs: 100 * hour, maxBytes: 100, keep: keepNothing),
      ["media-a-0.jpg", "media-b-0.jpg"])
check("what must stay stays", MediaRules.toDelete(three, now: now, maxAgeMs: 100 * hour, maxBytes: 100) { $0 == "media-a-0.jpg" }, ["media-b-0.jpg"])
let part = MediaStored(name: MediaRules.partName("a", 0, "part"), bytes: 10, modified: now - 2 * hour)
let fresh = MediaStored(name: MediaRules.captureName("b"), bytes: 10, modified: now - 60_000)
check("half-done files go after an hour", MediaRules.toDelete([part, fresh], now: now, maxAgeMs: MediaRules.keepMs, maxBytes: .max, keep: keepNothing), [part.name])
check("unless their job is open", MediaRules.toDelete([part], now: now, maxAgeMs: MediaRules.keepMs, maxBytes: .max) { $0.contains("a") }, [])
check("olderThanMs 0 means all", MediaRules.toDelete([part, fresh], now: now, maxAgeMs: 0, maxBytes: .max, keep: keepNothing).count, 2)

// MARK: The job on disk

let job = MediaJob(id: "abc", kind: MediaJob.camera, maxSize: 640, quality: 70, max: 3, maxBytes: 1000, resultCode: -1,
                   parts: [".media-abc-0.in", ".media-abc-1.in"], names: ["IMG_1.HEIC", nil], mimes: ["image/heic", nil], failed: [nil, "too_big"])
func text(_ j: MediaJob) -> String { String(data: try! JSONSerialization.data(withJSONObject: j.json), encoding: .utf8)! }
check("a job survives the trip to disk", MediaJob.from(text(job)), job)
let plain = MediaJob(id: "abc", kind: MediaJob.photos)
check("a plain job too", MediaJob.from(text(plain)), plain)
check("no result yet", MediaJob.from(text(plain))?.resultCode, nil)
check("a job we can't read counts as none", MediaJob.from("{}"), nil)
check("not JSON", MediaJob.from("not json"), nil)
check("nothing", MediaJob.from(nil), nil)

// MARK: Pictures (MediaImage.swift on real files)

let work = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory() + "zn-media-test")
try? FileManager.default.removeItem(at: work)
try! FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

// A picked item that is a folder (a package from Files: .pages, .key) is no file; one over maxBytes is too big.
let package = work.appendingPathComponent("Report.pages")
try! FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
try! Data(count: 10).write(to: package.appendingPathComponent("Index.zip"))
check("a package is refused", MediaRules.refusedCopy(package, maxBytes: 1_000_000), "read_failed")
let small = work.appendingPathComponent("small.bin")
try! Data(count: 100).write(to: small)
check("a small file is copied", MediaRules.refusedCopy(small, maxBytes: 100), nil)
check("one byte over", MediaRules.refusedCopy(small, maxBytes: 99), "too_big")

/// A w x h picture: the left half red, the right half blue (stored pixels), saved as [type] with [props].
func picture(_ name: String, _ w: Int, _ h: Int, type: String = "public.jpeg", alpha: Bool = false, props: [CFString: Any] = [:]) -> URL {
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    if alpha {
        ctx.clear(CGRect(x: 0, y: 0, width: w, height: h))  // all see-through but a red square at the stored top left
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: h / 2, width: w / 2, height: h / 2))
    } else {
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w / 2, height: h))
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: w / 2, y: 0, width: w - w / 2, height: h))
    }
    let url = work.appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, props as CFDictionary)
    CGImageDestinationFinalize(dest)
    return url
}

/// The colour at (x, y) from the top left of a written JPEG, as "r", "g", "b", "w" (white) or "?".
func colour(_ url: URL, _ x: Int, _ y: Int) -> String {
    let src = CGImageSourceCreateWithURL(url as CFURL, nil)!
    let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
    var px = [UInt8](repeating: 0, count: 4)
    let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: -x, y: -(img.height - 1 - y), width: img.width, height: img.height))
    let (r, g, b) = (Int(px[0]), Int(px[1]), Int(px[2]))
    if r > 200 && g > 200 && b > 200 { return "w" }
    if r > 180 && g < 80 && b < 80 { return "r" }
    if b > 180 && r < 80 && g < 80 { return "b" }
    if g > 180 && r < 80 && b < 80 { return "g" }
    return "?(\(r),\(g),\(b))"
}

func out(_ name: String) -> (URL, URL) { (work.appendingPathComponent(".\(name).out"), work.appendingPathComponent(name)) }

func written(_ source: URL, _ name: String, maxSize: Int = 2048, quality: Int = 90, rotate: Int = 0, crop: MediaCrop? = nil) -> URL? {
    let (w, t) = out(name)
    do {
        try MediaImage.write(source, work: w, target: t, maxSize: maxSize, quality: quality, rotate: rotate, crop: crop)
        check("\(name): no scratch file left", FileManager.default.fileExists(atPath: w.path), false)
        return t
    } catch {
        failures += 1
        print("FAIL \(name): \(error)")
        return nil
    }
}

let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 12.9, kCGImagePropertyGPSLatitudeRef: "N",
                            kCGImagePropertyGPSLongitude: 77.6, kCGImagePropertyGPSLongitudeRef: "E"]

// Stored 40 x 20, left red / right blue.
let flat = picture("flat.jpg", 40, 20)
if let t = written(flat, "media-flat-0.jpg") {
    check("as stored: size", MediaImage.size(t).0 == 40 && MediaImage.size(t).1 == 20, true)
    check("as stored: left red, right blue", [colour(t, 5, 10), colour(t, 35, 10)], ["r", "b"])
}
// EXIF 6: a quarter turn clockwise to show it, so the stored left (red) is the top.
let six = picture("six.jpg", 40, 20, props: [kCGImagePropertyOrientation: 6, kCGImagePropertyGPSDictionary: gps])
check("the test photo has a location", MediaImage.exif(six)?.location, true)
check("and a quarter turn", MediaImage.exif(six)?.degrees, 90)
if let t = written(six, "media-six-0.jpg") {
    check("EXIF 6: the sides swap", [MediaImage.size(t).0, MediaImage.size(t).1], [20, 40])
    check("EXIF 6: red on top, blue below", [colour(t, 10, 5), colour(t, 10, 35)], ["r", "b"])
    check("EXIF 6: no turn left in the file", MediaImage.exif(t)?.degrees, 0)
    check("EXIF 6: no location left", MediaImage.exif(t)?.location, false)
}
// EXIF 2: mirrored.
if let t = written(picture("two.jpg", 40, 20, props: [kCGImagePropertyOrientation: 2]), "media-two-0.jpg") {
    check("EXIF 2: left blue, right red", [colour(t, 5, 10), colour(t, 35, 10)], ["b", "r"])
}
// EXIF 8: three quarter turns, so the stored left (red) is the bottom.
if let t = written(picture("eight.jpg", 40, 20, props: [kCGImagePropertyOrientation: 8]), "media-eight-0.jpg") {
    check("EXIF 8: blue on top, red below", [colour(t, 10, 5), colour(t, 10, 35)], ["b", "r"])
}
// EXIF 5 (transpose): the stored left (red) is the top, as 6, and its stored top row is the left: the same picture
// here as 6 (both halves are full height).
if let t = written(picture("five.jpg", 40, 20, props: [kCGImagePropertyOrientation: 5]), "media-five-0.jpg") {
    check("EXIF 5: red on top", [colour(t, 10, 5), colour(t, 10, 35)], ["r", "b"])
}
// The app's turn: 90 on a flat picture.
if let t = written(flat, "media-turn-0.jpg", rotate: 90) {
    check("rotate 90: 20 x 40, red on top", [MediaImage.size(t).0, MediaImage.size(t).1], [20, 40])
    check("rotate 90: red on top", colour(t, 10, 5), "r")
}
if let t = written(flat, "media-turn180-0.jpg", rotate: 180) {
    check("rotate 180: left blue", [colour(t, 5, 10), colour(t, 35, 10)], ["b", "r"])
}
// A crop on the turned picture: the bottom half of the EXIF-6 picture is all blue.
if let t = written(six, "media-crop-0.jpg", crop: MediaCrop(x: 0, y: 22, width: 20, height: 18)) {
    check("crop: its size", [MediaImage.size(t).0, MediaImage.size(t).1], [20, 18])
    check("crop: blue only", [colour(t, 2, 2), colour(t, 17, 15)], ["b", "b"])
}
fails("a crop outside the picture", "invalid_crop") {
    let (w, t) = out("media-bad-0.jpg")
    try MediaImage.write(six, work: w, target: t, maxSize: 2048, quality: 80, crop: MediaCrop(x: 0, y: 0, width: 99999, height: 1))
}
// See-through becomes white (a PNG with alpha).
if let t = written(picture("alpha.png", 40, 20, type: "public.png", alpha: true), "media-alpha-0.jpg") {
    check("alpha: the red stays", colour(t, 5, 3), "r")
    check("alpha: see-through is white", colour(t, 35, 15), "w")
}
// A big picture is made smaller: 4000 x 3000 to 1000 x 750, colours where they were.
if let t = written(picture("big.jpg", 4000, 3000), "media-big-0.jpg", maxSize: 1000) {
    check("big: 1000 x 750", [MediaImage.size(t).0, MediaImage.size(t).1], [1000, 750])
    check("big: left red, right blue", [colour(t, 100, 300), colour(t, 900, 300)], ["r", "b"])
}
// HEIC (iPhone photos) reads as any other.
let heic = picture("heic.heic", 40, 20, type: "public.heic", props: [kCGImagePropertyOrientation: 6])
if MediaImage.size(heic).0 == 40, let t = written(heic, "media-heic-0.jpg") {
    check("HEIC with EXIF 6: red on top", [colour(t, 10, 5), colour(t, 10, 35)], ["r", "b"])
}
// Not a picture.
let notPicture = work.appendingPathComponent("note.txt")
try! "hello".write(to: notPicture, atomically: true, encoding: .utf8)
fails("a text file", "not_image") {
    let (w, t) = out("media-note-0.jpg")
    try MediaImage.write(notPicture, work: w, target: t, maxSize: 100, quality: 80)
}
check("a text file has no size", MediaImage.size(notPicture).0, 0)
// The debug photo: stored sideways with a location, as Android's; a write takes both away.
let debug = work.appendingPathComponent("media-debug-0.jpg")
try? MediaImage.debugPhoto(debug)
check("debug photo: a quarter turn and a location", MediaImage.exif(debug).map { [$0.degrees, $0.location ? 1 : 0] }, [90, 1])
check("debug photo: stored 1600 x 1200", [MediaImage.size(debug).0, MediaImage.size(debug).1], [1600, 1200])
if let t = written(debug, "media-debug-1.jpg") {
    check("debug photo written: 1200 x 1600, nothing left", [MediaImage.size(t).0, MediaImage.size(t).1, MediaImage.exif(t)?.degrees ?? -1], [1200, 1600, 0])
    check("debug photo written: no location", MediaImage.exif(t)?.location, false)
    check("debug photo written: the white mark at the top right", colour(t, 1150, 50), "w")
}

print(failures == 0 ? "ios media plugin: \(count) checks passed" : "ios media plugin: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
