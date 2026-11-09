package dev.zeronative.runtime

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Building a bundle from a patch zip (ZnOtaInstall.buildFromPatch, docs/ota-patches.md §3): a good patch makes every
 * file (copy, patch, zip), and each check refuses a bad patch zip or a wrong base. The bsdiff patch is the TS one
 * (tools/ota/make-patch-fixture.ts).
 */
class ZnOtaInstallPatchTest {
    private val root: File = Files.createTempDirectory("zn-ota-patch").toFile()
    private val requires = ZnBundles.Requires(8, 99, 2, mapOf("Fetch" to 1))
    private fun res(name: String): ByteArray = javaClass.classLoader!!.getResourceAsStream("ota-patch/$name")!!.use { it.readBytes() }
    private val oldHbc = res("old.hbc")
    private val newHbc = res("new.hbc")
    private val hbcPatch = res("main.patch")

    private fun sha(b: ByteArray) = ZnOtaInstall.hex(MessageDigest.getInstance("SHA-256").digest(b))
    private fun listed(files: Map<String, ByteArray>) = files.mapValues { (_, b) -> b.size.toLong() to sha(b) }

    /** The base bundle sample_11 on the phone. */
    private val baseFiles = mapOf("main.hbc" to oldHbc, "main.zn.ui" to "ui".toByteArray(), "images/a.png" to "png".toByteArray())
    private val baseSha = ZnOtaInstall.bundleSha256(listed(baseFiles))
    /** The new bundle sample_12: main.hbc patched, main.zn.ui the same, images/b.png new. */
    private val newFiles = mapOf("main.hbc" to newHbc, "main.zn.ui" to "ui".toByteArray(), "images/b.png" to "new png".toByteArray())
    private val newSha = ZnOtaInstall.bundleSha256(listed(newFiles))
    private val manifest = ZnOtaInstall.Manifest("sample", "sample_12", 12, newSha, requires, "z".repeat(64), 1, "/x", "sig")

    private fun info(files: Map<String, ByteArray> = newFiles, sha: String = newSha) = JSONObject()
        .put("format", 1).put("app", "sample").put("serial", 12).put("id", "sample_12").put("sha256", sha)
        .put("requires", JSONObject().put("registry", 8).put("bytecode", 99).put("hostApi", 2).put("modules", JSONObject().put("Fetch", 1)))
        .put("files", JSONObject().apply { listed(files).forEach { (n, v) -> put(n, JSONObject().put("size", v.first).put("sha256", v.second)) } })
        .put("builtAt", "t")

    private fun patchJson() = JSONObject()
        .put("format", "znbsdiff1")
        .put("from", JSONObject().put("id", "sample_11").put("sha256", baseSha))
        .put("to", JSONObject().put("id", "sample_12").put("sha256", newSha))
        .put("files", JSONObject()
            .put("main.hbc", JSONObject().put("patch", "p/main.hbc").put("base", "main.hbc"))
            .put("main.zn.ui", JSONObject().put("copy", "main.zn.ui"))
            .put("images/b.png", JSONObject().put("zip", "f/images/b.png")))

    /** A patch zip as the server makes it; [patch], [infoJson] and [edit] change what goes in. */
    private fun patchZip(
        patch: (JSONObject) -> Unit = {},
        infoJson: JSONObject = info(),
        edit: (MutableMap<String, ByteArray>) -> Unit = {},
    ): File {
        val p = patchJson().also(patch)
        val content = linkedMapOf(
            ZnOtaInstall.PATCH_FILE to p.toString().toByteArray(),
            ZnBundles.INFO_FILE to infoJson.toString().toByteArray(),
            "p/main.hbc" to hbcPatch,
            "f/images/b.png" to "new png".toByteArray(),
        )
        edit(content)
        val zip = File(root, "p-${System.nanoTime()}.zip")
        ZipOutputStream(zip.outputStream()).use { z -> content.forEach { (n, b) -> z.putNextEntry(ZipEntry(n)); z.write(b); z.closeEntry() } }
        return zip
    }

    private fun baseOf(files: Map<String, ByteArray>): (String) -> InputStream? = { name -> files[name]?.let(::ByteArrayInputStream) }

    private fun build(zip: File, base: Map<String, ByteArray> = baseFiles, fromId: String = "sample_11", fromSha: String = baseSha, m: ZnOtaInstall.Manifest = manifest): File {
        val dest = File(root, "dest-${System.nanoTime()}")
        ZnOtaInstall.buildFromPatch(zip, m, fromId, fromSha, baseOf(base), dest)
        return dest
    }

    private fun refused(zip: File, part: String, base: Map<String, ByteArray> = baseFiles, fromId: String = "sample_11", fromSha: String = baseSha) {
        try {
            build(zip, base, fromId, fromSha)
            fail("should refuse ($part)")
        } catch (e: ZnOtaError) {
            assertEquals("patch", e.code)
            assertTrue("\"${e.message}\" should mention \"$part\"", e.message!!.contains(part))
        }
    }

    @Test
    fun aGoodPatchMakesEveryFile() {
        val dest = build(patchZip())
        assertArrayEquals(newHbc, File(dest, "main.hbc").readBytes())
        assertEquals("ui", File(dest, "main.zn.ui").readText())
        assertEquals("new png", File(dest, "images/b.png").readText())
        assertFalse("the old image isn't in the new bundle", File(dest, "images/a.png").exists())
        val info = ZnBundles.parseInfo(File(dest, ZnBundles.INFO_FILE).readText())
        assertEquals("sample_12", info.id)
        assertEquals(newSha, info.sha256)
        // The folder passes the same check a downloaded bundle gets at start.
        val builtIn = ZnBundles.Info("sample", 0, "sample_0", "x", mapOf("main.hbc" to 1L), requires)
        val caps = ZnCapabilities(registry = 8, bytecode = 99, hostApi = 2, hostApiOldest = 1, modules = mapOf("Fetch" to 1))
        assertTrue(ZnBundles.checkBundle("sample_12", builtIn, caps) { dest } is ZnBundles.Check.Ok)
    }

    @Test
    fun aWrongBaseIsRefused() {
        // A copied file that differs, a patched file whose old bytes differ, a base file that is missing.
        refused(patchZip(), "main.zn.ui doesn't match its SHA-256", base = baseFiles + ("main.zn.ui" to "UI".toByteArray()))
        refused(patchZip(), "main.hbc doesn't match its SHA-256", base = baseFiles + ("main.hbc" to oldHbc.copyOf().also { it[0] = (it[0] + 1).toByte() }))
        refused(patchZip(), "has no main.hbc", base = baseFiles - "main.hbc")
        // Another id with the same SHA is the same files (an Android and an iOS store build of the same JS): it builds.
        build(patchZip(), fromId = "sample_10")
        refused(patchZip(), "another SHA-256 than the base sample_11", fromSha = "0".repeat(64))
    }

    @Test
    fun aPatchForAnotherBundleIsRefused() {
        refused(patchZip(patch = { it.getJSONObject("to").put("id", "sample_13") }), "the manifest says sample_12")
        refused(patchZip(patch = { it.getJSONObject("to").put("sha256", "0".repeat(64)) }), "the manifest says sample_12")
        refused(patchZip(patch = { it.put("format", "bsdiff40") }), "format \"bsdiff40\"")
        refused(patchZip(infoJson = info().put("id", "sample_11").put("serial", 11)), "the manifest says sample/sample_12")
        refused(patchZip(infoJson = info().also { it.getJSONObject("requires").put("registry", 9) }), "needs differ")
    }

    @Test
    fun aWrongShaIsRefused() {
        // The listed SHA of a file isn't what the patch makes.
        val other = newFiles + ("images/b.png" to "other png".toByteArray())
        val bad = info().also { it.getJSONObject("files").put("images/b.png", JSONObject().put("size", 7).put("sha256", sha("other p".toByteArray()))) }
        refused(patchZip(infoJson = bad), "images/b.png doesn't match its SHA-256")
        // Every file checks out, but zn-bundle.json's bundle SHA claims another bundle.
        refused(patchZip(infoJson = info(sha = "0".repeat(64))), "don't match the signed bundle SHA-256")
        // The files of another bundle with their own true SHAs: the bundle SHA no longer matches the manifest.
        refused(patchZip(infoJson = info(other, newSha), edit = { it["f/images/b.png"] = "other png".toByteArray() }), "don't match the signed bundle SHA-256")
    }

    @Test
    fun znPatchJsonMustCoverExactlyTheListedFiles() {
        refused(patchZip(patch = { it.getJSONObject("files").put("extra.js", JSONObject().put("zip", "f/images/b.png")) }), "has extra.js")
        refused(patchZip(patch = { it.getJSONObject("files").remove("main.zn.ui") }), "doesn't say how to make main.zn.ui")
        refused(patchZip(patch = { it.getJSONObject("files").put("main.zn.ui", JSONObject().put("copy", "main.zn.ui").put("zip", "f/images/b.png")) }), "needs one of copy, patch or zip")
        refused(patchZip(patch = { it.getJSONObject("files").put("main.zn.ui", JSONObject()) }), "needs one of copy, patch or zip")
        refused(patchZip(edit = { it.remove("f/images/b.png") }), "the patch zip has no f/images/b.png")
        refused(patchZip(edit = { it.remove(ZnOtaInstall.PATCH_FILE) }), "has no zn-patch.json")
        refused(patchZip(edit = { it.remove(ZnBundles.INFO_FILE) }), "has no zn-bundle.json")
        refused(patchZip(edit = { it[ZnOtaInstall.PATCH_FILE] = "{not json".toByteArray() }), "bad zn-patch.json")
    }

    @Test
    fun pathTricksAreRefused() {
        val tricks = listOf("../main.hbc", "/etc/passwd", "a//b", "..\\x", "")
        for (t in tricks) {
            refused(patchZip(patch = { it.getJSONObject("files").put("main.zn.ui", JSONObject().put("copy", t)) }), "bad path")
            refused(patchZip(patch = { it.getJSONObject("files").put("images/b.png", JSONObject().put("zip", t)) }), "bad path")
            refused(patchZip(patch = { it.getJSONObject("files").getJSONObject("main.hbc").put("base", t) }), "bad path")
            refused(patchZip(patch = { it.getJSONObject("files").getJSONObject("main.hbc").put("patch", t) }), "bad path")
        }
        // A new file outside the bundle folder: zn-bundle.json's own rules refuse it before anything is written.
        val evil = info().also { it.getJSONObject("files").put("../evil.so", JSONObject().put("size", 1).put("sha256", "x")) }
        refused(patchZip(infoJson = evil), "bad file path")
        assertFalse(File(root, "evil.so").exists())
    }

    @Test
    fun aPatchEntryOverItsLimitIsStopped() {
        // main.zn.ui is 2 bytes: its patch may unpack to at most 2 × 2 + 1 MiB. Zeros deflate to almost nothing.
        val big = ByteArray(2 * 2 + (1 shl 20) + 1)
        val zip = patchZip(
            patch = { it.getJSONObject("files").put("main.zn.ui", JSONObject().put("patch", "p/main.zn.ui").put("base", "main.zn.ui")) },
            edit = { it["p/main.zn.ui"] = big },
        )
        assertTrue("the zip stays small", zip.length() < 20_000)
        refused(zip, "bigger than its limit of ${2 * 2 + (1 shl 20)} bytes")
        // Just at the limit it is read, and refused by the patch checks instead.
        refused(patchZip(
            patch = { it.getJSONObject("files").put("main.zn.ui", JSONObject().put("patch", "p/main.zn.ui").put("base", "main.zn.ui")) },
            edit = { it["p/main.zn.ui"] = ByteArray(2 * 2 + (1 shl 20)) },
        ), "not a ZNBSDIFF1 patch")
    }

    @Test
    fun aWholeFileBiggerThanListedIsStoppedEarly() {
        refused(patchZip(edit = { it["f/images/b.png"] = ByteArray(100_000) }), "bigger than its listed 7 bytes")
    }

    @Test
    fun aCutOrChangedPatchEntryIsRefused() {
        refused(patchZip(edit = { it["p/main.hbc"] = hbcPatch.copyOf(hbcPatch.size - 20) }), "the patch for main.hbc")
        // A changed diff byte still applies, but makes a file whose SHA is wrong.
        val changed = hbcPatch.copyOf().also { it[24 + 26 * 24 + 5] = (it[24 + 26 * 24 + 5] + 1).toByte() }
        refused(patchZip(edit = { it["p/main.hbc"] = changed }), "main.hbc doesn't match its SHA-256")
    }

    @Test
    fun aBadZipOrAnExistingFolderIsRefused() {
        val notZip = File(root, "not.zip").apply { writeText("not a zip") }
        refused(notZip, "can't be read")
        val dest = File(root, "exists").apply { mkdirs() }
        try {
            ZnOtaInstall.buildFromPatch(patchZip(), manifest, "sample_11", baseSha, baseOf(baseFiles), dest)
            fail("should refuse an existing folder")
        } catch (e: ZnOtaError) {
            assertEquals("install", e.code)
        }
    }
}
