// The webview plugin's rules on the Mac (plugins/webview/ios/WebViewRules.swift), with the cases of android's
// WebViewRulesTest.kt that iOS has (iOS has no content:// uploads, LeaveGate or OneAnswer: its gap is a time check in
// the view, and the upload answer comes from the page script), plus the upload count and the scripts' host JSON.
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

print(failures == 0 ? "ios webview rules: \(count) checks passed" : "ios webview rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
