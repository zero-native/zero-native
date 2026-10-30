package dev.zeronative.runtime

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import org.json.JSONObject

/**
 * Where the running bundle's files come from (docs/ota.md §3.1, §3.5): the APK's assets (the **built-in** bundle) or
 * a downloaded bundle folder, `noBackupFilesDir/zn-ota/bundles/<id>/`. Bytecode ([ZnRuntime.evalAsset]), templates
 * and the manifest ([ZnTemplates]) and `asset:` images ([assetModel]) all ask here, so one process never mixes files
 * from two bundles.
 *
 * The choice is made once per process, the first time anything asks (on the zn-io or zn-js thread, never the main
 * thread at startup), and never changes in that process. Rules:
 * - `zn-ota/current` names the bundle to run. The installer writes it (step 4.5); until then it is written by hand.
 * - A downloaded bundle runs only if its `zn-bundle.json` is readable and has a known format, it is for this app,
 *   its serial is **bigger** than the built-in one (a newer APK always wins), it has every code file the built-in
 *   bundle has, and all its files are there with the sizes it lists, this app covers its `requires`
 *   ([ZnCapabilities]: registry version, bytecode format, host API, native modules), and every id in its templates is
 *   one this app knows ([TemplateReader]; the templates read here are kept for [ZnTemplates]).
 * - Anything else, or any error: the built-in bundle, and the reason is logged. The app always starts.
 * - Checksums and signatures are checked once, when a bundle is installed (steps 4.3, 4.5), not on every start.
 * A bundle folder is never changed after it is installed: bytecode is memory-mapped from it while JS runs.
 */
object ZnBundles {
    private const val TAG = "zn"
    const val INFO_FILE = "zn-bundle.json"
    private const val FORMAT = 1
    /** Bundle files that are code: a downloaded bundle must have every one the built-in bundle has. */
    private val CODE_SUFFIXES = listOf(".hbc", ".zn.ui", ".zn.ui.json")
    private val ID = Regex("^[a-z][a-z0-9_.-]*_[0-9]+$")

    /** What `zn-bundle.json` says (tools/bundle-info.ts). [files]: path → size in bytes. */
    class Info(
        val app: String,
        val serial: Int,
        val id: String,
        val sha256: String,
        val files: Map<String, Long>,
        /** What an app needs to run it; null in bundles built before step 4.2 (never run from files). */
        val requires: Requires? = null,
    ) {
        override fun toString() = "$id (#$serial)"
    }

    /** A bundle's needs (docs/ota.md §3.2). [modules]: native module name → lowest version. */
    class Requires(val registry: Int, val bytecode: Int, val hostApi: Int, val modules: Map<String, Int>)

    /** The bundle this process runs. [dir] is null for the built-in bundle (the APK's assets). */
    class Running(val info: Info?, val dir: File?) {
        val builtIn get() = dir == null
        /** For logs: "sample_12 (#12) from files" or "sample_0 (#0) built-in". */
        override fun toString() = "${info ?: "unnamed bundle"} " + if (dir == null) "built-in" else "from files"
    }

    @Volatile private var appContext: Context? = null
    /** Template files of the chosen downloaded bundle, already read (and checked) while choosing it. */
    private val preRead = java.util.concurrent.ConcurrentHashMap<String, TemplateFile>()

    /** Remembers the app context; does no work. Called by [ZnRuntime.start] and [ZnTemplates.preload]. */
    fun init(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    /** The bundle this process runs, chosen on first use (reads a few small files). */
    val running: Running by lazy { choose(checkNotNull(appContext) { "ZnBundles.init() was not called" }) }

    /** The OTA folder: not in backups (a restored bundle could be for another app version). */
    internal fun otaDir(context: Context) = File(context.noBackupFilesDir, "zn-ota")

    // ---- Reading bundle files -------------------------------------------------------------------------------------

    /** A file of the running bundle mapped into memory, or null if the bundle has no such file. */
    internal fun map(name: String): ByteBuffer? {
        val dir = running.dir ?: return mapAsset(name)
        val file = File(dir, name)
        if (!file.isFile) return null
        return FileInputStream(file).channel.use { it.map(FileChannel.MapMode.READ_ONLY, 0, it.size()) }
    }

    /** A text file of the running bundle, or null if the bundle has no such file. */
    internal fun readText(name: String): String? {
        val dir = running.dir
        return try {
            if (dir == null) appContext!!.assets.open(name).bufferedReader().use { it.readText() }
            else File(dir, name).takeIf { it.isFile }?.readText()
        } catch (_: java.io.IOException) {
            null
        }
    }

    /** Template file [name] if it was already read while choosing the bundle (each is handed out once), else null. */
    internal fun takeTemplateFile(name: String): TemplateFile? = running.let { preRead.remove(name) }

    /** The bytecode file to run from the bundle folder, or null when the built-in bundle runs (read from assets). */
    internal fun file(name: String): File? = running.dir?.let { File(it, name) }

    /**
     * What Coil loads for `asset:<path>`: the running bundle's copy when it has one, else the APK's asset. Images may
     * come from the APK: an update ships only the images it changed or added (the build lists them in its files).
     */
    fun assetModel(path: String): Any {
        val r = running
        if (r.dir != null && r.info?.files?.containsKey(path) == true) return File(r.dir, path)
        return "file:///android_asset/$path"
    }

    /** Maps the asset from the APK when it is stored uncompressed (apps mark *.zn.ui noCompress); else reads it. */
    private fun mapAsset(name: String): ByteBuffer? {
        val assets = appContext!!.assets
        return try {
            assets.openFd(name).use { fd ->
                FileInputStream(fd.fileDescriptor).channel.use { ch ->
                    ch.map(FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.length)
                }
            }
        } catch (_: java.io.FileNotFoundException) {
            // openFd fails for compressed assets, and for missing ones.
            try {
                ByteBuffer.wrap(assets.open(name).use { it.readBytes() })
            } catch (_: java.io.FileNotFoundException) {
                null
            }
        }
    }

    // ---- Choosing the bundle --------------------------------------------------------------------------------------

    private fun choose(context: Context): Running {
        val t0 = System.nanoTime()
        val builtIn = try {
            context.assets.open(INFO_FILE).bufferedReader().use { parseInfo(it.readText()) }
        } catch (e: Exception) {
            Log.w(TAG, "bundle: no readable $INFO_FILE in the APK (${e.message}); OTA bundles are off")
            null
        }
        ZnModules.versions() // from now on a late ZnModules.register is reported (it would miss the OTA check)
        val running = try {
            downloaded(context, builtIn) ?: Running(builtIn, null)
        } catch (e: Exception) {
            // Startup guard (docs/ota.md §3.6): whatever went wrong, the built-in bundle runs.
            Log.e(TAG, "bundle: choosing failed, running the built-in bundle", e)
            Running(builtIn, null)
        }
        Log.i(TAG, "bundle: running $running, chosen in %.2f ms".format((System.nanoTime() - t0) / 1e6))
        return running
    }

    /** The downloaded bundle named by `current`, if it may run; null (and the reason logged) if not. */
    private fun downloaded(context: Context, builtIn: Info?): Running? {
        val ota = otaDir(context)
        val id = File(ota, "current").takeIf { it.isFile }?.readText()?.trim() ?: return null
        if (builtIn == null) return null
        val caps = ZnCapabilities.current()
        val dir = File(ota, "bundles/$id")
        val reason = when (val v = checkBundle(id, builtIn, caps) { File(ota, "bundles/$it") }) {
            is Check.Ok -> readTemplates(dir, v.info) ?: return Running(v.info, dir)
            is Check.No -> v.reason
        }
        Log.w(TAG, "bundle: not running $id: $reason; running the built-in bundle (this app: $caps)")
        return null
    }

    /**
     * Reads every template file of a downloaded bundle; [TemplateReader] refuses ids this app doesn't know. This is the
     * safety net under the build's `requires`: a mistake there costs one refused update, never a wrong screen.
     * Returns why the bundle can't run, or null (the files are then kept in [preRead]).
     */
    private fun readTemplates(dir: File, info: Info): String? {
        for (name in info.files.keys.filter { it.endsWith(".zn.ui") }) {
            try {
                val buffer = FileInputStream(File(dir, name)).channel.use { it.map(FileChannel.MapMode.READ_ONLY, 0, it.size()) }
                preRead[name] = TemplateReader.read(buffer)
            } catch (e: Exception) {
                preRead.clear()
                return "its templates use something this app doesn't have ($name: ${e.message})"
            }
        }
        return null
    }

    /** Whether a downloaded bundle may run: [Ok] with its info, or [No] with the reason (for the log). */
    internal sealed interface Check {
        class Ok(val info: Info) : Check
        class No(val reason: String) : Check
    }

    /**
     * Checks downloaded bundle [id] against [builtIn] and this app's [caps]. [folder] maps a bundle id to its folder
     * (tests use a temp one). Templates are checked afterwards ([readTemplates]).
     */
    internal fun checkBundle(id: String, builtIn: Info, caps: ZnCapabilities, folder: (String) -> File): Check {
        if (!ID.matches(id)) return Check.No("\"$id\" is not a bundle id")
        val dir = folder(id)
        val infoFile = File(dir, INFO_FILE)
        if (!infoFile.isFile) return Check.No("its folder has no $INFO_FILE")
        val info = try {
            parseInfo(infoFile.readText())
        } catch (e: Exception) {
            return Check.No("its $INFO_FILE can't be read (${e.message})")
        }
        if (info.id != id) return Check.No("its $INFO_FILE says ${info.id}")
        if (info.app != builtIn.app) return Check.No("it is for app \"${info.app}\", this app is \"${builtIn.app}\"")
        if (info.serial <= builtIn.serial) return Check.No("the built-in bundle #${builtIn.serial} is the same or newer")
        val missingCode = builtIn.files.keys.filter { name -> CODE_SUFFIXES.any { name.endsWith(it) } }
            .filterNot { info.files.containsKey(it) }
        if (missingCode.isNotEmpty()) return Check.No("it has no ${missingCode.joinToString()}")
        for ((name, size) in info.files) {
            val f = File(dir, name)
            if (!f.isFile) return Check.No("$name is missing")
            if (f.length() != size) return Check.No("$name is ${f.length()} bytes, $INFO_FILE says $size")
        }
        val requires = info.requires ?: return Check.No("its $INFO_FILE doesn't say what it needs (requires)")
        caps.missing(requires)?.let { return Check.No("this app can't run it: $it") }
        return Check.Ok(info)
    }

    /** Parses `zn-bundle.json`. Throws if the format is unknown or a field is missing or wrong. */
    internal fun parseInfo(text: String): Info {
        val json = JSONObject(text)
        val format = json.getInt("format")
        require(format == FORMAT) { "format $format, this app reads format $FORMAT" }
        val files = json.getJSONObject("files")
        val sizes = files.keys().asSequence().associateWith { name ->
            require(!name.startsWith("/") && name.split('/').none { it == ".." || it.isEmpty() }) { "bad file path \"$name\"" }
            files.getJSONObject(name).getLong("size")
        }
        val serial = json.getInt("serial")
        require(serial >= 0) { "serial $serial" }
        val requires = json.optJSONObject("requires")?.let { r ->
            val m = r.getJSONObject("modules")
            Requires(
                registry = r.getInt("registry"),
                bytecode = r.getInt("bytecode"),
                hostApi = r.getInt("hostApi"),
                modules = m.keys().asSequence().associateWith { m.getInt(it) },
            )
        }
        return Info(json.getString("app"), serial, json.getString("id"), json.getString("sha256"), sizes, requires)
    }
}
