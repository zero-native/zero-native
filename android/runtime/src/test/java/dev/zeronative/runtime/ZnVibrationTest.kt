package dev.zeronative.runtime

import org.json.JSONArray
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a Vibration pattern from JS is read (ZnVibration.timings, isSilent). */
class ZnVibrationTest {
    @Test fun wholeNumbersBecomeMs() {
        assertArrayEquals(longArrayOf(0, 400), ZnVibration.timings(JSONArray("[0, 400]")))
        assertArrayEquals(longArrayOf(100, 200, 300, 400), ZnVibration.timings(JSONArray("[100, 200.0, 300, 400]")))
        assertArrayEquals(longArrayOf(), ZnVibration.timings(JSONArray("[]")))
    }

    @Test fun badValuesAreRefused() {
        for (bad in listOf("[-1]", "[1.5]", "[\"100\"]", "[null]", "[true]")) {
            assertThrows(bad, ZnInvalidArgs::class.java) { ZnVibration.timings(JSONArray(bad)) }
        }
    }

    @Test fun onlyVibrateStepsCount() {
        // [wait, vibrate, wait, vibrate]: the motor runs on odd indexes only.
        assertTrue(ZnVibration.isSilent(longArrayOf()))
        assertTrue(ZnVibration.isSilent(longArrayOf(500)))
        assertTrue(ZnVibration.isSilent(longArrayOf(500, 0, 300, 0)))
        assertFalse(ZnVibration.isSilent(longArrayOf(0, 400)))
        assertFalse(ZnVibration.isSilent(longArrayOf(500, 0, 300, 1)))
    }
}
