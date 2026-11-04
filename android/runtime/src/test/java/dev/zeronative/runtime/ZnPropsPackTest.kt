package dev.zeronative.runtime

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RN props pack 2 (registry 14-15): the parts that are plain logic. */
class ZnPropsPackTest {
    @Test
    fun textTransformLikeReactNative() {
        assertEquals("PAY ₹120", transformText("Pay ₹120", Registry.TextTransform.UPPERCASE))
        assertEquals("upi id", transformText("UPI ID", Registry.TextTransform.LOWERCASE))
        // capitalize: each word's first letter up, the rest down (React Native's Android code), "don't" is one word.
        assertEquals("Don't Pay Twice", transformText("don't PAY twice", Registry.TextTransform.CAPITALIZE))
        assertEquals("Hello\u001fWorld", transformText("hello\u001fworld", Registry.TextTransform.CAPITALIZE))
        assertEquals("", transformText("", Registry.TextTransform.CAPITALIZE))
        // No phone locale: "i" stays "I" (never the Turkish dotted one).
        assertEquals("TITLE", transformText("title", Registry.TextTransform.UPPERCASE))
        assertEquals("as is", transformText("as is", Registry.TextTransform.NONE))
    }

    @Test
    fun hitSlopFromTheCompiler() {
        assertArrayEquals(floatArrayOf(4f, 8f, 6f, 8f), parseHitSlop("4,8,6,8"), 0f)
        assertNull(parseHitSlop(null))
        assertNull(parseHitSlop("0,0,0,0")) // nothing to add
        assertNull(parseHitSlop("1,2,3")) // not the compiler's form
    }
}
