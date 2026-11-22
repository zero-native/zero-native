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

// The keyboard's target from its frame in the root's coordinates (env.keyboardTarget, KEYBOARD).
check("covers: docked", ZnWindowRules.keyboardCovers(keyboardMinY: 538, keyboardMaxY: 874, keyboardMinX: 0, keyboardMaxX: 402,
                                                     rootWidth: 402, rootHeight: 874), 336)
check("covers: hidden below", ZnWindowRules.keyboardCovers(keyboardMinY: 874, keyboardMaxY: 1210, keyboardMinX: 0,
                                                           keyboardMaxX: 402, rootWidth: 402, rootHeight: 874), 0)
// iPad split view: the window is the right third; the keyboard spans the screen, so it is wider than the root.
check("covers: split view", ZnWindowRules.keyboardCovers(keyboardMinY: 700, keyboardMaxY: 1032, keyboardMinX: -868,
                                                         keyboardMaxX: 507.5, rootWidth: 507.5, rootHeight: 1032), 332)
// A window shorter than the screen (Stage Manager): measured to the window's bottom, not the screen's.
check("covers: short window", ZnWindowRules.keyboardCovers(keyboardMinY: 500, keyboardMaxY: 800, keyboardMinX: 0,
                                                           keyboardMaxX: 600, rootWidth: 600, rootHeight: 800), 300)
check("covers: floating", ZnWindowRules.keyboardCovers(keyboardMinY: 400, keyboardMaxY: 650, keyboardMinX: 100,
                                                       keyboardMaxX: 420, rootWidth: 1024, rootHeight: 1366), 0)
check("covers: beside the window", ZnWindowRules.keyboardCovers(keyboardMinY: 700, keyboardMaxY: 1032, keyboardMinX: 600,
                                                                keyboardMaxX: 900, rootWidth: 507.5, rootHeight: 1032), 0)
check("covers: not finite", ZnWindowRules.keyboardCovers(keyboardMinY: .nan, keyboardMaxY: 874, keyboardMinX: 0,
                                                         keyboardMaxX: 402, rootWidth: 402, rootHeight: 874), 0)

// A tap on a notification: an event, or kept for getInitialNotification.
check("tap: no screens, kept", ZnTapRules.isEvent(uiStarted: false, asking: 0, frontFor: nil, answered: false), false)
check("tap: no screens after an answer, kept", ZnTapRules.isEvent(uiStarted: false, asking: 0, frontFor: nil, answered: true), false)
check("tap: a call waits, its answer", ZnTapRules.isEvent(uiStarted: true, asking: 1, frontFor: 5, answered: false), false)
check("tap: screens, never in front yet: opened the app", ZnTapRules.isEvent(uiStarted: true, asking: 0, frontFor: nil, answered: false), false)
check("tap: just came to the front: opened the app", ZnTapRules.isEvent(uiStarted: true, asking: 0, frontFor: 0.4, answered: false), false)
check("tap: opening, but the app asked already: event", ZnTapRules.isEvent(uiStarted: true, asking: 0, frontFor: 0.4, answered: true), true)
check("tap: app in use: event", ZnTapRules.isEvent(uiStarted: true, asking: 0, frontFor: 30, answered: false), true)

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
