package dev.zeronative.plugins.documentscanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DocScanRulesTest {
    private val ok = -1
    private val job = DocScanJob("a1", "order-1")

    @Test
    fun `a job comes back from disk as it went`() {
        val done = job.copy(resultCode = ok, pages = listOf("file:///c/p0.jpg", "file:///c/p1.jpg"), pdf = "file:///c/d.pdf", pdfPages = 2)
        assertEquals(done, DocScanJob.fromJson(done.toJson().toString()))
        assertEquals(job, DocScanJob.fromJson(job.toJson().toString()))
        val noTag = DocScanJob("b", null)
        assertEquals(noTag, DocScanJob.fromJson(noTag.toJson().toString()))
    }

    @Test
    fun `a broken record is no job, not a crash`() {
        assertNull(DocScanJob.fromJson("{"))
        assertNull(DocScanJob.fromJson("{\"tag\":\"x\"}")) // no id
    }

    @Test
    fun `the first answer wins and a second is dropped`() {
        val first = DocScanRules.withResult(job, ok, listOf("file:///c/p0.jpg"), null, 0)!!
        assertEquals(ok, first.resultCode)
        assertEquals("order-1", first.tag)
        assertNull(DocScanRules.withResult(first, 0, emptyList(), null, 0)) // a late "cancel" can't undo a scan
        assertNull(DocScanRules.withResult(null, ok, emptyList(), null, 0)) // no job of ours
    }

    @Test
    fun `collect answers only for its own id, and only once the answer is there`() {
        val done = DocScanRules.withResult(job, ok, listOf("file:///c/p0.jpg"), null, 0)!!
        assertEquals(DocScanRules.Collect.LOST, DocScanRules.collect(null, "a1", ok))
        assertEquals(DocScanRules.Collect.LOST, DocScanRules.collect(job, "a1", ok)) // still waiting
        assertEquals(DocScanRules.Collect.LOST, DocScanRules.collect(done, "other", ok))
        assertEquals(DocScanRules.Collect.FILES, DocScanRules.collect(done, "a1", ok))
        assertEquals(DocScanRules.Collect.CANCEL, DocScanRules.collect(job.copy(resultCode = 0), "a1", ok))
        assertEquals(DocScanRules.Collect.EMPTY, DocScanRules.collect(job.copy(resultCode = ok), "a1", ok))
        val pdfOnly = job.copy(resultCode = ok, pdf = "file:///c/d.pdf", pdfPages = 3)
        assertEquals(DocScanRules.Collect.FILES, DocScanRules.collect(pdfOnly, "a1", ok))
    }

    @Test
    fun `only the job's own id forgets it`() {
        assertTrue(DocScanRules.canForget(job, "a1"))
        assertFalse(DocScanRules.canForget(job, "old"))
        assertFalse(DocScanRules.canForget(null, "a1"))
    }

    @Test
    fun `options map to ML Kit's numbers, and wrong ones are refused`() {
        val d = DocScanRules.options(null, null, null, null)
        assertEquals(DocScanRules.Options(null, false, listOf(DocScanRules.FORMAT_JPEG), DocScanRules.MODE_FULL), d)
        val all = DocScanRules.options(5, true, listOf("pdf", "jpeg", "pdf"), "filter")
        assertEquals(DocScanRules.Options(5, true, listOf(DocScanRules.FORMAT_PDF, DocScanRules.FORMAT_JPEG), DocScanRules.MODE_BASE_WITH_FILTER), all)
        assertEquals(DocScanRules.MODE_BASE, DocScanRules.options(1, false, listOf("jpeg"), "base").mode)
        assertThrows(IllegalArgumentException::class.java) { DocScanRules.options(0, null, null, null) }
        assertThrows(IllegalArgumentException::class.java) { DocScanRules.options(101, null, null, null) }
        assertThrows(IllegalArgumentException::class.java) { DocScanRules.options(null, null, emptyList(), null) }
        assertThrows(IllegalArgumentException::class.java) { DocScanRules.options(null, null, listOf("png"), null) }
        assertThrows(IllegalArgumentException::class.java) { DocScanRules.options(null, null, null, "auto") }
        assertThrows(IllegalArgumentException::class.java) { DocScanRules.tag("x".repeat(201)) }
        assertEquals("order-1", DocScanRules.tag("order-1"))
    }

    @Test
    fun `file names can't name a path, and half files have dot names`() {
        assertEquals("docscanner-a1-0.jpg", DocScanRules.pageName("a1", 0))
        assertEquals("docscanner-a1.pdf", DocScanRules.pdfName("a1"))
        assertEquals(".docscanner-a1.pdf.part", DocScanRules.partName("docscanner-a1.pdf"))
        assertTrue(DocScanRules.usableLink("file"))
        assertTrue(DocScanRules.usableLink("content"))
        assertFalse(DocScanRules.usableLink("http"))
        assertFalse(DocScanRules.usableLink(null))
    }

    @Test
    fun `cleanup takes only our old files, never the open scan's or a kept one`() {
        val day = 24L * 3600 * 1000
        val now = 10 * day
        val files = listOf(
            "docscanner-old-0.jpg" to 0L,
            "docscanner-old.pdf" to 0L,
            ".docscanner-old-1.jpg.part" to 0L,
            "docscanner-open-0.jpg" to 0L,
            "docscanner-kept-0.jpg" to 0L,
            "docscanner-new-0.jpg" to now,
            "media-x-0.jpg" to 0L, // another plugin's
        )
        val gone = DocScanRules.toDelete(files, now, DocScanRules.KEEP_MS, setOf("docscanner-kept-0.jpg"), "open")
        assertEquals(listOf("docscanner-old-0.jpg", "docscanner-old.pdf", ".docscanner-old-1.jpg.part"), gone)
        val all = DocScanRules.toDelete(files, now, 0, emptySet(), null)
        assertEquals(6, all.size)
    }

    @Test
    fun `the status JS sees`() {
        // As a sorted map: org.json keeps no key order.
        fun s(a: String, d: Int?, e: Int = 0) = DocScanRules.status(a, d, e, 10, 100).let { o -> o.keys().asSequence().associateWith { o.get(it) }.toSortedMap().toString() }
        assertEquals("{status=available}", s("available", null))
        assertEquals("{status=available}", s("available", DocScanRules.STATE_FAILED)) // another app got it
        assertEquals("{status=not_downloaded}", s("not_downloaded", null))
        assertEquals("{reason=unknown_module, status=unavailable}", s("unavailable", null))
        assertEquals("{bytes=10, state=downloading, status=downloading, total=100}", s("not_downloaded", DocScanRules.STATE_DOWNLOADING))
        assertEquals("{bytes=10, state=paused, status=downloading, total=100}", s("not_downloaded", DocScanRules.STATE_DOWNLOAD_PAUSED))
        assertEquals("{reason=no_space, status=failed}", s("not_downloaded", DocScanRules.STATE_FAILED, 46003))
        assertEquals("{reason=canceled, status=failed}", s("not_downloaded", DocScanRules.STATE_CANCELED))
        assertEquals("{status=not_downloaded}", s("not_downloaded", DocScanRules.STATE_COMPLETED)) // Play not caught up yet
        assertEquals("available", DocScanRules.availability(DocScanRules.ALREADY_AVAILABLE))
        assertEquals("not_downloaded", DocScanRules.availability(DocScanRules.READY_TO_DOWNLOAD))
        assertEquals("unavailable", DocScanRules.availability(DocScanRules.UNKNOWN_MODULE))
    }

    @Test
    fun `Play services problems are reasons, and the right ones mean unavailable`() {
        assertNull(DocScanRules.playProblem(DocScanRules.PLAY_SUCCESS))
        assertEquals("no_play_services", DocScanRules.playProblem(DocScanRules.PLAY_MISSING))
        assertEquals("play_services_old", DocScanRules.playProblem(DocScanRules.PLAY_UPDATE_REQUIRED))
        assertEquals("play_services_disabled", DocScanRules.playProblem(DocScanRules.PLAY_DISABLED))
        assertEquals("play_services_updating", DocScanRules.playProblem(DocScanRules.PLAY_UPDATING))
        assertEquals("play_services_error", DocScanRules.playProblem(-1))
        assertEquals("not_downloaded", DocScanRules.scanRefusal(14, null))
        assertEquals("no_space", DocScanRules.scanRefusal(101, null))
        assertEquals("mlkit_13", DocScanRules.scanRefusal(13, null))
        assertEquals("network", DocScanRules.scanRefusal(null, 7))
        assertEquals("failed", DocScanRules.scanRefusal(null, null))
        assertTrue(DocScanRules.meansUnavailable("not_downloaded"))
        assertTrue(DocScanRules.meansUnavailable("play_services_old"))
        assertTrue(DocScanRules.meansUnavailable("no_play_services"))
        assertFalse(DocScanRules.meansUnavailable("timeout"))
        assertFalse(DocScanRules.meansUnavailable("busy"))
        assertTrue(DocScanRules.terminal(DocScanRules.STATE_COMPLETED))
        assertFalse(DocScanRules.terminal(DocScanRules.STATE_INSTALLING))
    }
}
