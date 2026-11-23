// The image viewer on the Mac: its rules (plugins/image-viewer/ios/ViewerRules.swift, the cases of android's
// ViewerRulesTest.kt) and the page's decoding (ViewerSource.swift) on real files: the fitted copy upright for each EXIF
// turn, sharp parts that match the same part of the upright picture, every nth pixel read for a part much bigger than
// the screen, no part for a mirror image, and a part of a big JPEG read without decoding the whole picture.
import CoreGraphics
import Foundation
import ImageIO

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func near(_ name: String, _ got: CGFloat?, _ want: CGFloat, _ eps: CGFloat = 0.01, line: Int = #line) {
    count += 1
    guard let got, abs(got - want) <= eps else {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(String(describing: got)), want \(want)")
        return
    }
}

let work = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory())

// A big JPEG for the memory check, made in a child process (its 192 MB bitmap would count in this one's peak).
if CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "make-big" {
    let (w, h) = (8000, 6000)
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    for i in 0..<200 {
        ctx.setFillColor(CGColor(red: CGFloat(i % 7) / 7, green: CGFloat(i % 5) / 5, blue: CGFloat(i % 3) / 3, alpha: 1))
        ctx.fill(CGRect(x: (i * 397) % w, y: (i * 211) % h, width: 600, height: 400))
    }
    let dest = CGImageDestinationCreateWithURL(work.appendingPathComponent("big.jpg") as CFURL, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImagePropertyOrientation: 6] as CFDictionary)
    exit(CGImageDestinationFinalize(dest) ? 0 : 1)
}

// MARK: The rules (ViewerRulesTest.kt; Android counts in pixels, so do these)

let phone = ViewerDims(w: 1080, h: 2400)
func cam(_ z: CGFloat, _ x: CGFloat, _ y: CGFloat) -> ViewerCamera { ViewerCamera(z: z, x: x, y: y) }
func rect(_ l: CGFloat, _ t: CGFloat, _ r: CGFloat, _ b: CGFloat) -> ViewerRect { ViewerRect(left: l, top: t, right: r, bottom: b) }

do {
    let f = ViewerRules.fitted(ViewerDims(w: 4000, h: 3000), phone)
    near("fit: width", f.w, 1080)
    near("fit: height", f.h, 810)
    let tall = ViewerRules.fitted(ViewerDims(w: 4320, h: 24000), phone)  // a long receipt: fits the height
    near("tall: width", tall.w, 432)
    near("tall: height", tall.h, 2400)
    check("not loaded yet: the screen", ViewerRules.fitted(ViewerDims(w: 0, h: 0), phone), phone)
}
do {
    let original = ViewerDims(w: 4000, h: 3000)
    let fitted = ViewerRules.fitted(original, phone)
    let a = ViewerRules.visibleArea(.fit, fitted, phone, original)
    near("at fit: screen left", a?.screen.left, 0)
    near("at fit: screen right", a?.screen.right, 1080)
    near("at fit: screen top", a?.screen.top, (2400 - 810) / 2)
    check("at fit: the whole picture", a.map { [$0.source.left, $0.source.top, $0.source.right, $0.source.bottom].map { $0.rounded() } }, [0, 0, 4000, 3000])
    // 4x, moved fully left (the clamp's -mx): the picture's right part shows. 4320 wide on screen, 1080 of it = a quarter.
    let z = ViewerRules.visibleArea(cam(4, -(fitted.w * 4 - phone.w) / 2, 0), fitted, phone, original)
    near("4x left: screen left", z?.screen.left, 0)
    near("4x left: screen right", z?.screen.right, 1080)
    near("4x left: source left", z?.source.left, 3000)
    near("4x left: source right", z?.source.right, 4000)
    near("4x left: screen top", z?.screen.top, 0)
    near("4x left: screen bottom", z?.screen.bottom, 2400)
    near("4x left: source top", z?.source.top, 1500 - 2400 / 3240 * 3000 / 2)
    check("no picture: no area", ViewerRules.visibleArea(.fit, ViewerDims(w: 0, h: 0), phone, original), nil)
    check("moved off screen: no area", ViewerRules.visibleArea(cam(1, 5000, 0), fitted, phone, original), nil)
}
do {
    let a = ViewerArea(screen: rect(0, 0, 1000, 1000), source: rect(10.5, 20.25, 110.5, 120.25))  // 10 screen px per source px
    let s = ViewerRules.snapped(a)
    check("snapped: whole source pixels", s.source, rect(10, 20, 111, 121))
    near("snapped: screen left", s.screen.left, -5)
    near("snapped: screen top", s.screen.top, -2.5)
    near("snapped: screen right", s.screen.right, 1005)
    near("snapped: screen bottom", s.screen.bottom, 1007.5)
}
do {
    let fitted = ViewerDims(w: 1080, h: 810)
    check("sharp: not at fit", ViewerRules.needsSharp(.fit, fitted, 1080, 4000), false)
    check("sharp: at 2x", ViewerRules.needsSharp(cam(2, 0, 0), fitted, 1080, 4000), true)
    check("sharp: a small original has nothing more", ViewerRules.needsSharp(cam(2, 0, 0), fitted, 1080, 1100), false)
    check("sharp: no copy yet", ViewerRules.needsSharp(cam(2, 0, 0), fitted, 0, 4000), false)
}
do {
    let screen = rect(0, 0, 1080, 2400)
    check("sample 1", ViewerRules.sampleSize(rect(0, 0, 1500, 3333), screen, 1e9), 1)
    check("sample 2", ViewerRules.sampleSize(rect(0, 0, 2200, 4900), screen, 1e9), 2)
    check("sample 4", ViewerRules.sampleSize(rect(0, 0, 4400, 9800), screen, 1e9), 4)
    check("sample: the cap wins", ViewerRules.sampleSize(rect(0, 0, 4000, 9000), screen, 2.5 * 1080 * 2400), 4)
    check("sample: empty", ViewerRules.sampleSize(rect(0, 0, 0, 0), screen, 1e9), 1)
}
do {
    check("EXIF 1", ViewerRules.degrees(1), 0)
    check("EXIF 0 (unknown)", ViewerRules.degrees(0), 0)
    check("EXIF 6", ViewerRules.degrees(6), 90)
    check("EXIF 3", ViewerRules.degrees(3), 180)
    check("EXIF 8", ViewerRules.degrees(8), 270)
    check("EXIF 2: mirror, no sharp part", ViewerRules.degrees(2), nil)
    check("EXIF 5: mirror", ViewerRules.degrees(5), nil)
    check("upright 90", ViewerRules.upright(ViewerDims(w: 4000, h: 3000), 90), ViewerDims(w: 3000, h: 4000))
    check("upright 180", ViewerRules.upright(ViewerDims(w: 4000, h: 3000), 180), ViewerDims(w: 4000, h: 3000))
    // Stored 400 x 300, shown turned: every corner of the stored rectangle, turned upright, lands on a corner of r.
    for degrees in [0, 90, 180, 270] {
        let raw = ViewerDims(w: 400, h: 300)
        let up = ViewerRules.upright(raw, degrees)
        var r = rect(30, 50, 120, 210)
        if r.right > up.w { r.right = up.w - 10 }
        let s = ViewerRules.storedRect(r, up, degrees)
        func turn(_ x: CGFloat, _ y: CGFloat) -> [CGFloat] {
            switch degrees {
            case 90: return [raw.h - y, x]
            case 180: return [raw.w - x, raw.h - y]
            case 270: return [y, raw.w - x]
            default: return [x, y]
            }
        }
        let turned = Set([turn(s.left, s.top), turn(s.right, s.top), turn(s.left, s.bottom), turn(s.right, s.bottom)])
        check("stored rect \(degrees)", turned, Set([[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]]))
    }
}
do {
    check("web", ViewerRules.kind("https://cdn.example.com/a.jpg"), .web)
    check("web, any case", ViewerRules.kind("HTTP://localhost/a.jpg"), .web)
    check("asset", ViewerRules.kind("asset:img/a.png"), .asset)
    check("asset://", ViewerRules.kind("asset://img/a.png"), .asset)
    check("asset path", ViewerRules.assetPath("asset://img/a.png"), "img/a.png")
    check("asset path, no ..", ViewerRules.assetPath("asset:img/../a.png"), nil)
    check("app file", ViewerRules.kind("zn://file/photo-1.jpg"), .file)
    check("file://", ViewerRules.kind("file:///var/a.jpg"), .fileUri)
    check("content:// (Android's)", ViewerRules.kind("content://media/external/images/media/1"), .content)
    check("held", ViewerRules.kind("held:data"), .held)
    check("other zn://", ViewerRules.kind("zn://app-icon/com.x"), .refused)
    check("data: in the params", ViewerRules.kind("data:image/png;base64,AAAA"), .refused)
    check("ftp", ViewerRules.kind("ftp://x/a.jpg"), .refused)
    check("a bare path", ViewerRules.kind("/sdcard/a.jpg"), .refused)
    check("empty", ViewerRules.kind(""), .refused)
    func start(_ s: String) -> Int? { ViewerRules.dataStart(s).map { s.distance(from: s.startIndex, to: $0) } }
    check("data: png", start("data:image/png;base64,iVBORw0KGgo="), 22)
    check("data: any case", start("DATA:IMAGE/JPEG;BASE64,/9j/4AAQ"), 23)
    check("data: not a picture", start("data:text/html;base64,PGgxPg=="), nil)
    check("data: not base64", start("data:image/svg+xml,<svg/>"), nil)
    check("data: empty", start("data:image/png;base64,"), nil)
    check("data: no comma", start("data:image/png;base64"), nil)
    let limit = ViewerRules.maxDataBytes / 3 * 4
    check("data: 5 MB", start("data:image/png;base64," + String(repeating: "A", count: limit)), 22)
    check("data: over 5 MB", start("data:image/png;base64," + String(repeating: "A", count: limit + 8)), nil)
    check("header", ViewerRules.safeHeader("Authorization", "Bearer abc.def"), true)
    check("header: no line breaks", ViewerRules.safeHeader("X-A", "a\r\nX-Injected: 1"), false)  // one Character in Swift
    check("header: no lone CR", ViewerRules.safeHeader("X-A", "a\rb"), false)
    check("header: no lone LF", ViewerRules.safeHeader("X-A", "a\nb"), false)
    check("header: no NUL", ViewerRules.safeHeader("X-A", "a\0b"), false)
    check("header: no space in the name", ViewerRules.safeHeader("Bad Name", "v"), false)
    check("header: no colon", ViewerRules.safeHeader("A:B", "v"), false)
    check("header: no name", ViewerRules.safeHeader("", "v"), false)
    check("header: ASCII names", ViewerRules.safeHeader("Ünicode", "v"), false)
    check("label", ViewerRules.label("Photo {n} of {count}", 1, 5), "Photo 2 of 5")
    check("closes: short", ViewerRules.closes(50, 0, 800), false)
    check("closes: long", ViewerRules.closes(130, 0, 800), true)
    check("closes: quick", ViewerRules.closes(30, 1500, 800), true)
    check("closes: thrown back", ViewerRules.closes(30, -1500, 800), false)
    near("background at rest", ViewerRules.backgroundAlpha(0, 800), 1)
    near("background at most 0.3", ViewerRules.backgroundAlpha(-5000, 800), 0.3)
}
do {
    // The page's camera from useZoom's values: points times the screen scale; a value JS didn't give is the fit.
    check("camera: no values", ViewerRules.camera(scale: nil, x: nil, y: nil, pixels: 3), .fit)
    check("camera: points to pixels", ViewerRules.camera(scale: 2, x: 10, y: -4, pixels: 3), cam(2, 30, -12))
    check("camera: a bad zoom is 1", ViewerRules.camera(scale: 0, x: .nan, y: .infinity, pixels: 3), .fit)
}

// MARK: Decoding (ViewerSource.swift)

/// A 120 x 80 picture as the user sees it: red top left, green top right, blue bottom left, white bottom right. Stored
/// turned for [orientation] (so it shows upright), as a JPEG.
func picture(_ name: String, orientation: Int, w: Int = 120, h: Int = 80) -> URL {
    let turned = orientation >= 5
    let (sw, sh) = turned ? (h, w) : (w, h)
    let ctx = CGContext(data: nil, width: sw, height: sh, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    // Draw the upright picture through the inverse of the EXIF turn: Core Graphics' y goes up.
    let (W, H) = (CGFloat(w), CGFloat(h))
    switch orientation {
    case 3: ctx.translateBy(x: W, y: H); ctx.rotate(by: .pi)
    case 6: ctx.translateBy(x: CGFloat(sw), y: 0); ctx.rotate(by: .pi / 2)  // shown turned clockwise: stored turned back
    case 8: ctx.translateBy(x: 0, y: CGFloat(sh)); ctx.rotate(by: -.pi / 2)
    case 2: ctx.translateBy(x: W, y: 0); ctx.scaleBy(x: -1, y: 1)
    default: break
    }
    func fill(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ x: CGFloat, _ y: CGFloat) {
        ctx.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1))
        ctx.fill(CGRect(x: x, y: y, width: W / 2, height: H / 2))
    }
    fill(1, 0, 0, 0, H / 2)  // top left (y up)
    fill(0, 1, 0, W / 2, H / 2)
    fill(0, 0, 1, 0, 0)
    fill(1, 1, 1, W / 2, 0)
    let url = work.appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImagePropertyOrientation: orientation, kCGImageDestinationLossyCompressionQuality: 1.0] as CFDictionary)
    CGImageDestinationFinalize(dest)
    return url
}

/// The colour at [x], [y] (from the top) of [img]: r, g, b, w or ?.
func colour(_ img: CGImage, _ x: Int, _ y: Int) -> String {
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

/// The colours at the four quarter points of [img]: top left, top right, bottom left, bottom right.
func quarters(_ img: CGImage?) -> [String] {
    guard let img else { return [] }
    let (x0, x1, y0, y1) = (img.width / 4, img.width * 3 / 4, img.height / 4, img.height * 3 / 4)
    return [colour(img, x0, y0), colour(img, x1, y0), colour(img, x0, y1), colour(img, x1, y1)]
}

for o in [1, 3, 6, 8] {
    let url = picture("turn-\(o).jpg", orientation: o)
    guard let s = ViewerSource(data: try! Data(contentsOf: url)) else {
        check("EXIF \(o): readable", false, true)
        continue
    }
    check("EXIF \(o): upright size", s.upright, ViewerDims(w: 120, h: 80))
    let fitted = s.fitted(maxPixels: 60)
    check("EXIF \(o): fitted 60 x 40", fitted.map { [$0.width, $0.height] }, [60, 40])
    check("EXIF \(o): fitted upright", quarters(fitted), ["r", "g", "b", "w"])
    // The whole picture as a part: the same as the fitted copy.
    let whole = ViewerArea(screen: rect(0, 0, 120, 80), source: rect(0, 0, 120, 80))
    let part = s.decode(whole, maxPixels: 1e9)
    check("EXIF \(o): whole part 120 x 80", part.map { [$0.width, $0.height] }, [120, 80])
    check("EXIF \(o): whole part upright", quarters(part), ["r", "g", "b", "w"])
    // The middle 40 x 40 (x 40-80, y 20-60): its quarter points are each in another colour, only if it is the right part.
    let mid = s.decode(ViewerArea(screen: rect(0, 0, 400, 400), source: rect(40, 20, 80, 60)), maxPixels: 1e9)
    check("EXIF \(o): middle part 40 x 40", mid.map { [$0.width, $0.height] }, [40, 40])
    check("EXIF \(o): middle part's colours", quarters(mid), ["r", "g", "b", "w"])
    // The top right quarter alone: all green.
    let tr = s.decode(ViewerArea(screen: rect(0, 0, 60, 40), source: rect(66, 4, 116, 36)), maxPixels: 1e9)
    check("EXIF \(o): top right part", quarters(tr), ["g", "g", "g", "g"])
}
do {
    let s = ViewerSource(data: try! Data(contentsOf: picture("mirror.jpg", orientation: 2)))
    check("mirror: read", s != nil, true)
    check("mirror: fitted, mirrored back", quarters(s?.fitted(maxPixels: 120)), ["r", "g", "b", "w"])
    check("mirror: no sharp part", s?.decode(ViewerArea(screen: rect(0, 0, 60, 40), source: rect(0, 0, 60, 40)), maxPixels: 1e9) == nil, true)
    check("not a picture", ViewerSource(data: Data("hello".utf8)) == nil, true)
    // A part much bigger than its place on screen reads every 4th pixel (as Android's inSampleSize).
    let big = ViewerSource(data: try! Data(contentsOf: picture("big.jpg", orientation: 6, w: 1200, h: 800)))
    let small = big?.decode(ViewerArea(screen: rect(0, 0, 300, 200), source: rect(0, 0, 1200, 800)), maxPixels: 1e9)
    check("every 4th pixel: 300 x 200", small.map { [$0.width, $0.height] }, [300, 200])
    check("every 4th pixel: upright", quarters(small), ["r", "g", "b", "w"])
    // The memory cap wins: 1200 x 800 under 10000 pixels → every 16th (75 x 50; ImageIO reads every 8th, drawn smaller).
    let capped = big?.decode(ViewerArea(screen: rect(0, 0, 1200, 800), source: rect(0, 0, 1200, 800)), maxPixels: 10000)
    check("capped: 75 x 50", capped.map { [$0.width, $0.height] }, [75, 50])
}

// MARK: Memory: a part of a big JPEG doesn't decode the whole picture

func footprint() -> (now: Int, peak: Int) {
    var info = task_vm_info_data_t()
    var n = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    _ = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(n)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &n) } }
    return (Int(info.phys_footprint) >> 20, Int(info.ledger_phys_footprint_peak) >> 20)
}

do {
    let maker = Process()
    maker.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    maker.arguments = [work.path, "make-big"]
    try! maker.run()
    maker.waitUntilExit()
    check("big JPEG made", maker.terminationStatus, 0)
    let data = try! Data(contentsOf: work.appendingPathComponent("big.jpg"), options: .mappedIfSafe)
    let before = footprint().peak
    let s = ViewerSource(data: data)
    check("big: 6000 x 8000 upright", s?.upright, ViewerDims(w: 6000, h: 8000))
    // The phone's screen at 5x: a 1179 x 2556 px part of 236 x 511 source pixels... at zoom 1 that's every pixel of a
    // part 1200 x 2600 (2.5 screens' cap: 7.5 M px).
    let part = s?.decode(ViewerArea(screen: rect(0, 0, 1179, 2556), source: rect(2000, 3000, 3200, 5600)), maxPixels: 2.5 * 1179 * 2556)
    check("big: part 1200 x 2600", part.map { [$0.width, $0.height] }, [1200, 2600])
    let grew = footprint().peak - before
    print("big: a 1200 x 2600 part of an 8000 x 6000 JPEG raised the peak by \(grew) MB")
    // The whole picture is 192 MB; the part and the decoder's rows stay well under it (about 30 MB measured).
    count += 1
    if grew >= 100 { failures += 1; print("FAIL big: peak grew \(grew) MB (the whole picture is 192 MB)") }
    // The fitted copy at a phone's size: never the whole picture either.
    let fitted = s?.fitted(maxPixels: 1600)
    check("big: fitted 1200 x 1600", fitted.map { [$0.width, $0.height] }, [1200, 1600])
}

print(failures == 0 ? "ios image-viewer plugin: \(count) checks passed" : "ios image-viewer plugin: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
