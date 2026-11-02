package dev.zeronative.runtime

import dev.zeronative.runtime.ZnLaunch.Rules
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Every change of a launch record (ZnLaunch.Rules): a result is never replaced, lost or cleared by mistake. */
class ZnLaunchTest {
    private val waiting = Rules.waiting("upi", "txn1")
    private fun result(record: JSONObject = waiting, code: Int = -1) = Rules.result(record, code, null, JSONObject())!!

    @Test fun aNewLaunchIsFreeWhenNothingIsOpen() {
        assertNull(Rules.refusal(null, null))
    }

    @Test fun oneLaunchAtATime() {
        assertEquals("busy", Rules.refusal(waiting, null))
        assertEquals("busy", Rules.refusal(waiting, waiting))
        assertEquals("busy", Rules.refusal(waiting, result(Rules.waiting("hint", "a"))))
    }

    @Test fun aResultNotAckedIsNeverReplaced() {
        assertEquals("unacked", Rules.refusal(null, result()))
        assertEquals("unacked", Rules.refusal(Rules.lost(waiting), Rules.lost(waiting)))
    }

    @Test fun anotherKeysLostRecordDoesNotBlock() {
        assertNull(Rules.refusal(Rules.lost(Rules.waiting("hint", "a")), null))
    }

    @Test fun onlyAWaitingRecordIsLost() {
        assertEquals(Rules.LOST, Rules.lost(waiting)!!.getString("status"))
        assertNull(Rules.lost(result()))
        assertNull(Rules.lost(Rules.lost(waiting)!!))
    }

    @Test fun aResultKeepsTheLaunchItAnswers() {
        val r = Rules.result(waiting, -1, "upi://done", JSONObject().put("Status", "SUCCESS"))!!
        assertEquals("upi", r.getString("key"))
        assertEquals("txn1", r.getString("id"))
        assertEquals(Rules.RESULT, r.getString("status"))
        assertEquals(-1, r.getInt("resultCode"))
        assertEquals("upi://done", r.getString("data"))
        assertEquals("SUCCESS", r.getJSONObject("extras").getString("Status"))
    }

    @Test fun noDataIsJsonNull() {
        assertTrue(result().isNull("data"))
    }

    @Test fun aLateResultWinsOverLost() {
        val late = Rules.result(Rules.lost(waiting)!!, 0, null, JSONObject())
        assertNotNull(late)
        assertEquals(Rules.RESULT, late!!.getString("status"))
    }

    @Test fun aSecondResultDoesNotReplaceTheFirst() {
        assertNull(Rules.result(result(code = -1), 0, null, JSONObject()))
    }

    @Test fun ackNeedsTheSameId() {
        assertTrue(Rules.canAck(result(), "txn1"))
        assertTrue(Rules.canAck(Rules.lost(waiting)!!, "txn1"))
        assertFalse(Rules.canAck(result(), "txn2"))
    }

    @Test fun aWaitingLaunchCanNotBeAcked() {
        assertFalse(Rules.canAck(waiting, "txn1"))
    }

    @Test fun simpleExtrasKeepTheirType() {
        val e = Rules.extras(mapOf("a" to "x", "b" to 1, "c" to true, "d" to 1.5))
        assertEquals("x", e.get("a"))
        assertEquals(1, e.get("b"))
        assertEquals(true, e.get("c"))
        assertEquals(1.5, e.get("d"))
    }

    @Test fun otherExtrasBecomeText() {
        val e = Rules.extras(mapOf("float" to 1.5f, "list" to listOf(1)))
        assertEquals("1.5", e.get("float"))
        assertEquals("[1]", e.get("list"))
    }

    @Test fun aLongKeepsEveryDigit() {
        assertEquals("9007199254740993", Rules.extras(mapOf("rrn" to 9007199254740993L)).get("rrn"))
    }

    @Test fun aNumberJsonRefusesDoesNotBreakTheResult() {
        val e = Rules.extras(mapOf("nan" to Double.NaN, "inf" to Double.POSITIVE_INFINITY, "Status" to "SUCCESS"))
        assertEquals("NaN", e.get("nan"))
        assertEquals("Infinity", e.get("inf"))
        assertEquals("SUCCESS", e.get("Status"))
    }

    @Test fun aNullExtraIsLeftOut() {
        assertEquals(setOf("a"), Rules.extras(mapOf("a" to "x", "b" to null)).keys().asSequence().toSet())
    }

    @Test fun anExtraThatCanNotBeReadIsSkippedAndTheRestKept() {
        val bad = object { override fun toString(): String = throw IllegalStateException("can't read") }
        val e = Rules.extras(mapOf("Status" to "SUCCESS", "bad" to bad, "txnId" to "t1"))
        assertEquals(setOf("Status", "txnId"), e.keys().asSequence().toSet())
    }

    @Test fun hugeExtrasAreDropped() {
        assertEquals(0, Rules.extras(mapOf("a" to "x".repeat(Rules.MAX_EXTRAS_CHARS))).length())
        assertEquals(1, Rules.extras(mapOf("a" to "x".repeat(100))).length())
    }
}
