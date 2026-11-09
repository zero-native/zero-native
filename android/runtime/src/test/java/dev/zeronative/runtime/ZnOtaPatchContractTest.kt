package dev.zeronative.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The phone builds a bundle from a patch zip the **server's own code** made (server/src/patches.ts), from two real
 * bundles. The files are too big for the repo, so this runs only when ZN_PATCH_CONTRACT_DIR names a folder made by
 * `bun run tools/ota/make-patch-contract.ts <old> <new> <out>` (patch.zip, base/, new-zn-bundle.json). Else skipped.
 */
class ZnOtaPatchContractTest {
    @Test
    fun theServersPatchBuildsTheNewBundle() {
        val dir = System.getenv("ZN_PATCH_CONTRACT_DIR")?.let(::File)
        assumeTrue("ZN_PATCH_CONTRACT_DIR not set", dir != null && dir.isDirectory)
        val base = File(dir, "base")
        val baseInfo = ZnBundles.parseInfo(File(base, ZnBundles.INFO_FILE).readText())
        val newInfo = ZnBundles.parseInfo(File(dir, "new-zn-bundle.json").readText())
        // Only the fields buildFromPatch reads matter here; the zip SHA and signature are checked before it, elsewhere.
        val m = ZnOtaInstall.Manifest(
            app = newInfo.app, id = newInfo.id, serial = newInfo.serial, bundleSha256 = newInfo.sha256,
            requires = newInfo.requires!!, zipSha256 = "", zipSize = 0, url = "", signature = "",
        )
        val dest = File(Files.createTempDirectory("zn-contract").toFile(), "out")
        ZnOtaInstall.buildFromPatch(File(dir, "patch.zip"), m, baseInfo.id, baseInfo.sha256, { name ->
            File(base, name).takeIf { it.isFile }?.inputStream()
        }, dest)
        // The built folder is a bundle the phone runs: the same checks as at a start.
        val built = ZnBundles.parseInfo(File(dest, ZnBundles.INFO_FILE).readText())
        assertEquals(newInfo.sha256, built.sha256)
        for ((name, size) in newInfo.files) assertEquals(name, size, File(dest, name).length())
        dest.parentFile!!.deleteRecursively()
    }
}
