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

// An installed family's faces: UIFont's weight trait as the nearest CSS weight, then picked as above.
check("regular trait", ZnFontRules.cssWeight(0), 400)
check("medium trait", ZnFontRules.cssWeight(0.23), 500)
check("semibold trait", ZnFontRules.cssWeight(0.3), 600)
check("bold trait", ZnFontRules.cssWeight(0.4), 700)
check("heavy trait", ZnFontRules.cssWeight(0.56), 800)
check("black trait", ZnFontRules.cssWeight(0.62), 900)
check("light trait", ZnFontRules.cssWeight(-0.4), 300)
check("ultralight trait", ZnFontRules.cssWeight(-0.8), 100)
check("between: nearest", ZnFontRules.cssWeight(0.37), 700)
check("Avenir Next demi bold at 700", pick([face(400), face(500), face(600), face(800)], 700), "800")

// Made fonts are kept per quarter point, so an animated size doesn't make one per frame.
check("quarter point", ZnFontRules.cacheSize(14.1), 14)
check("quarter point up", ZnFontRules.cacheSize(14.2), 14.25)
check("exact stays", ZnFontRules.cacheSize(17.5), 17.5)
check("no negative size", ZnFontRules.cacheSize(-3), 0)

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

// letterSpacing as Android draws it (znLetterSpacingPlan): the kerns to change, and the start and end padding. The
// kerns plus the padding always add up to what iOS drew before (the Text keeps its width).
func spacing(_ text: String, _ k: [CGFloat]) -> (changes: [String], lead: CGFloat, trail: CGFloat, total: CGFloat) {
    let chars = Array(text)
    let p = znLetterSpacingPlan(kerns: k, spaces: chars.map(\.isWhitespace), breaks: chars.map(\.isNewline))
    var now = k
    for c in p.changes { now[c.at] = c.kern }
    return (p.changes.map { "\($0.at):\($0.kern)" }, p.lead, p.trail, now.reduce(0, +) + p.lead + p.trail)
}
let words = spacing("AB CD", [2, 2, 2, 2, 2])
check("words: changes", words.changes, ["1:0.0", "2:4.0", "4:0.0"])
check("words: pads", [words.lead, words.trail], [1, 1])
check("words: width kept", words.total, 10)
let lines = spacing("AB\nCD", [2, 2, 2, 2, 2])
check("line break: the letter before it loses its kern, the break keeps its own", lines.changes, ["1:0.0", "4:0.0"])
let endSpace = spacing("AB ", [2, 2, 2])
check("a space at the end keeps its letter's kern", endSpace.changes, ["1:0.0"])
check("a space at the end: pads", [endSpace.lead, endSpace.trail], [1, 1])
check("a space at the end: width kept", endSpace.total, 6)
let one = spacing("A", [4])
check("one letter", one.changes, ["0:0.0"])
check("one letter: pads", [one.lead, one.trail], [2, 2])
let spans = spacing("AB CD", [2, 2, 2, 0, 0])
check("a span without spacing after a spaced one", spans.changes, ["1:0.0", "2:3.0"])
check("a span without spacing: width as Android's (3 spaced characters)", spans.total, 6)
let mixed = spacing("ABCD", [2, 2, 4, 4])
check("spans with different spacing: the mean between them", mixed.changes, ["1:3.0", "3:0.0"])
check("spans with different spacing: pads", [mixed.lead, mixed.trail], [1, 2])
check("a span without spacing: no end padding", [spans.lead, spans.trail], [1, 0])
let negative = spacing("AB", [-1, -1])
check("negative spacing is left as it is", negative.changes, [])
check("negative spacing: no padding", [negative.lead, negative.trail], [0, 0])
check("no text", spacing("", []).changes, [])
check("plain text", spacing("AB", [0, 0]).changes, [])

print("\(count - failures)/\(count) text checks passed")
exit(failures == 0 ? 0 : 1)
