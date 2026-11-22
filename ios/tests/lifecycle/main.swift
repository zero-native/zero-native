// The app's life with no iOS in it, on the Mac: tools/ios-unit-test.ts builds this with ZnLifecycleRules.swift.
// WINDOW's text follows android's ZnWindowTest.kt (one decimal for sizes, exact scales); the start gate is the order
// Android gets from its Application / Activity split (JS first, or the window first, START once).
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

// WINDOW: ZnWindowTest.sizesHaveOneDecimalAndScalesStayExact, and the text itself (fixed order, no ".0").
do {
    let json = ZnWindowRules.windowJson(width: 360.04, height: 800.96, scale: 2.75, fontScale: 1.15, screenWidth: 360.04,
                                        screenHeight: 820)
    let o = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Double]
    check("width one decimal", o["width"], 360.0)
    check("height one decimal", o["height"], 801.0)
    check("scale exact", o["scale"], 2.75)
    check("fontScale exact", o["fontScale"], 1.15)
    check("screenHeight", o["screenHeight"], 820.0)
    check("the text", json, "{\"width\":360,\"height\":801,\"scale\":2.75,\"fontScale\":1.15,\"screenWidth\":360,\"screenHeight\":820}")
}
do {
    // An iPhone 16 Pro, then turned: the same window gives the same text (no event), a turn another one.
    let portrait = ZnWindowRules.windowJson(width: 402, height: 874, scale: 3, fontScale: 1, screenWidth: 402, screenHeight: 874)
    check("same window, same text", portrait,
          ZnWindowRules.windowJson(width: 402.01, height: 873.99, scale: 3, fontScale: 1, screenWidth: 402, screenHeight: 874))
    let landscape = ZnWindowRules.windowJson(width: 874, height: 402, scale: 3, fontScale: 1, screenWidth: 874, screenHeight: 402)
    check("a turn is a change", portrait == landscape, false)
    check("landscape text", landscape, "{\"width\":874,\"height\":402,\"scale\":3,\"fontScale\":1,\"screenWidth\":874,\"screenHeight\":402}")
    // Text size: three decimals (on an iOS 26 simulator xxLarge gives 1.183 and AX5 2.817, UIFontMetrics' body curve).
    check("font scale rounded", ZnWindowRules.windowJson(width: 402, height: 874, scale: 3, fontScale: 1.35294, screenWidth: 402,
                                                         screenHeight: 874).contains("\"fontScale\":1.353"), true)
    // Split view: the window is narrower than the screen.
    let split = ZnWindowRules.windowJson(width: 507.5, height: 1032, scale: 2, fontScale: 1, screenWidth: 1376, screenHeight: 1032)
    check("split view", split, "{\"width\":507.5,\"height\":1032,\"scale\":2,\"fontScale\":1,\"screenWidth\":1376,\"screenHeight\":1032}")
}
check("number: whole", ZnWindowRules.number(393), "393")
check("number: decimals", ZnWindowRules.number(1.235), "1.235")
check("number: not finite", ZnWindowRules.number(.infinity), "0")

// The keyboard's height from its layout guide's top (motion env.keyboardHeight).
check("keyboard hidden", ZnWindowRules.keyboardHeight(windowHeight: 874, guideTop: 874), 0)
check("keyboard shown", ZnWindowRules.keyboardHeight(windowHeight: 874, guideTop: 538), 336)
check("guide below the window", ZnWindowRules.keyboardHeight(windowHeight: 874, guideTop: 900), 0)
check("not finite", ZnWindowRules.keyboardHeight(windowHeight: 874, guideTop: .nan), 0)

// START: the main script and the window, in either order; once.
do {
    var g = ZnStartGate()
    check("window first: waits for JS", g.windowAsks("[1]"), nil)
    check("not started yet", g.uiStarted, false)
    check("JS runs: START now", g.scriptRan(), "[1]")
    check("started", g.uiStarted, true)
    check("a second window: nothing", g.windowAsks("[2]"), nil)
    check("the script again: nothing", g.scriptRan(), nil)
}
do {
    // A launch with no window (a push): JS runs first; START goes when the window comes, maybe much later.
    var g = ZnStartGate()
    check("JS with no window: no START", g.scriptRan(), nil)
    check("loaded, no screens", g.scriptLoaded && !g.uiStarted, true)
    check("the window comes: START now", g.windowAsks("[3]"), "[3]")
    check("started", g.uiStarted, true)
}
do {
    // An update applied in place: a new runtime starts over.
    var g = ZnStartGate()
    _ = g.scriptRan()
    _ = g.windowAsks("[1]")
    g.reset()
    check("reset", g, ZnStartGate())
    check("new window waits", g.windowAsks("[4]"), nil)
    check("new JS: START", g.scriptRan(), "[4]")
}

print(failures == 0 ? "ios lifecycle rules: \(count) checks passed" : "ios lifecycle rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
