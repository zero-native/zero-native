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
}
