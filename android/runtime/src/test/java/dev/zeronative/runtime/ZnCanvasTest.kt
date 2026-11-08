package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ZnCanvasTest {
    @Test
    fun parsesBasicShapesAndCommands() {
        val json = """
            [
                {"type": "rect", "x": 10, "y": 20, "w": 100, "h": 50, "paint": {"color": "#FF0000", "style": "fill"}},
                {"type": "circle", "cx": 40, "cy": 40, "r": 20, "paint": {"color": "#00FF00"}},
                {"type": "line", "x1": 0, "y1": 0, "x2": 50, "y2": 50, "paint": {"strokeWidth": 2}},
                {"type": "text", "text": "Test", "x": 10, "y": 30, "options": {"fontSize": 16, "fontWeight": "bold"}},
                {"type": "save"},
                {"type": "translate", "dx": 5, "dy": 10},
                {"type": "restore"}
            ]
        """.trimIndent()
        val ops = parseCanvasCommands(json)
        assertEquals(7, ops.size)
        assertTrue(ops[0] is CanvasOp.RectOp)
        val rect = ops[0] as CanvasOp.RectOp
        assertEquals(10f, rect.x)
        assertEquals(20f, rect.y)
        assertEquals(100f, rect.w)
        assertEquals(50f, rect.h)

        assertTrue(ops[1] is CanvasOp.CircleOp)
        val circle = ops[1] as CanvasOp.CircleOp
        assertEquals(40f, circle.cx)
        assertEquals(20f, circle.r)

        assertTrue(ops[3] is CanvasOp.TextOp)
        val text = ops[3] as CanvasOp.TextOp
        assertEquals("Test", text.text)
        assertEquals(16f, text.fontSize)
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
        val ops = parseCanvasCommands(json)
        assertEquals(2, ops.size)
        assertTrue(ops[0] is CanvasOp.RectOp)
        assertTrue(ops[1] is CanvasOp.SaveOp)
    }

    @Test
    fun refusesExcessiveCommandsOverLimit() {
        val sb = StringBuilder("[")
        for (i in 0..10005) {
            if (i > 0) sb.append(",")
            sb.append("""{"type":"save"}""")
        }
        sb.append("]")
        val ops = parseCanvasCommands(sb.toString())
        assertEquals(0, ops.size)
    }
}
