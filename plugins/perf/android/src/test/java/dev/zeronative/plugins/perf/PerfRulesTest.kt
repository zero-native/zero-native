package dev.zeronative.plugins.perf

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PerfRulesTest {
    @Test fun `frames are slow past 16 ms and frozen past 700 ms`() {
        assertEquals(PerfRules.Frame.OK, PerfRules.frameKind(12_000_000L))
        assertEquals(PerfRules.Frame.SLOW, PerfRules.frameKind(17_000_000L))
        assertEquals(PerfRules.Frame.FROZEN, PerfRules.frameKind(701_000_000L))
    }

    @Test fun `trace names and attribute names follow Firebase's rules`() {
        assertNull(PerfRules.nameProblem("checkout_load"))
        assertNotNull(PerfRules.nameProblem(""))
        assertNotNull(PerfRules.nameProblem("_app_start"))
        assertNotNull(PerfRules.nameProblem(" pay"))
        assertNotNull(PerfRules.nameProblem("x".repeat(101)))
        assertNull(PerfRules.attributeProblem("plan"))
        assertNotNull(PerfRules.attributeProblem("1plan"))
        assertNotNull(PerfRules.attributeProblem("firebase_x"))
        assertEquals(100, PerfRules.attributeValue("v".repeat(150)).length)
        assertEquals("screen_home", PerfRules.screenTrace("home"))
    }

    @Test fun `Firebase sees no query and no fragment by default`() {
        assertEquals("https://api.example.com/v1/pay/123", PerfRules.defaultUrl("https://api.example.com/v1/pay/123?token=abc&phone=9#x".toHttpUrl()))
    }
}
