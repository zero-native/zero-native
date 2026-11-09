package dev.zeronative.plugins.firebase.messaging

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRulesTest {
    @Test fun `topic names follow FCM's rule`() {
        assertTrue(PushRules.validTopic("ota-android-staging"))
        assertFalse(PushRules.validTopic(""))
        assertFalse(PushRules.validTopic("has space"))
        assertFalse(PushRules.validTopic("/topics/x"))
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
        assertTrue(PushRules.isOtaCheck(mapOf("zn_ota" to "check", "zn_ota_delay_ms" to "3000")))
        assertFalse(PushRules.isOtaCheck(mapOf("zn_ota_delay_ms" to "3000")))
        assertFalse(PushRules.isOtaCheck(emptyMap()))
    }

    @Test fun `the OTA push's longest wait is whole ms, clamped to one day`() {
        fun max(v: String?) = PushRules.otaMaxDelayMs(if (v == null) mapOf("zn_ota" to "check") else mapOf("zn_ota" to "check", "zn_ota_delay_ms" to v))
        assertEquals(0L, max(null))
        assertEquals(0L, max(""))
        assertEquals(0L, max("soon"))
        assertEquals(0L, max("1.5"))
        assertEquals(0L, max("-5"))
        assertEquals(3000L, max("3000"))
        assertEquals(3000L, max(" 3000 "))
        assertEquals(21_600_000L, max("21600000"))
        assertEquals(PushRules.OTA_MAX_DELAY_MS, max("999999999999"))
        assertEquals(0L, max("99999999999999999999999")) // not a Long
    }

    @Test fun `the OTA wait is random in 0 to max, both ends included`() {
        assertEquals(0L, PushRules.otaDelayMs(0))
        assertEquals(0L, PushRules.otaDelayMs(-1))
        val r = kotlin.random.Random(7)
        val seen = (1..2000).map { PushRules.otaDelayMs(3, r) }.toSet()
        assertEquals(setOf(0L, 1L, 2L, 3L), seen)
        repeat(100) { assertTrue(PushRules.otaDelayMs(60_000, r) in 0..60_000) }
    }

    @Test fun `the OTA topic is zn-ota-app-channel and follows FCM's rule`() {
        assertEquals("zn-ota-sample-staging", PushRules.otaTopic("sample", "staging"))
        assertEquals("zn-ota-zero_bill.app-production", PushRules.otaTopic("zero_bill.app", "production"))
        assertEquals(null, PushRules.otaTopic("", "staging"))
        assertEquals(null, PushRules.otaTopic("sample", ""))
        assertEquals(null, PushRules.otaTopic("my app", "staging"))
        assertEquals(null, PushRules.otaTopic("sample/x", "staging"))
    }

    @Test fun `a changed OTA topic drops the old one`() {
        assertEquals(null, PushRules.otaTopicToDrop(null, "zn-ota-sample-staging"))
        assertEquals(null, PushRules.otaTopicToDrop("zn-ota-sample-staging", "zn-ota-sample-staging"))
        assertEquals("zn-ota-sample-staging", PushRules.otaTopicToDrop("zn-ota-sample-staging", "zn-ota-sample-production"))
    }

    @Test fun `only network-like OTA failures run the job again`() {
        assertTrue(PushRules.otaRetry("ERROR", "failed: Unable to resolve host"))
        assertTrue(PushRules.otaRetry("ERROR", "server: check answered HTTP 503"))
        assertTrue(PushRules.otaRetry("ERROR", "download: no data for 60 s"))
        assertFalse(PushRules.otaRetry("ERROR", "signature: bad bundle signature on sample_3"))
        assertFalse(PushRules.otaRetry("ERROR", "incompatible: module X"))
        assertFalse(PushRules.otaRetry("ERROR", null))
        assertFalse(PushRules.otaRetry("UP_TO_DATE", null))
        assertFalse(PushRules.otaRetry("OFF", null))
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
}
