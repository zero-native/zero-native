package dev.zeronative.plugins.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScannerRulesTest {
    private var now = 1000L
    private fun gate() = ScanGate({ now }).apply { start() }

    /** Lets the stale window pass: a first frame, then a frame after it. */
    private fun ScanGate.warm(): Int {
        frame()
        now += ScannerRules.WARMUP_MS
        return frame()
    }

    @Test
    fun `frames are skipped for 500 ms from the first real frame`() {
        val g = gate()
        now += 3000 // the camera took long to open: that time doesn't count
        assertEquals(ScanGate.SKIP, g.frame())
        now += 499
        assertEquals(ScanGate.SKIP, g.frame())
        now += 1
        assertNotEquals(ScanGate.SKIP, g.frame())
    }

    @Test
    fun `a return to the screen starts the stale window again`() {
        val g = gate()
        assertNotEquals(ScanGate.SKIP, g.warm())
        g.stop()
        assertEquals(ScanGate.SKIP, g.frame())
        g.start()
        assertEquals(ScanGate.SKIP, g.frame())
        now += 499
        assertEquals(ScanGate.SKIP, g.frame())
        now += 1
        assertNotEquals(ScanGate.SKIP, g.frame())
    }

    @Test
    fun `the first code wins`() {
        val g = gate()
        val run = g.warm()
        assertTrue(g.claim(run))
        assertFalse(g.claim(run))
        assertTrue(g.droppedOne())
        assertFalse(g.droppedOne())
        assertEquals("a locked gate reads no more frames", ScanGate.SKIP, g.frame())
    }

    @Test
    fun `a read that began before a stop can't win`() {
        val g = gate()
        val run = g.warm()
        g.stop()
        assertFalse(g.claim(run))
        g.start()
        assertFalse("still the old run", g.claim(run))
    }

    @Test
    fun `the lock stays through the background until the app asks to scan again`() {
        val g = gate()
        assertTrue(g.claim(g.warm()))
        g.stop()
        g.start()
        assertEquals(ScanGate.SKIP, g.warm())
        g.release()
        g.start()
        val run = g.warm()
        assertNotEquals(ScanGate.SKIP, run)
        assertTrue(g.claim(run))
    }

    @Test
    fun `the torch never comes back by surprise`() {
        var held = false
        assertTrue(TorchRule.isOn(true, held))
        held = TorchRule.heldAfterLeaving(true, held)
        assertFalse("the prop still says on", TorchRule.isOn(true, held))
        held = TorchRule.heldAfterProp(true, held)
        assertFalse("nothing changed", TorchRule.isOn(true, held))
        held = TorchRule.heldAfterProp(false, held)
        assertFalse(TorchRule.isOn(false, held))
        held = TorchRule.heldAfterProp(true, held)
        assertTrue("JS turned it on again", TorchRule.isOn(true, held))
    }

    @Test
    fun `a torch that was off stays free`() {
        assertFalse(TorchRule.heldAfterLeaving(false, false))
    }

    @Test
    fun `permission states`() {
        val state = ScannerRules::permission
        assertEquals(ScannerRules.Permission.GRANTED, state(true, false, true, false))
        assertEquals(ScannerRules.Permission.ASK, state(false, false, false, false))
        assertEquals(ScannerRules.Permission.ASKING, state(false, true, false, false))
        assertEquals(ScannerRules.Permission.DENIED, state(false, false, true, true))
        assertEquals(ScannerRules.Permission.BLOCKED, state(false, false, true, false))
        assertEquals("blocked", ScannerRules.Permission.BLOCKED.jsName)
    }

    @Test
    fun `formats default to QR and unknown names are dropped`() {
        assertEquals(listOf(256), ScannerRules.formatCodes(emptyList()))
        assertEquals(listOf(256), ScannerRules.formatCodes(listOf("nonsense")))
        assertEquals(listOf(32, 1), ScannerRules.formatCodes(listOf("ean13", "code128", "ean13")))
        assertEquals("qr", ScannerRules.formatName(256))
        assertEquals("unknown", ScannerRules.formatName(0))
    }

    @Test
    fun `only web links open from a bundle`() {
        assertEquals("https://a.example/x", ScannerRules.safeLink("https://a.example/x"))
        assertNull(ScannerRules.safeLink("intent://pay#Intent;end"))
        assertNull(ScannerRules.safeLink(""))
        assertNull(ScannerRules.safeLink(null))
    }
}
