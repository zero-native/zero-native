package dev.zeronative.runtime

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Colours are ARGB numbers (core canvas.ts converts them in JS): 0xFFFF0000 = 4294901760, 0xFF00FF00 = 4278255360,
// 0xFF0000FF = 4278190335.
private const val RED = 4294901760L
private const val GREEN = 4278255360L
private const val BLUE = 4278190335L

class ZnCanvasTest {
    @Test
    fun parsesBasicShapesAndCommands() {
        val json = """
            [
                {"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50, "paint": {"color": $RED, "style": "fill"}},
                {"type": "circle", "cx": 40, "cy": 40, "r": 20, "paint": {"color": $GREEN}},
                {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 50, "paint": {"strokeWidth": 2}},
                {"type": "text", "text": "Test", "x": 10, "y": 30, "options": {"fontSize": 16, "fontWeight": "bold"}},
                {"type": "save"},
                {"type": "translate", "dx": 5, "dy": 10},
                {"type": "restore"}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json)
        val ops = parsed.ops
        assertEquals(emptyList<String>(), parsed.errors)
        assertEquals(7, ops.size)
        assertTrue(ops[0] is CanvasOp.RectOp)
        val rect = ops[0] as CanvasOp.RectOp
        assertEquals(10f, rect.x)
        assertEquals(20f, rect.y)
        assertEquals(100f, rect.w)
        assertEquals(50f, rect.h)
        assertEquals(Color.Red, rect.paint.color)

        assertTrue(ops[1] is CanvasOp.CircleOp)
        val circle = ops[1] as CanvasOp.CircleOp
        assertEquals(40f, circle.cx)
        assertEquals(20f, circle.r)
        assertEquals(Color.Green, circle.paint.color)

        assertTrue(ops[3] is CanvasOp.TextOp)
        val text = ops[3] as CanvasOp.TextOp
        assertEquals("Test", text.text)
        assertEquals(16f, text.fontSize)
        assertEquals(700, text.fontWeight)
    }

    @Test
    fun positionsAreScaledByDensity() {
        val ops = parseCanvasCommands("""[{"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50, "paint": {"style": "stroke", "strokeWidth": 2}}]""", 3f).ops
        val rect = ops[0] as CanvasOp.RectOp
        assertEquals(30f, rect.x)
        assertEquals(300f, rect.w)
        assertEquals(6f, rect.paint.strokeWidth)
    }

    @Test
    fun skipsMalformedCommandGracefully() {
        val json = """
            [
                {"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50},
                {"type": "corrupted_non_existent", "bad": true},
                {"type": "save"}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json)
        assertEquals(2, parsed.ops.size)
        assertTrue(parsed.ops[0] is CanvasOp.RectOp)
        assertTrue(parsed.ops[1] is CanvasOp.SaveOp)
        assertEquals(1, parsed.errors.size)
        assertTrue(parsed.errors[0], parsed.errors[0].startsWith("command 1:"))
    }

    @Test
    fun knownCommandWithMissingOrWrongFieldIsDroppedAndNamed() {
        val json = """
            [
                {"type": "circle", "cx": 10, "cy": 10},
                {"type": "rect", "x": "ten", "y": 0, "w": 10, "h": 10},
                {"type": "path"},
                {"type": "circle", "cx": 10, "cy": 10, "r": 5}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json)
        assertEquals(1, parsed.ops.size)
        assertTrue(parsed.ops[0] is CanvasOp.CircleOp)
        assertEquals(3, parsed.errors.size)
        assertTrue(parsed.errors[0], parsed.errors[0].startsWith("command 0:") && parsed.errors[0].contains("\"r\""))
        assertTrue(parsed.errors[1], parsed.errors[1].startsWith("command 1:") && parsed.errors[1].contains("\"x\""))
        assertTrue(parsed.errors[2], parsed.errors[2].startsWith("command 2:") && parsed.errors[2].contains("\"d\""))
    }

    @Test
    fun nullAndFalseEntriesAreSkippedSilently() {
        val parsed = parseCanvasCommands("""[null, false, {"type": "save"}, {"type": "restore"}]""")
        assertEquals(2, parsed.ops.size)
        assertEquals(emptyList<String>(), parsed.errors)
    }

    @Test
    fun restoreWithoutSaveIsDroppedWithOneError() {
        val parsed = parseCanvasCommands("""[{"type": "restore"}, {"type": "save"}, {"type": "restore"}, {"type": "restore"}]""")
        assertEquals(2, parsed.ops.size)
        assertEquals(2, parsed.errors.size)
        assertTrue(parsed.errors[0].startsWith("command 0:"))
        assertTrue(parsed.errors[1].startsWith("command 3:"))
    }

    @Test
    fun oneColourGradientDrawsSolidWithoutBrush() {
        val json = """
            [
                {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": $RED, "linearGradient": {"x0": 0, "y0": 0, "x1": 10, "y1": 0, "colors": [$BLUE]}}},
                {"type": "circle", "cx": 5, "cy": 5, "r": 5, "paint": {"color": $RED, "radialGradient": {"cx": 5, "cy": 5, "r": 5, "colors": []}}}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json)
        assertEquals(2, parsed.ops.size)
        val rect = parsed.ops[0] as CanvasOp.RectOp
        assertNull(rect.paint.brush)
        assertEquals(Color.Blue, rect.paint.color) // the one colour
        val circle = parsed.ops[1] as CanvasOp.CircleOp
        assertNull(circle.paint.brush)
        assertEquals(Color.Red, circle.paint.color) // no colours: the paint colour
        assertEquals(2, parsed.errors.size)
    }

    @Test
    fun gradientStopsThatDontMatchAreDropped() {
        val json = """[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 10, "y1": 0, "colors": [$RED, $BLUE], "stops": [0, 0.5, 1]}}}]"""
        val parsed = parseCanvasCommands(json)
        val rect = parsed.ops[0] as CanvasOp.RectOp
        assertEquals(Brush.linearGradient(listOf(Color.Red, Color.Blue), start = Offset(0f, 0f), end = Offset(10f, 0f)), rect.paint.brush)
        assertEquals(1, parsed.errors.size)
    }

    @Test
    fun dashOfLengthOneIsDropped() {
        val json = """
            [
                {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [4]}},
                {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [0, 0]}},
                {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [4, -1]}},
                {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 0, "paint": {"style": "stroke", "dash": [4, 2]}}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json, 2f)
        assertEquals(4, parsed.ops.size)
        assertNull((parsed.ops[0] as CanvasOp.LineOp).paint.dash)
        assertNull((parsed.ops[1] as CanvasOp.LineOp).paint.dash)
        assertNull((parsed.ops[2] as CanvasOp.LineOp).paint.dash)
        assertArrayEquals(floatArrayOf(8f, 4f), (parsed.ops[3] as CanvasOp.LineOp).paint.dash, 0f)
        assertEquals(3, parsed.errors.size)
        assertTrue(parsed.errors[0].startsWith("command 0:"))
    }

    @Test
    fun nonFiniteNumbersAreRefused() {
        // JSON.stringify sends NaN / Infinity as null; a huge number becomes Infinity after toFloat().
        val json = """
            [
                {"type": "circle", "cx": null, "cy": 0, "r": 5},
                {"type": "rect", "x": 1e300, "y": 0, "w": 10, "h": 10},
                {"type": "circle", "cx": 5, "cy": 5, "r": 5, "paint": {"radialGradient": {"cx": 5, "cy": 5, "r": 1e300, "colors": [$RED, $BLUE]}}},
                {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json)
        assertEquals(1, parsed.ops.size)
        assertTrue(parsed.ops[0] is CanvasOp.RectOp)
        assertEquals(3, parsed.errors.size)
    }

    @Test
    fun stringColourIsBlackWithAnError() {
        val parsed = parseCanvasCommands("""[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": "#FF000080"}}]""")
        assertEquals(Color.Black, (parsed.ops[0] as CanvasOp.RectOp).paint.color)
        assertEquals(1, parsed.errors.size)
    }

    @Test
    fun argbNumbersKeepAlpha() {
        // #FF000080 in JS (red, half alpha) is 0x80FF0000 = 2164195328.
        val parsed = parseCanvasCommands("""[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": 2164195328}}]""")
        assertEquals(Color(0x80FF0000.toInt()), (parsed.ops[0] as CanvasOp.RectOp).paint.color)
    }

    @Test
    fun pathGradientBrushIsBuiltInDp() {
        // A path is drawn under scale(density): its brush must not be scaled by density again.
        val json = """[{"type": "path", "d": "M0 0 L100 0 L100 50 Z", "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 0, "y1": 50, "colors": [$RED, $BLUE]}}}]"""
        val parsed = parseCanvasCommands(json, 3f)
        val path = parsed.ops[0] as CanvasOp.PathOp
        assertEquals(Brush.linearGradient(listOf(Color.Red, Color.Blue), start = Offset(0f, 0f), end = Offset(0f, 50f)), path.paint.brush)
        // A rect with the same gradient is in px.
        val rectJson = """[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 0, "y1": 50, "colors": [$RED, $BLUE]}}}]"""
        val rect = parseCanvasCommands(rectJson, 3f).ops[0] as CanvasOp.RectOp
        assertEquals(Brush.linearGradient(listOf(Color.Red, Color.Blue), start = Offset(0f, 0f), end = Offset(0f, 150f)), rect.paint.brush)
    }

    @Test
    fun strokeWidthMinimumIsOnePixelForPathsToo() {
        val json = """
            [
                {"type": "path", "d": "M0 0 L10 0", "paint": {"style": "stroke", "strokeWidth": 0}},
                {"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0, "paint": {"strokeWidth": 0}}
            ]
        """.trimIndent()
        val ops = parseCanvasCommands(json, 2f).ops
        assertEquals(0.5f, (ops[0] as CanvasOp.PathOp).paint.strokeWidth) // dp units: 0.5 dp × 2 = 1 px
        assertEquals(1f, (ops[1] as CanvasOp.LineOp).paint.strokeWidth) // px
    }

    @Test
    fun malformedJsonGivesNothingAndAnError() {
        val parsed = parseCanvasCommands("""[{"type": "rect", """)
        assertEquals(0, parsed.ops.size)
        assertEquals(1, parsed.errors.size)
        val notArray = parseCanvasCommands("""{"type": "rect"}""")
        assertEquals(0, notArray.ops.size)
        assertEquals(1, notArray.errors.size)
    }

    private fun saves(n: Int): String {
        val sb = StringBuilder("[")
        for (i in 0 until n) {
            if (i > 0) sb.append(",")
            sb.append("""{"type":"save"}""")
        }
        return sb.append("]").toString()
    }

    @Test
    fun allowsExactlyTheLimit() {
        val parsed = parseCanvasCommands(saves(MAX_CANVAS_COMMANDS))
        assertEquals(MAX_CANVAS_COMMANDS, parsed.ops.size)
        assertEquals(emptyList<String>(), parsed.errors)
    }

    @Test
    fun refusesOneOverTheLimit() {
        val parsed = parseCanvasCommands(saves(MAX_CANVAS_COMMANDS + 1))
        assertEquals(0, parsed.ops.size)
        assertEquals(1, parsed.errors.size)
        assertNotNull(parsed.errors[0])
    }

    @Test
    fun errorListIsCapped() {
        val sb = StringBuilder("[")
        for (i in 0 until 50) {
            if (i > 0) sb.append(",")
            sb.append("""{"type":"nope"}""")
        }
        val parsed = parseCanvasCommands(sb.append("]").toString())
        assertEquals(11, parsed.errors.size)
        assertEquals("and 40 more", parsed.errors.last())
    }
}
