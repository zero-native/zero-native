package dev.zeronative.runtime

/**
 * Applies a ZNBSDIFF1 patch (docs/ota-patches.md §2): the phone side of tools/ota/bsdiff.ts, whose `applyPatch` is
 * the reference. Plain JVM code (no Android APIs), so every check is tested on the JVM (ZnBsPatchTest).
 *
 * Format, all numbers 8-byte little endian, signed:
 *
 *     0   "ZNBSDIF1"                      magic
 *     8   newSize                         size of the file it makes
 *     16  controls                        number of (add, copy, seek) triples
 *     24  controls × (add, copy, seek)
 *     ..  diff bytes (sum of add), then extra bytes (sum of copy)
 *
 * For each triple: `add` bytes of `diff[i] + old[oldPos + i]` (old byte 0 outside the old file), then `copy` bytes from
 * extra, then `oldPos += seek`.
 *
 * A patch is not trusted: every number is checked against newSize, the patch's own size and the counts before it is
 * used, and all math is safe from overflow. A bad patch can only fail; the caller still checks the result's size and
 * SHA-256 against the signed bundle list ([ZnOtaInstall.buildFromPatch]).
 */
internal object ZnBsPatch {
    /** The format name in the check request (`patches`), the answer and `zn-patch.json`. */
    const val FORMAT = "znbsdiff1"
    private val MAGIC = "ZNBSDIF1".toByteArray(Charsets.US_ASCII)
    private const val HEADER = 24
    private const val CONTROL = 24
    /** The biggest file a ByteArray can hold, with a little room (the JVM keeps a few bytes per array). */
    private const val MAX_FILE = Int.MAX_VALUE - 16L

    /**
     * Makes the new file from [old] and [patch]. The patch must make exactly [expectSize] bytes (the file's listed
     * size). Throws [ZnOtaError] with code "patch" on any problem; never another exception for a bad patch.
     */
    fun apply(old: ByteArray, patch: ByteArray, expectSize: Long): ByteArray {
        if (patch.size < HEADER || (0 until 8).any { patch[it] != MAGIC[it] }) bad("not a ZNBSDIFF1 patch")
        val newSize = long(patch, 8)
        val controls = long(patch, 16)
        if (newSize < 0 || newSize != expectSize) bad("the patch makes $newSize bytes, expected $expectSize")
        if (newSize > MAX_FILE) bad("the patch makes $newSize bytes, too big")
        // Each control needs 24 bytes of the patch, so this also keeps controls × 24 small.
        if (controls < 0 || controls > (patch.size - HEADER) / CONTROL) bad("bad control count $controls")
        val diffStart = HEADER + controls.toInt() * CONTROL

        // The diff part is the sum of every add. Checked one add at a time, so the sum can't overflow.
        var addTotal = 0L
        for (c in 0 until controls.toInt()) {
            val add = long(patch, HEADER + c * CONTROL)
            if (add < 0 || add > patch.size - diffStart - addTotal) bad("bad diff length")
            addTotal += add
        }

        val out = ByteArray(newSize.toInt())
        var diffAt = diffStart
        var extraAt = diffStart + addTotal.toInt()
        var newPos = 0
        var oldPos = 0L
        for (c in 0 until controls.toInt()) {
            val at = HEADER + c * CONTROL
            val add = long(patch, at)
            val copy = long(patch, at + 8)
            val seek = long(patch, at + 16)
            if (add < 0 || copy < 0 || add > newSize - newPos || copy > newSize - newPos - add) bad("a control goes past the new size")
            if (add > patch.size - diffAt || copy > patch.size - extraAt) bad("a control goes past the patch")
            val a = add.toInt()
            val end = plus(oldPos, add) // oldPos + i below can't overflow now
            for (i in 0 until a) {
                val o = oldPos + i
                val base = if (o >= 0 && o < old.size) old[o.toInt()].toInt() else 0
                out[newPos + i] = (patch[diffAt + i].toInt() + base).toByte()
            }
            diffAt += a
            newPos += a
            oldPos = end
            val n = copy.toInt()
            System.arraycopy(patch, extraAt, out, newPos, n)
            extraAt += n
            newPos += n
            oldPos = plus(oldPos, seek)
        }
        if (newPos.toLong() != newSize) bad("the patch made $newPos of $newSize bytes")
        // Bytes after the extra part are not read, as in bsdiff.ts (its makePatch leaves 8 zero bytes there today).
        return out
    }

    /** The signed 8-byte little-endian number at [at] (the caller checked that the 8 bytes are there). */
    private fun long(b: ByteArray, at: Int): Long {
        var v = 0L
        for (i in 7 downTo 0) v = (v shl 8) or (b[at + i].toLong() and 0xff)
        return v
    }

    /** [a] + [b], refused when it doesn't fit in a Long (a seek made to overflow the old position). */
    private fun plus(a: Long, b: Long): Long = try {
        Math.addExact(a, b)
    } catch (_: ArithmeticException) {
        bad("the old position goes out of range")
    }

    private fun bad(why: String): Nothing = throw ZnOtaError("patch", why)
}
