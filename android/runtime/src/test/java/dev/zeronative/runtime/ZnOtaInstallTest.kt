package dev.zeronative.runtime

import java.io.File
import java.nio.file.Files
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Installing a downloaded bundle (ZnOtaInstall): each check that must refuse a bad zip, and a good install. */
class ZnOtaInstallTest {
    private val root: File = Files.createTempDirectory("zn-ota-install").toFile()
    private val keys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val publicKey = Base64.getEncoder().encodeToString(keys.public.encoded)
    private val requires = ZnBundles.Requires(8, 99, 2, mapOf("Fetch" to 1))

    private fun sha(b: ByteArray) = ZnOtaInstall.hex(MessageDigest.getInstance("SHA-256").digest(b))

    private fun sign(text: String): String = Base64.getEncoder().encodeToString(
        Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update(text.toByteArray()); sign() },
    )

    /**
     * A bundle zip as the release CLI makes it. [edit] can change what goes in (to make a bad zip); the manifest is
     * made from the good files unless [manifestFrom] says otherwise.
     */
    private fun release(
        files: Map<String, ByteArray> = mapOf("main.hbc" to "code".toByteArray(), "main.zn.ui" to "ui".toByteArray(), "images/a.png" to "png".toByteArray()),
        edit: (MutableMap<String, ByteArray>) -> Unit = {},
        infoEdit: (JSONObject) -> Unit = {},
    ): Pair<File, ZnOtaInstall.Manifest> {
        val listed = files.mapValues { (_, b) -> b.size.toLong() to sha(b) }
        val bundleSha = ZnOtaInstall.bundleSha256(listed)
        val info = JSONObject().put("format", 1).put("app", "sample").put("serial", 12).put("id", "sample_12").put("sha256", bundleSha)
            .put("requires", JSONObject().put("registry", 8).put("bytecode", 99).put("hostApi", 2).put("modules", JSONObject().put("Fetch", 1)))
            .put("files", JSONObject().apply { listed.forEach { (n, v) -> put(n, JSONObject().put("size", v.first).put("sha256", v.second)) } })
            .put("builtAt", "t")
        infoEdit(info)
        val content = files.toMutableMap().apply { put(ZnBundles.INFO_FILE, info.toString().toByteArray()) }
        edit(content)
        val zip = File(root, "b-${System.nanoTime()}.zip")
        ZipOutputStream(zip.outputStream()).use { z -> content.forEach { (n, b) -> z.putNextEntry(ZipEntry(n)); z.write(b); z.closeEntry() } }
        val zipBytes = zip.readBytes()
        val text = ZnOtaSignature.bundleText("sample", "sample_12", 12, bundleSha, requires, sha(zipBytes), zipBytes.size.toLong())
        return zip to ZnOtaInstall.Manifest("sample", "sample_12", 12, bundleSha, requires, sha(zipBytes), zipBytes.size.toLong(), "/x", sign(text))
    }

    private fun refused(zip: File, m: ZnOtaInstall.Manifest, part: String) {
        val dest = File(root, "dest-${System.nanoTime()}")
        try {
            ZnOtaInstall.extract(zip, m, dest)
            fail("should refuse ($part)")
        } catch (e: ZnOtaError) {
            assertTrue("\"${e.message}\" should mention \"$part\"", e.message!!.contains(part))
        }
    }

    @Test
    fun theBundleShaIsTheSameAsTheCli() {
        // Value from tools/bundle-info.ts bundleSha256 for the same three files.
        val files = mapOf(
            "main.hbc" to (4L to sha("code".toByteArray())),
            "images/a.png" to (3L to sha("png".toByteArray())),
            "main.zn.ui" to (2L to sha("ui".toByteArray())),
        )
        assertEquals("ea063c10b361e8fc4448c2a74e0b97a51651fe3c351a1bc2705442df7b8033d2", ZnOtaInstall.bundleSha256(files))
    }

    @Test
    fun aGoodBundleInstallsWithEveryFile() {
        val (zip, m) = release()
        assertTrue(ZnOtaInstall.verifyManifest(m, listOf(publicKey)))
        assertEquals(m.zipSha256, ZnOtaInstall.sha256(zip))
        val dest = File(root, "good")
        ZnOtaInstall.extract(zip, m, dest)
        assertEquals("code", File(dest, "main.hbc").readText())
        assertEquals("png", File(dest, "images/a.png").readText())
        assertEquals("sample_12", ZnBundles.parseInfo(File(dest, ZnBundles.INFO_FILE).readText()).id)
    }

    @Test
    fun aChangedManifestFailsItsSignature() {
        val (_, m) = release()
        val tampered = ZnOtaInstall.Manifest(m.app, m.id, 13, m.bundleSha256, m.requires, m.zipSha256, m.zipSize, m.url, m.signature)
        assertFalse(ZnOtaInstall.verifyManifest(tampered, listOf(publicKey)))
    }

    @Test
    fun aFileChangedInsideTheZipIsRefused() {
        val (zip, m) = release(edit = { it["main.hbc"] = "evil".toByteArray() })
        refused(zip, m, "main.hbc doesn't match its SHA-256")
    }

    @Test
    fun aFileBiggerThanListedIsStoppedEarly() {
        val (zip, m) = release(edit = { it["main.hbc"] = ByteArray(10_000) })
        refused(zip, m, "bigger than its listed 4 bytes")
    }

    @Test
    fun aMissingFileOrInfoIsRefused() {
        val (zip, m) = release(edit = { it.remove("images/a.png") })
        refused(zip, m, "the zip has no images/a.png")
        val (zip2, m2) = release(edit = { it.remove(ZnBundles.INFO_FILE) })
        refused(zip2, m2, "has no zn-bundle.json")
    }

    @Test
    fun aZipForAnotherBundleOrWithOtherNeedsIsRefused() {
        val (zip, m) = release(infoEdit = { it.put("id", "sample_11").put("serial", 11) })
        refused(zip, m, "the manifest says sample/sample_12")
        val (zip2, m2) = release(infoEdit = { it.getJSONObject("requires").put("registry", 9) })
        refused(zip2, m2, "needs differ")
    }

    @Test
    fun pathsOutsideTheBundleAreRefusedBeforeAnythingIsWritten() {
        val (zip, m) = release(infoEdit = { it.getJSONObject("files").put("../evil.so", JSONObject().put("size", 1).put("sha256", "x")) })
        refused(zip, m, "bad file path")
        assertFalse(File(root, "evil.so").exists())
    }

    @Test
    fun aFileSwappedForAnotherBundlesFileFailsTheBundleSha() {
        // Same listed files, but the info's bundle sha256 claims another bundle.
        val (zip, m) = release(infoEdit = { it.put("sha256", "0".repeat(64)) })
        refused(zip, m, "don't match the signed bundle SHA-256")
    }

    @Test
    fun pointersVerifyAndAChangedSeqDoesNot() {
        val text = ZnOtaSignature.pointerText("sample", "staging", 3, "sample_12")
        val p = ZnOtaInstall.Pointer("sample", "staging", 3, "sample_12", "normal", sign(text))
        assertTrue(ZnOtaInstall.verifyPointer(p, listOf(publicKey)))
        assertFalse(ZnOtaInstall.verifyPointer(ZnOtaInstall.Pointer("sample", "staging", 4, "sample_12", "normal", p.signature), listOf(publicKey)))
        assertFalse(ZnOtaInstall.verifyPointer(ZnOtaInstall.Pointer("sample", "production", 3, "sample_12", "normal", p.signature), listOf(publicKey)))
    }

    @Test
    fun atomicWritesLeaveTheNewTextAndNoTempFile() {
        val f = File(root, "current")
        ZnOtaInstall.writeAtomic(f, "sample_11")
        ZnOtaInstall.writeAtomic(f, "sample_12")
        assertEquals("sample_12", f.readText())
        assertFalse(File(root, ".current.tmp").exists())
    }
}
