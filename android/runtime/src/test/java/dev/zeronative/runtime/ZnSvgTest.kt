package dev.zeronative.runtime

import androidx.compose.ui.graphics.vector.PathNode
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * SVG draw data, format v1 (compiler/src/svg-data.ts header). Only the plain reader (ZnSvgReader): Compose Paths and
 * shaders need Android, so they are not built here. Path data is read by Compose's PathParser (plain Kotlin).
 */
class ZnSvgTest {
    private fun read(s: String) = ZnSvgReader.read(s)

    @Test
    fun headerAndAspectCodes() {
        val d = read("Z1 -1.5 0 24 12.25 4")
        assertEquals(-1.5f, d.vx)
        assertEquals(0f, d.vy)
        assertEquals(24f, d.vw)
        assertEquals(12.25f, d.vh)
        assertEquals(4, d.aspect)
        assertEquals(0, d.ops.size)
        assertEquals(0, d.gradients.size)
        assertEquals(0, d.clips.size)
        assertEquals(0, d.maxDepth)
        for (a in 0..18) assertEquals(a, read("Z1 0 0 24 24 $a").aspect)
        bad("Z1 0 0 24 24 19")
        bad("Z1 0 0 24 24 -1")
        bad("Z1 0 0 24 24 4.5")
        bad("Z1 0 0 0 24 4") // empty viewBox
        bad("Z1 0 0 24 -24 4")
        bad("Z2 0 0 24 24 4") // another version
        bad("Z1")
        bad("")
    }

    @Test
    fun everyOpAndDef() {
        val d = read(
            "Z1 0 0 24 24 9" +
                " LG 0 0 24 0 1 0 2 0 #FFFF0000 1 #800000FF" +
                " RG 12 12 10 2 1 1 0 0 1 2 -3 1 0.5 #FF00FF00" +
                " K KP 0 M0 0h24v24z; KP 1 M1 1 2 2 1 2z;" +
                " K KP 1 M0 0H1V1Z;" +
                " G 0.5 1" +
                " S @0 1 - 1 0 1 0 M0 0L1 1Z;" +
                " S c 0.5 #FF112233 0.25 1 0.75 2 1 2 4 2 1 0.5 -0.25 1 2 0 0 2 0 0 M0 0C1 2 3 4 5 6;" +
                " g" +
                " S - 1 @1 1 0 1 1.5 0 0 4 0 0 0 M3 3;",
        )
        assertEquals(9, d.aspect)

        // Gradients: linear then radial, numbered together in order.
        assertEquals(2, d.gradients.size)
        val lg = d.gradients[0]
        assertFalse(lg.radial)
        assertArrayEquals(floatArrayOf(0f, 0f, 24f, 0f), lg.coords, 0f)
        assertEquals(1, lg.spread)
        assertNull(lg.matrix)
        assertArrayEquals(floatArrayOf(0f, 1f), lg.offsets, 0f)
        assertArrayEquals(intArrayOf(0xFFFF0000.toInt(), 0x800000FF.toInt()), lg.colors)
        val rg = d.gradients[1]
        assertTrue(rg.radial)
        assertArrayEquals(floatArrayOf(12f, 12f, 10f), rg.coords, 0f)
        assertEquals(2, rg.spread)
        assertArrayEquals(floatArrayOf(1f, 0f, 0f, 1f, 2f, -3f), rg.matrix, 0f)
        assertArrayEquals(floatArrayOf(0.5f), rg.offsets, 0f)
        assertArrayEquals(intArrayOf(0xFF00FF00.toInt()), rg.colors)

        // Clips: the first has two paths with their own rules.
        assertEquals(2, d.clips.size)
        assertArrayEquals(intArrayOf(0, 1), d.clips[0].rules)
        assertEquals(2, d.clips[0].paths.size)
        assertEquals(
            listOf(PathNode.MoveTo(0f, 0f), PathNode.RelativeHorizontalTo(24f), PathNode.RelativeVerticalTo(24f), PathNode.Close),
            d.clips[0].paths[0].nodes,
        )
        // An implicit repeat after M is a line.
        assertEquals(
            listOf(PathNode.MoveTo(1f, 1f), PathNode.LineTo(2f, 2f), PathNode.LineTo(1f, 2f), PathNode.Close),
            d.clips[0].paths[1].nodes,
        )
        assertArrayEquals(intArrayOf(1), d.clips[1].rules)

        // Ops: G, S, S, g, S.
        assertEquals(5, d.ops.size)
        assertEquals(1, d.maxDepth)
        val g = d.ops[0] as SvgGroup
        assertEquals(0.5f, g.opacity)
        assertEquals(1, g.clip)
        assertEquals(3, g.end)
        assertSame(SvgGroupEnd, d.ops[3])

        val s1 = d.ops[1] as SvgShape
        assertEquals(SVG_PAINT_GRADIENT, s1.fillKind)
        assertEquals(0, s1.fill)
        assertEquals(1f, s1.fillAlpha)
        assertEquals(SVG_PAINT_NONE, s1.strokeKind)
        assertNull(s1.strokeSpec) // no stroke paint: no stroke spec in the data
        assertEquals(0, s1.rule)
        assertEquals(1f, s1.opacity)
        assertNull(s1.matrix)
        assertEquals(0, s1.index)

        val s2 = d.ops[2] as SvgShape
        assertEquals(SVG_PAINT_CURRENT, s2.fillKind)
        assertEquals(0.5f, s2.fillAlpha)
        assertEquals(SVG_PAINT_COLOR, s2.strokeKind)
        assertEquals(0xFF112233.toInt(), s2.stroke)
        assertEquals(0.25f, s2.strokeAlpha)
        assertEquals(1, s2.rule)
        assertEquals(0.75f, s2.opacity)
        val st = s2.strokeSpec!!
        assertEquals(2f, st.width)
        assertEquals(1, st.cap)
        assertEquals(2, st.join)
        assertEquals(4f, st.miter)
        assertArrayEquals(floatArrayOf(1f, 0.5f), st.dashes, 0f)
        assertEquals(-0.25f, st.dashOffset)
        assertArrayEquals(floatArrayOf(2f, 0f, 0f, 2f, 0f, 0f), s2.matrix, 0f)
        assertEquals(1, s2.index)
        assertEquals(listOf(PathNode.MoveTo(0f, 0f), PathNode.CurveTo(1f, 2f, 3f, 4f, 5f, 6f)), d.paths[1].nodes)

        val s3 = d.ops[4] as SvgShape
        assertEquals(SVG_PAINT_NONE, s3.fillKind)
        assertEquals(SVG_PAINT_GRADIENT, s3.strokeKind)
        assertEquals(1, s3.stroke)
        assertNull(s3.strokeSpec!!.dashes) // n = 0: solid
        assertEquals(1.5f, s3.strokeSpec.width)
        assertEquals(3, d.paths.size)
    }

    @Test
    fun minifiedPathData() {
        // "-" and a second "." start a new number; spaces and commas are allowed; every command letter is read.
        val d = read("Z1 0 0 24 24 4 S c 1 - 1 0 1 0 M9.5 15.1l8.4-8.4.5.5 a2 2 0 0 1 4 0Q1,2 3,4T5 6s1 2 3 4z;")
        assertEquals(
            listOf(
                PathNode.MoveTo(9.5f, 15.1f),
                PathNode.RelativeLineTo(8.4f, -8.4f),
                PathNode.RelativeLineTo(0.5f, 0.5f),
                PathNode.RelativeArcTo(2f, 2f, 0f, false, true, 4f, 0f),
                PathNode.QuadTo(1f, 2f, 3f, 4f),
                PathNode.ReflectiveQuadTo(5f, 6f),
                PathNode.RelativeReflectiveCurveTo(1f, 2f, 3f, 4f),
                PathNode.Close,
            ),
            d.paths[0].nodes,
        )
        // An empty path is allowed (draws nothing), also as the last token.
        assertEquals(0, read("Z1 0 0 24 24 4 S c 1 - 1 0 1 0 ;").paths[0].nodes.size)
        // The path ends at its ";": the next op follows.
        val two = read("Z1 0 0 24 24 4 G 1 -1 S #FF000000 1 - 1 0 1 0 M0 0h24v24z; g")
        assertEquals(3, two.ops.size) // G, S, g
    }

    @Test
    fun negativeAndDecimalNumbers() {
        val d = read("Z1 -0.0001 -12.5 24.125 24 4 S c 0.3333 - 1 0 -0 0 M0 0;")
        assertEquals(-0.0001f, d.vx, 1e-9f)
        assertEquals(-12.5f, d.vy)
        assertEquals(24.125f, d.vw)
        assertEquals(0.3333f, (d.ops[0] as SvgShape).fillAlpha, 1e-7f)
    }

    @Test
    fun partIndexesCountGroupsAndShapesInOrder() {
        val shape = "S c 1 - 1 0 1 0 M0 0;"
        val d = read("Z1 0 0 24 24 4 G 1 -1 $shape G 0.5 -1 $shape g G 1 -1 g g $shape")
        val parts = d.ops.filter { it !== SvgGroupEnd }.map { it.part }
        assertEquals(listOf(0, 1, 2, 3, 4, 5), parts)
        assertEquals(2, d.maxDepth)
        // Each G knows where its g is.
        assertEquals(7, (d.ops[0] as SvgGroup).end)
        assertEquals(4, (d.ops[2] as SvgGroup).end)
        assertEquals(6, (d.ops[5] as SvgGroup).end)
    }

    @Test
    fun gradientStopsFollowSvgRules() {
        // An offset below an earlier one takes the earlier one's value; offsets stay within 0–1.
        val g = read("Z1 0 0 24 24 4 LG 0 0 1 0 0 0 3 0.6 #FF000000 0.2 #FF000000 2 #FF000000").gradients[0]
        assertArrayEquals(floatArrayOf(0.6f, 0.6f, 1f), g.offsets, 0f)
        // Zero stops is valid (paints nothing); lower-case hex is read too.
        assertEquals(0, read("Z1 0 0 24 24 4 RG 1 1 1 0 0 0").gradients[0].colors.size)
        assertEquals(0x7f00ff00, read("Z1 0 0 24 24 4 LG 0 0 1 0 0 0 1 0 #7f00ff00").gradients[0].colors[0])
    }

    @Test
    fun allZeroDashesAreSolid() {
        val s = read("Z1 0 0 24 24 4 S - 1 c 1 0 1 1 0 0 4 2 0 0 0 0 M0 0;").ops[0] as SvgShape
        assertNull(s.strokeSpec!!.dashes)
    }

    @Test
    fun malformedDataFailsWithoutThrowing() {
        val ok = "S c 1 - 1 0 1 0 M0 0;"
        // truncated
        bad("Z1 0 0 24")
        bad("Z1 0 0 24 24 4 S c 1 - 1 0 1 0 M1") // path without its ";"
        bad("Z1 0 0 24 24 4 S c 1 - 1 0 1 0")
        bad("Z1 0 0 24 24 4 S c 1 - 1 0")
        bad("Z1 0 0 24 24 4 LG 0 0 1 0 0 0 2 0 #FF000000")
        bad("Z1 0 0 24 24 4 S c 1 c 1 0 1 1 0 0 4 2 1") // dash spec cut short
        bad("Z1 0 0 24 24 4 K KP 0 M0 0h1") // clip path without its ";"
        // unknown tokens
        bad("Z1 0 0 24 24 4 X")
        bad("Z1 0 0 24 24 4 $ok Q 1 2")
        bad("Z1 0 0 24 24 4 S x 1 - 1 0 1 0 M0 0;")
        bad("Z1 0 0 24 24 4 $ok LG 0 0 1 0 0 0 0") // a def after the ops
        bad("Z1 0 0 24 24 4 K") // a clip with no path
        bad("Z1 0 0 24 24 4 S c 1 - 1 0 1 0 M0 0X5;") // unknown path command
        bad("Z1 0 0 24 24 4 S c 1 - 1 0 1 0 M0 0;g") // no space after ";"
        // bad numbers
        bad("Z1 0 0 2a 24 4")
        bad("Z1 0 0 1.2.3 24 4")
        bad("Z1 0 0 .5 24 4")
        bad("Z1 0 0 1. 24 4")
        bad("Z1 0 0 --1 24 4")
        bad("Z1 0 0 - 24 4")
        bad("Z1 0 0 1e5 24 4")
        bad("Z1 0 0 24 24 4 S c 1 - 1 2 1 0 M0 0;") // rule 2
        bad("Z1 0 0 24 24 4 S c 1 - 1 0 1 2 M0 0;") // matrix flag 2
        bad("Z1 0 0 24 24 4 S #FF00000 1 - 1 0 1 0 M0 0;") // 7 hex digits
        bad("Z1 0 0 24 24 4 S #FF00000G 1 - 1 0 1 0 M0 0;")
        bad("Z1 0 0 24 24 4 LG 0 0 1 0 3 0 0") // spread 3
        bad("Z1 0 0 24 24 4 LG 0 0 1 0 0 0 99999999 0 #FF000000") // more stops than the data could hold
        // spaces
        bad("Z1 0 0 24  24 4")
        bad("Z1 0 0 24 24 4 ")
        bad("Z1 0 0 24 24 4 $ok ")
        // gradient and clip numbers out of range
        bad("Z1 0 0 24 24 4 S @0 1 - 1 0 1 0 M0 0;")
        bad("Z1 0 0 24 24 4 LG 0 0 1 0 0 0 0 S @1 1 - 1 0 1 0 M0 0;")
        bad("Z1 0 0 24 24 4 S @-1 1 - 1 0 1 0 M0 0;")
        bad("Z1 0 0 24 24 4 G 1 0 g")
        bad("Z1 0 0 24 24 4 G 1 -2 g")
        // unbalanced groups
        bad("Z1 0 0 24 24 4 G 1 -1 $ok")
        bad("Z1 0 0 24 24 4 $ok g")
        bad("Z1 0 0 24 24 4 G 1 -1 g g")
        // strokes
        bad("Z1 0 0 24 24 4 S - 1 c 1 0 1 1 0 0 4 3 1 1 1 0 0 M0 0;") // odd dash count
        bad("Z1 0 0 24 24 4 S - 1 c 1 0 1 1 0 0 4 2 1 -1 0 0 M0 0;") // negative dash
        bad("Z1 0 0 24 24 4 S - 1 c 1 0 1 -1 0 0 4 0 0 0 M0 0;") // negative width
        bad("Z1 0 0 24 24 4 S - 1 c 1 0 1 1 3 0 4 0 0 0 M0 0;") // cap 3
    }

    @Test
    fun readOrNullReportsOnce() {
        val errors = ArrayList<String>()
        assertNull(ZnSvgReader.readOrNull("Z1 0 0 24 24 4 X") { errors += it })
        assertEquals(1, errors.size)
        assertTrue(errors[0], errors[0].contains("unknown token"))
        assertNotNull(ZnSvgReader.readOrNull("Z1 0 0 24 24 4") { errors += it })
        assertEquals(1, errors.size)
    }

    /** [s] must fail with the reader's own error (not a crash inside it), and readOrNull must give null. */
    private fun bad(s: String) {
        try {
            read(s)
            fail("should fail: \"$s\"")
        } catch (e: ZnSvgFormatException) {
            // expected
        } catch (e: Throwable) {
            throw AssertionError("\"$s\" failed with ${e::class.simpleName}, not ZnSvgFormatException", e)
        }
        var reported = 0
        assertNull(ZnSvgReader.readOrNull(s) { reported++ })
        assertEquals(1, reported)
    }
}
