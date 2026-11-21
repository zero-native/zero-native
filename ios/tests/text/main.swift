// iOS's text size and font rules on the Mac (tools/ios-unit-test.ts builds this with ZnFontRules.swift, from
// sources.txt). The cases follow android/runtime: ZnTemplate.kt fontScaleCap, ZnFontsTest.kt (the font file check and
// the phone's names), and Compose's font matching (CSS) for the face a weight picks. Arguments (args.txt): three of the
// sample's font files, Inconsolata Regular and SemiBold and Lato Black, read as the app reads them.
import CoreGraphics
import CoreText
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

// Text scale: the phone's, capped by maxFontScale (Android: fontScale × fontScaleCap).
check("capped", znTextScale(phone: 2.0, max: 1.15), 1.15)
check("allowFontScaling false at a big size", znTextScale(phone: 3.1, max: 1), 1)
check("small sizes still shrink", znTextScale(phone: 0.85, max: 1), 0.85)
check("under the cap", znTextScale(phone: 1.1, max: 1.15), 1.1)
check("no cap", znTextScale(phone: 1.35, max: nil), 1.35)
check("a cap of 0 is none", znTextScale(phone: 1.35, max: 0), 1.35)

// The font file check (ZnFontsTest.aFontStartsWithAnSfntTag).
check("truetype", ZnFontRules.looksLikeFont(Data([0, 1, 0, 0, 9, 9])), true)
check("OTTO", ZnFontRules.looksLikeFont(Data("OTTO....".utf8)), true)
check("true", ZnFontRules.looksLikeFont(Data("true".utf8)), true)
check("html page", ZnFontRules.looksLikeFont(Data("<html>".utf8)), false)
check("collection", ZnFontRules.looksLikeFont(Data("ttcf....".utf8)), false)
check("cut file", ZnFontRules.looksLikeFont(Data([0, 1])), false)
check("not a font: no CGFont", ZnFontRules.cgFont(Data("<html><body>404</body></html>".utf8)) == nil, true)

// The phone's names (ZnFontsTest.systemNamesNeedNoFile), as iOS draws them.
check("System", ZnFontRules.systemFont("System"), ZnSystemFont())
check("Roboto", ZnFontRules.systemFont("Roboto"), ZnSystemFont())
check("sans-serif", ZnFontRules.systemFont("sans-serif"), ZnSystemFont())
check("serif", ZnFontRules.systemFont("serif"), ZnSystemFont(design: .serif))
check("monospace", ZnFontRules.systemFont("monospace"), ZnSystemFont(design: .monospaced))
check("medium", ZnFontRules.systemFont("sans-serif-medium"), ZnSystemFont(weight: 500))
check("thin", ZnFontRules.systemFont("sans-serif-thin"), ZnSystemFont(weight: 100))
check("condensed light", ZnFontRules.systemFont("sans-serif-condensed-light"), ZnSystemFont(weight: 300, condensed: true))
check("not a system name", ZnFontRules.systemFont("Inconsolata"), nil)

// The manifest's table (compiler/src/fonts.ts); malformed entries are skipped.
let table = ZnFontRules.parse([
    "Inconsolata": [
        ["file": "fonts/Inconsolata-Regular.ttf", "weight": 400, "italic": false],
        ["file": "fonts/Inconsolata-SemiBold.ttf", "weight": 600, "italic": false],
        ["weight": 700],  // no file
        "junk",
    ],
    "Broken": "not a list",
    "Defaults": [["file": "fonts/x.ttf"]],
])
check("faces kept", table["Inconsolata"]?.map(\.file) ?? [], ["fonts/Inconsolata-Regular.ttf", "fonts/Inconsolata-SemiBold.ttf"])
check("not a list: left out", table["Broken"] == nil, true)
check("weight and italic default", table["Defaults"] ?? [], [ZnFontFace(file: "fonts/x.ttf", weight: 400, italic: false)])

// Which face a weight and style pick (CSS font matching, as Compose).
func face(_ w: Int, _ i: Bool = false) -> ZnFontFace { ZnFontFace(file: "\(w)\(i ? "i" : "")", weight: w, italic: i) }
func pick(_ faces: [ZnFontFace], _ w: Int, italic: Bool = false) -> String {
    guard let p = ZnFontRules.pick(faces, weight: w, italic: italic) else { return "none" }
    return p.face.file + (p.synthItalic ? " slanted" : "")
}
let inconsolata = [face(400), face(500), face(600)]
check("exact", pick(inconsolata, 500), "500")
check("bold: the nearest heavier, else lighter", pick(inconsolata, 700), "600")
check("600 of 400 / 700", pick([face(400), face(700)], 600), "700")
check("300 of 400 / 500", pick([face(400), face(500)], 300), "400")
check("400 tries 500 before 300", pick([face(300), face(500)], 400), "500")
check("500 tries 400 before 600", pick([face(400), face(600)], 500), "400")
check("450 goes up to 500 first", pick([face(400), face(500), face(600)], 450), "500")
check("below 400: lighter first", pick([face(100), face(500)], 300), "100")
check("above 500: heavier first", pick([face(500), face(900)], 700), "900")
check("above 500, nothing heavier: lighter", pick([face(400), face(500)], 800), "500")
check("italic face wins", pick([face(400), face(400, true)], 400, italic: true), "400i")
check("no italic face: upright, slanted", pick(inconsolata, 400, italic: true), "400 slanted")
check("upright wanted, only italic", pick([face(400, true)], 400), "400i")
check("lato only black", pick([face(900)], 400), "900")
check("no faces", pick([], 400), "none")

// The sample's font files load, and their weights read as the build wrote them (fonts.ts reads the OS/2 table).
let files = Array(CommandLine.arguments.dropFirst())
check("three font files given", files.count, 3)
func weight(_ cg: CGFont) -> Double {
    let ct = CTFontCreateWithGraphicsFont(cg, 12, nil, nil)
    let traits = CTFontCopyTraits(ct) as NSDictionary
    return (traits[kCTFontWeightTrait] as? NSNumber)?.doubleValue ?? -9
}
var weights: [String: Double] = [:]
for path in files {
    guard let data = FileManager.default.contents(atPath: path) else {
        check("read \(path)", false, true)
        continue
    }
    check("\(path) looks like a font", ZnFontRules.looksLikeFont(data), true)
    guard let cg = ZnFontRules.cgFont(data) else {
        check("\(path) loads", false, true)
        continue
    }
    weights[(path as NSString).lastPathComponent] = weight(cg)
    // A cut file is refused, never a crash.
    check("\(path) cut", ZnFontRules.cgFont(data.prefix(64)) == nil, true)
}
if let r = weights["Inconsolata-Regular.ttf"], let sb = weights["Inconsolata-SemiBold.ttf"], let black = weights["lato-black.ttf"] {
    check("regular is regular", abs(r) < 0.05, true)
    check("semibold heavier than regular", sb > r + 0.1, true)
    check("black heavier than semibold", black > sb, true)
}

print("\(count - failures)/\(count) text checks passed")
exit(failures == 0 ? 0 : 1)
