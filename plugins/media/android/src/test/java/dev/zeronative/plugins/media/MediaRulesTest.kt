package dev.zeronative.plugins.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaRulesTest {
    private fun plan(w: Int, h: Int, exif: Int = 0, rotate: Int = 0, crop: Crop? = null, maxSize: Int = 1000) =
        MediaRules.plan(w, h, exif, false, rotate, crop, maxSize)

    @Test
    fun `a big photo shrinks to fit and keeps its shape`() {
        val p = plan(4000, 3000)!!
        assertEquals(1000, p.width)
        assertEquals(750, p.height)
        assertEquals("read at the final size: no time spent on pixels we drop", 4, p.sample)
    }

    @Test
    fun `a small photo is never made bigger`() {
        val p = plan(300, 200)!!
        assertEquals(300, p.width)
        assertEquals(200, p.height)
        assertEquals(1, p.sample)
    }

    @Test
    fun `a sideways photo swaps its sides, and the app's rotate adds to the EXIF one`() {
        assertEquals(750 to 1000, plan(4000, 3000, exif = 90)!!.run { width to height })
        assertEquals(90, plan(4000, 3000, exif = 90)!!.turn)
        assertEquals(1000 to 750, plan(4000, 3000, exif = 90, rotate = 90)!!.run { width to height })
        assertEquals(180, plan(4000, 3000, exif = 90, rotate = 90)!!.turn)
        assertEquals(0, plan(4000, 3000, exif = 270, rotate = 90)!!.turn)
    }

    @Test
    fun `a crop counts on the turned picture`() {
        val p = plan(4000, 3000, exif = 90, crop = Crop(100, 200, 2900, 3800), maxSize = 5000)!!
        assertEquals(2900 to 3800, p.width to p.height)
        assertEquals(100 to 200, p.cropX to p.cropY)
    }

    @Test
    fun `a crop outside the picture is refused, not cut short`() {
        assertNull(plan(100, 100, crop = Crop(50, 0, 51, 10)))
        assertNull(plan(100, 100, crop = Crop(-1, 0, 10, 10)))
        assertNull(plan(100, 100, crop = Crop(0, 0, 0, 10)))
        assertNull("no overflow", plan(100, 100, crop = Crop(Int.MAX_VALUE, 0, Int.MAX_VALUE, 10)))
        assertNull("4000 is the short side once turned", plan(4000, 100, exif = 90, crop = Crop(0, 0, 4000, 100)))
        assertNotNull(plan(100, 100, crop = Crop(90, 90, 10, 10)))
    }

    @Test
    fun `a crop from a huge photo reads just enough`() {
        val p = plan(6000, 4000, crop = Crop(0, 0, 1000, 1000), maxSize = 1000)!!
        assertEquals("24 MP fits, and the crop needs every pixel", 1, p.sample)
        assertEquals(1000, p.width)
    }

    @Test
    fun `a huge picture can't run the phone out of memory`() {
        val p = plan(20000, 20000, maxSize = 100000)!!
        assertTrue(p.width.toLong() * p.height <= MediaRules.MAX_PIXELS * 1.001)
        assertTrue((20000L / p.sample) * (20000L / p.sample) <= MediaRules.MAX_PIXELS)
    }

    @Test
    fun `rotate must be a quarter turn, and maxSize and quality must make sense`() {
        assertEquals(270, MediaRules.rotate(-90))
        assertEquals(0, MediaRules.rotate(360))
        assertEquals(0, MediaRules.rotate(null))
        assertThrows(IllegalArgumentException::class.java) { MediaRules.rotate(45) }
        assertThrows(IllegalArgumentException::class.java) { MediaRules.maxSize(0) }
        assertThrows(IllegalArgumentException::class.java) { MediaRules.quality(101) }
        assertEquals(MediaRules.DEFAULT_QUALITY, MediaRules.quality(null))
    }

    @Test
    fun `only another app's content link is read`() {
        assertTrue(MediaRules.usableUri("content", "media", "own.zn.media"))
        assertFalse("a bad app could point us at our own private files", MediaRules.usableUri("file", null, "own.zn.media"))
        assertFalse(MediaRules.usableUri("content", "own.zn.media", "own.zn.media"))
        assertFalse(MediaRules.usableUri("content", null, "own.zn.media"))
        assertEquals(listOf("a", "b"), MediaRules.usableUris(listOf("a", "a", "b", "c"), 2))
    }

    @Test
    fun `names and types from another app are cleaned`() {
        assertEquals("a_b_c.pdf", MediaRules.displayName("a/b\\c.pdf", "x"))
        assertEquals("x", MediaRules.displayName("   ", "x"))
        assertEquals("x", MediaRules.displayName(null, "x"))
        assertEquals(120, MediaRules.displayName("n".repeat(500), "x").length)
        assertEquals("image/png", MediaRules.mimeOr("IMAGE/PNG", "d"))
        assertEquals("d", MediaRules.mimeOr("../../etc", "d"))
        assertEquals("*/*", MediaRules.mimeOr("*/*", "d"))
        assertEquals("image/*", MediaRules.mimeOr("image/*", "d"))
        assertEquals("d", MediaRules.mimeOr(null, "d"))
        assertEquals("pdf", MediaRules.extension("application/pdf", "ignored.bin"))
        assertEquals("docx", MediaRules.extension("application/whatever", "Report.DOCX"))
        assertEquals("bin", MediaRules.extension("application/whatever", "a.../x"))
        assertEquals("IMG.jpg", MediaRules.withExtension("IMG.heic", "jpg"))
        assertEquals("application/pdf", MediaRules.mimeOf("media-a-0.pdf"))
    }

    @Test
    fun `a half-done file has a name a handle can't take`() {
        assertTrue(MediaRules.partName("abc", 0, "part").startsWith("."))
        assertTrue(MediaRules.captureName("abc").startsWith("."))
        assertFalse(MediaRules.fileName("abc", 0, "jpg").startsWith("."))
    }

    private val hour = 3600_000L
    private val now = 1000 * hour
    private fun keepNothing(@Suppress("UNUSED_PARAMETER") name: String) = false

    @Test
    fun `cleanup takes old files and leaves other plugins alone`() {
        val files = listOf(Stored("media-a-0.jpg", 10, now - 200 * hour), Stored("media-b-0.jpg", 10, now), Stored("lab-1.png", 10, now - 900 * hour))
        assertEquals(listOf("media-a-0.jpg"), MediaRules.toDelete(files, now, MediaRules.KEEP_MS, Long.MAX_VALUE, ::keepNothing))
    }

    @Test
    fun `cleanup takes the oldest when the folder is too big, and what it must keep stays`() {
        val files = listOf(Stored("media-a-0.jpg", 60, now - 3), Stored("media-b-0.jpg", 60, now - 2), Stored("media-c-0.jpg", 60, now - 1))
        assertEquals(listOf("media-a-0.jpg", "media-b-0.jpg"), MediaRules.toDelete(files, now, 100 * hour, 100, ::keepNothing))
        assertEquals(listOf("media-b-0.jpg"), MediaRules.toDelete(files, now, 100 * hour, 100) { it == "media-a-0.jpg" })
    }

    @Test
    fun `half-done files go after an hour, unless their job is open`() {
        val part = Stored(MediaRules.partName("a", 0, "part"), 10, now - 2 * hour)
        val fresh = Stored(MediaRules.captureName("b"), 10, now - 60_000)
        assertEquals(listOf(part.name), MediaRules.toDelete(listOf(part, fresh), now, MediaRules.KEEP_MS, Long.MAX_VALUE, ::keepNothing))
        assertEquals(emptyList<String>(), MediaRules.toDelete(listOf(part), now, MediaRules.KEEP_MS, Long.MAX_VALUE) { "a" in it })
        assertEquals("olderThanMs 0 means all", 2, MediaRules.toDelete(listOf(part, fresh), now, 0, Long.MAX_VALUE, ::keepNothing).size)
    }

    @Test
    fun `the camera trap needs both things to be true`() {
        assertTrue(MediaRules.cameraPermissionMissing(declared = true, granted = false))
        assertFalse(MediaRules.cameraPermissionMissing(declared = false, granted = false))
        assertFalse(MediaRules.cameraPermissionMissing(declared = true, granted = true))
    }

    @Test
    fun `a job survives the trip to disk`() {
        val job = MediaJob("abc", MediaJob.CAMERA, 640, 70, 3, 1000, capture = ".media-abc-camera.jpg", resultCode = -1, uris = listOf("content://x/1", "content://x/2"))
        assertEquals(job, MediaJob.fromJson(job.toJson().toString()))
        val plain = MediaJob("abc", MediaJob.PHOTOS)
        assertEquals(plain, MediaJob.fromJson(plain.toJson().toString()))
        assertNull("no result yet", MediaJob.fromJson(plain.toJson().toString())!!.resultCode)
    }

    @Test
    fun `a job we can't read counts as none`() {
        assertNull(MediaJob.fromJson("{}"))
        assertNull(MediaJob.fromJson("not json"))
    }
}
