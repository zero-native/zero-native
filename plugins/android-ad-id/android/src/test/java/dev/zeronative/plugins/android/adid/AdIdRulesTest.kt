package dev.zeronative.plugins.android.adid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AdIdRulesTest {
    @Test
    fun aRealIdIsGiven() {
        val a = AdIdRules.answer("38400000-8cf0-11bd-b23e-10b96e40000d", false)
        assertEquals("38400000-8cf0-11bd-b23e-10b96e40000d", a.id)
        assertFalse(a.limitAdTracking)
    }

    @Test
    fun aRealIdWithTheUsersNoIsGivenWithTheFlag() {
        // Android 11 and older: ads personalisation off still gives the id. The app must respect the flag.
        val a = AdIdRules.answer("38400000-8cf0-11bd-b23e-10b96e40000d", true)
        assertEquals("38400000-8cf0-11bd-b23e-10b96e40000d", a.id)
        assertTrue(a.limitAdTracking)
    }

    @Test
    fun allZerosIsNoId() {
        // Android 12+ after the user deleted the id; Android 13+ without the AD_ID permission.
        val a = AdIdRules.answer("00000000-0000-0000-0000-000000000000", false)
        assertNull(a.id)
        assertTrue(a.limitAdTracking)
    }

    @Test
    fun noIdIsNull() {
        assertNull(AdIdRules.answer(null, false).id)
        assertNull(AdIdRules.answer("  ", true).id)
        assertFalse(AdIdRules.answer(null, false).limitAdTracking)
    }
}
