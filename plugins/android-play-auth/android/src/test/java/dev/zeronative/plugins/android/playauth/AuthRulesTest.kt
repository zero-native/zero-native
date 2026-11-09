package dev.zeronative.plugins.android.playauth

import com.google.android.gms.common.api.CommonStatusCodes
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthRulesTest {
    private val default = AuthRules.pattern(null)!!
    private val ok = -1
    private val cancelled = 0

    @Test fun defaultFindsA4Or6DigitCode() {
        assertEquals("4821", AuthRules.extractCode("Your code is 4821. Do not share it.", default))
        assertEquals("482133", AuthRules.extractCode("482133 is your code", default))
    }

    @Test fun defaultTakesOnlyStandaloneNumbers() {
        assertNull(AuthRules.extractCode("Order 12345 is ready", default))
        assertNull(AuthRules.extractCode("Order 1234567 is ready", default))
        assertNull(AuthRules.extractCode("abc1234 is not a code", default))
        assertEquals("4821", AuthRules.extractCode("Ref 12345, code 4821", default))
    }

    @Test fun defaultTakesTheFirstOfTwo() {
        assertEquals("1111", AuthRules.extractCode("1111 then 2222", default))
    }

    @Test fun noMatchIsNoCode() {
        assertNull(AuthRules.extractCode("", default))
        assertNull(AuthRules.extractCode("no digits here", default))
    }

    @Test fun aCustomPatternUsesGroupOne() {
        val pattern = AuthRules.pattern("code: (\\d{5})")!!
        assertEquals("12345", AuthRules.extractCode("your code: 12345 thanks", pattern))
    }

    @Test fun aCustomPatternWithNoGroupUsesTheWholeMatch() {
        assertEquals("AB12", AuthRules.extractCode("use AB12 now", AuthRules.pattern("[A-Z]{2}\\d{2}")!!))
    }

    @Test fun aPatternThatMatchesNothingAtAllIsNoCode() {
        assertNull(AuthRules.extractCode("anything", AuthRules.pattern("")!!))
    }

    @Test fun aBrokenPatternIsRefusedNotThrown() {
        assertNull(AuthRules.pattern("("))
    }

    @Test fun statusCodesMatchPlayServices() {
        assertEquals(CommonStatusCodes.SUCCESS, AuthRules.STATUS_SUCCESS)
        assertEquals(CommonStatusCodes.TIMEOUT, AuthRules.STATUS_TIMEOUT)
    }

    @Test fun aGoodSmsGivesTheCode() {
        val answer = AuthRules.otpAnswer(AuthRules.STATUS_SUCCESS, "1234 is your code", default)
        assertEquals("1234", answer.code)
        assertNull(answer.reason)
    }

    @Test fun anSmsWithNoCodeEndsTheWait() {
        val answer = AuthRules.otpAnswer(AuthRules.STATUS_SUCCESS, "hello", default)
        assertNull(answer.code)
        assertEquals("no_code", answer.reason)
        assertEquals("no_code", AuthRules.otpAnswer(AuthRules.STATUS_SUCCESS, null, default).reason)
    }

    @Test fun timeoutAndAnyOtherStatusEndTheWait() {
        assertEquals("timeout", AuthRules.otpAnswer(AuthRules.STATUS_TIMEOUT, null, default).reason)
        assertEquals("failed", AuthRules.otpAnswer(CommonStatusCodes.API_NOT_CONNECTED, null, default).reason)
        assertEquals("failed", AuthRules.otpAnswer(CommonStatusCodes.INTERNAL_ERROR, "1234", default).reason)
    }

    @Test fun waitIsAtMostFiveMinutes() {
        assertEquals(300_000L, AuthRules.waitMs(null))
        assertEquals(300_000L, AuthRules.waitMs(900_000))
        assertEquals(3_000L, AuthRules.waitMs(3_000))
        assertEquals(1_000L, AuthRules.waitMs(0))
        assertEquals(1_000L, AuthRules.waitMs(-5))
    }

    @Test fun onlyARealNumberIsAHint() {
        val answer = AuthRules.hintAnswer(ok, true) { "+919876543210" }
        assertEquals("+919876543210", answer.phone)
        assertNull(answer.reason)
    }

    @Test fun anythingElseIsTypeItByHand() {
        assertEquals("cancelled", AuthRules.hintAnswer(cancelled, true) { "+919876543210" }.reason)
        assertEquals("cancelled", AuthRules.hintAnswer(cancelled, false) { null }.reason)
        assertEquals("no_number", AuthRules.hintAnswer(ok, false) { "+919876543210" }.reason)
        assertEquals("no_number", AuthRules.hintAnswer(ok, true) { null }.reason)
        assertEquals("no_number", AuthRules.hintAnswer(ok, true) { "  " }.reason)
        assertEquals("no_number", AuthRules.hintAnswer(ok, true) { throw IllegalStateException("no number") }.reason)
        assertEquals("no_number", AuthRules.hintAnswer(ok, true) { throw NoClassDefFoundError("no Play services") }.reason)
    }

    @Test fun aRefusedHintNeverCarriesANumber() {
        assertNull(AuthRules.hintAnswer(cancelled, true) { "+919876543210" }.phone)
    }

    @Test fun theHashIsGooglesFormat() {
        // sha256("com.example.app abcdef"), first 9 bytes, base64, first 11 chars. Worked out apart from this code.
        val hash = AuthRules.appHash("com.example.app", "abcdef") { Base64.getEncoder().withoutPadding().encodeToString(it) }
        assertEquals("Lfftl75Dg+V", hash)
        assertEquals(11, hash.length)
    }

    @Test fun aSecondRequestHandsBackTheFirst() {
        val latest = Latest<Any>()
        val first = Any()
        val second = Any()
        assertNull(latest.begin(first))
        assertSame(first, latest.begin(second))
        assertSame(second, latest.current)
    }

    @Test fun aReplacedRequestCanNotEndTheNewOne() {
        val latest = Latest<Any>()
        val first = Any()
        val second = Any()
        latest.begin(first)
        latest.begin(second)
        assertFalse(latest.end(first))
        assertSame(second, latest.current)
    }

    @Test fun aRequestEndsOnce() {
        val latest = Latest<Any>()
        val only = Any()
        latest.begin(only)
        assertTrue(latest.end(only))
        assertFalse(latest.end(only))
        assertNull(latest.current)
    }
}
