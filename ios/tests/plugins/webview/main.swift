// The webview plugin's rules on the Mac (plugins/webview/ios/WebViewRules.swift), with the cases of android's
// WebViewRulesTest.kt that iOS has (iOS has no content:// uploads, LeaveGate or OneAnswer: its gap is a time check in
// the view, and the upload answer comes from the page script), plus the upload count and the scripts' host JSON.
import Foundation
import JavaScriptCore

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

let policy = WebViewRules.policy(["pay.example.com", "*.shop.example", "port.example:8443"], ["tel", "mailto", "upi"], localHttp: false)
func action(_ url: String, main: Bool = true) -> WebViewRules.Action { WebViewRules.decide(url, mainFrame: main, policy).0 }
func reason(_ url: String) -> String? { WebViewRules.decide(url, mainFrame: true, policy).1 }

// An allowed host stays inside
for url in ["https://pay.example.com/checkout?a=1#top", "HTTPS://PAY.EXAMPLE.COM/", "https://pay.example.com:443/",
            "https://a.shop.example/", "https://a.b.shop.example/", "https://port.example:8443/x"] {
    check("stays \(url)", action(url), .stay)
}

// Any other host is refused
for url in ["https://evil.com/", "https://shop.example/", "https://pay.example.com.evil.com/", "https://notpay.example.com/",
            "https://evilshop.example/", "https://port.example/", "https://pay.example.com:8443/"] {
    check("host \(url)", reason(url), "host")
}
check("plain http refused", reason("http://pay.example.com/"), "host")

// Ways to fool a host check are refused
for url in ["https://pay.example.com@evil.com/", "https://pay.example.com:x@evil.com/", "https://evil.com\\@pay.example.com/",
            "https://evil.com\\.pay.example.com/", "https://evil.com#@pay.example.com/", "https://evil.com?@pay.example.com/",
            "https://pay.example.com\t.evil.com/", " https://pay.example.com/", "https://pay.example.com:99999/",
            "https://pay.example.com:abc/", "https://[::1]/", "https://pаy.example.com/", "https:pay.example.com",
            "https:///pay.example.com"] {
    check("fooled \(url.debugDescription)", action(url), .refuse)
}

// Only listed schemes leave, and nothing leaves from an iframe
check("tel", action("tel:+911234567890"), .leave)
check("mailto", action("mailto:a@example.com"), .leave)
check("upi", action("upi://pay?pa=x@y&am=1"), .leave)
check("TEL", action("TEL:123"), .leave)
check("sms", action("sms:123"), .refuse)
check("market", action("market://details?id=x"), .refuse)
check("frame tel reason", WebViewRules.decide("tel:123", mainFrame: false, policy).1, "frame")
check("frame upi", action("upi://pay?pa=x", main: false), .refuse)
check("frame intent", action("intent://x#Intent;end", main: false), .refuse)
check("frame javascript", action("javascript:alert(1)", main: false), .refuse)
check("frame other host", action("https://other.com/", main: false), .stay)
check("frame srcdoc", action("about:srcdoc", main: false), .stay)

// Intent links and local schemes never open
do {
    let listed = WebViewRules.policy(["pay.example.com"], ["intent", "android-app", "INTENT:"], localHttp: false)
    check("intent schemes dropped", listed.leaveSchemes.isEmpty, true)
    check("intent schemes reported", listed.refused.count, 3)
    for url in ["intent://pay#Intent;scheme=upi;package=com.bank;end", "INTENT://x#Intent;end", "android-app://com.bank/https/example.com"] {
        check("intent \(url)", WebViewRules.decide(url, mainFrame: true, listed).1, "scheme")
    }
    let local = WebViewRules.policy(["pay.example.com"], ["file", "content", "javascript", "data", "about", "blob"], localHttp: false)
    check("local schemes dropped", local.leaveSchemes.isEmpty, true)
    for url in ["file:///data/secret", "content://app.provider/secret", "javascript:alert(1)", "data:text/html,hi", "about:blank",
                "blob:https://pay.example.com/1", "chrome://crash"] {
        check("local \(url)", WebViewRules.decide(url, mainFrame: true, local).0, .refuse)
    }
}
check("nothing allowed", WebViewRules.decide("https://pay.example.com/", mainFrame: true, WebViewRules.none).0, .refuse)
check("long link", action("https://pay.example.com/" + String(repeating: "a", count: WebViewRules.maxUrlChars)), .refuse)

// Origins (the bridge and upload checks) are checked like pages
check("origin ok", policy.allowsPage("https://pay.example.com"), true)
check("origin wild", policy.allowsPage("https://a.shop.example"), true)
check("origin port", policy.allowsPage("https://port.example:8443"), true)
check("origin evil", policy.allowsPage("https://evil.com"), false)
check("origin http", policy.allowsPage("http://pay.example.com"), false)
check("origin no port", policy.allowsPage("https://port.example"), false)
check("origin null", policy.allowsPage("null"), false)
check("origin empty", policy.allowsPage(""), false)

// Bad host rules are refused; plain http only for this computer in debug builds
for raw in ["*", "*.com", "*.*.example.com", "ex*ample.com", "a.*.example.com", "*.127.0.0.1", "", "https://", "example.com/path",
            "example.com?x", "ftp://example.com", "user@example.com", "javascript://example.com", "http://example.com"] {
    check("bad rule \(raw)", WebViewRules.hostRule(raw, localHttp: true) == nil, true)
}
check("localhost, release", WebViewRules.hostRule("http://localhost:8790", localHttp: false) == nil, true)
check("127, release", WebViewRules.hostRule("http://127.0.0.1:8790", localHttp: false) == nil, true)
check("lan, debug", WebViewRules.hostRule("http://10.0.0.2:8790", localHttp: true) == nil, true)
check("wild localhost", WebViewRules.hostRule("http://*.localhost", localHttp: true) == nil, true)
check("127, debug", WebViewRules.hostRule("http://127.0.0.1:8790", localHttp: true) != nil, true)
do {
    let p = WebViewRules.policy(["ok.example", "*"], ["tel", "not a scheme"], localHttp: false)
    check("one good host", p.hosts.count, 1)
    check("bad entries reported", p.refused, ["*", "not a scheme"])
}

// The page check catches what the link check misses
check("page ok", WebViewRules.pageMayShow("https://pay.example.com/x", policy, inline: false), true)
check("page evil", WebViewRules.pageMayShow("https://evil.com/form", policy, inline: false), false)
check("page blank", WebViewRules.pageMayShow("about:blank", policy, inline: false), true)
check("page data", WebViewRules.pageMayShow("data:text/html,hi", policy, inline: false), false)
check("page data inline", WebViewRules.pageMayShow("data:text/html,hi", policy, inline: true), true)
check("page evil inline", WebViewRules.pageMayShow("https://evil.com/", policy, inline: true), false)
check("page nil", WebViewRules.pageMayShow(nil, policy, inline: false), false)

// Logs see the host only
check("host of", WebViewRules.hostOf("https://pay.example.com/x?token=secret"), "pay.example.com")
check("host of tel", WebViewRules.hostOf("tel:123"), "tel")
check("host of junk", WebViewRules.hostOf("not a link"), "?")

// The upload script's answer: a whole count of files, never negative or huge, 0 for anything else
check("upload 2", WebViewRules.uploadCount(NSNumber(value: 2)), 2)
check("upload 0", WebViewRules.uploadCount(NSNumber(value: 0)), 0)
check("upload negative", WebViewRules.uploadCount(NSNumber(value: -3)), 0)
check("upload fraction", WebViewRules.uploadCount(NSNumber(value: 2.9)), 2)
check("upload huge", WebViewRules.uploadCount(NSNumber(value: 1e12)), WebViewRules.maxUploadCount)
check("upload NaN", WebViewRules.uploadCount(NSNumber(value: Double.nan)), 0)
check("upload text", WebViewRules.uploadCount("2"), 0)
check("upload nil", WebViewRules.uploadCount(nil), 0)

// The scripts get the allowed hosts as JSON: scheme, host, port (-1 = the scheme's own) and star
check("script rules", WebViewRules.scriptRules(policy),
      #"[{"h":"pay.example.com","p":-1,"s":"https","w":false},{"h":"shop.example","p":-1,"s":"https","w":true},{"h":"port.example","p":8443,"s":"https","w":false}]"#)
check("script rules none", WebViewRules.scriptRules(WebViewRules.none), "[]")

// The upload script itself, under JavaScriptCore with a tiny stand-in for the page: its host rule (the same as
// WebViewRules.Policy's, copied into JavaScript), and when it stops a file input and what it answers.
struct UploadRun { var posted: [Int] = []; var prevented = false }
func upload(_ origin: String, on: Bool = true, frame ancestors: [String]? = nil, _ steps: String) -> UploadRun {
    let ctx = JSContext()!
    var errors: [String] = []
    ctx.exceptionHandler = { _, e in errors.append(e?.toString() ?? "?") }
    let anc = ancestors.map { "[" + $0.map { "'\($0)'" }.joined(separator: ",") + "]" } ?? "[]"
    ctx.evaluateScript("""
    var window = this, posted = [], listeners = {};
    window.top = \(ancestors == nil ? "window" : "{}");
    var location = { origin: '\(origin)', ancestorOrigins: \(anc) };
    window.addEventListener = function(t, f){ (listeners[t] = listeners[t] || []).push(f); };
    window.webkit = { messageHandlers: { znUpload: { postMessage: function(n){ posted.push(n); } } } };
    function input(n, type){ return { tagName: 'INPUT', type: type || 'file', files: { length: n || 0 }, l: {},
      addEventListener: function(t, f){ (this.l[t] = this.l[t] || []).push(f); } }; }
    function ev(path, trusted){ return { target: path[path.length - 1], isTrusted: trusted !== false, prevented: false,
      composedPath: function(){ return path; }, preventDefault: function(){ this.prevented = true; }, stopImmediatePropagation: function(){} }; }
    function fire(type, e){ (listeners[type] || []).forEach(function(f){ f(e); }); }
    function fireOn(el, type, e){ (el.l[type] || []).forEach(function(f){ f(e); }); }
    """)
    ctx.evaluateScript(WebViewRules.uploadScript(WebViewRules.scriptRules(policy), allowed: on, handler: "znUpload"))
    ctx.evaluateScript("var prevented = false;\n" + steps)
    if !errors.isEmpty { print("JS errors: \(errors)") }
    let posted = (ctx.objectForKeyedSubscript("posted").toArray() ?? []).compactMap { ($0 as? NSNumber)?.intValue }
    return UploadRun(posted: errors.isEmpty ? posted : [-1], prevented: ctx.objectForKeyedSubscript("prevented").toBool())
}
let clickPick = "var i = input(2); var c = ev([i]); fire('click', c); prevented = c.prevented; var e = ev([i]); fire('change', e); fireOn(i, 'change', e);"
// A stopped click opens no picker, so no change follows
let clickOnly = "var i = input(2); var c = ev([i]); fire('click', c); prevented = c.prevented;"
do {
    let r = upload("https://pay.example.com", clickPick)
    check("upload allowed opens", r.prevented, false)
    check("upload allowed answers once", r.posted, [2])
}
for origin in ["https://evil.com", "https://shop.example", "https://pay.example.com.evil.com", "https://port.example",
               "https://pay.example.com:8443", "http://pay.example.com", "null", "file://"] {
    let r = upload(origin, clickOnly)
    check("upload refused on \(origin)", r.prevented, true)
    check("upload refused answers 0 on \(origin)", r.posted, [0])
}
for origin in ["https://a.shop.example", "https://a.b.shop.example", "https://port.example:8443", "https://pay.example.com:443", "HTTPS://PAY.EXAMPLE.COM"] {
    check("upload host \(origin)", upload(origin, clickPick).prevented, false)
}
do {
    let r = upload("https://pay.example.com", on: false, clickOnly)
    check("upload off stops", r.prevented, true)
    check("upload off answers 0", r.posted, [0])
}
// A frame counts by the top page's origin (ancestorOrigins' last)
check("upload frame on allowed page", upload("https://evil.com", frame: ["https://x.test", "https://pay.example.com"], clickPick).prevented, false)
check("upload frame on other page", upload("https://pay.example.com", frame: ["https://evil.com"], clickPick).prevented, true)
check("upload frame no ancestors", upload("https://pay.example.com", frame: [], clickPick).prevented, true)
// An input in an open shadow root: the click's target is the host, its composed path starts at the input
do {
    let steps = "var i = input(1), host = { tagName: 'DIV' }; var c = ev([i, host]); c.target = host; fire('click', c); prevented = c.prevented;"
    let r = upload("https://pay.example.com", on: false, steps)
    check("upload shadow stopped", r.prevented, true)
    check("upload shadow answers 0", r.posted, [0])
    // change doesn't leave a shadow root: the clicked input's own listener answers
    let pick = "var i = input(3), host = { tagName: 'DIV' }; var c = ev([i, host]); c.target = host; fire('click', c); fireOn(i, 'change', ev([i]));"
    check("upload shadow change", upload("https://pay.example.com", pick).posted, [3])
}
// showPicker(): no click, the browser's own change still answers
check("upload no click", upload("https://pay.example.com", "fire('change', ev([input(2)]));").posted, [2])
check("upload cancel", upload("https://pay.example.com", "var i = input(0); fire('click', ev([i])); fire('cancel', ev([i]));").posted, [0])
// A page's own made-up events (isTrusted false) and other inputs don't answer
check("upload fake change", upload("https://pay.example.com", "fire('change', ev([input(5)], false));").posted, [])
check("upload fake cancel", upload("https://pay.example.com", "fire('cancel', ev([input(0)], false));").posted, [])
check("upload text input", upload("https://pay.example.com", "var t = input(0, 'text'); var c = ev([t]); fire('click', c); prevented = c.prevented; fire('change', ev([t]));").posted, [])
check("upload text input open", upload("https://pay.example.com", on: false, "var t = input(0, 'text'); var c = ev([t]); fire('click', c); prevented = c.prevented;").prevented, false)
check("upload FILE type", upload("https://pay.example.com", on: false, "var i = input(1, 'FILE'); var c = ev([i]); fire('click', c); prevented = c.prevented;").prevented, true)
// Native's own check (the open-panel gate)
check("refuses off", WebViewRules.refusesUploads(fileUpload: false, page: "https://pay.example.com/", policy), true)
check("refuses other host", WebViewRules.refusesUploads(fileUpload: true, page: "https://evil.com/", policy), true)
check("refuses blank", WebViewRules.refusesUploads(fileUpload: true, page: "about:blank", policy), true)
check("refuses nil", WebViewRules.refusesUploads(fileUpload: true, page: nil, policy), true)
check("allows", WebViewRules.refusesUploads(fileUpload: true, page: "https://pay.example.com/x", policy), false)

print(failures == 0 ? "ios webview rules: \(count) checks passed" : "ios webview rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
