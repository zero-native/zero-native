package dev.zeronative.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    /** This "app": registry v9, Hermes format 99, host API 1–2, Device v2 and Keyboard v1. */
    private var caps = ZnCapabilities(9, 99, 2, 1, mapOf("Device" to 2, "Keyboard" to 1))

    /** A JSON value written as it is (for "requires"). */
    private class Raw(val json: String) {
        override fun toString() = json
    }
    private val needsLittle = Raw("""{"registry":8,"bytecode":99,"hostApi":1,"modules":{"Device":1}}""")

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
            "requires" to needsLittle,
        )
        edit(fields)
        val list = files.entries.joinToString(",") { (n, t) -> "\"$n\":{\"size\":${t.length},\"sha256\":\"z\"}" }
        val head = fields.entries.joinToString(",") { (k, v) -> "\"$k\":" + if (v is String) "\"$v\"" else "$v" }
        File(dir, ZnBundles.INFO_FILE).writeText("{$head,\"files\":{$list}}")
    }

    private fun check(id: String) = ZnBundles.checkBundle(id, builtIn, caps) { File(root, it) }

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
        // Normal after a store update: marked superseded, so it is not reported as a problem
        assertTrue((check("sample_2") as ZnBundles.Check.No).superseded)
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
        assertFalse((check("sample_5") as ZnBundles.Check.No).superseded) // a real problem: still reported

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

    // ---- Capabilities (step 4.2): the app must cover what the bundle needs ------------------------------------------

    private fun needs(registry: Int = 8, bytecode: Int = 99, hostApi: Int = 1, modules: String = "{\"Device\":1}") =
        Raw("{\"registry\":$registry,\"bytecode\":$bytecode,\"hostApi\":$hostApi,\"modules\":$modules}")

    @Test
    fun aBundleThatListsNoNeedsIsRefused() {
        bundle("sample_5") { it.remove("requires") }
        assertNo("sample_5", "doesn't say what it needs")
    }

    @Test
    fun aBundleNeedingANewerRegistryIsRefused() {
        bundle("sample_5") { it["requires"] = needs(registry = 10) }
        assertNo("sample_5", "needs registry v10, this app has v9")
        bundle("sample_6") { it["requires"] = needs(registry = 9) }
        assertTrue(check("sample_6") is ZnBundles.Check.Ok)
    }

    @Test
    fun aBundleForAnotherBytecodeFormatIsRefused() {
        bundle("sample_5") { it["requires"] = needs(bytecode = 98) }
        assertNo("sample_5", "format 98")
    }

    @Test
    fun theHostApiMustBeInTheAppsRange() {
        bundle("sample_5") { it["requires"] = needs(hostApi = 3) }
        assertNo("sample_5", "needs host API v3")
        caps = ZnCapabilities(9, 99, 4, 2, mapOf("Device" to 2))
        bundle("sample_6") { it["requires"] = needs(hostApi = 1) }
        assertNo("sample_6", "built for host API v1; this app runs v2 and newer")
    }

    @Test
    fun anOlderAppWithoutAModuleIgnoresTheBundle() {
        // The must-pass test of ARCHITECTURE §16.2: a newer bundle needs a module this (older) app doesn't have.
        bundle("sample_5") { it["requires"] = needs(modules = "{\"Device\":1,\"Scanner\":1}") }
        assertNo("sample_5", "needs native module Scanner")
        bundle("sample_6") { it["requires"] = needs(modules = "{\"Device\":3}") }
        assertNo("sample_6", "needs Device v3, this app has v2")
    }

    @Test
    fun parseInfoReadsRequires() {
        val info = ZnBundles.parseInfo(
            """{"format":1,"app":"sample","serial":2,"id":"sample_2","sha256":"ab","files":{},
               "requires":{"registry":8,"bytecode":99,"hostApi":1,"modules":{"Fetch":1,"Device":2}}}""",
        )
        val r = info.requires!!
        assertEquals(8, r.registry)
        assertEquals(99, r.bytecode)
        assertEquals(1, r.hostApi)
        assertEquals(mapOf("Fetch" to 1, "Device" to 2), r.modules)
    }
}
