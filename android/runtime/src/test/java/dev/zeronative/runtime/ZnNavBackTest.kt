package dev.zeronative.runtime

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a back press arms native's own 300 ms pop (ZnNav.systemBack, backFallbackArms). */
class ZnNavBackTest {
    @Test
    fun aScreenWithoutAHandlerKeepsTheFallback() {
        assertTrue(backFallbackArms(5, emptyMap()))
    }

    @Test
    fun aScreenThatAskedForBackFirstIsNeverPoppedByTheTimer() {
        // A payment screen with useBack ("can't leave while paying"): a busy JS thread must not let native close it.
        assertFalse(backFallbackArms(5, mapOf(5 to Unit)))
    }

    @Test
    fun onlyTheTopScreensHandlerCounts() {
        // The screen below has a handler, the top one doesn't: the top one keeps the fallback.
        assertTrue(backFallbackArms(5, mapOf(3 to Unit)))
    }

    @Test
    fun nativeIdsWork() {
        // Native-allocated ids have the top bit set: negative as Kotlin Ints.
        val id = 0x80000001.toInt()
        assertFalse(backFallbackArms(id, mapOf(id to Unit)))
        assertTrue(backFallbackArms(id, mapOf(0x80000002.toInt() to Unit)))
    }
}
