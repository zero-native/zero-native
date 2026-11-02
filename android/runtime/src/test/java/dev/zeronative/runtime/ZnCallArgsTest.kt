package dev.zeronative.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The typed argument helpers in ZnModules.kt. Args are parsed from JSON, as they arrive from JS. */
class ZnCallArgsTest {
    private fun call(json: String) = object : ZnCall {
        override val args = JSONObject(json)
        override val bytes: ByteArray? = null
        override val isCancelled = false
        override fun resolve(value: Any?) {}
        override fun resolveBytes(value: Any?, bytes: ByteArray) {}
        override fun reject(code: String, message: String) {}
        override fun onCancel(block: () -> Unit) {}
    }

    private fun refused(json: String, read: (ZnCall) -> Any?) =
        assertThrows(ZnInvalidArgs::class.java) { read(call(json)) }.message!!

    @Test fun goodValues() {
        val c = call("""{"s":"hi","empty":"","i":7,"neg":-7,"l":4102444800000,"d":1.5,"whole":2,"yes":true,"no":false}""")
        assertEquals("hi", c.string("s"))
        assertEquals("", c.string("empty"))
        assertEquals(7, c.int("i"))
        assertEquals(-7, c.int("neg"))
        assertEquals(4102444800000L, c.long("l"))
        assertEquals(7L, c.long("i"))
        assertEquals(1.5, c.double("d"), 0.0)
        assertEquals(2.0, c.double("whole"), 0.0)
        assertEquals(true, c.boolean("yes"))
        assertEquals(false, c.boolean("no"))
    }

    @Test fun aMissingValueIsRefusedOrNull() {
        assertTrue(refused("{}") { it.string("x") }.contains("\"x\" is missing"))
        refused("{}") { it.int("x") }
        refused("{}") { it.long("x") }
        refused("{}") { it.double("x") }
        refused("{}") { it.boolean("x") }
        val c = call("{}")
        assertNull(c.stringOrNull("x"))
        assertNull(c.intOrNull("x"))
        assertNull(c.longOrNull("x"))
        assertNull(c.doubleOrNull("x"))
        assertNull(c.booleanOrNull("x"))
    }

    @Test fun jsNullCountsAsMissing() {
        refused("""{"x":null}""") { it.string("x") }
        refused("""{"x":null}""") { it.int("x") }
        val c = call("""{"x":null}""")
        assertNull(c.stringOrNull("x"))
        assertNull(c.intOrNull("x"))
        assertNull(c.booleanOrNull("x"))
    }

    @Test fun theWrongTypeIsRefusedInBothForms() {
        assertTrue(refused("""{"x":5}""") { it.string("x") }.contains("\"x\" must be a string, got 5"))
        refused("""{"x":5}""") { it.stringOrNull("x") }
        refused("""{"x":true}""") { it.string("x") }
        refused("""{"x":"5"}""") { it.int("x") }
        refused("""{"x":"5"}""") { it.intOrNull("x") }
        refused("""{"x":"5"}""") { it.long("x") }
        refused("""{"x":"5"}""") { it.double("x") }
        refused("""{"x":"true"}""") { it.boolean("x") }
        refused("""{"x":1}""") { it.boolean("x") }
    }

    @Test fun aFractionIsNotAWholeNumber() {
        refused("""{"x":1.5}""") { it.int("x") }
        refused("""{"x":1.5}""") { it.intOrNull("x") }
        refused("""{"x":1.5}""") { it.long("x") }
    }

    @Test fun aWholeNumberOutOfRangeIsRefused() {
        assertEquals(Int.MAX_VALUE, call("""{"x":2147483647}""").int("x"))
        refused("""{"x":2147483648}""") { it.int("x") }
        refused("""{"x":-2147483649}""") { it.int("x") }
        assertEquals(9007199254740991L, call("""{"x":9007199254740991}""").long("x"))
        refused("""{"x":9007199254740992}""") { it.long("x") }
        refused("""{"x":1e300}""") { it.long("x") }
    }
}
