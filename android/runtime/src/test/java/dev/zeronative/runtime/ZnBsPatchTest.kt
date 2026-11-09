package dev.zeronative.runtime

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.random.Random
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Applying ZNBSDIFF1 patches (ZnBsPatch): the phone makes the same file as tools/ota/bsdiff.ts from a patch the TS
 * code made (fixtures from tools/ota/make-patch-fixture.ts), and refuses every cut or changed patch with a ZnOtaError.
 */
class ZnBsPatchTest {
    private fun res(name: String): ByteArray = javaClass.classLoader!!.getResourceAsStream("ota-patch/$name")!!.use { it.readBytes() }
    private val fixture = JSONObject(String(res("fixture.json")))
    private val old = res("old.hbc")
    private val new = res("new.hbc")
    private val patch = res("main.patch")

    private fun sha(b: ByteArray) = ZnOtaInstall.hex(MessageDigest.getInstance("SHA-256").digest(b))

    /** A patch made by hand: header, then the (add, copy, seek) triples, then diff and extra bytes. */
    private fun patchOf(newSize: Long, controls: List<LongArray>, diff: ByteArray = ByteArray(0), extra: ByteArray = ByteArray(0), count: Long = controls.size.toLong()): ByteArray {
        val b = ByteBuffer.allocate(24 + controls.size * 24 + diff.size + extra.size).order(ByteOrder.LITTLE_ENDIAN)
        b.put("ZNBSDIF1".toByteArray()).putLong(newSize).putLong(count)
        for (c in controls) c.forEach { b.putLong(it) }
        b.put(diff).put(extra)
        return b.array()
    }

    private fun refused(old: ByteArray, patch: ByteArray, size: Long, part: String) {
        try {
            ZnBsPatch.apply(old, patch, size)
            fail("should refuse ($part)")
        } catch (e: ZnOtaError) {
            assertEquals("patch", e.code)
            assertTrue("\"${e.message}\" should mention \"$part\"", e.message!!.contains(part))
        }
    }

    @Test
    fun theFixtureIsWhatTheScriptSays() {
        assertEquals(fixture.getJSONObject("old").getString("sha256"), sha(old))
        assertEquals(fixture.getJSONObject("new").getString("sha256"), sha(new))
        assertEquals(fixture.getJSONObject("patch").getInt("size"), patch.size)
        assertTrue("the fixture should have seeks", fixture.getJSONObject("patch").getInt("controls") >= 3)
    }

    @Test
    fun aPatchMadeByTheTsCodeMakesTheNewFile() {
        val made = ZnBsPatch.apply(old, patch, new.size.toLong())
        assertArrayEquals(new, made)
    }

    @Test
    fun aPatchFromAnEmptyFileMakesTheNewFile() {
        val made = ZnBsPatch.apply(ByteArray(0), res("from-empty.patch"), fixture.getJSONObject("fromEmpty").getString("text").toByteArray().size.toLong())
        assertEquals(fixture.getJSONObject("fromEmpty").getString("text"), String(made))
    }

    @Test
    fun handMadePatchesWork() {
        // add 3 (old + diff), copy 2 from extra, seek back 3 so the next add reads old from the start again.
        val p = patchOf(7, listOf(longArrayOf(3, 2, -3), longArrayOf(2, 0, 0)), diff = byteArrayOf(1, 1, 1, 0, 0), extra = "xy".toByteArray())
        assertEquals("bcdxyab", String(ZnBsPatch.apply("abcd".toByteArray(), p, 7)))
        // Reads outside the old file count as 0: a seek far past the end gives the diff bytes themselves.
        val q = patchOf(2, listOf(longArrayOf(0, 0, 1000), longArrayOf(2, 0, 0)), diff = "hi".toByteArray())
        assertEquals("hi", String(ZnBsPatch.apply("abcd".toByteArray(), q, 2)))
        assertEquals(0, ZnBsPatch.apply(ByteArray(0), patchOf(0, emptyList()), 0).size)
    }

    @Test
    fun aWrongMagicOrSizeIsRefused() {
        refused(old, patch.copyOf().also { it[0] = 'X'.code.toByte() }, new.size.toLong(), "not a ZNBSDIFF1 patch")
        refused(old, patch.copyOf(10), new.size.toLong(), "not a ZNBSDIFF1 patch")
        refused(old, patch, new.size + 1L, "expected ${new.size + 1}")
        refused(old, patchOf(-1, emptyList()), -1, "makes -1 bytes")
        refused(old, patchOf(Long.MAX_VALUE, emptyList()), Long.MAX_VALUE, "too big")
    }

    /** Where the patch's data ends: header, controls, then the sum of add and the sum of copy. */
    private fun dataEnd(p: ByteArray): Int {
        val b = ByteBuffer.wrap(p).order(ByteOrder.LITTLE_ENDIAN)
        val controls = b.getLong(16).toInt()
        var end = 24L + controls * 24
        for (c in 0 until controls) end += b.getLong(24 + c * 24) + b.getLong(32 + c * 24)
        return end.toInt()
    }

    @Test
    fun aCutPatchIsAlwaysRefused() {
        // Every length shorter than its data, around the header, the controls, and the diff and extra parts.
        val end = dataEnd(patch)
        assertTrue(end <= patch.size)
        val cuts = (0 until 600) + (end - 600 until end) + (0 until 200).map { Random(it).nextInt(end) }
        for (n in cuts) {
            try {
                ZnBsPatch.apply(old, patch.copyOf(n), new.size.toLong())
                fail("a patch cut to $n bytes should be refused")
            } catch (_: ZnOtaError) {
            }
        }
    }

    @Test
    fun bytesAfterTheExtraPartAreNotRead() {
        // As bsdiff.ts's applyPatch. Its makePatch ends exactly with the extra part (since 2026-11-09; patches made
        // before that had 8 zero bytes after it, which must still work).
        assertEquals(patch.size, dataEnd(patch))
        assertArrayEquals(new, ZnBsPatch.apply(old, patch + ByteArray(8), new.size.toLong()))
        assertArrayEquals(new, ZnBsPatch.apply(old, patch + ByteArray(5) { 7 }, new.size.toLong()))
    }

    @Test
    fun badControlsAreRefused() {
        val s = 4L
        refused(old, patchOf(s, emptyList(), count = 1_000_000), s, "bad control count")
        refused(old, patchOf(s, emptyList(), count = -1), s, "bad control count")
        refused(old, patchOf(s, emptyList(), count = Long.MAX_VALUE), s, "bad control count")
        refused(old, patchOf(s, listOf(longArrayOf(-1, 5, 0)), extra = ByteArray(5)), s, "bad diff length")
        refused(old, patchOf(s, listOf(longArrayOf(Long.MAX_VALUE, 0, 0))), s, "bad diff length")
        refused(old, patchOf(s, listOf(longArrayOf(2, 0, 0), longArrayOf(Long.MAX_VALUE - 1, 0, 0)), diff = ByteArray(2)), s, "bad diff length")
        refused(old, patchOf(s, listOf(longArrayOf(0, -1, 0))), s, "past the new size")
        refused(old, patchOf(s, listOf(longArrayOf(0, Long.MAX_VALUE, 0))), s, "past the new size")
        refused(old, patchOf(s, listOf(longArrayOf(5, 0, 0)), diff = ByteArray(5)), s, "past the new size")
        refused(old, patchOf(s, listOf(longArrayOf(2, 3, 0)), diff = ByteArray(2), extra = ByteArray(3)), s, "past the new size")
        refused(old, patchOf(s, listOf(longArrayOf(0, 4, 0)), extra = ByteArray(3)), s, "past the patch")
        refused(old, patchOf(s, listOf(longArrayOf(0, 2, 0))), s, "past the patch")
        // Ends short of newSize: 2 of 4 bytes.
        refused(old, patchOf(s, listOf(longArrayOf(0, 2, 0)), extra = ByteArray(2)), s, "made 2 of 4 bytes")
    }

    @Test
    fun aSeekThatOverflowsIsRefused() {
        refused(old, patchOf(2, listOf(longArrayOf(0, 0, Long.MAX_VALUE), longArrayOf(0, 0, 1), longArrayOf(2, 0, 0)), diff = ByteArray(2)), 2, "out of range")
        refused(old, patchOf(2, listOf(longArrayOf(0, 0, Long.MIN_VALUE), longArrayOf(0, 0, -1), longArrayOf(2, 0, 0)), diff = ByteArray(2)), 2, "out of range")
        // At the edge but not over: still works (old reads count as 0 there).
        val p = patchOf(2, listOf(longArrayOf(0, 0, Long.MAX_VALUE - 2), longArrayOf(2, 0, 0)), diff = "ok".toByteArray())
        assertEquals("ok", String(ZnBsPatch.apply(old, p, 2)))
        // add itself moves the old position: MAX - 1 + add 2 overflows.
        refused(old, patchOf(2, listOf(longArrayOf(0, 0, Long.MAX_VALUE - 1), longArrayOf(2, 0, 0)), diff = ByteArray(2)), 2, "out of range")
    }

    @Test
    fun aChangedPatchFailsOrMakesAnotherFileNeverACrash() {
        // Random changes in the header and controls: a ZnOtaError, or a file of the right size (that the SHA check
        // then refuses). Never another exception (no index out of range, no huge array).
        val rnd = Random(7)
        repeat(3_000) {
            val p = patch.copyOf()
            repeat(1 + rnd.nextInt(4)) { p[rnd.nextInt(24 + 26 * 24)] = rnd.nextInt(256).toByte() }
            try {
                val out = ZnBsPatch.apply(old, p, new.size.toLong())
                assertEquals(new.size, out.size)
            } catch (_: ZnOtaError) {
            }
        }
        // One changed diff byte: the patch still applies, but the file differs, so the SHA check catches it.
        val p = patch.copyOf().also { it[24 + 26 * 24 + 5] = (it[24 + 26 * 24 + 5] + 1).toByte() }
        assertFalse(sha(ZnBsPatch.apply(old, p, new.size.toLong())) == sha(new))
    }
}
