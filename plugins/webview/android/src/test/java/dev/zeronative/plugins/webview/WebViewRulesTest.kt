package dev.zeronative.plugins.webview

import dev.zeronative.plugins.webview.WebViewRules.Action
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewRulesTest {
    private val policy = WebViewRules.policy(
        listOf("pay.example.com", "*.shop.example", "port.example:8443"),
        listOf("tel", "mailto", "upi"),
        localHttp = false,
    )

    private fun action(url: String, mainFrame: Boolean = true) = WebViewRules.decide(url, mainFrame, policy).action
    private fun reason(url: String) = WebViewRules.decide(url, true, policy).reason

    @Test fun anAllowedHostStaysInside() {
        assertEquals(Action.STAY, action("https://pay.example.com/checkout?a=1#top"))
        assertEquals(Action.STAY, action("HTTPS://PAY.EXAMPLE.COM/"))
        assertEquals(Action.STAY, action("https://pay.example.com:443/"))
        assertEquals(Action.STAY, action("https://a.shop.example/"))
        assertEquals(Action.STAY, action("https://a.b.shop.example/"))
        assertEquals(Action.STAY, action("https://port.example:8443/x"))
    }

    @Test fun anyOtherHostIsRefused() {
        for (url in listOf(
            "https://evil.com/",
            "https://shop.example/", // a star covers what is under the name, not the name
            "https://pay.example.com.evil.com/",
            "https://notpay.example.com/",
            "https://evilshop.example/",
            "https://port.example/", // the port must match
            "https://pay.example.com:8443/",
        )) assertEquals(url, "host", reason(url))
    }

    @Test fun plainHttpIsRefusedEvenForAnAllowedHost() {
        assertEquals("host", reason("http://pay.example.com/"))
    }

    @Test fun waysToFoolAHostCheckAreRefused() {
        for (url in listOf(
            "https://pay.example.com@evil.com/",
            "https://pay.example.com:x@evil.com/",
            "https://evil.com\\@pay.example.com/",
            "https://evil.com\\.pay.example.com/",
            "https://evil.com#@pay.example.com/",
            "https://evil.com?@pay.example.com/",
            "https://pay.example.com\t.evil.com/",
            " https://pay.example.com/",
            "https://pay.example.com:99999/",
            "https://pay.example.com:abc/",
            "https://[::1]/",
            "https://pаy.example.com/", // a Cyrillic a
            "https:pay.example.com",
            "https:///pay.example.com",
        )) assertEquals(url, Action.REFUSE, action(url))
    }

    @Test fun onlyListedSchemesLeave() {
        assertEquals(Action.LEAVE, action("tel:+911234567890"))
        assertEquals(Action.LEAVE, action("mailto:a@example.com"))
        assertEquals(Action.LEAVE, action("upi://pay?pa=x@y&am=1"))
        assertEquals(Action.LEAVE, action("TEL:123"))
        assertEquals(Action.REFUSE, action("sms:123"))
        assertEquals(Action.REFUSE, action("market://details?id=x"))
    }

    @Test fun nothingLeavesFromAnIframe() {
        assertEquals("frame", WebViewRules.decide("tel:123", false, policy).reason)
        assertEquals(Action.REFUSE, action("upi://pay?pa=x", mainFrame = false))
        assertEquals(Action.REFUSE, action("intent://x#Intent;end", mainFrame = false))
        assertEquals(Action.REFUSE, action("javascript:alert(1)", mainFrame = false))
        assertEquals(Action.STAY, action("https://other.com/", mainFrame = false))
        assertEquals(Action.STAY, action("about:srcdoc", mainFrame = false))
    }

    @Test fun intentLinksAreAlwaysRefused() {
        val listed = WebViewRules.policy(listOf("pay.example.com"), listOf("intent", "android-app", "INTENT:"), false)
        assertTrue(listed.leaveSchemes.isEmpty())
        assertEquals(3, listed.refused.size)
        for (url in listOf(
            "intent://pay#Intent;scheme=upi;package=com.bank;end",
            "intent://x#Intent;component=dev.zeronative.sample/.MainActivity;S.secret=1;end",
            "INTENT://x#Intent;end",
            "intent:#Intent;action=android.intent.action.CALL;end",
            "android-app://com.bank/https/example.com",
        )) {
            assertEquals(url, Action.REFUSE, WebViewRules.decide(url, true, listed).action)
            assertEquals(url, "scheme", WebViewRules.decide(url, true, listed).reason)
        }
    }

    @Test fun localSchemesNeverOpen() {
        val listed = WebViewRules.policy(listOf("pay.example.com"), listOf("file", "content", "javascript", "data", "about", "blob"), false)
        assertTrue(listed.leaveSchemes.isEmpty())
        for (url in listOf(
            "file:///data/data/app/secret",
            "content://app.provider/secret",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "blob:https://pay.example.com/1",
            "chrome://crash",
        )) assertEquals(url, Action.REFUSE, WebViewRules.decide(url, true, listed).action)
    }

    @Test fun nothingAllowedMeansNothingStays() {
        assertEquals(Action.REFUSE, WebViewRules.decide("https://pay.example.com/", true, WebViewRules.NONE).action)
    }

    @Test fun aLongLinkIsRefused() {
        assertEquals(Action.REFUSE, action("https://pay.example.com/" + "a".repeat(WebViewRules.MAX_URL_CHARS)))
    }

    @Test fun originsAreCheckedLikePages() {
        assertTrue(policy.allowsOrigin("https://pay.example.com"))
        assertTrue(policy.allowsOrigin("https://a.shop.example"))
        assertTrue(policy.allowsOrigin("https://port.example:8443"))
        assertFalse(policy.allowsOrigin("https://evil.com"))
        assertFalse(policy.allowsOrigin("http://pay.example.com"))
        assertFalse(policy.allowsOrigin("https://port.example"))
        assertFalse(policy.allowsOrigin("null"))
        assertFalse(policy.allowsOrigin(""))
    }

    @Test fun rulesBecomeWebkitOrigins() {
        assertEquals(
            listOf("https://pay.example.com", "https://*.shop.example", "https://port.example:8443"),
            policy.hosts.map { it.origin },
        )
        assertEquals("http://localhost:8790", WebViewRules.hostRule("http://localhost:8790", true)?.origin)
        assertEquals("https://example.com", WebViewRules.hostRule("https://Example.com", false)?.origin)
    }

    @Test fun badHostRulesAreRefused() {
        for (raw in listOf(
            "*", "*.com", "*.*.example.com", "ex*ample.com", "a.*.example.com", "*.127.0.0.1",
            "", "https://", "example.com/path", "example.com?x", "ftp://example.com", "user@example.com",
            "javascript://example.com", "http://example.com",
        )) assertNull(raw, WebViewRules.hostRule(raw, localHttp = true))
    }

    @Test fun plainHttpOnlyForThisComputerInDebugBuilds() {
        assertNull(WebViewRules.hostRule("http://localhost:8790", localHttp = false))
        assertNull(WebViewRules.hostRule("http://127.0.0.1:8790", localHttp = false))
        assertNull(WebViewRules.hostRule("http://10.0.0.2:8790", localHttp = true))
        assertNull(WebViewRules.hostRule("http://*.localhost", localHttp = true))
        assertNotNull(WebViewRules.hostRule("http://127.0.0.1:8790", localHttp = true))
    }

    @Test fun aBadEntryIsReported() {
        val p = WebViewRules.policy(listOf("ok.example", "*"), listOf("tel", "not a scheme"), false)
        assertEquals(1, p.hosts.size)
        assertEquals(listOf("*", "not a scheme"), p.refused)
    }

    @Test fun thePageCheckCatchesWhatTheLinkCheckMisses() {
        assertTrue(WebViewRules.pageMayShow("https://pay.example.com/x", policy, inline = false))
        assertFalse(WebViewRules.pageMayShow("https://evil.com/form", policy, inline = false))
        assertTrue(WebViewRules.pageMayShow("about:blank", policy, inline = false))
        assertFalse(WebViewRules.pageMayShow("data:text/html,hi", policy, inline = false))
        assertTrue(WebViewRules.pageMayShow("data:text/html,hi", policy, inline = true))
        assertFalse(WebViewRules.pageMayShow("https://evil.com/", policy, inline = true))
        assertFalse(WebViewRules.pageMayShow(null, policy, inline = false))
    }

    @Test fun onlyContentFromOtherAppsCanBeUploaded() {
        val ours = { a: String -> a == "dev.zeronative.sample.files" }
        assertTrue(WebViewRules.uploadAllowed("content", "media", ours))
        assertTrue(WebViewRules.uploadAllowed("content", "0@media", ours))
        assertFalse(WebViewRules.uploadAllowed("file", null, ours))
        assertFalse(WebViewRules.uploadAllowed("file", "", ours))
        assertFalse(WebViewRules.uploadAllowed("content", "dev.zeronative.sample.files", ours))
        assertFalse(WebViewRules.uploadAllowed("content", "0@dev.zeronative.sample.files", ours))
        assertFalse(WebViewRules.uploadAllowed(null, "media", ours))
    }

    @Test fun logsSeeTheHostOnly() {
        assertEquals("pay.example.com", WebViewRules.hostOf("https://pay.example.com/x?token=secret"))
        assertEquals("tel", WebViewRules.hostOf("tel:123"))
        assertEquals("?", WebViewRules.hostOf("not a link"))
    }

    @Test fun linksOutHaveAGap() {
        val gate = LeaveGate(gapMs = 800)
        assertTrue(gate.allow(0))
        assertFalse(gate.allow(100))
        assertFalse(gate.allow(799))
        assertTrue(gate.allow(800))
    }

    @Test fun anUploadIsAnsweredOnce() {
        val heard = ArrayList<String?>()
        val slot = OneAnswer<String>()
        slot.open { heard += it }
        assertTrue(slot.open)
        slot.answer("file")
        slot.answer("again")
        assertEquals(listOf<String?>("file"), heard)
        assertFalse(slot.open)
    }

    @Test fun aNewUploadClosesTheOldOne() {
        val first = ArrayList<String?>()
        val second = ArrayList<String?>()
        val slot = OneAnswer<String>()
        slot.open { first += it }
        slot.open { second += it }
        assertEquals(listOf<String?>(null), first)
        slot.answer("b")
        assertEquals(listOf<String?>("b"), second)
    }

    @Test fun closingTheViewAnswersWithNull() {
        val heard = ArrayList<String?>()
        val slot = OneAnswer<String>()
        slot.open { heard += it }
        slot.answer(null)
        assertEquals(listOf<String?>(null), heard)
    }
}
