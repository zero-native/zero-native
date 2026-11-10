package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Second-opinions #217: failed checks must not push serious outcomes out before they reach the server. */
class ZnOtaOutcomesTest {
    private val serious = { s: String -> s.startsWith("!") }

    @Test
    fun shortListsStayAsTheyAre() {
        assertEquals(listOf("a", "!b"), ZnOtaOutcomes.trim(listOf("a", "!b"), 20, serious))
    }

    @Test
    fun plainOnesGoFirstOldestFirst() {
        val items = listOf("!crash", "f1", "f2", "f3", "!rollback", "f4")
        assertEquals(listOf("!crash", "f3", "!rollback", "f4"), ZnOtaOutcomes.trim(items, 4, serious))
    }

    @Test
    fun aCrashSurvives25FailedChecks() {
        val items = listOf("!launch_crashed") + List(25) { "failed$it" }
        val kept = ZnOtaOutcomes.trim(items, 20, serious)
        assertEquals(20, kept.size)
        assertEquals("!launch_crashed", kept.first())
        assertEquals("failed24", kept.last())
    }

    @Test
    fun onlySeriousOnesLeftThenTheOldestGo() {
        val items = List(25) { "!s$it" }
        val kept = ZnOtaOutcomes.trim(items, 20, serious)
        assertEquals(List(20) { "!s${it + 5}" }, kept)
    }

    @Test
    fun theSameFailureAgainTakesOnePlace() {
        assertTrue(ZnOtaOutcomes.sameFailureAgain("failed", lastHasBundle = false, kind = "failed", serious = false))
        assertFalse(ZnOtaOutcomes.sameFailureAgain("network", lastHasBundle = false, kind = "failed", serious = false))
        assertFalse(ZnOtaOutcomes.sameFailureAgain("signature", lastHasBundle = false, kind = "signature", serious = true))
        assertFalse(ZnOtaOutcomes.sameFailureAgain("failed", lastHasBundle = true, kind = "failed", serious = false))
        assertFalse(ZnOtaOutcomes.sameFailureAgain(null, lastHasBundle = false, kind = "failed", serious = false))
    }
}
