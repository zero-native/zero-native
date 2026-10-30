package dev.zeronative.runtime

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * The update client (step 4.5, docs/ota.md §3.5). Apps turn it on in Application.onCreate:
 *
 *     ZnOta.configure(this, ZnOta.Config(
 *         server = "https://updates.example.com", channel = "production",
 *         publicKeys = listOf(MAIN_KEY, BACKUP_KEY)))
 *
 * It checks a few seconds after the app comes on screen and when it returns to the foreground (at most every
 * [Config.checkIntervalMs]); never for a start without UI (a push, a background job). One check at a time, on its own
 * thread. A downloaded bundle is verified ([ZnOtaInstall]), installed into its own folder and becomes `current`; it runs
 * from the **next cold start** ([ZnBundles] reads `current` once per process). Switching while the app runs is step 4.6.
 *
 * Rules the phone keeps whatever the server says:
 * - a pointer counts only if its signature is valid, it is for this app and channel, and its seq is above the highest
 *   seq this phone accepted (so an old answer can't be replayed);
 * - an action that changes the bundle (update, switch, kill switch) needs such a pointer naming that bundle;
 * - a seq is saved only once its action is done (a failed download is retried with the same signed pointer);
 * - the bundle must be signed, fit this app, and be newer than the APK's own bundle.
 * Files under `noBackupFilesDir/zn-ota/`: `current`, `state.json`, `bundles/<id>/`, `download.part` (+ `.json`), `tmp/`.
 */
object ZnOta {
    private const val TAG = "zn-ota"
    /** Downloaded bundles kept besides the running and the current one, newest first: going back downloads nothing. */
    private const val KEEP = 4
    private const val MAX_OUTCOMES = 20

    class Config(
        /** The update server's base URL (the reference server: `bun run ota serve`). */
        val server: String,
        /** "production", "staging", ... */
        val channel: String,
        /** Trusted public keys, base64 SPKI DER: the main key first, the offline backup key second. */
        val publicKeys: List<String>,
        /** Least time between two automatic checks (on returning to the foreground). */
        val checkIntervalMs: Long = 5 * 60_000L,
        /** Wait after the app comes on screen before the first check, so startup is never slowed. */
        val firstCheckDelayMs: Long = 3_000L,
    )

    @Volatile private var config: Config? = null
    private lateinit var appContext: Context
    /** Made on first use: an app that never configures OTA gets no thread. */
    private val worker by lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "zn-ota").apply { isDaemon = true } } }
    private val main = Handler(Looper.getMainLooper())
    private val stateLock = Any()

    @Volatile private var phase = "off"
    @Volatile private var progress = 0.0
    @Volatile private var lastAutoCheck = 0L
    @Volatile private var checkQueued = false

    /** Turns the client on. Main process only (an SDK's extra process never checks). Call once, in Application.onCreate. */
    fun configure(context: Context, config: Config) {
        if (!ZnProcess.isMain(context)) return
        require(config.publicKeys.isNotEmpty()) { "ZnOta needs at least one public key" }
        require(config.server.startsWith("https://") || config.server.startsWith("http://")) { "ZnOta server must be an http(s) URL" }
        require(Regex("^[a-z][a-z0-9-]{0,31}$").matches(config.channel)) { "ZnOta channel \"${config.channel}\": use a-z, 0-9 and -" }
        appContext = context.applicationContext
        ZnBundles.init(appContext)
        this.config = config
        phase = "idle"
        // Checks follow the UI: an Activity coming on screen (the app's first, or back from the background).
        (appContext as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            private var started = 0
            override fun onActivityStarted(activity: Activity) {
                if (started++ == 0) maybeAutoCheck()
            }
            override fun onActivityStopped(activity: Activity) {
                started = (started - 1).coerceAtLeast(0)
            }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }

    private fun maybeAutoCheck() {
        val c = config ?: return
        val now = SystemClock.elapsedRealtime()
        if (checkQueued || (lastAutoCheck != 0L && now - lastAutoCheck < c.checkIntervalMs)) return
        lastAutoCheck = now
        checkQueued = true
        // A few seconds after the app comes on screen: never in the way of startup or of the screen opening.
        main.postDelayed({ worker.execute { checkQueued = false; runCheck() } }, c.firstCheckDelayMs)
    }

    /** Runs a check now (on the client's thread); [done] gets the result on that thread. */
    fun check(done: (JSONObject) -> Unit = {}) {
        worker.execute { done(runCheck()) }
    }

    // ---- Status (also for JS: Updates.status / onStatus) ----------------------------------------------------------

    /**
     * phase: off / idle / checking / downloading / installing / failed; running: the bundle running now (null = the
     * APK's); next: what runs from the next cold start; pendingRestart: they differ.
     */
    fun status(): JSONObject {
        val c = config ?: return JSONObject().put("enabled", false).put("phase", "off")
        val running = ZnBundles.running.let { if (it.builtIn) null else it.info?.id }
        val next = currentFile().takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }
        val st = synchronized(stateLock) { loadState() }
        return JSONObject()
            .put("enabled", true)
            .put("phase", phase)
            .put("progress", progress)
            .put("channel", c.channel)
            .put("running", running ?: JSONObject.NULL)
            .put("builtIn", ZnBundles.builtIn?.id ?: JSONObject.NULL)
            .put("next", next ?: JSONObject.NULL)
            .put("pendingRestart", next != running)
            .put("lastCheckAt", if (st.lastCheckAt > 0) st.lastCheckAt else JSONObject.NULL)
            .put("lastResult", st.lastResult ?: JSONObject.NULL)
            .put("lastError", st.lastError ?: JSONObject.NULL)
    }

    private fun setPhase(p: String, prog: Double = 0.0) {
        phase = p
        progress = prog
        if (ZnRuntime.isStarted) ZnModules.emit("Updates", "status", status(), latestOnly = true)
    }

    // ---- The check ------------------------------------------------------------------------------------------------

    private fun ota() = ZnBundles.otaDir(appContext)
    private fun currentFile() = File(ota(), "current")

    /** One check, start to end. Never throws: problems become the result and an outcome for telemetry. */
    private fun runCheck(): JSONObject {
        val c = config ?: return JSONObject().put("action", "NONE").put("reason", "OFF")
        val t0 = SystemClock.elapsedRealtime()
        val st = synchronized(stateLock) { loadState() }
        return try {
            val builtIn = ZnBundles.builtIn ?: throw ZnOtaError("setup", "the APK has no zn-bundle.json")
            setPhase("checking")
            noteRunning(st)
            val answer = post(c, builtIn, st)
            st.outcomes.clear() // they reached the server
            val result = act(c, builtIn, st, answer)
            st.lastCheckAt = System.currentTimeMillis()
            st.lastResult = "${result.getString("action")} ${result.getString("reason")}"
            st.lastError = null
            synchronized(stateLock) { saveState(st) }
            setPhase("idle")
            Log.i(TAG, "check ${c.channel}: ${st.lastResult} in ${SystemClock.elapsedRealtime() - t0} ms")
            result
        } catch (e: Exception) {
            val code = (e as? ZnOtaError)?.code ?: "failed"
            Log.w(TAG, "check failed ($code): ${e.message}")
            synchronized(stateLock) {
                outcome(st, code, null, e.message)
                st.lastCheckAt = System.currentTimeMillis()
                st.lastError = "$code: ${e.message}"
                saveState(st)
            }
            setPhase("failed")
            JSONObject().put("action", "NONE").put("reason", "ERROR").put("error", "$code: ${e.message}")
        }
    }

    /** The phone's request (docs/ota.md §3.4) and the server's answer. */
    private fun post(c: Config, builtIn: ZnBundles.Info, st: State): JSONObject {
        val running = ZnBundles.running
        val caps = ZnCapabilities.current()
        val body = JSONObject()
            .put("app", builtIn.app)
            .put("channel", c.channel)
            .put("installId", st.installId)
            .put("capabilities", JSONObject().put("registry", caps.registry).put("bytecode", caps.bytecode)
                .put("hostApi", caps.hostApi).put("hostApiOldest", caps.hostApiOldest).put("modules", JSONObject(caps.modules)))
            .put("running", if (running.builtIn) JSONObject.NULL else JSONObject().put("id", running.info!!.id).put("sha256", running.info.sha256))
            .put("builtIn", JSONObject().put("id", builtIn.id).put("serial", builtIn.serial))
            .put("kept", JSONArray(keptBundles(builtIn, caps).take(16)))
            .put("seq", st.seq(c.channel))
            .put("outcomes", JSONArray(st.outcomes.toList()))
        val request = Request.Builder()
            .url(c.server.trimEnd('/') + "/v1/check")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        ZnFetch.client.newCall(request).execute().use { r ->
            if (!r.isSuccessful) throw ZnOtaError("server", "check answered HTTP ${r.code}")
            val text = r.body.string()
            if (text.length > 256 * 1024) throw ZnOtaError("server", "check answer too big")
            return JSONObject(text)
        }
    }

    /** Does what the answer says, after checking everything signed. Returns { action, reason, bundle? }. */
    private fun act(c: Config, builtIn: ZnBundles.Info, st: State, answer: JSONObject): JSONObject {
        val action = answer.optString("action", "NONE")
        val reason = answer.optString("reason", "")
        val result = JSONObject().put("action", action).put("reason", reason)
        val pointer = answer.optJSONObject("pointer")?.let(ZnOtaInstall::parsePointer)
        val accepted = pointer != null && pointer.app == builtIn.app && pointer.channel == c.channel &&
            pointer.seq > st.seq(c.channel) && ZnOtaInstall.verifyPointer(pointer, c.publicKeys)
        if (pointer != null && !accepted) {
            // An old answer, another app's or channel's pointer, or a bad signature: ignore the whole answer.
            outcome(st, "pointer_refused", pointer.target, "seq ${pointer.seq}, phone has ${st.seq(c.channel)}")
            return result.put("action", "NONE").put("reason", "POINTER_REFUSED")
        }
        when (action) {
            "NONE" -> if (accepted) {
                // Nothing to download, but the signed pointer still says what must run next. A bundle installed and
                // waiting for the next start must not start after a kill switch or a rollback (the server only
                // sees what runs now).
                val running = ZnBundles.running
                when {
                    pointer!!.target == ZnOtaSignature.BUILT_IN || reason == "APK_NEWER" -> currentFile().delete()
                    reason == "UP_TO_DATE" -> if (running.builtIn) currentFile().delete()
                        else ZnOtaInstall.writeAtomic(currentFile(), running.info!!.id)
                }
                st.setSeq(c.channel, pointer.seq)
            }
            "BUILT_IN" -> {
                val p = pointer ?: throw ZnOtaError("pointer", "BUILT_IN without a signed pointer")
                val serial = p.target.substringAfterLast('_').toIntOrNull()
                if (p.target != ZnOtaSignature.BUILT_IN && (serial == null || serial > builtIn.serial)) {
                    throw ZnOtaError("pointer", "BUILT_IN, but the pointer names ${p.target}")
                }
                currentFile().delete()
                st.setSeq(c.channel, p.seq)
                outcome(st, "switched", "built-in", reason)
            }
            "USE_LOCAL", "UPDATE" -> {
                val p = pointer ?: throw ZnOtaError("pointer", "$action without a signed pointer")
                val m = answer.optJSONObject("bundle")?.let(ZnOtaInstall::parseManifest) ?: throw ZnOtaError("bundle", "$action without a bundle")
                if (m.id != p.target || m.app != builtIn.app) throw ZnOtaError("bundle", "the bundle ${m.id} isn't what the pointer names (${p.target})")
                if (!ZnOtaInstall.verifyManifest(m, c.publicKeys)) throw ZnOtaError("signature", "bad bundle signature on ${m.id}")
                if (m.serial <= builtIn.serial) throw ZnOtaError("bundle", "${m.id} isn't newer than the APK's own #${builtIn.serial}")
                ZnCapabilities.current().missing(m.requires)?.let { throw ZnOtaError("incompatible", it) }
                if (action == "UPDATE") install(c, m) else switchTo(builtIn, m)
                st.setSeq(c.channel, p.seq)
                outcome(st, if (action == "UPDATE") "downloaded" else "switched", m.id, null)
                result.put("bundle", m.id)
                prune(builtIn)
            }
        }
        return result
    }

    private fun switchTo(builtIn: ZnBundles.Info, m: ZnOtaInstall.Manifest) {
        val check = ZnBundles.checkBundle(m.id, builtIn, ZnCapabilities.current()) { File(ota(), "bundles/$it") }
        if (check !is ZnBundles.Check.Ok || check.info.sha256 != m.bundleSha256) throw ZnOtaError("local", "kept ${m.id} can't be used")
        ZnOtaInstall.writeAtomic(currentFile(), m.id)
    }

    // ---- Download and install -------------------------------------------------------------------------------------

    private fun install(c: Config, m: ZnOtaInstall.Manifest) {
        val running = ZnBundles.running
        if (!running.builtIn && running.info?.id == m.id) throw ZnOtaError("install", "${m.id} is running already")
        val zip = download(c, m)
        setPhase("installing")
        val tmp = File(ota(), "tmp").apply { deleteRecursively() }
        val staged = File(tmp, m.id)
        ZnOtaInstall.extract(zip, m, staged)
        val dest = File(ota(), "bundles/${m.id}")
        dest.parentFile!!.mkdirs()
        if (dest.exists()) dest.deleteRecursively() // a copy left by an earlier install of the same bytes (ids never change)
        if (!staged.renameTo(dest)) throw ZnOtaError("install", "can't move ${m.id} into place")
        ZnOtaInstall.writeAtomic(currentFile(), m.id) // the last step: until here the old bundle stays current
        zip.delete()
        File(ota(), "download.json").delete()
        tmp.deleteRecursively()
        Log.i(TAG, "installed ${m.id}; it runs from the next start")
    }

    /** Downloads the bundle's zip to `download.part`, resuming a cut download of the same zip. Returns the checked file. */
    private fun download(c: Config, m: ZnOtaInstall.Manifest): File {
        val part = File(ota(), "download.part")
        val partInfo = File(ota(), "download.json")
        val same = partInfo.isFile && runCatching { JSONObject(partInfo.readText()).getString("sha256") }.getOrNull() == m.zipSha256
        if (!same || part.length() > m.zipSize) {
            part.delete()
            ZnOtaInstall.writeAtomic(partInfo, JSONObject().put("sha256", m.zipSha256).put("size", m.zipSize).toString())
        }
        var have = if (part.isFile) part.length() else 0L
        if (have < m.zipSize) {
            setPhase("downloading", have.toDouble() / m.zipSize)
            val url = c.server.toHttpUrl().resolve(m.url) ?: throw ZnOtaError("bundle", "bad download url ${m.url}")
            val request = Request.Builder().url(url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
            if (have > 0) Log.i(TAG, "resuming ${m.id} at $have of ${m.zipSize} bytes")
            ZnFetch.client.newCall(request).execute().use { r ->
                val append = when {
                    r.code == 206 && r.header("Content-Range")?.startsWith("bytes $have-") == true -> true
                    r.code == 200 -> false
                    else -> throw ZnOtaError("download", "download answered HTTP ${r.code}")
                }
                if (!append) have = 0
                FileOutputStream(part, append).use { out ->
                    r.body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        var lastReport = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            have += n
                            if (have > m.zipSize) throw ZnOtaError("download", "the download is bigger than its ${m.zipSize} bytes")
                            out.write(buf, 0, n)
                            if (have - lastReport >= 64 * 1024) {
                                lastReport = have
                                setPhase("downloading", have.toDouble() / m.zipSize)
                            }
                        }
                    }
                    out.fd.sync()
                }
            }
        }
        if (part.length() != m.zipSize || ZnOtaInstall.sha256(part) != m.zipSha256) {
            part.delete()
            partInfo.delete()
            throw ZnOtaError("zip_sha", "the downloaded zip doesn't match the signed manifest")
        }
        return part
    }

    /** Installed bundles this app can still run (sent as `kept`), newest first. */
    private fun keptBundles(builtIn: ZnBundles.Info, caps: ZnCapabilities): List<String> {
        val dirs = File(ota(), "bundles").listFiles()?.filter { it.isDirectory } ?: return emptyList()
        return dirs.mapNotNull { d ->
            (ZnBundles.checkBundle(d.name, builtIn, caps) { File(ota(), "bundles/$it") } as? ZnBundles.Check.Ok)?.info
        }.sortedByDescending { it.serial }.map { it.id }
    }

    /** Keeps the running bundle, the current one and the newest [KEEP] others; deletes the rest. */
    private fun prune(builtIn: ZnBundles.Info) {
        val dirs = File(ota(), "bundles").listFiles()?.filter { it.isDirectory } ?: return
        val keep = HashSet<String>()
        ZnBundles.running.let { if (!it.builtIn) it.info?.id?.let(keep::add) }
        currentFile().takeIf { it.isFile }?.readText()?.trim()?.let(keep::add)
        dirs.map { it.name }.filter { it.startsWith("${builtIn.app}_") }
            .sortedByDescending { it.substringAfterLast('_').toIntOrNull() ?: -1 }
            .filterNot { it in keep }.take(KEEP).let(keep::addAll)
        for (d in dirs) if (d.name !in keep) {
            d.deleteRecursively()
            Log.i(TAG, "deleted old bundle ${d.name}")
        }
    }

    // ---- State: install id, seq per channel, outcomes not yet sent --------------------------------------------------

    private class State(
        var installId: String,
        val seqs: JSONObject,
        val outcomes: MutableList<JSONObject>,
        var lastRunning: String?,
        var lastCheckAt: Long,
        var lastResult: String?,
        var lastError: String?,
    ) {
        fun seq(channel: String) = seqs.optLong(channel, 0L)
        fun setSeq(channel: String, seq: Long) {
            seqs.put(channel, seq)
        }
    }

    private fun stateFile() = File(ota(), "state.json")

    private fun loadState(): State {
        val j = runCatching { JSONObject(stateFile().readText()) }.getOrNull() ?: JSONObject()
        val outcomes = j.optJSONArray("outcomes")?.let { a -> MutableList(a.length()) { a.getJSONObject(it) } } ?: mutableListOf()
        val id = j.optString("installId").ifEmpty { UUID.randomUUID().toString() }
        return State(id, j.optJSONObject("seq") ?: JSONObject(), outcomes, j.optString("lastRunning").ifEmpty { null },
            j.optLong("lastCheckAt", 0L), j.optString("lastResult").ifEmpty { null }, j.optString("lastError").ifEmpty { null })
    }

    private fun saveState(st: State) {
        val j = JSONObject().put("installId", st.installId).put("seq", st.seqs).put("outcomes", JSONArray(st.outcomes.takeLast(MAX_OUTCOMES)))
            .put("lastRunning", st.lastRunning ?: "").put("lastCheckAt", st.lastCheckAt)
            .put("lastResult", st.lastResult ?: "").put("lastError", st.lastError ?: "")
        ZnOtaInstall.writeAtomic(stateFile(), j.toString())
    }

    private fun outcome(st: State, kind: String, bundle: String?, detail: String?) {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val o = JSONObject().put("kind", kind).put("at", iso.format(Date()))
        if (bundle != null) o.put("bundle", bundle)
        if (detail != null) o.put("detail", detail.take(300))
        st.outcomes += o
    }

    /** Reports, once, that a new bundle started running (installed earlier, applied at this cold start). */
    private fun noteRunning(st: State) {
        val now = ZnBundles.running.let { if (it.builtIn) "built-in ${it.info?.id}" else it.info?.id }
        if (now != st.lastRunning) {
            if (st.lastRunning != null) outcome(st, "started", now, "was ${st.lastRunning}")
            st.lastRunning = now
        }
    }

    // ---- JS: the built-in Updates module (packages/core/src/updates.ts) ---------------------------------------------

    internal object Module : ZnModuleBase("Updates", version = 1) {
        init {
            function("status") { call -> call.resolve(status()) }
            function("check") { call ->
                if (config == null) return@function call.resolve(JSONObject().put("action", "NONE").put("reason", "OFF"))
                check { result -> call.resolve(result.put("status", status())) }
            }
        }
    }
}

