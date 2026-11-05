package dev.zeronative.runtime

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** <OtpInput> (registry 18): the parts that are plain logic. */
class ZnOtpInputTest {
    private val numeric = Registry.OtpType.NUMERIC

    @Test
    fun typingAndPaste() {
        assertEquals("1234", otpFilter("1234", numeric, 4))
        // A paste with other characters keeps the digits (RN drops the whole paste), cut to the boxes.
        assertEquals("1234", otpFilter("1234 ", numeric, 4))
        assertEquals("4821", otpFilter("Your code: 4821. Don't share it", numeric, 4))
        assertEquals("1234", otpFilter("123456", numeric, 4))
        assertEquals("", otpFilter("abc", numeric, 4))
        // Devanagari and Arabic-Indic digits from some Indian keyboards.
        assertEquals("1234", otpFilter("१२३४", numeric, 4))
        assertEquals("1234", otpFilter("١٢٣٤", numeric, 6))
    }

    @Test
    fun alphaAndAlphanumeric() {
        assertEquals("AbC", otpFilter("A1b2C3", Registry.OtpType.ALPHA, 6))
        assertEquals("A1b2C3", otpFilter("A1-b2 C3", Registry.OtpType.ALPHANUMERIC, 6))
        // Only a-z: no accented letters, as RN's [a-zA-Z].
        assertEquals("ab", otpFilter("aéb", Registry.OtpType.ALPHA, 6))
    }

    @Test
    fun themeFromTheCompiler() {
        // The RN customer app's theme, as the compiler writes it.
        val t = ZnOtpTheme.parse("fc=#FF006E67;w=60;h=64;r=12;bw=1.5;bc=#FFE5E7EB;bg=#FFF9FAFB;fbc=#FF006E67;fbw=2;dbg=#FFF9FAFB;sc=#FF006E67;sh=24;sw=2")
        val idle = t.boxFor(focusedBox = false, filledBox = false, isDisabled = false, isError = false)
        assertEquals(60f, idle.width)
        assertEquals(64f, idle.height)
        assertEquals(1.5f, idle.borderWidth)
        assertEquals(Color(0xFFE5E7EB), idle.borderColor)
        assertEquals(Color(0xFFF9FAFB), idle.background)
        val focused = t.boxFor(focusedBox = true, filledBox = false, isDisabled = false, isError = false)
        assertEquals(2f, focused.borderWidth)
        assertEquals(Color(0xFF006E67), focused.borderColor)
        assertEquals(60f, focused.width) // the base still applies
        assertEquals(24f, t.stickHeight)
        assertEquals(Color(0xFF006E67), t.stickColor)
        assertFalse(t.hideStick)
    }

    @Test
    fun rnDefaultsAndOrder() {
        val t = ZnOtpTheme.parse(null)
        val idle = t.boxFor(false, false, false, false)
        assertEquals(44f, idle.width)
        assertEquals(60f, idle.height)
        assertEquals(Color(0xFFDFDFDE), idle.borderColor)
        // focusColor alone colours the focused box's border and the caret.
        val f = ZnOtpTheme.parse("fc=#FF112233")
        assertEquals(Color(0xFF112233), f.boxFor(true, false, false, false).borderColor)
        assertEquals(Color(0xFF112233), f.stickColor)
        assertEquals(350, f.blinkMs)
        // Later states win: error over disabled over filled over focused.
        val o = ZnOtpTheme.parse("fbc=#FF000001;lbc=#FF000002;dbc=#FF000003;ebc=#FF000004;hs=1")
        assertEquals(Color(0xFF000002), o.boxFor(true, true, false, false).borderColor)
        assertEquals(Color(0xFF000003), o.boxFor(true, true, true, false).borderColor)
        assertEquals(Color(0xFF000004), o.boxFor(true, true, true, true).borderColor)
        assertTrue(o.hideStick)
        // A bad value is skipped, not a crash.
        assertEquals(44f, ZnOtpTheme.parse("w=wide;bc=red").boxFor(false, false, false, false).width)
    }
}
