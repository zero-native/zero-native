package dev.zeronative.plugins.location

import dev.zeronative.plugins.location.LocationRules.Accuracy
import dev.zeronative.plugins.location.LocationRules.Fix
import dev.zeronative.plugins.location.LocationRules.GPS
import dev.zeronative.plugins.location.LocationRules.NETWORK
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationRulesTest {
    private fun fix(accuracy: Float?, provider: String = NETWORK, at: Long = 10_000L) = Fix(12.9, 77.6, accuracy, provider, at)
    private val both = setOf(GPS, NETWORK)

    @Test
    fun accuracyNames() {
        assertEquals(Accuracy.BALANCED, LocationRules.accuracy(null))
        assertEquals(Accuracy.HIGH, LocationRules.accuracy("high"))
        assertEquals(Accuracy.LOW, LocationRules.accuracy("low"))
        assertNull(LocationRules.accuracy("best"))
    }

    @Test
    fun limitsAreKept() {
        assertEquals(10_000L, LocationRules.timeoutMs(null))
        assertEquals(60_000L, LocationRules.timeoutMs(Long.MAX_VALUE))
        assertEquals(500L, LocationRules.timeoutMs(0))
        assertEquals(0L, LocationRules.maxAgeMs(null))
        assertEquals(0L, LocationRules.maxAgeMs(-5))
        assertEquals(1_000L, LocationRules.intervalMs(10))
        assertEquals(5_000L, LocationRules.intervalMs(null))
        assertEquals(0f, LocationRules.distanceM(-1.0))
        assertEquals(1, LocationRules.geocodeMax(null))
        assertEquals(5, LocationRules.geocodeMax(50))
    }

    @Test
    fun zeroZeroAndOutOfRangeAreNotPlaces() {
        assertTrue(LocationRules.valid(12.9, 77.6))
        assertFalse(LocationRules.valid(0.0, 0.0))
        assertFalse(LocationRules.valid(Double.NaN, 77.6))
        assertFalse(LocationRules.valid(91.0, 77.6))
        assertFalse(LocationRules.valid(12.9, 181.0))
        assertTrue(LocationRules.valid(0.0, 77.6)) // on the equator is fine
    }

    @Test
    fun gpsNeedsThePrecisePermission() {
        assertEquals(listOf(GPS, NETWORK), LocationRules.providers(Accuracy.HIGH, fine = true, coarse = true, has = both, on = both, onlyOn = true))
        assertEquals(listOf(NETWORK), LocationRules.providers(Accuracy.HIGH, fine = false, coarse = true, has = both, on = both, onlyOn = true))
        assertEquals(emptyList<String>(), LocationRules.providers(Accuracy.HIGH, fine = false, coarse = false, has = both, on = both, onlyOn = true))
    }

    @Test
    fun lowNeverStartsTheGpsWhenNetworkWorks() {
        assertEquals(listOf(NETWORK), LocationRules.providers(Accuracy.LOW, fine = true, coarse = true, has = both, on = both, onlyOn = true))
        // No network provider on: low falls back to GPS rather than nothing.
        assertEquals(listOf(GPS), LocationRules.providers(Accuracy.LOW, fine = true, coarse = true, has = both, on = setOf(GPS), onlyOn = true))
    }

    @Test
    fun aOneShotSkipsProvidersThatAreOffAWatchKeepsThem() {
        val on = setOf(NETWORK)
        assertEquals(listOf(NETWORK), LocationRules.providers(Accuracy.BALANCED, true, true, both, on, onlyOn = true))
        assertEquals(listOf(GPS, NETWORK), LocationRules.providers(Accuracy.BALANCED, true, true, both, on, onlyOn = false))
        assertEquals(listOf(GPS), LocationRules.providers(Accuracy.BALANCED, true, true, setOf(GPS), setOf(GPS), onlyOn = true))
    }

    @Test
    fun whyAOneShotCantStart() {
        assertEquals("denied", LocationRules.cantStart(fine = false, coarse = false, enabled = true, providers = listOf(NETWORK), inFront = true))
        assertEquals("background", LocationRules.cantStart(true, true, true, listOf(NETWORK), inFront = false))
        assertEquals("off", LocationRules.cantStart(true, true, enabled = false, providers = emptyList(), inFront = true))
        assertEquals("unavailable", LocationRules.cantStart(true, true, enabled = true, providers = emptyList(), inFront = true))
        assertNull(LocationRules.cantStart(false, true, true, listOf(NETWORK), true))
    }

    @Test
    fun aCachedFixSentAtOnceIsNotFresh() {
        assertTrue(LocationRules.fresh(fix(10f, at = 9_000L), startMs = 10_000L, precise = true))
        assertFalse(LocationRules.fresh(fix(10f, at = 7_000L), startMs = 10_000L, precise = true))
    }

    @Test
    fun withTheRoughPermissionOnlyAFewMinutesOldFixCountsAndTheFirstWins() {
        val start = 1_000_000L
        assertTrue(LocationRules.fresh(fix(2000f, at = start - 155_000L), start, precise = false))
        assertFalse(LocationRules.fresh(fix(2000f, at = start - 12 * 60_000L), start, precise = false))
        assertTrue(LocationRules.goodEnough(fix(2000f), Accuracy.HIGH, precise = false))
    }

    @Test
    fun theMoreAccurateFixWins() {
        val a = fix(50f)
        val b = fix(20f, GPS)
        assertSame(b, LocationRules.better(a, b))
        assertSame(b, LocationRules.better(b, a))
        assertSame(a, LocationRules.better(null, a))
        val noAccuracy = fix(null)
        assertSame(a, LocationRules.better(a, noAccuracy))
        val newer = fix(50f, at = 11_000L)
        assertSame(newer, LocationRules.better(a, newer))
    }

    @Test
    fun goodEnoughDependsOnTheAccuracyAsked() {
        assertTrue(LocationRules.goodEnough(fix(80f), Accuracy.BALANCED, precise = true))
        assertFalse(LocationRules.goodEnough(fix(120f), Accuracy.BALANCED, precise = true))
        assertFalse(LocationRules.goodEnough(fix(30f), Accuracy.HIGH, precise = true))
        assertTrue(LocationRules.goodEnough(fix(25f), Accuracy.HIGH, precise = true))
        assertTrue(LocationRules.goodEnough(fix(5000f), Accuracy.LOW, precise = true))
        assertFalse(LocationRules.goodEnough(fix(null), Accuracy.BALANCED, precise = true))
    }

    @Test
    fun aCachedFixAnswersOnlyWhenAllowedThatOld() {
        val cached = fix(30f, at = 10_000L)
        assertFalse(LocationRules.cachedOk(cached, nowMs = 12_000L, maxAgeMs = 0))
        assertTrue(LocationRules.cachedOk(cached, nowMs = 12_000L, maxAgeMs = 5_000))
        assertFalse(LocationRules.cachedOk(cached, nowMs = 20_000L, maxAgeMs = 5_000))
        assertFalse(LocationRules.cachedOk(null, nowMs = 12_000L, maxAgeMs = 5_000))
        assertEquals(fix(1f, at = 3L), LocationRules.newest(listOf(fix(5f, at = 1L), fix(1f, at = 3L), fix(2f, at = 2L))))
    }

    @Test
    fun onlyResolutionRequiredOpensTheTurnOnDialog() {
        assertEquals("dialog", LocationRules.turnOnStep(6, resolvable = true))
        assertEquals("unavailable", LocationRules.turnOnStep(2, resolvable = true)) // Play services too old: no update screen
        assertEquals("unavailable", LocationRules.turnOnStep(8502, resolvable = false)) // the settings can't change (airplane mode)
        assertEquals("unavailable", LocationRules.turnOnStep(6, resolvable = false))
    }

    @Test
    fun aWatchDropsAWorseFixFromTheOtherProvider() {
        val gps = fix(8f, GPS, at = 10_000L)
        assertTrue(LocationRules.watchKeeps(null, gps, 5_000))
        assertFalse(LocationRules.watchKeeps(gps, fix(40f, NETWORK, at = 12_000L), 5_000))
        assertTrue(LocationRules.watchKeeps(gps, fix(6f, NETWORK, at = 12_000L), 5_000))
        assertTrue(LocationRules.watchKeeps(gps, fix(40f, NETWORK, at = 20_000L), 5_000)) // GPS went quiet (indoors)
        assertTrue(LocationRules.watchKeeps(gps, fix(30f, GPS, at = 15_000L), 5_000)) // same provider always passes
    }
}
