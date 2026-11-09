package dev.zeronative.plugins.firebase.crashlytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashlyticsRulesTest {
    @Test fun `a Hermes stack that already has the message is kept as it is`() {
        val stack = "TypeError: amount is undefined\n    at pay (main.js:12:4)"
        assertEquals(stack, CrashlyticsRules.details("TypeError", "amount is undefined", stack))
    }

    @Test fun `the name and message go first when the stack lacks them, or there is no stack`() {
        assertEquals("Error: boom\n    at f (main.js:1:1)", CrashlyticsRules.details("Error", "boom", "    at f (main.js:1:1)"))
        assertEquals("boom", CrashlyticsRules.details(null, "boom", null))
        assertEquals("RangeError: boom", CrashlyticsRules.details("RangeError", "boom", ""))
    }

    @Test fun `the bundle id is the label before the SHA`() {
        assertEquals("sample_12", CrashlyticsRules.bundleId("sample_12@1a2b3c4d5e6f"))
        assertEquals("sample_0", CrashlyticsRules.bundleId("sample_0"))
    }

    @Test fun `key values keep strings, booleans and numbers, whole numbers as Long`() {
        assertEquals("x", CrashlyticsRules.keyValue("x"))
        assertEquals(true, CrashlyticsRules.keyValue(true))
        assertEquals(3L, CrashlyticsRules.keyValue(3))
        assertEquals(3L, CrashlyticsRules.keyValue(3.0))
        assertEquals(1.5, CrashlyticsRules.keyValue(1.5))
        assertEquals(1024, (CrashlyticsRules.keyValue("a".repeat(2000)) as String).length)
        assertNull(CrashlyticsRules.keyValue(null))
        assertNull(CrashlyticsRules.keyValue(listOf(1)))
    }

    @Test fun `an empty or too long key is refused`() {
        assertFalse(CrashlyticsRules.validKey(""))
        assertFalse(CrashlyticsRules.validKey("k".repeat(1025)))
        assertTrue(CrashlyticsRules.validKey("zn_route"))
    }

    @Test fun `the budget sends the first ones and counts the rest`() {
        val b = CrashlyticsRules.Budget(max = 2)
        assertTrue(b.take())
        assertTrue(b.take())
        assertFalse(b.take())
        assertFalse(b.take())
        assertEquals(2, b.dropped)
    }

    @Test fun `log lines for routes and OTA outcomes`() {
        assertEquals("nav: - -> home", CrashlyticsRules.routeLog(null, "home"))
        assertEquals("nav: home -> pay", CrashlyticsRules.routeLog("home", "pay"))
        assertEquals("ota: error_rollback sample_3: error screen", CrashlyticsRules.otaLog("error_rollback", "sample_3", "error screen"))
        assertEquals("ota: checked", CrashlyticsRules.otaLog("checked", null, null))
    }

    @Test fun `an OTA non-fatal has one frame named after its kind, so each kind is one issue`() {
        val e = ZnOtaEventException("watchdog_block", "sample_3", "2 crashes")
        assertEquals("OTA watchdog_block sample_3: 2 crashes", e.message)
        assertEquals(1, e.stackTrace.size)
        assertEquals("zn.ota", e.stackTrace[0].className)
        assertEquals("watchdog_block", e.stackTrace[0].methodName)
    }
}
