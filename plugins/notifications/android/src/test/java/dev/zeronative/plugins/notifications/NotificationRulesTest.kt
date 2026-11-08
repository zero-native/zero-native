package dev.zeronative.plugins.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationRulesTest {
    @Test fun `importance names map to Android's values, default when left out, null when unknown`() {
        assertEquals(4, NotificationRules.importance("high"))
        assertEquals(3, NotificationRules.importance(null))
        assertEquals(0, NotificationRules.importance("none"))
        assertNull(NotificationRules.importance("urgent"))
    }

    @Test fun `a picture wins, then big text for a long body or an explicit one, else plain`() {
        assertEquals(NotificationRules.Style.PICTURE, NotificationRules.style("short", null, hasPicture = true))
        assertEquals(NotificationRules.Style.BIG_TEXT, NotificationRules.style("x".repeat(41), null, hasPicture = false))
        assertEquals(NotificationRules.Style.BIG_TEXT, NotificationRules.style("short", "longer text", hasPicture = false))
        assertEquals(NotificationRules.Style.PLAIN, NotificationRules.style("short", null, hasPicture = false))
        assertEquals(NotificationRules.Style.PLAIN, NotificationRules.style(null, null, hasPicture = false))
    }

    @Test fun `images come over https, and over http only in debug builds`() {
        assertTrue(NotificationRules.imageUrlAllowed("https://cdn.example.com/a.png", debug = false))
        assertFalse(NotificationRules.imageUrlAllowed("http://10.0.2.2/a.png", debug = false))
        assertTrue(NotificationRules.imageUrlAllowed("http://10.0.2.2/a.png", debug = true))
        assertFalse(NotificationRules.imageUrlAllowed("file:///sdcard/a.png", debug = true))
    }

    @Test fun `summary tags are told apart from the app's own ids`() {
        assertEquals("zn-summary:OFFERS", NotificationRules.summaryTag("OFFERS"))
        assertTrue(NotificationRules.isSummaryTag("zn-summary:OFFERS"))
        assertFalse(NotificationRules.isSummaryTag("offer-12"))
        assertFalse(NotificationRules.isSummaryTag(null))
    }

    @Test fun `summary lines and text`() {
        assertEquals("Cafe: 10% off", NotificationRules.inboxLine("Cafe", "10% off"))
        assertEquals("Cafe", NotificationRules.inboxLine("Cafe", " "))
        assertEquals("3 stores have new offers", NotificationRules.summaryText("%d stores have new offers", 3))
        assertEquals("New offers", NotificationRules.summaryText("New offers", 3))
        assertNull(NotificationRules.summaryText(null, 3))
    }

    @Test fun `why a notification can't show`() {
        assertEquals("off", NotificationRules.blocked(appEnabled = false, channelExists = true, channelImportance = 4))
        assertEquals("no_channel", NotificationRules.blocked(appEnabled = true, channelExists = false, channelImportance = null))
        assertEquals("channel_blocked", NotificationRules.blocked(appEnabled = true, channelExists = true, channelImportance = 0))
        assertNull(NotificationRules.blocked(appEnabled = true, channelExists = true, channelImportance = 3))
    }

    @Test fun `inbox lines come after a picture, before big text`() {
        assertEquals(NotificationRules.Style.PICTURE, NotificationRules.style("b", null, hasPicture = true, hasLines = true))
        assertEquals(NotificationRules.Style.INBOX, NotificationRules.style("x".repeat(60), "big", hasPicture = false, hasLines = true))
    }

    @Test fun `lock screen visibility, categories, colors and progress`() {
        assertEquals(0, NotificationRules.visibility(null))
        assertEquals(-1, NotificationRules.visibility("secret"))
        assertNull(NotificationRules.visibility("hidden"))
        assertEquals("msg", NotificationRules.category("message"))
        assertEquals("", NotificationRules.category("unknown"))
        assertNull(NotificationRules.category(null))
        assertEquals(0xFFE23744.toInt(), NotificationRules.color("#E23744"))
        assertEquals(0x80E23744.toInt(), NotificationRules.color("#80E23744"))
        assertNull(NotificationRules.color("red"))
        assertNull(NotificationRules.progress(null, 3, null))
        assertEquals(100, NotificationRules.progress(100, 250, null)!!.current)
        assertTrue(NotificationRules.progress(null, null, true)!!.indeterminate)
        assertNull(NotificationRules.progress(0, 0, false))
    }

    @Test fun `each button of each notification has its own request code`() {
        assertTrue(NotificationRules.actionRequestCode("n1", "pay") != NotificationRules.actionRequestCode("n1", "later"))
        assertTrue(NotificationRules.actionRequestCode("n1", "pay") != NotificationRules.actionRequestCode("n2", "pay"))
    }

    @Test fun `a repeat moves to its next time after now, a time ahead stays`() {
        val day = 86_400_000L
        assertEquals(1_000L, NotificationRules.nextAt(1_000L, "daily", 500L))
        assertEquals(1_000L + day, NotificationRules.nextAt(1_000L, "daily", 1_000L))
        assertEquals(1_000L + 3 * day, NotificationRules.nextAt(1_000L, "daily", 1_000L + 2 * day + 5))
        assertEquals(1_000L, NotificationRules.nextAt(1_000L, "yearly", 9_000L))
        assertNull(NotificationRules.repeatMs("monthly"))
        assertEquals(604_800_000L, NotificationRules.repeatMs("weekly"))
    }

    @Test
    fun htmlOnlyWhenTheTextHasATagOrAnEntity() {
        // The cashback push, as the backend sends it.
        assertTrue(NotificationRules.looksLikeHtml("You got <b><span style=\"color:#0A8F08\">₹25</span></b> cashback"))
        assertTrue(NotificationRules.looksLikeHtml("Tom &amp; Jerry"))
        assertTrue(NotificationRules.looksLikeHtml("&#8377;25"))
        assertTrue(NotificationRules.looksLikeHtml("line<br/>break"))
        // Plain text stays exactly as given (Android's HTML reader would turn its line breaks into spaces).
        assertFalse(NotificationRules.looksLikeHtml("Paid ₹499 to Ravi\nRef 1234"))
        assertFalse(NotificationRules.looksLikeHtml("2 < 3 and 5 > 4"))
        assertFalse(NotificationRules.looksLikeHtml("Save 10% & more"))
    }

    @Test fun `every push service gives JS the same message shape`() {
        val m = PushMessage("fcm", "0:1", "/topics/offers", 5L, "high", "weird", mapOf("lab" to "x"), PushMessage.Notice("T", null))
        val f = NotificationRules.messageFields(m, inFront = true)
        assertEquals(listOf("provider", "messageId", "from", "sentAt", "priority", "originalPriority", "inFront", "data", "notification"), f.keys.toList())
        assertEquals("fcm", f["provider"])
        assertEquals("high", f["priority"])
        assertEquals("unknown", f["originalPriority"])
        assertEquals(mapOf("title" to "T", "body" to null), f["notification"])
        assertNull(NotificationRules.messageFields(PushMessage("apns", null, null, 0L, null, data = emptyMap()), false)["notification"])
    }
}
