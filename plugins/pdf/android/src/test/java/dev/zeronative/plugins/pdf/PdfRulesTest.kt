package dev.zeronative.plugins.pdf

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PdfRulesTest {
    private val a4 = PageSize(595f, 842f)
    private val mb = 1024L * 1024

    @Test
    fun `a file name is a plain handle name, the same for the same url and key, and only ours start with pdf-`() {
        val name = PdfRules.fileName("https://r.example/a.pdf", "k1")
        assertTrue(name, Regex("pdf-[0-9a-f]{32}\\.pdf").matches(name))
        assertEquals(name, PdfRules.fileName("https://r.example/a.pdf", "k1"))
        assertNotEquals(name, PdfRules.fileName("https://r.example/a.pdf", "k2"))
        assertNotEquals("a key changes the file", PdfRules.fileName("https://r.example/a.pdf", "x"), PdfRules.fileName("https://r.example/a.pdf", null))
        assertEquals(PdfRules.fileName("https://r.example/a.pdf", ""), PdfRules.fileName("https://r.example/a.pdf", null))
        assertTrue(PdfRules.partName(name).startsWith("."))
        assertTrue(PdfRules.ours(name))
        assertTrue(PdfRules.ours(PdfRules.partName(name)))
        assertFalse("media's files are not ours", PdfRules.ours("media-a-0.pdf"))
    }

    @Test
    fun `https only, http to this computer only in debug builds`() {
        assertTrue(PdfRules.urlAllowed("https://r.example/a.pdf?t=1", debug = false))
        assertFalse(PdfRules.urlAllowed("http://r.example/a.pdf", debug = true))
        assertFalse(PdfRules.urlAllowed("http://localhost:8792/a.pdf", debug = false))
        assertTrue(PdfRules.urlAllowed("http://localhost:8792/a.pdf", debug = true))
        assertTrue(PdfRules.urlAllowed("http://127.0.0.1:8792/a.pdf", debug = true))
        for (bad in listOf("file:///sdcard/a.pdf", "content://x/a", "ftp://r.example/a.pdf", "https:///a.pdf", "not a url", "https://u:p@r.example/a.pdf")) {
            assertFalse(bad, PdfRules.urlAllowed(bad, debug = true))
        }
    }

    @Test
    fun `headers only follow a redirect to the same origin`() {
        assertTrue(PdfRules.sameOrigin("https://r.example/a", "https://R.example:443/b"))
        assertFalse(PdfRules.sameOrigin("https://r.example/a", "https://cdn.example/b"))
        assertFalse(PdfRules.sameOrigin("https://r.example/a", "https://r.example:8443/b"))
        assertFalse(PdfRules.sameOrigin("http://localhost:1/a", "http://localhost:2/b"))
    }

    @Test
    fun `a pdf has the PDF mark in its first 1024 bytes, an html page does not`() {
        val pdf = "%PDF-1.4\n".toByteArray()
        assertTrue(PdfRules.looksLikePdf(pdf, pdf.size))
        val junk = ByteArray(1024) { ' '.code.toByte() }.also { "%PDF-".toByteArray().copyInto(it, 1000) }
        assertTrue(PdfRules.looksLikePdf(junk, junk.size))
        val html = "<!doctype html><title>404</title>".toByteArray()
        assertFalse(PdfRules.looksLikePdf(html, html.size))
        assertFalse(PdfRules.looksLikePdf(ByteArray(3), 3))
        assertFalse("past 1024 bytes doesn't count", PdfRules.looksLikePdf(ByteArray(2000).also { "%PDF-".toByteArray().copyInto(it, 1500) }, 2000))
    }

    @Test
    fun `the budget is an eighth of the heap, 16 to 48 MB, 16 on low-RAM phones`() {
        assertEquals(32 * mb, PdfRules.budget(256, lowRam = false))
        assertEquals(16 * mb, PdfRules.budget(96, lowRam = false))
        assertEquals(48 * mb, PdfRules.budget(512, lowRam = false))
        assertEquals(16 * mb, PdfRules.budget(512, lowRam = true))
    }

    @Test
    fun `an A4 page is drawn as wide as the view while three fit the budget`() {
        val budget = 32 * mb * 2 / 3
        assertEquals(1080, PdfRules.baseWidth(1080, a4, budget))
        val w = PdfRules.baseWidth(1080, a4, 16 * mb * 2 / 3)
        val bytes = 4L * w * (w * a4.aspect).toLong()
        assertTrue("$w px: $bytes bytes", w < 1080 && bytes * 3 <= 16 * mb * 2 / 3)
    }

    @Test
    fun `a long receipt page is drawn narrower, and never with a side over 2048`() {
        val roll = PageSize(226f, 2000f) // 80 mm wide, 70 cm long
        val w = PdfRules.baseWidth(1080, roll, 32 * mb * 2 / 3)
        assertTrue("$w", w * roll.aspect <= PdfRules.MAX_SIDE + 1)
        assertTrue(PdfRules.baseWidth(4000, a4, 1024 * mb) <= PdfRules.MAX_SIDE)
    }

    @Test
    fun `the sharp layer is view-sized while it fits, else smaller`() {
        assertEquals(1f, PdfRules.areaScale(1080, 1800, 32 * mb / 3), 0f)
        val s = PdfRules.areaScale(1080, 1800, 4 * mb)
        assertTrue("$s", s < 1f && 4L * (1080 * s).toLong() * (1800 * s).toLong() <= 4 * mb)
        assertTrue(PdfRules.areaScale(3000, 1000, 1024 * mb) * 3000 <= PdfRules.MAX_SIDE + 0.5f)
    }

    @Test
    fun `preview width fit starts at the top, contain sits in the middle`() {
        val w = PdfRules.previewPlace(0, a4, 1000, 300, contain = false)
        assertEquals(0f, w.y, 0f)
        assertEquals(1000f / 595f, w.scale, 1e-4f)
        val c = PdfRules.previewPlace(0, a4, 1000, 300, contain = true)
        assertEquals(300f / 842f, c.scale, 1e-4f)
        assertEquals((1000 - 595 * c.scale) / 2, c.x, 1e-3f)
        assertEquals(0f, c.y, 1e-3f)
    }

    @Test
    fun `cleanup takes only our old files, and never what is kept`() {
        val now = 10_000_000_000L
        val old = now - PdfRules.KEEP_MS
        val files = listOf(Stored("pdf-a.pdf", old), Stored(".pdf-b.pdf.part", old), Stored("pdf-c.pdf", now - 1000), Stored("media-x.jpg", old), Stored("pdf-d.pdf", old))
        assertEquals(listOf("pdf-a.pdf", ".pdf-b.pdf.part"), PdfRules.toDelete(files, now, PdfRules.KEEP_MS) { it == "pdf-d.pdf" })
        assertEquals(listOf("pdf-a.pdf", ".pdf-b.pdf.part", "pdf-c.pdf", "pdf-d.pdf"), PdfRules.toDelete(files, now, 0) { false })
    }

    @Test
    fun `eviction drops the farthest pages first and never one that shows`() {
        val bytes = (0..9).associateWith { 10L }
        assertEquals(listOf(9, 0, 8, 1), PdfRules.evict(bytes, 3..5, 4, 60))
        assertEquals(emptyList<Int>(), PdfRules.evict(bytes, 0..9, 4, 10))
        assertEquals(emptyList<Int>(), PdfRules.evict(bytes, 3..5, 4, 1000))
    }

    @Test
    fun `max zoom is 1 to 10, default 5`() {
        assertEquals(5f, PdfRules.maxZoom(null), 0f)
        assertEquals(1f, PdfRules.maxZoom(0.2), 0f)
        assertEquals(10f, PdfRules.maxZoom(99.0), 0f)
        assertEquals(5f, PdfRules.maxZoom(Double.NaN), 0f)
    }

    @Test
    fun `layout puts pages one under the other with the gap between, not around`() {
        val l = PdfLayout(listOf(a4, a4, PageSize(595f, 421f)), 595f, 10f)
        assertEquals(listOf(0f, 852f, 1704f), l.tops.toList())
        assertEquals(1704f + 421f, l.height, 0f)
        assertEquals(0f, PdfLayout(emptyList(), 100f, 10f).height, 0f)
    }

    @Test
    fun `visible and current pages follow the scroll and the zoom`() {
        val l = PdfLayout(List(10) { a4 }, 595f, 10f) // each 842 tall, 852 apart
        assertEquals(0..1, l.visible(1f, 0f, 1000f))
        assertEquals(1..1, l.visible(1f, 900f, 800f))
        assertEquals(1..2, l.visible(1f, 900f, 900f))
        assertEquals(0..0, l.visible(2f, 0f, 1000f))
        assertEquals(0, l.current(1f, 0f, 1000f))
        assertEquals(4, l.current(1f, 4 * 852f, 600f))
        assertEquals("at the end, the last page", 9, l.current(1f, l.height - 1000f, 1000f))
    }

    @Test
    fun `the camera can't leave the document, and a short one stays at the top`() {
        val l = PdfLayout(List(3) { a4 }, 1000f, 0f)
        val c = PdfRules.clamp(Camera(1f, -50f, -50f), l, 1000f, 1000f, 5f)
        assertEquals(Camera(1f, 0f, 0f), c)
        val far = PdfRules.clamp(Camera(2f, 99999f, 99999f), l, 1000f, 1000f, 5f)
        assertEquals(1000f, far.x, 0.01f)
        assertEquals(l.height * 2 - 1000f, far.y, 0.01f)
        val short = PdfLayout(listOf(PageSize(1000f, 100f)), 1000f, 0f)
        assertEquals(0f, PdfRules.clamp(Camera(1f, 0f, 300f), short, 1000f, 1000f, 5f).y, 0f)
        assertEquals(5f, PdfRules.clamp(Camera(9f, 0f, 0f), l, 1000f, 1000f, 5f).z, 0f)
    }

    @Test
    fun `zoom keeps the point under the fingers still`() {
        val before = Camera(1f, 100f, 200f)
        val after = PdfRules.zoomAround(before, 2f, 300f, 400f, 5f)
        assertEquals(2f, after.z, 0f)
        // The document point under the fingers: (x + fx) / z, the same before and after.
        assertEquals((100f + 300f) / 1f, (after.x + 300f) / 2f, 1e-3f)
        assertEquals((200f + 400f) / 1f, (after.y + 400f) / 2f, 1e-3f)
        assertEquals(5f, PdfRules.zoomAround(before, 100f, 0f, 0f, 5f).z, 0f)
        assertEquals(1f, PdfRules.zoomAround(before, 0.01f, 0f, 0f, 5f).z, 0f)
    }

    @Test
    fun `the sharp layer places each visible page at the camera`() {
        val l = PdfLayout(List(3) { a4 }, 1190f, 20f)
        val places = PdfRules.areaPlaces(l, Camera(2f, 100f, 3000f), 1000f, 0.5f)
        assertEquals("the end of page 1 and the start of page 2", listOf(0, 1), places.map { it.index })
        val p = places[1]
        assertEquals(-50f, p.x, 1e-3f)
        assertEquals((l.tops[1] * 2 - 3000f) * 0.5f, p.y, 1e-3f)
        assertEquals(1190f * 2 / 595f * 0.5f, p.scale, 1e-4f)
    }
}
