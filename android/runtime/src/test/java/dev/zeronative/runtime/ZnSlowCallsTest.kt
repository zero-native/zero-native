package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The call pool's watch (docs/http-stall-investigation.md, fix 4): which calls get logged, and when. */
class ZnSlowCallsTest {
    private var now = 1_000L
    private val slow = ZnSlowCalls(limitMs = 5_000) { now }

    @Test
    fun aQuickCallIsNeverLogged() {
        val k = Any()
        slow.start(k, "Os.info")
        now += 20
        assertEquals(emptyList<String>(), slow.check(waiting = 0))
        assertNull(slow.end(k))
        assertTrue(slow.isEmpty())
    }

    @Test
    fun aCallOverTheLimitIsLoggedOnceWithTheQueueThenWhenItEnds() {
        val k = Any()
        slow.start(k, "InAppUpdate.isUpdateAvailable")
        now += 4_999
        assertEquals(emptyList<String>(), slow.check(waiting = 3))
        now += 1
        val lines = slow.check(waiting = 3)
        assertEquals(1, lines.size)
        assertTrue(lines[0], lines[0].contains("InAppUpdate.isUpdateAvailable has held a call thread for 5000 ms"))
        assertTrue(lines[0], lines[0].contains("3 other native calls wait"))
        now += 10_000
        assertEquals(emptyList<String>(), slow.check(waiting = 3)) // once per call
        assertEquals("native call InAppUpdate.isUpdateAvailable gave its call thread back after 15000 ms", slow.end(k))
        assertTrue(slow.isEmpty())
    }

    @Test
    fun eachCallIsTimedFromItsOwnStart() {
        val a = Any()
        val b = Any()
        slow.start(a, "A.slow")
        now += 3_000
        slow.start(b, "B.slow")
        now += 2_000
        assertEquals(listOf("A.slow"), slow.check(waiting = 0).map { it.substringAfter("native call ").substringBefore(" has") })
        now += 3_000
        assertEquals(listOf("B.slow"), slow.check(waiting = 0).map { it.substringAfter("native call ").substringBefore(" has") })
        assertNull(slow.end(Any())) // a key it never saw
    }
}
