package dev.zeronative.plugins.firebase.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyticsRulesTest {
    @Test fun `event names follow Analytics' rules`() {
        assertNull(AnalyticsRules.eventNameProblem("pay_tapped"))
        assertNull(AnalyticsRules.eventNameProblem("a".repeat(40)))
        assertNotNull(AnalyticsRules.eventNameProblem(""))
        assertNotNull(AnalyticsRules.eventNameProblem("a".repeat(41)))
        assertNotNull(AnalyticsRules.eventNameProblem("1st_pay"))
        assertNotNull(AnalyticsRules.eventNameProblem("pay-tapped"))
        assertNotNull(AnalyticsRules.eventNameProblem("firebase_pay"))
        assertNotNull(AnalyticsRules.eventNameProblem("ga_pay"))
        assertNotNull(AnalyticsRules.eventNameProblem("session_start"))
    }

    @Test fun `user property names are shorter and some are Firebase's`() {
        assertNull(AnalyticsRules.propertyNameProblem("plan"))
        assertNotNull(AnalyticsRules.propertyNameProblem("a".repeat(25)))
        assertNotNull(AnalyticsRules.propertyNameProblem("user_id"))
        assertEquals(36, AnalyticsRules.propertyValue("x".repeat(50)).length)
    }

    @Test fun `values become strings, longs and doubles`() {
        val p = AnalyticsRules.params(mapOf("s" to "x".repeat(150), "i" to 3, "l" to 4L, "d" to 2.5, "t" to true, "f" to false, "n" to null))
        assertNull(p.problem)
        assertEquals(100, (p.values["s"] as String).length)
        assertEquals(3L, p.values["i"])
        assertEquals(4L, p.values["l"])
        assertEquals(2.5, p.values["d"])
        assertEquals(1L, p.values["t"])
        assertEquals(0L, p.values["f"])
        assertTrue("n" !in p.values)
    }

    @Test fun `bad parameters stop the event`() {
        assertNotNull(AnalyticsRules.params(mapOf("bad-name" to 1)).problem)
        assertNotNull(AnalyticsRules.params(mapOf("x" to Double.NaN)).problem)
        assertNotNull(AnalyticsRules.params(mapOf("x" to mapOf("a" to 1))).problem)
        assertNotNull(AnalyticsRules.params(mapOf("tags" to listOf("a"))).problem)
        assertNotNull(AnalyticsRules.params((1..26).associate { "p$it" to it }).problem)
        assertNull(AnalyticsRules.params((1..25).associate { "p$it" to it }).problem)
    }

    @Test fun `items is the one list, of objects with the same rules`() {
        val ok = AnalyticsRules.params(mapOf("items" to listOf(mapOf("item_id" to "sku1", "price" to 49.5, "quantity" to 2))))
        assertNull(ok.problem)
        @Suppress("UNCHECKED_CAST")
        val items = ok.values["items"] as List<Map<String, Any>>
        assertEquals(2L, items[0]["quantity"])
        assertNotNull(AnalyticsRules.params(mapOf("items" to listOf("sku1"))).problem)
        assertNotNull(AnalyticsRules.params(mapOf("items" to listOf(mapOf("items" to listOf(mapOf("a" to 1)))))).problem)
        assertNotNull(AnalyticsRules.params(mapOf("items" to listOf(mapOf("a" to 1))), allowItems = false).problem)
        assertNotNull(AnalyticsRules.params(mapOf("items" to List(201) { mapOf("a" to it) })).problem)
    }

    @Test fun `user id has a length limit`() {
        assertNull(AnalyticsRules.userIdProblem("ZB12345"))
        assertNotNull(AnalyticsRules.userIdProblem("x".repeat(257)))
    }
}
