package dev.zeronative.plugins.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRulesTest {
    @Test fun `importance names map to Android's values, default when left out, null when unknown`() {
        assertEquals(4, PushRules.importance("high"))
        assertEquals(3, PushRules.importance(null))
        assertEquals(0, PushRules.importance("none"))
        assertNull(PushRules.importance("urgent"))
    }

    @Test fun `a picture wins, then big text for a long body or an explicit one, else plain`() {
        assertEquals(PushRules.Style.PICTURE, PushRules.style("short", null, hasPicture = true))
        assertEquals(PushRules.Style.BIG_TEXT, PushRules.style("x".repeat(41), null, hasPicture = false))
        assertEquals(PushRules.Style.BIG_TEXT, PushRules.style("short", "longer text", hasPicture = false))
        assertEquals(PushRules.Style.PLAIN, PushRules.style("short", null, hasPicture = false))
        assertEquals(PushRules.Style.PLAIN, PushRules.style(null, null, hasPicture = false))
    }

    @Test fun `images come over https, and over http only in debug builds`() {
        assertTrue(PushRules.imageUrlAllowed("https://cdn.example.com/a.png", debug = false))
        assertFalse(PushRules.imageUrlAllowed("http://10.0.2.2/a.png", debug = false))
        assertTrue(PushRules.imageUrlAllowed("http://10.0.2.2/a.png", debug = true))
        assertFalse(PushRules.imageUrlAllowed("file:///sdcard/a.png", debug = true))
    }

    @Test fun `topic names follow FCM's rule`() {
        assertTrue(PushRules.validTopic("ota-android-staging"))
        assertFalse(PushRules.validTopic(""))
        assertFalse(PushRules.validTopic("has space"))
        assertFalse(PushRules.validTopic("/topics/x"))
    }

    @Test fun `summary tags are told apart from the app's own ids`() {
        assertEquals("zn-summary:OFFERS", PushRules.summaryTag("OFFERS"))
        assertTrue(PushRules.isSummaryTag("zn-summary:OFFERS"))
        assertFalse(PushRules.isSummaryTag("offer-12"))
        assertFalse(PushRules.isSummaryTag(null))
    }

    @Test fun `summary lines and text`() {
        assertEquals("Cafe: 10% off", PushRules.inboxLine("Cafe", "10% off"))
        assertEquals("Cafe", PushRules.inboxLine("Cafe", " "))
        assertEquals("3 stores have new offers", PushRules.summaryText("%d stores have new offers", 3))
        assertEquals("New offers", PushRules.summaryText("New offers", 3))
        assertNull(PushRules.summaryText(null, 3))
    }

    @Test fun `why a notification can't show`() {
        assertEquals("off", PushRules.blocked(appEnabled = false, channelExists = true, channelImportance = 4))
        assertEquals("no_channel", PushRules.blocked(appEnabled = true, channelExists = false, channelImportance = null))
        assertEquals("channel_blocked", PushRules.blocked(appEnabled = true, channelExists = true, channelImportance = 0))
        assertNull(PushRules.blocked(appEnabled = true, channelExists = true, channelImportance = 3))
    }

    @Test fun `token errors become reasons the app can act on`() {
        assertEquals("not_now", PushRules.tokenReason("java.io.IOException: SERVICE_NOT_AVAILABLE"))
        assertEquals("no_play_services", PushRules.tokenReason("MISSING_INSTANCEID_SERVICE"))
        assertEquals("failed", PushRules.tokenReason("AUTHENTICATION_FAILED"))
        assertEquals("failed", PushRules.tokenReason(null))
    }

    @Test fun `the OTA check push is a data key with one value`() {
        assertTrue(PushRules.isOtaCheck(mapOf("zn_ota" to "check")))
        assertFalse(PushRules.isOtaCheck(mapOf("zn_ota" to "now")))
        assertFalse(PushRules.isOtaCheck(mapOf("lab" to "show")))
    }

    @Test fun `a tap on FCM's notification gives the message id and its own data only`() {
        val extras = mapOf<String, Any?>(
            "google.message_id" to "0:123", "google.sent_time" to 1_700_000_000_000L, "google.ttl" to 2419200,
            "from" to "866710910996", "collapse_key" to "dev.zeronative.sample", "gcm.n.e" to "1",
            "lab" to "opened", "link" to "zn://sample/dev/push", "android.intent.extra.X" to 5,
        )
        assertTrue(PushRules.isFcmTap(extras))
        assertFalse(PushRules.isFcmTap(mapOf("lab" to "x")))
        assertEquals(mapOf("lab" to "opened", "link" to "zn://sample/dev/push"), PushRules.tapData(extras))
        assertEquals(1_700_000_000_000L, PushRules.sentAt(extras["google.sent_time"]))
        assertEquals(5L, PushRules.sentAt("5"))
        assertEquals(0L, PushRules.sentAt(null))
    }

    @Test fun `inbox lines come after a picture, before big text`() {
        assertEquals(PushRules.Style.PICTURE, PushRules.style("b", null, hasPicture = true, hasLines = true))
        assertEquals(PushRules.Style.INBOX, PushRules.style("x".repeat(60), "big", hasPicture = false, hasLines = true))
    }

    @Test fun `lock screen visibility, categories, colors and progress`() {
        assertEquals(0, PushRules.visibility(null))
        assertEquals(-1, PushRules.visibility("secret"))
        assertNull(PushRules.visibility("hidden"))
        assertEquals("msg", PushRules.category("message"))
        assertEquals("", PushRules.category("unknown"))
        assertNull(PushRules.category(null))
        assertEquals(0xFFE23744.toInt(), PushRules.color("#E23744"))
        assertEquals(0x80E23744.toInt(), PushRules.color("#80E23744"))
        assertNull(PushRules.color("red"))
        assertNull(PushRules.progress(null, 3, null))
        assertEquals(100, PushRules.progress(100, 250, null)!!.current)
        assertTrue(PushRules.progress(null, null, true)!!.indeterminate)
        assertNull(PushRules.progress(0, 0, false))
    }

    @Test fun `each button of each notification has its own request code`() {
        assertTrue(PushRules.actionRequestCode("n1", "pay") != PushRules.actionRequestCode("n1", "later"))
        assertTrue(PushRules.actionRequestCode("n1", "pay") != PushRules.actionRequestCode("n2", "pay"))
    }

    @Test fun `a repeat moves to its next time after now, a time ahead stays`() {
        val day = 86_400_000L
        assertEquals(1_000L, PushRules.nextAt(1_000L, "daily", 500L))
        assertEquals(1_000L + day, PushRules.nextAt(1_000L, "daily", 1_000L))
        assertEquals(1_000L + 3 * day, PushRules.nextAt(1_000L, "daily", 1_000L + 2 * day + 5))
        assertEquals(1_000L, PushRules.nextAt(1_000L, "yearly", 9_000L))
        assertNull(PushRules.repeatMs("monthly"))
        assertEquals(604_800_000L, PushRules.repeatMs("weekly"))
    }
}
