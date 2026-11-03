package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What a bundle can name as a file (ZnHandles): JS writes this text, so it is outside input. */
class ZnHandlesTest {
    @Test fun `a plain name is a file`() {
        assertEquals("photo-1.jpg", ZnHandles.fileName("photo-1.jpg"))
        assertEquals("a_b.c.png", ZnHandles.fileName("a_b.c.png"))
    }

    @Test fun `anything that could leave the folder is refused`() {
        for (name in listOf("..", ".", "../secret", "a/b", "a\\b", "/data/x", ".hidden", "", "a\u0000b", "a b", "%2e%2e")) {
            assertNull(name, ZnHandles.fileName(name))
        }
    }

    @Test fun `a handle splits into kind and path`() {
        assertEquals("file" to "a.png", ZnHandles.parse("zn://file/a.png"))
        assertEquals("file" to "../a", ZnHandles.parse("zn://file/../a")) // parse only splits: fileName refuses this one
        assertNull(ZnHandles.parse("file:///a"))
    }
}
