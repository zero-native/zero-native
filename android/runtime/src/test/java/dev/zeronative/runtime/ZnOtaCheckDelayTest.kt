package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Test

/** How long the automatic check waits after the app comes on screen (ZnOta.Config.autoCheckDelayMs, 2026-11-10). */
class ZnOtaCheckDelayTest {
    @Test
    fun theFirstTimeOnScreenWaitsLongerThanAReturn() {
        val c = ZnOta.Config(server = "https://updates.example", channel = "staging", publicKeys = listOf("k"))
        assertEquals(3_000L, c.autoCheckDelayMs(returning = false)) // a cold start: startup first
        assertEquals(1_000L, c.autoCheckDelayMs(returning = true)) // back from the background
    }

    @Test
    fun anAppSetsBoth() {
        val c = ZnOta.Config(server = "https://updates.example", channel = "staging", publicKeys = listOf("k"), firstCheckDelayMs = 2_000L, returnCheckDelayMs = 300L)
        assertEquals(2_000L, c.autoCheckDelayMs(returning = false))
        assertEquals(300L, c.autoCheckDelayMs(returning = true))
    }
}
