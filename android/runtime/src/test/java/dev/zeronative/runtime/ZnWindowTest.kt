package dev.zeronative.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What DEVICE, WINDOW and KEYBOARD send to JS (platform.ts, dimensions.ts, keyboard.ts read these names). */
class ZnWindowTest {
    @Test fun deviceHasTheFactsPlatformReads() {
        val d = JSONObject(ZnWindow.deviceJson(34, "14", "Blaze 2 5G", "LAVA", "LAVA"))
        assertEquals(34, d.getInt("sdk"))
        assertEquals("14", d.getString("release"))
        assertEquals("Blaze 2 5G", d.getString("model"))
        assertEquals("LAVA", d.getString("brand"))
        assertEquals("LAVA", d.getString("manufacturer"))
    }

    @Test fun sizesHaveOneDecimalAndScalesStayExact() {
        val w = JSONObject(ZnWindow.windowJson(360.04f, 800.96f, 2.75f, 1.15f, 360.04f, 820f))
        assertEquals(360.0, w.getDouble("width"), 0.0)
        assertEquals(801.0, w.getDouble("height"), 0.0)
        assertEquals(2.75, w.getDouble("scale"), 0.0) // PixelRatio.get() must be the real density
        assertEquals(1.15, w.getDouble("fontScale"), 0.0)
        assertEquals(820.0, w.getDouble("screenHeight"), 0.0)
    }

    @Test fun keyboardIsVisibleOnlyWithAHeight() {
        val shown = JSONObject(ZnWindow.keyboardJson(301.24f))
        assertTrue(shown.getBoolean("visible"))
        assertEquals(301.2, shown.getDouble("height"), 0.0)
        assertFalse(JSONObject(ZnWindow.keyboardJson(0f)).getBoolean("visible"))
    }
}
