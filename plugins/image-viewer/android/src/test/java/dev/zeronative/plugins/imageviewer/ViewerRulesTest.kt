package dev.zeronative.plugins.imageviewer

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewerRulesTest {
    private val phone = Dims(1080f, 2400f)
    private val eps = 0.01f

    private fun near(expected: Float, actual: Float) = assertEquals(expected, actual, eps)

    @Test fun `a picture fits the screen and keeps its shape`() {
        ViewerRules.fitted(Dims(4000f, 3000f), phone).let { near(1080f, it.w); near(810f, it.h) }
        val tall = ViewerRules.fitted(Dims(4320f, 24000f), phone) // a long receipt: fits the height
        near(432f, tall.w)
        near(2400f, tall.h)
        assertEquals(phone, ViewerRules.fitted(Dims(0f, 0f), phone)) // not loaded yet: the screen
    }

    @Test fun `clamp keeps the zoom in range and the picture over the screen`() {
        val fitted = Dims(1080f, 810f)
        assertEquals(Camera(5f, 0f, 0f), ViewerRules.clamp(Camera(9f, 0f, 0f), fitted, phone))
        assertEquals(0.8f, ViewerRules.clamp(Camera(0.1f, 0f, 0f), fitted, phone).z)
        assertEquals(1f, ViewerRules.clamp(Camera(0.1f, 0f, 0f), fitted, phone, minZ = 1f).z)
        // At 2x: 2160 wide, so 540 each side can move; 1620 tall < 2400, so it stays in the middle.
        val c = ViewerRules.clamp(Camera(2f, 9999f, 500f), fitted, phone)
        assertEquals(Camera(2f, 540f, 0f), c)
        assertEquals(-540f, ViewerRules.clamp(Camera(2f, -9999f, 0f), fitted, phone).x)
    }

    @Test fun `zooming around a point keeps that point under the fingers`() {
        val focus = 800f to 600f
        val c0 = Camera(1.5f, 30f, -20f)
        val c1 = ViewerRules.zoomAround(c0, 2f, focus.first, focus.second, phone)
        // The picture point under the focus: (focus - middle - offset) / zoom. It must be the same before and after.
        fun under(c: Camera) = ((focus.first - phone.w / 2 - c.x) / c.z) to ((focus.second - phone.h / 2 - c.y) / c.z)
        near(under(c0).first, under(c1).first)
        near(under(c0).second, under(c1).second)
        near(3f, c1.z)
    }

    @Test fun `zoom stops at the limits, and the point still stays put`() {
        val c = ViewerRules.zoomAround(Camera(4f, 0f, 0f), 3f, 540f, 1200f, phone)
        assertEquals(5f, c.z)
        assertEquals(Camera(5f, 0f, 0f), c) // the middle: no move
        assertEquals(0.8f, ViewerRules.zoomAround(Camera(1f, 0f, 0f), 0.1f, 0f, 0f, phone).z)
    }

    @Test fun `double tap zooms to 2_5 at the tap and back to fit when zoomed`() {
        val fitted = Dims(1080f, 810f)
        val tap = ViewerRules.doubleTap(Camera.FIT, 740f, 1200f, fitted, phone)
        near(2.5f, tap.z)
        near(-300f, tap.x) // 200 px right of the middle, times (1 - 2.5)
        near(0f, tap.y) // 810 * 2.5 = 2025 < 2400 tall: stays in the middle
        // A narrow picture tapped near the edge: kept inside, no empty space at the side.
        val narrow = Dims(540f, 810f)
        val edge = ViewerRules.doubleTap(Camera.FIT, 1070f, 1200f, narrow, phone)
        near(-(540f * 2.5f - 1080f) / 2, edge.x)
        assertEquals(Camera.FIT, ViewerRules.doubleTap(Camera(1.2f, 10f, 0f), 0f, 0f, fitted, phone))
        // 1.04 counts as not zoomed (a pinch that barely moved): zoom in.
        near(2.5f, ViewerRules.doubleTap(Camera(1.04f, 0f, 0f), 540f, 1200f, fitted, phone).z)
    }

    @Test fun `letting go under 1 springs back to fit, over 1 stays inside the limits`() {
        val fitted = Dims(1080f, 810f)
        assertEquals(Camera.FIT, ViewerRules.settle(Camera(0.85f, 40f, 40f), fitted, phone))
        assertEquals(Camera(2f, 540f, 0f), ViewerRules.settle(Camera(2f, 600f, 50f), fitted, phone))
    }

    @Test fun `a swipe closes when long or quick in its own direction`() {
        val h = 2400f
        assertFalse(ViewerRules.closes(100f, 0f, h, 2625f))
        assertTrue(ViewerRules.closes(400f, 0f, h, 2625f)) // over 15%
        assertTrue(ViewerRules.closes(-400f, 0f, h, 2625f)) // up too
        assertTrue(ViewerRules.closes(80f, 3000f, h, 2625f)) // short but quick, downwards
        assertFalse(ViewerRules.closes(80f, -3000f, h, 2625f)) // thrown back up: stays
        assertFalse(ViewerRules.closes(0f, 3000f, h, 2625f))
        assertFalse(ViewerRules.closes(999f, 0f, 0f, 2625f)) // no size yet
    }

    @Test fun `the background fades while the picture is swiped`() {
        near(1f, ViewerRules.backgroundAlpha(0f, 2400f))
        near(0.65f, ViewerRules.backgroundAlpha(600f, 2400f))
        near(0.3f, ViewerRules.backgroundAlpha(-5000f, 2400f))
    }

    @Test fun `the visible area at fit is the whole picture`() {
        val original = Dims(4000f, 3000f)
        val fitted = ViewerRules.fitted(original, phone)
        val a = ViewerRules.visibleArea(Camera.FIT, fitted, phone, original)!!
        near(0f, a.screen.left)
        near(1080f, a.screen.right)
        near((2400f - 810f) / 2, a.screen.top)
        assertEquals(Rect4(0f, 0f, 4000f, 3000f).toString(), round(a.source).toString())
    }

    @Test fun `the visible area when zoomed is the part under the screen`() {
        val original = Dims(4000f, 3000f)
        val fitted = ViewerRules.fitted(original, phone)
        // 4x, moved fully left: the picture's right part shows. 4320 wide on screen, 1080 of it visible = a quarter.
        val c = ViewerRules.clamp(Camera(4f, -99999f, 0f), fitted, phone)
        val a = ViewerRules.visibleArea(c, fitted, phone, original)!!
        near(0f, a.screen.left)
        near(1080f, a.screen.right)
        near(3000f, a.source.left)
        near(4000f, a.source.right)
        // 3240 tall on screen, 2400 visible, in the middle.
        near(0f, a.screen.top)
        near(2400f, a.screen.bottom)
        near(1500f - 2400f / 3240f * 3000f / 2, a.source.top)
        assertNull(ViewerRules.visibleArea(Camera.FIT, Dims(0f, 0f), phone, original))
    }

    @Test fun `snapped grows the source to whole pixels, and the screen part with it`() {
        val a = Area(Rect4(0f, 0f, 1000f, 1000f), Rect4(10.5f, 20.25f, 110.5f, 120.25f)) // 10 screen px per source px
        val s = ViewerRules.snapped(a)
        assertEquals(Rect4(10f, 20f, 111f, 121f), s.source)
        near(-5f, s.screen.left)
        near(-2.5f, s.screen.top)
        near(1005f, s.screen.right)
        near(1007.5f, s.screen.bottom)
    }

    @Test fun `a sharp copy is needed only when Coil's copy is stretched and the original has more`() {
        val fitted = Dims(1080f, 810f)
        assertFalse(ViewerRules.needsSharp(Camera.FIT, fitted, 1080f, 4000f))
        assertTrue(ViewerRules.needsSharp(Camera(2f, 0f, 0f), fitted, 1080f, 4000f))
        assertFalse(ViewerRules.needsSharp(Camera(2f, 0f, 0f), fitted, 1080f, 1100f)) // a small original: nothing more to give
        assertFalse(ViewerRules.needsSharp(Camera(2f, 0f, 0f), fitted, 0f, 4000f))
    }

    @Test fun `sample size keeps a pixel per screen pixel, under the memory cap`() {
        val screen = Rect4(0f, 0f, 1080f, 2400f)
        assertEquals(1, ViewerRules.sampleSize(Rect4(0f, 0f, 1500f, 3333f), screen, 1e9f))
        assertEquals(2, ViewerRules.sampleSize(Rect4(0f, 0f, 2200f, 4900f), screen, 1e9f))
        assertEquals(4, ViewerRules.sampleSize(Rect4(0f, 0f, 4400f, 9800f), screen, 1e9f))
        // A huge part: the cap wins, a step softer.
        assertEquals(4, ViewerRules.sampleSize(Rect4(0f, 0f, 4000f, 9000f), screen, 2.5f * 1080 * 2400))
        assertEquals(1, ViewerRules.sampleSize(Rect4(0f, 0f, 0f, 0f), screen, 1e9f))
    }

    @Test fun `EXIF turns map back to the stored pixels`() {
        assertEquals(0, ViewerRules.degrees(1))
        assertEquals(0, ViewerRules.degrees(0))
        assertEquals(90, ViewerRules.degrees(6))
        assertEquals(180, ViewerRules.degrees(3))
        assertEquals(270, ViewerRules.degrees(8))
        assertNull(ViewerRules.degrees(2)) // mirror: no sharp copy
        assertNull(ViewerRules.degrees(5))
        assertEquals(Dims(3000f, 4000f), ViewerRules.upright(Dims(4000f, 3000f), 90))
        assertEquals(Dims(4000f, 3000f), ViewerRules.upright(Dims(4000f, 3000f), 180))
    }

    @Test fun `a turned rectangle covers the same stored pixels`() {
        // Stored 400 x 300 (raw), shown turned 90 clockwise as 300 x 400. Check each stored pixel's upright place.
        for (degrees in listOf(0, 90, 180, 270)) {
            val raw = Dims(400f, 300f)
            val up = ViewerRules.upright(raw, degrees)
            val r = Rect4(30f, 50f, 120f, 210f).let { if (it.right > up.w) Rect4(30f, 50f, up.w - 10, 210f) else it }
            val stored = ViewerRules.storedRect(r, up, degrees)
            // Every corner of the stored rectangle, turned upright, lands on a corner of r.
            val corners = listOf(stored.left to stored.top, stored.right to stored.top, stored.left to stored.bottom, stored.right to stored.bottom)
            val turned = corners.map { (x, y) -> turn(x, y, raw, degrees) }.toSet()
            val expected = setOf(r.left to r.top, r.right to r.top, r.left to r.bottom, r.right to r.bottom)
            assertEquals("degrees $degrees", expected, turned)
        }
    }

    /** A stored point turned [degrees] clockwise, as Android shows the picture. */
    private fun turn(x: Float, y: Float, raw: Dims, degrees: Int): Pair<Float, Float> = when (degrees) {
        90 -> (raw.h - y) to x
        180 -> (raw.w - x) to (raw.h - y)
        270 -> y to (raw.w - x)
        else -> x to y
    }

    @Test fun `links by kind, data in the params and other schemes refused`() {
        assertEquals(ViewerRules.Source.WEB, ViewerRules.kind("https://cdn.example.com/a.jpg"))
        assertEquals(ViewerRules.Source.WEB, ViewerRules.kind("HTTP://localhost/a.jpg"))
        assertEquals(ViewerRules.Source.ASSET, ViewerRules.kind("asset:img/a.png"))
        assertEquals(ViewerRules.Source.ASSET, ViewerRules.kind("asset://img/a.png"))
        assertEquals("img/a.png", ViewerRules.assetPath("asset://img/a.png"))
        assertEquals("img/a.png", ViewerRules.assetPath("asset:img/a.png"))
        assertEquals(ViewerRules.Source.FILE, ViewerRules.kind("zn://file/photo-1.jpg"))
        assertEquals(ViewerRules.Source.FILE_URI, ViewerRules.kind("file:///data/data/x/cache/a.jpg")) // checked later: insideRoots
        assertEquals(ViewerRules.Source.CONTENT, ViewerRules.kind("content://media/external/images/media/1"))
        assertEquals(ViewerRules.Source.HELD, ViewerRules.kind("held:data"))
        assertEquals(ViewerRules.Source.REFUSED, ViewerRules.kind("zn://app-icon/com.x"))
        // A data: link must come through ImageViewer.open (held natively), never in the saved params.
        assertEquals(ViewerRules.Source.REFUSED, ViewerRules.kind("data:image/png;base64,AAAA"))
        assertEquals(ViewerRules.Source.REFUSED, ViewerRules.kind("ftp://x/a.jpg"))
        assertEquals(ViewerRules.Source.REFUSED, ViewerRules.kind("/sdcard/a.jpg"))
    }

    @Test fun `data links - base64 pictures only, at most 5 MB decoded`() {
        assertEquals(22, ViewerRules.dataStart("data:image/png;base64,iVBORw0KGgo="))
        assertEquals(23, ViewerRules.dataStart("DATA:IMAGE/JPEG;BASE64,/9j/4AAQ"))
        assertNull(ViewerRules.dataStart("data:text/html;base64,PGgxPg=="))
        assertNull(ViewerRules.dataStart("data:image/svg+xml,<svg/>")) // not base64
        assertNull(ViewerRules.dataStart("data:image/png;base64,")) // empty
        assertNull(ViewerRules.dataStart("data:image/png;base64")) // no comma
        val limit = ViewerRules.MAX_DATA_BYTES / 3 * 4 // base64 characters for exactly 5 MB
        assertEquals(22, ViewerRules.dataStart("data:image/png;base64," + "A".repeat(limit)))
        assertNull(ViewerRules.dataStart("data:image/png;base64," + "A".repeat(limit + 8)))
    }

    @Test fun `file links - the path, decoded, and only on this phone`() {
        assertEquals("/data/user/0/app/cache/a b.jpg", ViewerRules.filePath("file:///data/user/0/app/cache/a%20b.jpg"))
        assertEquals("/data/x/a.jpg", ViewerRules.filePath("file://localhost/data/x/a.jpg"))
        assertNull(ViewerRules.filePath("file://evil.host/data/x/a.jpg"))
        assertNull(ViewerRules.filePath("file://"))
        assertNull(ViewerRules.filePath("file:///a b")) // a raw space is not a valid link
    }

    @Test fun `file links stay inside the app's folders, also with dot dot`() {
        val roots = listOf("/data/user/0/app/cache", "/data/user/0/app/files", "/storage/emulated/0/Android/data/app/files")
        assertTrue(ViewerRules.insideRoots("/data/user/0/app/cache/receipts/r1.jpg", roots))
        assertTrue(ViewerRules.insideRoots("/data/user/0/app/files", roots))
        assertTrue(ViewerRules.insideRoots("/storage/emulated/0/Android/data/app/files/p.png", roots))
        assertFalse(ViewerRules.insideRoots("/data/user/0/app/cache-other/x.jpg", roots)) // a name that only starts the same
        assertFalse(ViewerRules.insideRoots("/data/user/0/app/shared_prefs/secret.xml", roots))
        assertFalse(ViewerRules.insideRoots("/sdcard/DCIM/a.jpg", roots))
        assertFalse(ViewerRules.insideRoots("/data/user/0/app/cache/r.jpg", listOf("")))
        // The caller resolves ".." first (File.canonicalPath); after that, an escape is just another outside path.
        val tmp = java.io.File(System.getProperty("java.io.tmpdir")).canonicalFile
        val root = java.io.File(tmp, "zn-viewer-root").canonicalPath
        val escaped = java.io.File(tmp, "zn-viewer-root/../secret.jpg").canonicalPath
        val inside = java.io.File(tmp, "zn-viewer-root/a/../b.jpg").canonicalPath
        assertFalse(ViewerRules.insideRoots(escaped, listOf(root)))
        assertTrue(ViewerRules.insideRoots(inside, listOf(root)))
    }

    @Test fun `headers - no line breaks, no odd names`() {
        assertTrue(ViewerRules.safeHeader("Authorization", "Bearer abc.def"))
        assertTrue(ViewerRules.safeHeader("_zcc", "token"))
        assertFalse(ViewerRules.safeHeader("X-A", "a\r\nX-Injected: 1"))
        assertFalse(ViewerRules.safeHeader("Bad Name", "v"))
        assertFalse(ViewerRules.safeHeader("A:B", "v"))
        assertFalse(ViewerRules.safeHeader("", "v"))
        assertFalse(ViewerRules.safeHeader("Ünicode", "v"))
    }

    @Test fun `held parts reach the right picture, and a missing key gives none`() {
        val spec = ViewerSpec(JSONObject("""{"images":[{"uri":"https://a/1.jpg"},{"uri":"held:data"}],"held":"k-test-1"}"""))
        assertNull(spec.images[0].held) // nothing was held: after a kill, or a key never given
        assertNull(spec.images[1].held)
        assertNull(ViewerHeld.get(null, 0))
    }

    @Test fun `TalkBack label fills in n from 1 and the count`() {
        assertEquals("Photo 2 of 5", ViewerRules.label("Photo {n} of {count}", 1, 5))
        assertEquals("Photo 2 / 5", ViewerRules.label("Photo {n} / {count}", 1, 5))
    }

    @Test fun `params are read again without trusting them`() {
        val spec = ViewerSpec(
            JSONObject("""{"images":[{"uri":"https://a/1.jpg"},{"uri":""},"junk",{"uri":"asset:b.png","alt":"Shop"}],"index":7,"swipeToClose":false,"backgroundColor":"#112233","closeLabel":"Band"}"""),
        )
        assertEquals(listOf(ViewerImage("https://a/1.jpg", null), ViewerImage("asset:b.png", "Shop")), spec.images)
        assertEquals(1, spec.index) // kept inside the list
        assertFalse(spec.swipeToClose)
        assertTrue(spec.doubleTap)
        assertEquals(0xFF112233.toInt(), spec.background)
        assertEquals("Band", spec.close)
        assertEquals("Try again", spec.retry)
    }

    @Test fun `params with a bad colour give black, no list gives none, a negative index gives 0`() {
        val spec = ViewerSpec(JSONObject("""{"index":-4,"backgroundColor":"red"}"""))
        assertEquals(emptyList<ViewerImage>(), spec.images)
        assertEquals(0, spec.index)
        assertEquals(ViewerSpec.BLACK, spec.background)
        assertEquals(0x80000000.toInt(), ViewerSpec(JSONObject("""{"backgroundColor":"#80000000"}""")).background)
        assertEquals(ViewerSpec.BLACK, ViewerSpec(JSONObject("""{"backgroundColor":"#12345"}""")).background)
    }

    private fun round(r: Rect4) = Rect4(Math.round(r.left).toFloat(), Math.round(r.top).toFloat(), Math.round(r.right).toFloat(), Math.round(r.bottom).toFloat())
}
