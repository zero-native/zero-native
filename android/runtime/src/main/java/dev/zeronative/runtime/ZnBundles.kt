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
 * thread at startup). It changes only when the app applies an update while it runs (`Updates.applyNow()`, step 4.6:
 * [candidate], then [switchTo], while the JS runtime is replaced). Rules:
 * - `zn-ota/current` names the bundle to run. The installer writes it (step 4.5); until then it is written by hand.
 * - A downloaded bundle runs only if its `zn-bundle.json` is readable and has a known format, it is for this app,
 *   its serial is **bigger** than the built-in one (a newer APK always wins), it has every code file the built-in
 *   bundle has, and all its files are there with the sizes it lists, this app covers its `requires`
 *   ([ZnCapabilities]: registry version, bytecode format, host API, native modules), and every id in its templates is
 *   one this app knows ([TemplateReader]; the templates read here are kept for [ZnTemplates]).
 * - Anything else, or any error: the built-in bundle, and the reason is logged. The app always starts.
 * - A bundle blocked by the safety nets ([ZnOtaHealth], step 4.7) never runs: the last good bundle does, if it can.
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
    /**
     * [modules]: needed on both OSes. [os]: modules needed on one OS only ("android" / "ios" → name → version), from
     * Android-only or iOS-only plugins (docs/ota-requires-per-os.md); empty when the bundle has none.
     */
    class Requires(
        val registry: Int,
        val bytecode: Int,
        val hostApi: Int,
        val modules: Map<String, Int>,
        val os: Map<String, Map<String, Int>> = emptyMap(),
    ) {
        companion object {
            /** The OSes a bundle's needs can name, in the signed line's order. */
            val OSES = listOf("android", "ios")

            /** `requires` as zn-bundle.json and the server's manifests write it. */
            fun from(r: JSONObject): Requires {
                fun map(o: JSONObject) = o.keys().asSequence().associateWith { o.getInt(it) }
                val os = r.optJSONObject("os")
                return Requires(
                    registry = r.getInt("registry"),
                    bytecode = r.getInt("bytecode"),
                    hostApi = r.getInt("hostApi"),
                    modules = map(r.getJSONObject("modules")),
                    os = os?.keys()?.asSequence()?.associateWith { map(os.getJSONObject(it)) } ?: emptyMap(),
                )
            }
        }
    }

    /** The bundle this process runs. [dir] is null for the built-in bundle (the APK's assets). */
    class Running(val info: Info?, val dir: File?) {
        val builtIn get() = dir == null
        /**
         * How reports name this bundle: `sample_12@1a2b3c4d5e6f` (id and the first 12 characters of its SHA). The SHA
         * is needed because the APK's own bundle is `<app>_0` in every APK; `bun run ota symbolicate` finds the
         * source map by it (step 4.8). Null for an APK built without `zn-bundle.json`.
         */
        val label: String? get() = info?.let { "${it.id}@${it.sha256.take(12)}" }
        /** For logs: "sample_12 (#12) from files" or "sample_0 (#0) built-in". */
        override fun toString() = "${info ?: "unnamed bundle"} " + if (dir == null) "built-in" else "from files"
    }

    private val watchers = java.util.concurrent.CopyOnWriteArrayList<(String) -> Unit>()
    private val mainHandler by lazy { android.os.Handler(android.os.Looper.getMainLooper()) }

    /**
     * Calls [listener] on the main thread with the running bundle's [Running.label]: once it is chosen (at once if it
     * already is), and again every time it changes while the app runs (an update applied in place, a rollback). For
     * a crash reporter's custom key, so native crashes say which bundle ran too:
     *
     *     ZnBundles.watchRunning { FirebaseCrashlytics.getInstance().setCustomKey("zn_bundle", it) }
     */
    fun watchRunning(listener: (label: String) -> Unit) {
        watchers += listener
        chosen?.label?.let { label -> mainHandler.post { listener(label) } }
    }

    private fun tellWatchers(r: Running) {
        val label = r.label ?: return
        if (watchers.isNotEmpty()) mainHandler.post { for (w in watchers) w(label) }
    }

    @Volatile private var appContext: Context? = null
    /** Template files of the chosen downloaded bundle, already read (and checked) while choosing it. */
    private val preRead = java.util.concurrent.ConcurrentHashMap<String, TemplateFile>()

    /** The APK's assets (app fonts read from the APK, ZnFonts.kt). */
    internal fun apkAssets(): android.content.res.AssetManager =
        checkNotNull(appContext) { "ZnBundles.init() was not called" }.assets

    /** Remembers the app context; does no work. Called by [ZnRuntime.start] and [ZnTemplates.preload]. */
    fun init(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    @Volatile private var chosen: Running? = null

    /** The running bundle if it was chosen already, else null (never does the choosing: safe on the main thread). */
    internal val runningIfChosen: Running? get() = chosen

    /** The bundle this process runs, chosen on first use (reads a few small files). */
    val running: Running
        get() = chosen ?: synchronized(this) {
            chosen ?: choose(checkNotNull(appContext) { "ZnBundles.init() was not called" }).also {
                chosen = it
                tellWatchers(it)
            }
        }

    /** A bundle ready to run in place of the running one (step 4.6): checked, and its template files already read. */
    internal class Candidate(val running: Running, val templates: Map<String, TemplateFile>)

    /**
     * The bundle `current` names now (none: the built-in bundle), checked like at a cold start, for applying it while
     * the app runs. Off the main thread. Throws [ZnOtaError] with the reason if it can't run; nothing is changed.
     */
    internal fun candidate(): Candidate {
        val context = checkNotNull(appContext) { "ZnBundles.init() was not called" }
        val id = File(otaDir(context), "current").takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }
        return candidateFor(id)
    }

    /**
     * Where a rollback goes (step 4.7): the last bundle marked healthy on this phone if it isn't [exclude], isn't
     * blocked and still passes every check; else the built-in bundle. Off the main thread. Never throws.
     */
    internal fun fallbackCandidate(exclude: String?): Candidate {
        val good = ZnOtaHealth.lastGood?.takeIf { it != exclude && !ZnOtaHealth.isBlocked(it) }
        if (good != null) {
            try {
                return candidateFor(good)
            } catch (e: Exception) {
                Log.w(TAG, "bundle: last good bundle $good can't run any more (${e.message}); using the built-in bundle")
                ZnOtaHealth.forgetGood(good)
            }
        }
        return Candidate(Running(builtIn, null), emptyMap())
    }

    /** Bundle [id] (null: the built-in bundle) checked like at a cold start. Throws [ZnOtaError] if it can't run. */
    private fun candidateFor(id: String?): Candidate {
        val context = checkNotNull(appContext) { "ZnBundles.init() was not called" }
        val builtIn = builtIn ?: throw ZnOtaError("apply", "the APK has no $INFO_FILE")
        val ota = otaDir(context)
        if (id == null) return Candidate(Running(builtIn, null), emptyMap())
        if (ZnOtaHealth.isBlocked(id)) throw ZnOtaError("apply", "$id is blocked on this phone")
        val dir = File(ota, "bundles/$id")
        val templates = HashMap<String, TemplateFile>()
        val reason = when (val v = checkBundle(id, builtIn, ZnCapabilities.current()) { File(ota, "bundles/$it") }) {
            is Check.Ok -> readTemplates(dir, v.info, templates) ?: return Candidate(Running(v.info, dir), templates)
            is Check.No -> v.reason
        }
        throw ZnOtaError("apply", "$id can't run: $reason")
    }

    /** Main thread, while the JS runtime is being replaced: from now on the process runs [c]'s files. */
    internal fun switchTo(c: Candidate) {
        synchronized(this) {
            preRead.clear()
            chosen = c.running
        }
        Log.i(TAG, "bundle: now running ${c.running}")
        ZnOtaHealth.onChosen(c.running)
        tellWatchers(c.running)
    }

    /** The OTA folder: not in backups (a restored bundle could be for another app version). */
    internal fun otaDir(context: Context) = File(context.noBackupFilesDir, "zn-ota")

    // ---- Reading bundle files -------------------------------------------------------------------------------------

    /** A file of bundle [r] (default: the running one) mapped into memory, or null if the bundle has no such file. */
    internal fun map(name: String, r: Running = running): ByteBuffer? {
        val dir = r.dir ?: return mapAsset(name)
        val file = File(dir, name)
        if (!file.isFile) return null
        return FileInputStream(file).channel.use { it.map(FileChannel.MapMode.READ_ONLY, 0, it.size()) }
    }

    /** A text file of bundle [r] (default: the running one), or null if the bundle has no such file. */
    internal fun readText(name: String, r: Running = running): String? {
        val dir = r.dir
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

    /** The APK's own bundle (its `zn-bundle.json`), or null if the APK has none: OTA bundles are then off. */
    val builtIn: Info? by lazy {
        val context = checkNotNull(appContext) { "ZnBundles.init() was not called" }
        try {
            context.assets.open(INFO_FILE).bufferedReader().use { parseInfo(it.readText()) }
        } catch (e: Exception) {
            Log.w(TAG, "bundle: no readable $INFO_FILE in the APK (${e.message}); OTA bundles are off")
            null
        }
    }

    private fun choose(context: Context): Running {
        val t0 = System.nanoTime()
        val builtIn = builtIn
        ZnModules.versions() // from now on a late ZnModules.register is reported (it would miss the OTA check)
        val running = try {
            // The safety nets (step 4.7): a new APK, a launch the last process left pending, the startup fuse.
            val off = builtIn != null && ZnOtaHealth.atStart(context)
            val pick = if (off) Running(builtIn, null) else downloaded(context, builtIn) ?: Running(builtIn, null)
            ZnOtaHealth.guardOk()
            pick
        } catch (e: Exception) {
            // Startup guard (docs/ota.md §3.6): whatever went wrong, the built-in bundle runs, and OTA is off in this
            // process (twice in a row: until the next APK install).
            Log.e(TAG, "bundle: choosing failed, running the built-in bundle", e)
            ZnOtaHealth.guardFailed(e)
            Running(builtIn, null)
        }
        Log.i(TAG, "bundle: running $running (${running.label}), chosen in %.2f ms".format((System.nanoTime() - t0) / 1e6))
        ZnOtaHealth.onChosen(running)
        warnMissingModules(running)
        return running
    }

    /**
     * R31 (2026-11-05): the running bundle needs a native module that no plugin registered, for example a plugin added
     * in Gradle but not in `ZnPlugins.register(...)`. Its calls fail with "unavailable" and nothing else says why, so
     * log one clear error, and in a debug build show it on the dev error screen too. The app still starts. (A downloaded
     * bundle with a missing module never gets here: the OTA check refuses it. This catches the APK's own bundle.)
     */
    private fun warnMissingModules(running: Running) {
        val needs = running.info?.requires?.modules ?: return
        val have = ZnModules.versions()
        val missing = needs.filter { (name, version) -> (have[name] ?: 0) < version }
        if (missing.isEmpty()) return
        val list = missing.entries.joinToString { (name, version) ->
            have[name]?.let { "$name v$version (this app has v$it)" } ?: name
        }
        val message = "the bundle needs native modules this app didn't register: $list. Add the plugin to " +
            "ZnPlugins.register(...) in Application.onCreate (its README has the line). Until then its calls fail " +
            "with \"unavailable\"."
        Log.e(TAG, "bundle: $message")
        if (BuildConfig.DEBUG) android.os.Handler(android.os.Looper.getMainLooper()).post { ZnDev.onJsError("native modules missing\n$message") }
    }

    /**
     * The downloaded bundle named by `current`, if it may run; null if not. A blocked bundle (step 4.7) never runs, and
     * neither does one that fails its checks (H.4): the last good bundle runs instead if it can, and becomes `current`.
     * With no last good bundle, `current` goes and the APK's bundle runs. A bundle that can't run is reported once.
     */
    private fun downloaded(context: Context, builtIn: Info?): Running? {
        val ota = otaDir(context)
        val current = File(ota, "current")
        var id = current.takeIf { it.isFile }?.readText()?.trim() ?: return null
        if (builtIn == null) return null
        if (ZnOtaHealth.isBlocked(id)) {
            val good = ZnOtaHealth.lastGood?.takeIf { it != id && !ZnOtaHealth.isBlocked(it) }
            Log.w(TAG, "bundle: $id is blocked on this phone; running ${good ?: "the built-in bundle"}")
            if (good == null) {
                current.delete()
                return null
            }
            ZnOtaInstall.writeAtomic(current, good)
            id = good
        }
        val caps = ZnCapabilities.current()
        val no = when (val v = tryBundle(ota, id, builtIn, caps)) {
            is Check.Ok -> return Running(v.info, File(ota, "bundles/$id"))
            is Check.No -> v
        }
        val reason = no.reason
        if (no.superseded) {
            Log.i(TAG, "bundle: not running $id: $reason (a store update came after it)")
            ZnOtaHealth.superseded(id, reason)
        } else {
            Log.w(TAG, "bundle: not running $id: $reason (this app: $caps)")
            ZnOtaHealth.unusable(id, reason)
        }
        if (ZnOtaHealth.lastGood == id) ZnOtaHealth.forgetGood(id)
        val good = ZnOtaHealth.lastGood?.takeIf { !ZnOtaHealth.isBlocked(it) }
        if (good != null) {
            val v = tryBundle(ota, good, builtIn, caps)
            if (v is Check.Ok) {
                Log.w(TAG, "bundle: running the last good bundle $good instead")
                ZnOtaInstall.writeAtomic(current, good)
                return Running(v.info, File(ota, "bundles/$good"))
            }
            ZnOtaHealth.forgetGood(good)
        }
        Log.w(TAG, "bundle: running the built-in bundle")
        current.delete()
        return null
    }

    /** Runs every check on bundle [id], and keeps its template files for the start if it passes. */
    private fun tryBundle(ota: File, id: String, builtIn: Info, caps: ZnCapabilities): Check {
        val v = checkBundle(id, builtIn, caps) { File(ota, "bundles/$it") }
        if (v !is Check.Ok) return v
        val problem = readTemplates(File(ota, "bundles/$id"), v.info, preRead) ?: return v
        preRead.clear()
        return Check.No(problem)
    }

    /**
     * Reads every template file of a downloaded bundle; [TemplateReader] refuses ids this app doesn't know. This is the
     * safety net under the build's `requires`: a mistake there costs one refused update, never a wrong screen.
     * Returns why the bundle can't run, or null (the files are then kept in [into]).
     */
    private fun readTemplates(dir: File, info: Info, into: MutableMap<String, TemplateFile>): String? {
        for (name in info.files.keys.filter { it.endsWith(".zn.ui") }) {
            try {
                val buffer = FileInputStream(File(dir, name)).channel.use { it.map(FileChannel.MapMode.READ_ONLY, 0, it.size()) }
                into[name] = TemplateReader.read(buffer)
            } catch (e: Exception) {
                into.clear()
                return "its templates use something this app doesn't have ($name: ${e.message})"
            }
        }
        return null
    }

    /** Whether a downloaded bundle may run: [Ok] with its info, or [No] with the reason (for the log). */
    internal sealed interface Check {
        class Ok(val info: Info) : Check
        /**
         * [superseded]: nothing is wrong with it, the APK's own bundle is the same or newer (a store update came after
         * this OTA bundle). Normal, so not reported as a problem (Crashlytics non-fatal on the Lava, 2026-11-09).
         */
        class No(val reason: String, val superseded: Boolean = false) : Check
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
        if (info.serial <= builtIn.serial) return Check.No("the built-in bundle #${builtIn.serial} is the same or newer", superseded = true)
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
        val requires = json.optJSONObject("requires")?.let { Requires.from(it) }
        return Info(json.getString("app"), serial, json.getString("id"), json.getString("sha256"), sizes, requires)
    }
}
