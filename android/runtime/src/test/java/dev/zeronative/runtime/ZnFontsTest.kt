package dev.zeronative.runtime

import androidx.compose.ui.text.font.FontFamily
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** App fonts (registry 24, ZnFonts.kt): the font check and the phone's own names. */
class ZnFontsTest {
    private fun bytes(vararg b: Int) = b.map { it.toByte() }.toByteArray().inputStream()

    @Test
    fun aFontStartsWithAnSfntTag() {
        assertTrue(ZnFontTable.looksLikeFont(bytes(0, 1, 0, 0, 9, 9)))
        assertTrue(ZnFontTable.looksLikeFont("OTTO....".byteInputStream()))
        assertTrue(ZnFontTable.looksLikeFont("true".byteInputStream()))
        // An HTML error page saved as a font, a collection, a cut file.
        assertFalse(ZnFontTable.looksLikeFont("<html>".byteInputStream()))
        assertFalse(ZnFontTable.looksLikeFont("ttcf....".byteInputStream()))
        assertFalse(ZnFontTable.looksLikeFont(bytes(0, 1)))
    }

    @Test
    fun systemNamesNeedNoFile() {
        val t = ZnFontTable.EMPTY
        assertNull(t.family(null))
        assertNull(t.family(""))
        assertNull(t.family("System")) // the default font
        assertNull(t.family("Roboto"))
        assertEquals(FontFamily.Serif, t.family("serif"))
        assertEquals(FontFamily.Monospace, t.family("monospace"))
        // Cached: the same answer the second time.
        assertEquals(FontFamily.Serif, t.family("serif"))
        assertNull(t.family("System"))
    }
}
