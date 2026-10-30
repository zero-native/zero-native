package dev.zeronative.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Which downloaded bundle may run (ZnBundles.checkBundle): one test per rule in its doc comment. */
class ZnBundlesTest {
    private val root: File = Files.createTempDirectory("zn-bundles").toFile()
    private val builtIn = ZnBundles.Info(
        app = "sample", serial = 3, id = "sample_3", sha256 = "x",
        files = mapOf("main.hbc" to 4L, "main.zn.ui" to 2L, "main.zn.ui.json" to 2L),
    )

    /** Writes bundle [id] with [files] (name → content) and a matching zn-bundle.json, changed by [edit]. */
    private fun bundle(
        id: String,
        files: Map<String, String> = mapOf("main.hbc" to "code", "main.zn.ui" to "ui", "main.zn.ui.json" to "{}"),
        edit: (MutableMap<String, Any>) -> Unit = {},
    ) {
        val dir = File(root, id).apply { mkdirs() }
        for ((name, text) in files) File(dir, name).apply { parentFile!!.mkdirs() }.writeText(text)
        val fields = mutableMapOf<String, Any>(
            "format" to 1, "app" to "sample", "serial" to id.substringAfterLast('_').toInt(), "id" to id, "sha256" to "y",
        )
        edit(fields)
        val list = files.entries.joinToString(",") { (n, t) -> "\"$n\":{\"size\":${t.length},\"sha256\":\"z\"}" }
        val head = fields.entries.joinToString(",") { (k, v) -> "\"$k\":" + if (v is String) "\"$v\"" else "$v" }
        File(dir, ZnBundles.INFO_FILE).writeText("{$head,\"files\":{$list}}")
    }

    private fun check(id: String) = ZnBundles.checkBundle(id, builtIn) { File(root, it) }

    private fun assertNo(id: String, reasonPart: String) {
        when (val v = check(id)) {
            is ZnBundles.Check.Ok -> fail("$id should not run")
            is ZnBundles.Check.No -> assertTrue("\"${v.reason}\" should mention \"$reasonPart\"", v.reason.contains(reasonPart))
        }
    }

    @Test
    fun aNewerCompleteBundleRuns() {
        bundle("sample_4", files = mapOf("main.hbc" to "code", "main.zn.ui" to "ui", "main.zn.ui.json" to "{}", "images/a.png" to "png"))
        val v = check("sample_4")
        assertTrue(v is ZnBundles.Check.Ok)
        val info = (v as ZnBundles.Check.Ok).info
        assertEquals(4, info.serial)
        assertEquals(3L, info.files["images/a.png"])
    }

    @Test
    fun theBuiltInBundleWinsWhenItIsTheSameOrNewer() {
        bundle("sample_3")
        assertNo("sample_3", "same or newer")
        bundle("sample_2")
        assertNo("sample_2", "same or newer")
    }

    @Test
    fun badIdsAreRefusedBeforeTouchingFiles() {
        assertNo("../sample_9", "not a bundle id")
        assertNo("sample", "not a bundle id")
        assertNo("", "not a bundle id")
    }

    @Test
    fun aMissingFolderOrInfoFileIsRefused() {
        assertNo("sample_7", "no zn-bundle.json")
    }

    @Test
    fun anotherAppsBundleIsRefused() {
        bundle("sample_5") { it["app"] = "other" }
        assertNo("sample_5", "for app \"other\"")
    }

    @Test
    fun anInfoFileForAnotherIdIsRefused() {
        bundle("sample_5") { it["id"] = "sample_6" }
        assertNo("sample_5", "says sample_6")
    }

    @Test
    fun anUnknownFormatIsRefused() {
        bundle("sample_5") { it["format"] = 2 }
        assertNo("sample_5", "format 2")
    }

    @Test
    fun aBundleWithoutTheBuiltInCodeFilesIsRefused() {
        bundle("sample_5", files = mapOf("main.hbc" to "code", "main.zn.ui" to "ui"))
        assertNo("sample_5", "main.zn.ui.json")
    }

    @Test
    fun aMissingOrCutFileIsRefused() {
        bundle("sample_5")
        File(root, "sample_5/main.zn.ui").delete()
        assertNo("sample_5", "main.zn.ui is missing")

        bundle("sample_6")
        File(root, "sample_6/main.hbc").writeText("cod") // a cut download
        assertNo("sample_6", "main.hbc is 3 bytes")
    }

    @Test
    fun filePathsCantLeaveTheBundleFolder() {
        bundle("sample_5", files = mapOf("main.hbc" to "code", "main.zn.ui" to "ui", "main.zn.ui.json" to "{}", "../x.png" to "p"))
        assertNo("sample_5", "bad file path")
    }

    @Test
    fun parseInfoReadsTheBuildOutput() {
        // The shape tools/bundle-info.ts writes.
        val info = ZnBundles.parseInfo(
            """{"format":1,"app":"sample","serial":12,"id":"sample_12","sha256":"ab",
               "files":{"main.hbc":{"size":10,"sha256":"cd"}},"builtAt":"2026-10-30T00:00:00Z"}""",
        )
        assertEquals("sample_12", info.id)
        assertEquals(12, info.serial)
        assertEquals(mapOf("main.hbc" to 10L), info.files)
    }
}
