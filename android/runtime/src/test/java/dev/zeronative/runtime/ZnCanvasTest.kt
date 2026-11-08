package dev.zeronative.runtime

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
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
        assertEquals(10f, rect.x.value)
        assertEquals(20f, rect.y.value)
        assertEquals(100f, rect.w.value)
        assertEquals(50f, rect.h.value)
        assertEquals(Color.Red, rect.paint.color.value)

        assertTrue(ops[1] is CanvasOp.CircleOp)
        val circle = ops[1] as CanvasOp.CircleOp
        assertEquals(40f, circle.cx.value)
        assertEquals(20f, circle.r.value)
        assertEquals(Color.Green, circle.paint.color.value)

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
        assertEquals(30f, rect.x.value)
        assertEquals(300f, rect.w.value)
        assertEquals(6f, rect.paint.width())
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
        assertNull(rect.paint.gradient)
        assertEquals(Color.Blue, rect.paint.color.value) // the one colour
        val circle = parsed.ops[1] as CanvasOp.CircleOp
        assertNull(circle.paint.gradient)
        assertEquals(Color.Red, circle.paint.color.value) // no colours: the paint colour
        assertEquals(2, parsed.errors.size)
    }

    @Test
    fun gradientStopsThatDontMatchAreDropped() {
        val json = """[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 10, "y1": 0, "colors": [$RED, $BLUE], "stops": [0, 0.5, 1]}}}]"""
        val parsed = parseCanvasCommands(json)
        val rect = parsed.ops[0] as CanvasOp.RectOp
        assertEquals(Brush.linearGradient(listOf(Color.Red, Color.Blue), start = Offset(0f, 0f), end = Offset(10f, 0f)), rect.paint.gradient)
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
        assertEquals(Color.Black, (parsed.ops[0] as CanvasOp.RectOp).paint.color.value)
        assertEquals(1, parsed.errors.size)
    }

    @Test
    fun argbNumbersKeepAlpha() {
        // #FF000080 in JS (red, half alpha) is 0x80FF0000 = 2164195328.
        val parsed = parseCanvasCommands("""[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"color": 2164195328}}]""")
        assertEquals(Color(0x80FF0000.toInt()), (parsed.ops[0] as CanvasOp.RectOp).paint.color.value)
    }

    @Test
    fun pathGradientBrushIsBuiltInDp() {
        // A path is drawn under scale(density): its brush must not be scaled by density again.
        val json = """[{"type": "path", "d": "M0 0 L100 0 L100 50 Z", "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 0, "y1": 50, "colors": [$RED, $BLUE]}}}]"""
        val parsed = parseCanvasCommands(json, 3f)
        val path = parsed.ops[0] as CanvasOp.PathOp
        assertEquals(Brush.linearGradient(listOf(Color.Red, Color.Blue), start = Offset(0f, 0f), end = Offset(0f, 50f)), path.paint.gradient)
        // A rect with the same gradient is in px.
        val rectJson = """[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": 0, "y0": 0, "x1": 0, "y1": 50, "colors": [$RED, $BLUE]}}}]"""
        val rect = parseCanvasCommands(rectJson, 3f).ops[0] as CanvasOp.RectOp
        assertEquals(Brush.linearGradient(listOf(Color.Red, Color.Blue), start = Offset(0f, 0f), end = Offset(0f, 150f)), rect.paint.gradient)
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
        assertEquals(0.5f, (ops[0] as CanvasOp.PathOp).paint.width()) // dp units: 0.5 dp × 2 = 1 px
        assertEquals(1f, (ops[1] as CanvasOp.LineOp).paint.width()) // px
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

    // ---- Motion values in commands (C1) ----------------------------------------------------------------------------

    @Test
    fun numbersFollowMotionValuesAndConstantsStayAsTheyWere() {
        val v = ZnMotion.putValue(5101, 10f)
        try {
            val json = """[{"type": "rect", "x": "\u0000m5101", "y": 4, "w": 10, "h": 10}, {"type": "arc", "x": 0, "y": 0, "w": 10, "h": 10, "start": -90, "sweep": "\u0000m5101"}]"""
            val parsed = parseCanvasCommands(json, 2f)
            assertEquals(emptyList<String>(), parsed.errors)
            val rect = parsed.ops[0] as CanvasOp.RectOp
            assertNotNull(rect.x.src)
            assertNull(rect.y.src)
            assertEquals(20f, rect.x.value) // dp × density, read now
            assertEquals(8f, rect.y.value)
            v.value = 30f
            assertEquals(60f, rect.x.value) // the same op reads the new value: no new parse
            val arc = parsed.ops[1] as CanvasOp.ArcOp
            assertEquals(30f, arc.sweep.value) // degrees: not scaled by density
            assertEquals(-90f, arc.start.value)
        } finally {
            ZnMotion.dispose(5101)
        }
    }

    @Test
    fun aMotionValueThatIsGoneDrawsAsZeroWithAWarning() {
        val parsed = parseCanvasCommands("""[{"type": "circle", "cx": "\u0000m987654", "cy": 5, "r": 5}]""")
        assertEquals(1, parsed.ops.size)
        val circle = parsed.ops[0] as CanvasOp.CircleOp
        assertEquals(0f, circle.cx.value)
        assertEquals(1, parsed.errors.size)
        assertTrue(parsed.errors[0], parsed.errors[0].contains("gone"))
    }

    @Test
    fun paintOpacityStrokeWidthAndColourFollowMotionValues() {
        val v = ZnMotion.putValue(5102, 0.5f)
        val c = ZnColorMapSource(5103, v, floatArrayOf(0f, 1f), intArrayOf(0xFFFF0000.toInt(), 0xFF0000FF.toInt()))
        ZnMotion.putSource(c)
        try {
            val json = """[{"type": "line", "x1": 0, "y1": 0, "x2": 10, "y2": 0,
                "paint": {"style": "stroke", "strokeWidth": "\u0000m5102", "opacity": "\u0000m5102", "color": "\u0000m5103"}}]"""
            val parsed = parseCanvasCommands(json, 2f)
            assertEquals(emptyList<String>(), parsed.errors)
            val p = (parsed.ops[0] as CanvasOp.LineOp).paint
            assertEquals(0.5f, p.alpha())
            assertEquals(1f, p.width()) // 0.5 dp × 2
            v.value = 0f
            assertEquals(Color.Red, p.color.value)
            assertEquals(1f, p.width()) // 0: the 1 px minimum
            v.value = 3f
            assertEquals(1f, p.alpha()) // clamped
            assertEquals(6f, p.width())
        } finally {
            ZnMotion.dispose(5102)
            ZnMotion.dispose(5103)
        }
    }

    @Test
    fun aNumberMotionValueAsAColourIsBlackWithAWarning() {
        ZnMotion.putValue(5104, 1f)
        try {
            val parsed = parseCanvasCommands("""[{"type": "text", "text": "a", "x": 0, "y": 10, "options": {"color": "\u0000m5104"}}]""")
            assertEquals(Color.Black, (parsed.ops[0] as CanvasOp.TextOp).color.value)
            assertEquals(1, parsed.errors.size)
        } finally {
            ZnMotion.dispose(5104)
        }
    }

    @Test
    fun aMotionValueWhereNoneIsAllowedSkipsTheCommand() {
        ZnMotion.putValue(5105, 1f)
        try {
            val json = """
                [
                    {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"linearGradient": {"x0": "\u0000m5105", "y0": 0, "x1": 10, "y1": 0, "colors": [$RED, $BLUE]}}},
                    {"type": "paragraph", "text": "a", "x": 0, "y": 0, "width": "\u0000m5105"},
                    {"type": "text", "text": "a", "x": 0, "y": 10, "options": {"fontSize": "\u0000m5105"}}
                ]
            """.trimIndent()
            val parsed = parseCanvasCommands(json)
            assertEquals(0, parsed.ops.size)
            assertEquals(3, parsed.errors.size)
        } finally {
            ZnMotion.dispose(5105)
        }
    }

    @Test
    fun pathTrimsParse() {
        ZnMotion.putValue(5106, 0.25f)
        try {
            val json = """
                [
                    {"type": "path", "d": "M0 0 L10 0", "trimEnd": "\u0000m5106", "trimStart": 0},
                    {"type": "path", "d": "M0 0 L10 0"},
                    {"type": "path", "d": "M0 0 L10 0", "trimOffset": "nope"}
                ]
            """.trimIndent()
            val parsed = parseCanvasCommands(json, 3f)
            assertEquals(2, parsed.ops.size)
            val trimmed = parsed.ops[0] as CanvasOp.PathOp
            assertTrue(trimmed.trimmed)
            assertEquals(0.25f, trimmed.trimEnd!!.value) // a fraction: not scaled by density
            assertEquals(0f, trimmed.trimStart!!.value)
            assertNull(trimmed.trimOffset)
            assertTrue(!(parsed.ops[1] as CanvasOp.PathOp).trimmed)
            assertEquals(1, parsed.errors.size)
        } finally {
            ZnMotion.dispose(5106)
        }
    }

    // ---- New commands (C4-C7) ----------------------------------------------------------------------------------------

    @Test
    fun paragraphParses() {
        val json = """
            [
                {"type": "paragraph", "text": "Hello there", "x": 10, "y": 20, "width": 100, "options": {"fontSize": 12, "fontWeight": "bold", "align": "center", "lineHeight": 18, "maxLines": 2, "color": $RED}},
                {"type": "paragraph", "text": "a", "x": 0, "y": 0, "width": 0},
                {"type": "paragraph", "text": "a", "x": 0, "y": 0, "width": 50, "options": {"maxLines": 0, "lineHeight": -1}}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json, 2f)
        assertEquals(2, parsed.ops.size)
        val p = parsed.ops[0] as CanvasOp.ParagraphOp
        assertEquals(200, p.width)
        assertEquals(24f, p.fontSizePx)
        assertEquals(700, p.fontWeight)
        assertEquals(1, p.align)
        assertEquals(36f, p.lineHeight)
        assertEquals(2, p.maxLines)
        assertEquals(Color.Red, p.color.value)
        assertEquals(40f, p.y.value)
        val loose = parsed.ops[1] as CanvasOp.ParagraphOp
        assertEquals(Int.MAX_VALUE, loose.maxLines)
        assertEquals(0f, loose.lineHeight)
        assertEquals(3, parsed.errors.size) // width 0, maxLines 0, lineHeight -1
    }

    @Test
    fun imageParses() {
        val json = """
            [
                {"type": "image", "src": "asset:images/a.png", "x": 0, "y": 0, "w": 80, "h": 40, "options": {"fit": "contain", "radius": 8, "opacity": 0.5}},
                {"type": "image", "src": "https://x.test/a.png", "x": 0, "y": 0, "w": 9000, "h": 10},
                {"type": "image", "x": 0, "y": 0, "w": 10, "h": 10},
                {"type": "image", "src": "a", "x": 0, "y": 0, "w": 10, "h": 10, "options": {"fit": "zoom"}}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json, 2f)
        assertEquals(3, parsed.ops.size)
        val a = parsed.ops[0] as CanvasOp.ImageOp
        assertEquals(FIT_CONTAIN, a.fit)
        assertEquals(160, a.decodeW)
        assertEquals(80, a.decodeH)
        assertEquals(16f, a.radius!!.value)
        assertEquals(0.5f, a.opacity.value)
        val b = parsed.ops[1] as CanvasOp.ImageOp
        assertEquals(FIT_COVER, b.fit)
        assertEquals(4096, b.decodeW) // capped
        assertNull(b.radius)
        assertEquals(FIT_COVER, (parsed.ops[2] as CanvasOp.ImageOp).fit)
        assertEquals(2, parsed.errors.size) // no src, unknown fit
    }

    @Test
    fun clipsTakeAnOp() {
        val json = """
            [
                {"type": "clipRect", "x": 0, "y": 0, "w": 10, "h": 10},
                {"type": "clipRect", "x": 0, "y": 0, "w": 10, "h": 10, "op": "difference"},
                {"type": "clipRoundRect", "x": 0, "y": 0, "w": 10, "h": 10, "r": 4, "op": "difference"},
                {"type": "clipPath", "d": "M0 0 L10 0 L10 10 Z", "op": "intersect", "fillType": "evenOdd"},
                {"type": "clipRect", "x": 0, "y": 0, "w": 10, "h": 10, "op": "union"},
                {"type": "clipPath", "op": "difference"}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json, 2f)
        assertEquals(5, parsed.ops.size)
        assertEquals(ClipOp.Intersect, (parsed.ops[0] as CanvasOp.ClipRectOp).op)
        assertEquals(ClipOp.Difference, (parsed.ops[1] as CanvasOp.ClipRectOp).op)
        val rr = parsed.ops[2] as CanvasOp.ClipRoundRectOp
        assertEquals(ClipOp.Difference, rr.op)
        assertEquals(8f, rr.r.value)
        val cp = parsed.ops[3] as CanvasOp.ClipPathOp
        assertEquals(PathFillType.EvenOdd, cp.fillType)
        assertEquals(2f, cp.scale)
        assertEquals(ClipOp.Intersect, (parsed.ops[4] as CanvasOp.ClipRectOp).op) // unknown op: intersect
        assertEquals(2, parsed.errors.size)
    }

    @Test
    fun paintEffectsParse() {
        val json = """
            [
                {"type": "path", "d": "M0 0 L10 0 L10 10 Z", "paint": {"fillType": "evenOdd", "blendMode": "multiply"}},
                {"type": "circle", "cx": 5, "cy": 5, "r": 5, "paint": {"sweepGradient": {"cx": 5, "cy": 5, "colors": [$RED, $BLUE], "stops": [0, 1], "startAngle": -90}}},
                {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"shadow": {"dx": 1, "dy": 2, "blur": 4, "color": $RED}, "blur": 3}},
                {"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"shadow": {"dx": 1, "dy": 2, "blur": 4, "color": "#000"}, "blendMode": "hue", "blur": -1}}
            ]
        """.trimIndent()
        val parsed = parseCanvasCommands(json, 2f)
        assertEquals(4, parsed.ops.size)
        assertTrue(parsed.needsLayer)
        val path = (parsed.ops[0] as CanvasOp.PathOp).paint
        assertEquals(PathFillType.EvenOdd, path.fillType)
        assertEquals(BlendMode.Multiply, path.blendMode)
        val sweep = (parsed.ops[1] as CanvasOp.CircleOp).paint.sweep!!
        assertEquals(10f, sweep.cx)
        assertEquals(-90f, sweep.startAngle)
        assertArrayEquals(floatArrayOf(0f, 1f), sweep.stops, 0f)
        assertEquals(2, sweep.colors.size)
        val fx = (parsed.ops[2] as CanvasOp.RectOp).paint
        assertTrue(fx.hasFx)
        assertEquals(2f, fx.shadow!!.dx)
        assertEquals(8f, fx.shadow!!.blur)
        assertEquals(6f, fx.blur)
        val bad = (parsed.ops[3] as CanvasOp.RectOp).paint
        assertNull(bad.shadow)
        assertEquals(BlendMode.SrcOver, bad.blendMode)
        assertEquals(0f, bad.blur)
        assertEquals(3, parsed.errors.size) // a string shadow colour, an unknown blend mode, a negative blur
    }

    @Test
    fun noBlendModeNeedsNoLayer() {
        assertTrue(!parseCanvasCommands("""[{"type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "paint": {"blendMode": "srcOver"}}]""").needsLayer)
    }
}
