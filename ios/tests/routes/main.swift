// iOS routes on the Mac (tools/ios-unit-test.ts builds this with ZnRoutes.swift, from sources.txt). The deep link cases
// are ZnRoutesTest.kt's, so the two copies of the matching can't drift apart silently; the see-through cases follow
// ZnNavHost.kt's ZnSeeThroughStrategy. Argument (args.txt): the sample's built main.zn.ui.json.
import Foundation

var failures = 0
var count = 0
var current = ""

func test(_ name: String, _ body: () throws -> Void) {
    current = name
    count += 1
    do { try body() } catch { fail("threw \(error)") }
}

func fail(_ why: String, line: Int = #line) {
    failures += 1
    print("FAIL \(current) (line \(line)): \(why)")
}

func eq<T: Equatable>(_ a: T, _ b: T, _ what: String = "", line: Int = #line) {
    if a != b { fail("\(what) expected \(b), got \(a)", line: line) }
}

func yes(_ v: Bool, _ what: String = "", line: Int = #line) { if !v { fail("expected true: \(what)", line: line) } }
func no(_ v: Bool, _ what: String = "", line: Int = #line) { if v { fail("expected false: \(what)", line: line) } }

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: routes-tests <main.zn.ui.json>"); exit(2) }

func route(_ name: String, _ path: String, deepLink: Bool = true, tabs: [String] = []) -> ZnRoute {
    ZnRoute(json: ["name": name, "path": path, "deepLink": deepLink, "tabs": tabs])
}

/// The matched route's name and params ("amount merchantId=m1"), or nil.
func link(_ path: String, _ routes: [ZnRoute]) -> String? {
    guard let m = ZnLinks.match(path, routes) else { return nil }
    let params = m.params.keys.sorted().map { "\($0)=\(m.params[$0]!)" }.joined(separator: ",")
    return params.isEmpty ? routes[m.route].name : "\(routes[m.route].name) \(params)"
}

// MARK: The sample's routes (secure, transparent)

test("sampleOptions") {
    guard let routes = try ZnRoutes.read(Data(contentsOf: URL(fileURLWithPath: args[1]))) else { return fail("no routes") }
    yes(routes.count > 10, "the sample has its routes")
    eq(routes.filter(\.secure).map(\.name), ["secureLab", "secureNative", "sharedLabSecure"], "secure routes")
    eq(routes.filter(\.transparent).map(\.name), ["photoViewer", "seeThroughLab", "seeThroughSlide", "sharedLabSeeThrough", "ivInvisibleLayer"], "transparent routes")
    eq(routes.filter(\.accessibilityHidesBelow).map(\.name), ["photoViewer"], "routes that hide the screens below")
    // The other options of the transparent one still read.
    guard let viewer = routes.first(where: { $0.name == "photoViewer" }) else { return fail("no photoViewer") }
    eq(viewer.transition, .none, "photoViewer transition")
    no(viewer.restore, "photoViewer restore")
    yes(viewer.lightStatusBar, "photoViewer statusBar light")
    no(viewer.safeTop || viewer.safeBottom, "photoViewer safeArea none")
}

test("optionDefaults") {
    let r = ZnRoute(json: ["name": "a", "path": "/a"])
    no(r.secure, "secure")
    no(r.transparent, "transparent")
    yes(r.restore, "restore")
    eq(r.transition, .push, "transition")
    no(r.accessibilityHidesBelow, "accessibilityHidesBelow")
    let on = ZnRoute(json: ["name": "b", "secure": true, "transparent": true, "accessibilityHidesBelow": true])
    yes(on.secure && on.transparent && on.accessibilityHidesBelow, "all on")
}

// MARK: See-through (ZnSeeThroughStrategy)

test("seeThroughRange") {
    eq(ZnRoutes.seeThroughRange([false, false, true]), 1..<3, "one over an opaque one")
    eq(ZnRoutes.seeThroughRange([false, true, true]), 0..<3, "two see-through ones")
    eq(ZnRoutes.seeThroughRange([true, true]), 0..<2, "see-through at the bottom too")
    eq(ZnRoutes.seeThroughRange([false, false]), nil, "opaque top")
    eq(ZnRoutes.seeThroughRange([false, true, false]), nil, "opaque over a see-through")
    eq(ZnRoutes.seeThroughRange([true]), nil, "alone")
    eq(ZnRoutes.seeThroughRange([]), nil, "empty")
}

test("seeThroughGroups") {
    eq(ZnRoutes.seeThroughGroups([]), [], "empty")
    eq(ZnRoutes.seeThroughGroups([false]), [0..<1], "one screen")
    eq(ZnRoutes.seeThroughGroups([false, false, false]), [0..<1, 1..<2, 2..<3], "opaque screens: one each")
    eq(ZnRoutes.seeThroughGroups([false, false, true]), [0..<1, 1..<3], "a see-through one joins the screen below")
    eq(ZnRoutes.seeThroughGroups([false, true, true]), [0..<3], "two see-through ones")
    eq(ZnRoutes.seeThroughGroups([false, true, false, true]), [0..<2, 2..<4], "a push over a see-through one starts a group")
    eq(ZnRoutes.seeThroughGroups([true, false]), [0..<1, 1..<2], "see-through at the bottom, covered")
    eq(ZnRoutes.seeThroughGroups([true, true]), [0..<2], "see-through at the bottom too")
    // The top group is what ZnSeeThroughStrategy draws together, whenever it draws more than one.
    for t in [[false, true], [false, false, true], [true, true, true], [false, true, false, true, true]] {
        eq(ZnRoutes.seeThroughGroups(t).last, ZnRoutes.seeThroughRange(t), "top group \(t)")
    }
}

// MARK: Deep links (ZnRoutesTest.kt)

let routes = [
    route("home", "/"),
    route("amount", "/pay/:merchantId"),
    route("newPay", "/pay/new"),
    route("tab", "/pay/:merchantId/:tab"),
    route("secret", "/admin/:id", deepLink: false),
]

test("aTabLinkOpensItsScreenWithTheTab") {
    let r = [
        route("home", "/", tabs: ["pay", "stores"]),
        route("offers", "/offers"),
        route("shop", "/shop/:id", tabs: ["menu", "reviews"]),
        route("quiet", "/quiet", deepLink: false, tabs: ["a", "b"]),
    ]
    eq(link("/stores", r), "home tab=stores")
    eq(link("/", r), "home", "the screen itself still matches")
    eq(link("/offers", r), "offers", "not a tab: an ordinary route")
    eq(link("/shop/s%201/reviews", r), "shop id=s 1,tab=reviews")
    eq(link("/shop/s1", r), "shop id=s1")
    eq(link("/shop/s1/photos", r), nil, "not one of its tabs")
    eq(link("/quiet/a", r), nil, "no deepLink: its tabs can't be linked either")
}

test("matchesParamsAndRoot") {
    eq(link("/pay/m1", routes), "amount merchantId=m1")
    eq(link("/pay/m1/upi", routes), "tab merchantId=m1,tab=upi")
    eq(link("/", routes), "home")
    eq(link("", routes), "home")
    // Trailing slash, query and fragment are ignored.
    eq(link("/pay/m1/?utm=x#top", routes), "amount merchantId=m1")
}

test("literalBeatsParam") {
    eq(link("/pay/new", routes), "newPay")
}

test("noMatch") {
    eq(link("/pay", routes), nil)
    eq(link("/pay/m1/upi/extra", routes), nil)
    eq(link("/other/m1", routes), nil)
    eq(link("/admin/1", routes), nil, "routes without deepLink can't be opened from a link")
}

test("decodesParams") {
    eq(link("/pay/Kalyan%20Jewellers", routes), "amount merchantId=Kalyan Jewellers")
    eq(link("/pay/a+b", routes), "amount merchantId=a+b")
    eq(link("/pay/%E2%82%B9", routes), "amount merchantId=₹")
    // Malformed escapes and invalid UTF-8 don't match.
    eq(link("/pay/%2", routes), nil)
    eq(link("/pay/%ZZ", routes), nil)
    eq(link("/pay/%C3%28", routes), nil)
}

test("urlQueryValuesAreParams") {
    let m = ZnLinks.match(URL(string: "zn://sample/pay/m1?ref=qr&merchantId=other")!, routes)
    eq(m.map { routes[$0.route].name }, "amount")
    eq(m?.params["ref"], "qr", "a query value")
    eq(m?.params["merchantId"], "m1", "the path's value wins")
}

print(failures == 0 ? "routes: \(count) tests passed" : "routes: \(failures) failures in \(count) tests")
exit(failures == 0 ? 0 : 1)
