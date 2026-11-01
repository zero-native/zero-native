package dev.zeronative.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The back stack as saved in the Activity's state (ZnNav.saveState), with restorableSignal values (host API 4). */
class ZnNavSavedTest {
    private val stack = listOf(
        ZnSavedEntry("home", "{}"),
        ZnSavedEntry("amount", """{"merchantId":"m1"}""", """{"amount":"250","tip":{"pct":10},"note":null}"""),
    )

    @Test
    fun valuesSurviveTheRoundTrip() {
        val back = readSavedStack(savedStackJson(stack))!!
        assertEquals(listOf("home", "amount"), back.map { it.route })
        assertNull(back[0].values) // a screen without values saves none
        assertEquals("m1", JSONObject(back[1].params).getString("merchantId"))
        val v = JSONObject(back[1].values!!)
        assertEquals("250", v.getString("amount"))
        assertEquals(10, v.getJSONObject("tip").getInt("pct"))
        assertEquals(JSONObject.NULL, v.get("note")) // a null value is kept as null, not dropped
    }

    @Test
    fun withoutValuesOnlyTheScreensAreSaved() {
        val back = readSavedStack(savedStackJson(stack, withValues = false))!!
        assertEquals(2, back.size)
        assertNull(back[1].values)
    }

    @Test
    fun aStackSavedBeforeHostApi4StillReads() {
        val back = readSavedStack("""[{"route":"home","params":{}},{"route":"amount","params":{"merchantId":"m1"}}]""")!!
        assertEquals(listOf("home", "amount"), back.map { it.route })
        assertNull(back[1].values)
    }

    @Test
    fun aBrokenSavedStackReadsAsNull() {
        assertNull(readSavedStack("[{\"route\":"))
        assertNull(readSavedStack("""[{"params":{}}]"""))
    }
}
