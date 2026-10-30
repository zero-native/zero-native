package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A JS error in the forms crash reporters and OTA telemetry get (step 4.8): [ZnJsError.asThrowable], [jsTopFrames]. */
class ZnJsErrorTest {
    private val details = """
        Error: amount is not a number
            at HomeScreen (main.js:2051:22)
            at anonymous (main.js:88:3)
            at render (native)
            at C:\b\main.js:10:4
    """.trimIndent()

    private val error = ZnJsError("screen", "screen \"home\" threw", details, "home", "app_8", "app_8@1a2b3c4d5e6f")

    @Test fun theThrowableNamesTheBundleAndCarriesTheJsFrames() {
        val t = error.asThrowable()
        assertEquals("JS error [app_8@1a2b3c4d5e6f] screen in screen \"home\" threw: Error: amount is not a number", t.message)
        val frames = t.stackTrace.map { "${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
        // The native frame has no position: left out. A path keeps only the file name.
        assertEquals(listOf("zn.js.HomeScreen(main.js:2051)", "zn.js.anonymous(main.js:88)", "zn.js.<anonymous>(main.js:10)"), frames)
    }

    @Test fun withoutALabelTheIdIsUsed() {
        val e = ZnJsError("async", "a Promise", "Error: x", null, "app_8")
        assertTrue(e.asThrowable().message!!.startsWith("JS error [app_8] async"))
    }

    @Test fun topFramesKeepOnlyFramesAndStaySmall() {
        assertEquals("at HomeScreen (main.js:2051:22)\nat anonymous (main.js:88:3)\nat render (native)\nat C:\\b\\main.js:10:4", jsTopFrames(details))
        assertNull(jsTopFrames("Error: no stack"))
        val deep = (1..50).joinToString("\n") { "    at f$it (main.js:$it:1)" }
        assertEquals(8, jsTopFrames(deep)!!.lines().size)
        val wide = (1..8).joinToString("\n") { "at ${"f".repeat(200)} (main.js:$it:1)" }
        assertTrue(jsTopFrames(wide)!!.length <= MAX_JS_FRAMES_CHARS)
    }
}
