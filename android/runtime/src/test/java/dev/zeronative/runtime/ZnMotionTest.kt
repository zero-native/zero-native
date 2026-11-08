package dev.zeronative.runtime

import androidx.compose.ui.unit.Density
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Motion values (ZnMotion.kt), formulas (ZnFormula.kt) and gesture releases (ZnGesture.kt): the maths. */
class ZnMotionTest {
    private fun consts(vararg v: Float) = Array<ZnFormula.Input>(v.size) { ZnFormula.Input.Const(v[it]) }

    private fun formula(code: String, inputs: Array<ZnFormula.Input> = emptyArray(), tables: String? = null) =
        ZnFormula.compile(JSONArray(code), inputs, tables?.let { JSONArray(it) })

    @Test
    fun formulasRunLikeJs() {
        // Math.abs(x) / 120 + 2 * k with x = -240, k = 3
        assertEquals(8f, formula("""["${'$'}0","abs",120,"/",2,"${'$'}1","*","+"]""", consts(-240f, 3f)).eval(null), 0f)
        // (a > 10 && !b) ? a : -a
        val f = """["${'$'}0",10,">","${'$'}1","!","&&","${'$'}0","${'$'}0","neg","?"]"""
        assertEquals(20f, formula(f, consts(20f, 0f)).eval(null), 0f)
        assertEquals(-20f, formula(f, consts(20f, 1f)).eval(null), 0f)
        assertEquals(-5f, formula(f, consts(5f, 0f)).eval(null), 0f)
        // Math.atan2(y, x): JS's order
        assertEquals((Math.PI / 2).toFloat(), formula("""["${'$'}0","${'$'}1","atan2"]""", consts(1f, 0f)).eval(null), 1e-6f)
        // clamp(x, lo, hi), hypot, min / max chains
        assertEquals(5f, formula("""[9,0,5,"clamp"]""").eval(null), 0f)
        assertEquals(5f, formula("""[3,4,"hypot"]""").eval(null), 0f)
        assertEquals(1f, formula("""[3,1,"min",2,"min"]""").eval(null), 0f)
        // JS Math.round: halves go up, also below 0
        assertEquals(-2f, formula("""[-2.5,"round"]""").eval(null), 0f)
        assertEquals(3f, formula("""[2.5,"round"]""").eval(null), 0f)
    }

    @Test
    fun divisionByZeroIsZeroAndSourcesKeepTheLastGoodValue() {
        assertEquals(0f, formula("""[5,0,"/"]""").eval(null), 0f)
        assertEquals(0f, formula("""[5,0,"%"]""").eval(null), 0f)
        // sqrt(-1) is NaN: the source gives its last good value (0 at first), never NaN (plan rule 5).
        val src = ZnFormulaSource(900, formula("""[-1,"sqrt"]"""))
        assertEquals(0f, src.read(null), 0f)
    }

    @Test
    fun selfAndParentSizesComeFromTheSite() {
        val site = ZnSite().apply { update(100f, 50f, 400f, 800f) }
        // parent.width - self.width: the room to travel
        val f = formula("""["pw","sw","-"]""")
        assertTrue(f.usesSite)
        assertEquals(300f, f.eval(site), 0f)
        assertEquals(0f, f.eval(null), 0f)
    }

    @Test
    fun tablesInterpolateAndMixColours() {
        val f = formula("""["${'$'}0","L0"]""", consts(50f), """[[[0,100],[0,1],0,0]]""")
        assertEquals(0.5f, f.eval(null), 0f)
        val white = 0xFFFFFFFF.toInt()
        val black = 0xFF000000.toInt()
        val c = formula("""["${'$'}0","C0"]""", consts(0.5f), """[[[0,1],[$white,$black],0,1]]""")
        assertTrue(c.isColor)
        assertEquals(0xFF7F7F7F.toInt(), c.evalColor(null))
    }

    @Test
    fun theVerifierRefusesBadFormulas() {
        fun refuses(code: String, why: String, inputs: Array<ZnFormula.Input> = emptyArray(), tables: String? = null) {
            val e = assertThrows(ZnInvalidArgs::class.java) { formula(code, inputs, tables) }
            assertTrue("${e.message} should mention $why", e.message!!.contains(why))
        }
        refuses("""[1,"+"]""", "needs 2 values")
        refuses("""[1,2]""", "leaves 2 values")
        refuses("""["${'$'}3"]""", "input 3 doesn't exist", consts(1f))
        refuses("""[1,"eval"]""", "can't use \"eval\"")
        refuses(JSONArray(List(65) { 1 }).toString(), "at most 64")
        refuses(JSONArray(List(17) { 1 }).toString(), "more than 16")
        refuses("""[1,"C0",1,"+"]""", "last step", tables = """[[[0,1],[0,1],0,1]]""")
        refuses("""[1,"L0"]""", "inputs must go up", tables = """[[[1,0],[0,1],0,0]]""")
    }

    @Test
    fun interpolateExtrapolates() {
        val ins = floatArrayOf(0f, 100f)
        val outs = floatArrayOf(0f, 1f)
        assertEquals(1f, znInterpolate(150f, ins, outs, 0), 0f)
        assertEquals(1.5f, znInterpolate(150f, ins, outs, 1), 1e-6f)
        assertEquals(150f, znInterpolate(150f, ins, outs, 2), 0f)
        assertEquals(5f, znInterpolate(75f, floatArrayOf(0f, 50f, 100f), floatArrayOf(0f, 10f, 0f), 0), 0f)
    }

    @Test
    fun rubberBandGrowsSlowerThanTheFinger() {
        val a = ZnGesture.rubber(50f, 200f)
        val b = ZnGesture.rubber(500f, 200f)
        assertTrue(a in 0f..50f)
        assertTrue(b < 200f && b > a)
    }

    @Test
    fun decelerationMatchesReanimated() {
        // withDecay's 0.998 per ms: after 1 s the speed is 0.998^1000 of the start.
        val f = znFriction(0.998)
        val kept = kotlin.math.exp(-4.2 * f)
        assertEquals(Math.pow(0.998, 1000.0), kept, 1e-6)
    }

    private fun pan(o: String): ZnGesture = ZnGesture.make(800, JSONObject(o)).also { it.site.update(80f, 60f, 400f, 800f) }

    @Test
    fun oneAxisReleasePicksTheAnchorByFlickOrDistance() {
        val g = pan("""{"kind":"pan","axis":"x","values":{"x":801,"y":802},
            "anchors":[{"id":"start","x":0},{"id":"paid","x":"100%"}],"release":{"threshold":{"velocity":400,"distance":40}}}""")
        val d = Density(2f)
        // A fast flick right from near the start: the next anchor its way (100% = 400 - 80 = 320).
        val flick = g.chooseTarget(30f, 0f, 900f, 0f, 0f, 0f, d)!!
        assertEquals("paid", flick.id)
        assertEquals(320f, flick.x!!, 0f)
        // Slow, past half: the nearest.
        assertEquals("paid", g.chooseTarget(200f, 0f, 50f, 0f, 0f, 0f, d)!!.id)
        // Slow, moved less than threshold.distance: back to where it started.
        assertEquals("start", g.chooseTarget(30f, 0f, 0f, 0f, 0f, 0f, d)!!.id)
        // A flick left from the end goes back to the start.
        assertEquals("start", g.chooseTarget(300f, 0f, -900f, 0f, 320f, 0f, d)!!.id)
    }

    @Test
    fun twoAxisReleasePicksTheNearestCornerAndMagnetsWin() {
        val g = pan("""{"kind":"pan","axis":"xy","values":{"x":811,"y":812},
            "anchors":[{"id":"tl","x":0,"y":0},{"id":"br","x":"100%","y":"100%"}],
            "magnets":[{"id":"bin","x":200,"y":700,"radius":60}]}""")
        val d = Density(2f)
        assertEquals("tl", g.chooseTarget(40f, 60f, 0f, 0f, 0f, 0f, d)!!.id)
        val br = g.chooseTarget(300f, 600f, 0f, 0f, 0f, 0f, d)!!
        assertEquals("br", br.id)
        assertEquals(740f, br.y!!, 0f) // 800 - 60
        assertEquals("bin", g.chooseTarget(210f, 690f, 0f, 0f, 0f, 0f, d)!!.id)
    }

    @Test
    fun noAnchorsMeansNoTarget() {
        val g = pan("""{"kind":"pan","axis":"xy","values":{"x":821,"y":822}}""")
        assertNull(g.chooseTarget(10f, 10f, 0f, 0f, 0f, 0f, Density(2f)))
    }

    @Test
    fun progressFollowsTheBoundsOfItsAxis() {
        val g = pan("""{"kind":"pan","axis":"x","values":{"x":831,"y":832,"progress":833},"bounds":{"x":[0,"100%"]}}""")
        g.x!!.value = 160f
        assertEquals(0.5f, ZnMotion.find(833)!!.read(null), 1e-6f)
    }

    @Test
    fun specsResolveAgainstTheSite() {
        val s = ZnSpec.parse("50%")!!
        assertEquals(160f, s.resolve(80f, 400f, null), 0f)
        assertEquals(40f, ZnSpec.parse("50%self")!!.resolve(80f, 400f, null), 0f)
        assertEquals(200f, ZnSpec.parse("50%parent")!!.resolve(80f, 400f, null), 0f)
        assertThrows(ZnInvalidArgs::class.java) { ZnSpec.parse("50px") }
    }

    @Test
    fun numberFormatGroupsTheIndianWayByDefault() {
        val f = ZnNumberFormat.parse("""{"p":"₹"}""")
        assertEquals("₹0", f.format(0f))
        assertEquals("₹999", f.format(999f))
        assertEquals("₹1,000", f.format(1000f))
        assertEquals("₹12,34,567", f.format(1234567f))
        assertEquals("₹3", f.format(2.5f)) // half away from zero, not to even
        assertEquals("-₹3", f.format(-2.5f)) // the minus before the prefix
        assertEquals("₹0", f.format(-0.4f)) // no "-₹0"
        assertEquals("₹0", f.format(Float.NaN))
    }

    @Test
    fun numberFormatDecimalsGroupingAndSuffix() {
        assertEquals("1,234,567.50", ZnNumberFormat.parse("""{"d":2,"g":"standard"}""").format(1234567.5f))
        assertEquals("1234.5 km", ZnNumberFormat.parse("""{"d":1,"g":"none","s":" km"}""").format(1234.46f))
        assertEquals("0.05", ZnNumberFormat.parse("""{"d":2}""").format(0.05f))
        assertEquals("7", ZnNumberFormat.parse("not json").format(7.2f))
    }
}
