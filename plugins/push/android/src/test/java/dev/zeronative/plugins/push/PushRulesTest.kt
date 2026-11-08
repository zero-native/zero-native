package dev.zeronative.plugins.push

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
