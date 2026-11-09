package dev.zeronative.plugins.firebase.remoteconfig

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteConfigRulesTest {
    @Test fun `defaults keep strings, numbers and booleans, and leave nulls out`() {
        val d = RemoteConfigRules.defaults(mapOf("s" to "x", "i" to 3, "l" to 4L, "d" to 1.5, "b" to true, "n" to null))
        assertEquals(mapOf("s" to "x", "i" to 3L, "l" to 4L, "d" to 1.5, "b" to true), d)
        assertTrue("n" !in d)
    }

    @Test fun `sources, fetch status and seconds by Firebase's numbers`() {
        assertEquals("remote", RemoteConfigRules.source(2))
        assertEquals("default", RemoteConfigRules.source(1))
        assertEquals("static", RemoteConfigRules.source(0))
        assertEquals("success", RemoteConfigRules.fetchStatus(-1))
        assertEquals("throttled", RemoteConfigRules.fetchStatus(2))
        assertEquals("no_fetch_yet", RemoteConfigRules.fetchStatus(0))
        assertEquals(43_200L, RemoteConfigRules.seconds(43_200_000.0))
        assertEquals(0L, RemoteConfigRules.seconds(-5.0))
    }

    @Test fun `fetch failures by kind`() {
        assertEquals("failed", RemoteConfigRules.reason(null))
        assertEquals("failed", RemoteConfigRules.reason(IllegalStateException("x")))
    }
}
