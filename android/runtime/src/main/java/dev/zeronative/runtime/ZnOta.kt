package dev.zeronative.runtime

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.ui.graphics.Color
import java.io.File
import java.io.FileOutputStream
import java.io.InterruptedIOException
import java.text.SimpleDateFormat
import java.util.Collections
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
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
 * from the **next cold start** ([ZnBundles] reads `current` once per process), or at once if the app calls [applyNow]
 * (`Updates.applyNow()`; step 4.6), which JS can hold off (`Updates.holdApply()`) during a payment or a form.
 *
 * Rules the phone keeps whatever the server says:
 * - a pointer counts only if its signature is valid, it is for this app and channel, and its seq is above the highest
 *   seq this phone accepted (so an old answer can't be replayed);
 * - an action that changes the bundle (update, switch, kill switch) needs such a pointer naming that bundle;
 * - a seq is saved only once its action is done (a failed download is retried with the same signed pointer);
 * - the bundle must be signed, fit this app, and be newer than the APK's own bundle.
 *
 * Safety nets (step 4.7, docs/ota.md §3.6, [ZnOtaHealth]): a downloaded bundle counts as healthy once its first
 * screens were up [Config.healthyAfterMs] in the foreground (or JS calls `Updates.markHealthy()`). Before that, an
 * error screen, or first screens not up within [Config.firstScreenTimeoutMs], blocks it and rolls back in place to the
 * last healthy bundle (or the APK's); launches ended by a crash or a freeze block it after two in a row. Every outcome
 * reaches the server with the next check and [Config.onReport] at once.
 * Files under `noBackupFilesDir/zn-ota/`: `current`, `state.json`, `health.json`, `bundles/<id>/`, `download.part`
 * (+ `.json`), `tmp/`.
 */
object ZnOta {
    private const val TAG = "zn-ota"
    /** Downloaded bundles kept besides the running and the current one, newest first: going back downloads nothing. */
    private const val KEEP = 4
    private const val MAX_OUTCOMES = 20
    /** The check is a small JSON answer: this limit covers the whole call. */
    private const val CHECK_TIMEOUT_MS = 30_000L
    private const val MAX_CHECK_ANSWER = 256 * 1024L
    /** The download has no total limit, so a slow one that still moves is fine. This is the longest gap between bytes. */
    private const val DOWNLOAD_IDLE_TIMEOUT_MS = 60_000L

    class Config(
        /** The update server's base URL (the reference server: `bun run ota serve`). */
        val server: String,
        /** "production", "staging", ... */
        val channel: String,
        /** Trusted public keys, base64 SPKI DER: the main key first, the offline backup key second. */
        val publicKeys: List<String>,
        /**
         * Least time between two automatic checks (on returning to the foreground). 0: a check on every return (an
         * app whose store update rules must reach phones at once), at most one per [minCheckGapMs].
         */
        val checkIntervalMs: Long = 5 * 60_000L,
        /**
         * Two automatic checks are never closer than this, whatever [checkIntervalMs] says: the launch gate's check at
         * a cold start counts as that start's check, and a quick back-and-forth (a UPI app that closes in 2 s) makes
         * one call. 0: no floor, the app's [checkIntervalMs] alone decides (a cold start then makes two calls).
         */
        val minCheckGapMs: Long = 5_000L,
        /** Wait after the app comes on screen before the first check, so startup is never slowed. */
        val firstCheckDelayMs: Long = 3_000L,
        /**
         * A downloaded bundle is healthy once its first screens were up this long while the app is in the foreground
         * (step 4.7). 0: only when JS calls `Updates.markHealthy()` (for an app whose first screen loads its data).
         */
        val healthyAfterMs: Long = 4_000L,
        /** A downloaded bundle whose first screens aren't up this long after the app came on screen is rolled back. */
        val firstScreenTimeoutMs: Long = 10_000L,
        /**
         * Hears every outcome on the main thread: updates, rollbacks, blocked bundles, failed checks. Where an app logs
         * to Crashlytics (for example `recordException` when [ZnOtaReport.serious]); they also reach the server.
         */
        val onReport: ((ZnOtaReport) -> Unit)? = null,
        /**
         * Runs on a JS error's text before it is stored or sent, after the built-in masks ([ZnOtaHealth.Rules.mask]): for
         * private data only your app knows the shape of. Keep it fast and simple. If it throws, the masked text is used.
         */
        val redact: ((String) -> String)? = null,
        /**
         * A release build may use an `http://` server only with this on (a test against a server on this computer).
         * Off: a release build with an http server turns OTA off and logs why (2026-11-09, zn-updates P2).
         */
        val allowHttpInRelease: Boolean = false,
        /**
         * The launch gate (docs/ota-patches.md §8, [ZnOtaGate]): at a start with UI the check runs at once, and the
         * launch screen waits for its answer at most this long from the tap. 0 turns the gate off (updates then run
         * from the next cold start, or when JS calls `Updates.applyNow()`).
         */
        val launchDecisionMs: Long = 800L,
        /** A priority high update swaps at the update screen only within this time from the tap (RN: 4 s). */
        val launchCapMs: Long = 4_000L,
        /** The same for priority critical (and the kill switch) (RN: 5.8 s). */
        val launchCapCriticalMs: Long = 5_800L,
        /** How the update screen looks: its words and the brand colour of its progress bar. */
        val updateScreen: ZnUpdateScreen = ZnUpdateScreen(),
    )

    @Volatile private var config: Config? = null
    private lateinit var appContext: Context
    /** Made on first use: an app that never configures OTA gets no thread. */
    private val worker by lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "zn-ota").apply { isDaemon = true } } }
    // ZnFetch's client has no read limit (each fetch sets its own). Without these, a server that accepts and never
    // answers would block [worker] for good: no more checks, and applyNow would never answer.
    // Read per call (ZnFetch.derived): after a Wi-Fi ↔ mobile change they are built again on the fresh pool.
    private val checkClient get() = ZnFetch.derived("zn.otaCheck") { it.callTimeout(CHECK_TIMEOUT_MS, TimeUnit.MILLISECONDS) }
    private val downloadClient get() = ZnFetch.derived("zn.otaDownload") { it.readTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS) }
    private val main = Handler(Looper.getMainLooper())
    private val stateLock = Any()
    private val reportListeners = java.util.concurrent.CopyOnWriteArrayList<(ZnOtaReport) -> Unit>()

    /**
     * Like [Config.onReport], but any number of them, so a plugin (plugins/firebase-crashlytics) and the app can both listen.
     * Called after `onReport`, on the main thread. Can be added before [configure]. Returns a function that removes it.
     */
    fun addReportListener(listener: (ZnOtaReport) -> Unit): () -> Unit {
        reportListeners += listener
        return { reportListeners -= listener }
    }

    @Volatile private var storeLauncher: ZnStoreLauncher? = null

    /** For a plugin that opens the store's own update screen at launch ([ZnStoreLauncher]). One per app; null removes it. */
    fun setStoreLauncher(launcher: ZnStoreLauncher?) {
        storeLauncher = launcher
    }

    /**
     * From the [ZnStoreLauncher], main thread: it is done with this launch. [opened]: the store's update screen opened
     * (the app opens under it). false: it won't open one now ([why] is logged); the app opens if it was waiting for it.
     */
    fun storeLaunchDone(opened: Boolean, why: String) = ZnOtaGate.storeDone(opened, why)

    /** For [ZnOtaGate]. */
    internal fun storeLauncherOrNull(): ZnStoreLauncher? = storeLauncher

    /** For [ZnOtaGate]: this APK's last store answer, read from the saved state. */
    internal fun savedStoreUpdate(): ZnStoreUpdate? =
        ZnOtaStore.update(synchronized(stateLock) { loadState() }.storeAnswer(apkVersion()))

    @Volatile private var phase = "off"
    @Volatile private var progress = 0.0
    @Volatile private var lastAutoCheck = 0L
    @Volatile private var checkQueued = false
    /** Client thread: the clean-up after a new APK install was done in this process. */
    private var apkCleaned = false

    /** Turns the client on. Main process only (an SDK's extra process never checks). Call once, in Application.onCreate. */
    fun configure(context: Context, config: Config) {
        if (!ZnProcess.isMain(context)) return
        require(config.publicKeys.isNotEmpty()) { "ZnOta needs at least one public key" }
        require(config.server.startsWith("https://") || config.server.startsWith("http://")) { "ZnOta server must be an http(s) URL" }
        require(Regex("^[a-z][a-z0-9-]{0,31}$").matches(config.channel)) { "ZnOta channel \"${config.channel}\": use a-z, 0-9 and -" }
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (config.server.startsWith("http://") && !debuggable && !config.allowHttpInRelease) {
            // Release builds talk to the update server over HTTPS only. The signatures still stop a wrong bundle over
            // plain HTTP, but anyone on the way could read every check or block updates.
            Log.e(TAG, "OTA is off: a release build needs an https:// server, not ${config.server} (or Config.allowHttpInRelease for a local test)")
            return
        }
        appContext = context.applicationContext
        ZnBundles.init(appContext)
        this.config = config
        phase = "idle"
        // Checks and the safety nets follow the UI: an Activity coming on screen (the app's first, or back from the
        // background), and the last one leaving it (not a rotation: that Activity comes back at once).
        (appContext as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            private var started = 0
            override fun onActivityStarted(activity: Activity) {
                if (started++ == 0) {
                    onFront()
                    maybeAutoCheck()
                }
            }
            override fun onActivityStopped(activity: Activity) {
                started = (started - 1).coerceAtLeast(0)
                if (started == 0 && !activity.isChangingConfigurations) onBack()
            }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
                // The first Activity of this process: a cold start with UI. The launch gate checks now (ZnOtaGate).
                if (launchSeen) return
                launchSeen = true
                ZnOtaGate.beginCold(::checkForGate)
            }
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        deliverSoon() // safety-net events noted before OTA was turned on
    }

    private fun maybeAutoCheck() {
        val c = config ?: return
        val now = SystemClock.elapsedRealtime()
        if (checkQueued || (lastAutoCheck != 0L && now - lastAutoCheck < maxOf(c.checkIntervalMs, c.minCheckGapMs))) return
        lastAutoCheck = now
        checkQueued = true
        // A few seconds after the app comes on screen: never in the way of startup or of the screen opening.
        main.postDelayed({ worker.execute { checkQueued = false; runCheck() } }, c.firstCheckDelayMs)
    }

    /** Main thread: an Activity of this process was created already (the launch gate runs once per process). */
    private var launchSeen = false

    /** Main thread: the launch gate's check, at once. It counts as the automatic check of this time on screen. */
    private fun checkForGate() {
        lastAutoCheck = SystemClock.elapsedRealtime()
        worker.execute { runCheck(forGate = true) }
    }

    /** For [ZnOtaGate]: the config, or null while OTA is off. */
    internal fun configOrNull(): Config? = config

    /**
     * For [ZnOtaGate]: how long the app theme's animated launch icon plays (Android 12+
     * `windowSplashScreenAnimationDuration`), 0 when it has none.
     */
    internal fun launchIconMs(): Long {
        if (android.os.Build.VERSION.SDK_INT < 31) return 0L
        val a = appContext.theme.obtainStyledAttributes(intArrayOf(android.R.attr.windowSplashScreenAnimationDuration))
        return try { a.getInt(0, 0).toLong().coerceIn(0L, 2_000L) } finally { a.recycle() }
    }

    /** For [ZnOtaGate]: the phase ("downloading", "installing", ...) and the download progress 0..1. */
    internal fun phaseAndProgress(): Pair<String, Double> = phase to progress

    /** For [ZnOtaGate]: an outcome for the next check, about the bundle that runs now. Any thread. */
    internal fun gateOutcome(kind: String, detail: String) {
        if (config == null) return
        worker.execute { record(kind, ZnBundles.running.key() ?: "built-in", detail, running = null) }
    }

    /**
     * 0 normal, 1 high, 2 critical (docs/ota-patches.md §7). Not signed, like rollout. A kill switch is always critical.
     */
    private fun priorityOf(p: ZnOtaInstall.Pointer?): Int = when {
        p == null -> 0
        p.target == ZnOtaSignature.BUILT_IN || p.priority == "critical" -> 2
        p.priority == "high" -> 1
        else -> 0
    }

    /** Runs a check now (on the client's thread); [done] gets the result on that thread. */
    fun check(done: (JSONObject) -> Unit = {}) {
        worker.execute { done(runCheck()) }
    }

    /**
     * The OTA app id (the APK's own bundle's) and the configured channel, or null while OTA is off or the APK has no
     * bundle info. Read-only, for plugins (the push plugin's FCM topic `zn-ota-<app>-<channel>`).
     */
    fun appAndChannel(): Pair<String, String>? {
        val c = config ?: return null
        val app = ZnBundles.builtIn?.app ?: return null
        return app to c.channel
    }

    // ---- Status (also for JS: Updates.status / onStatus) ----------------------------------------------------------

    /**
     * phase: off / idle / checking / downloading / installing / failed; running: the bundle running now (null = the
     * APK's); next: what runs from the next cold start; pendingRestart: they differ ([applyNow] runs it now);
     * held: JS holds updates; healthy: the running bundle was marked healthy (always true for the APK's); lastGood:
     * where a rollback goes (null: the APK's bundle); blocked: bundle id → "error" or "watchdog"; otaOff: the startup
     * guard turned OTA off in this process.
     */
    fun status(): JSONObject {
        val c = config ?: return JSONObject().put("enabled", false).put("phase", "off")
        val running = ZnBundles.running.let { if (it.builtIn) null else it.info?.id }
        val next = waitingNext()
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
            // 0 / 1 / 2: how urgent the waiting update is (docs/ota-patches.md §7); 0 when nothing waits.
            .put("nextPriority", if (next != running) st.nextPriority else 0)
            .put("held", holds.isNotEmpty())
            .put("healthy", running == null || ZnOtaHealth.healthyBundle == running)
            .put("lastGood", ZnOtaHealth.lastGood ?: JSONObject.NULL)
            .put("blocked", JSONObject(ZnOtaHealth.blocked() as Map<*, *>))
            .put("otaOff", ZnOtaHealth.offInProcess)
            .put("lastCheckAt", if (st.lastCheckAt > 0) st.lastCheckAt else JSONObject.NULL)
            .put("lastResult", st.lastResult ?: JSONObject.NULL)
            .put("lastError", st.lastError ?: JSONObject.NULL)
            // The store update answer of the last check that had one, for this APK only ([storeFor]): an answer
            // saved before a store update must not ask the user again after it.
            .put("store", st.storeAnswer(apkVersion())?.let(::JSONObject) ?: JSONObject.NULL)
    }

    private fun setPhase(p: String, prog: Double = 0.0) {
        phase = p
        progress = prog
        emitStatus()
    }

    /** Tells JS (`Updates.onStatus`) the status changed. */
    private fun emitStatus() {
        if (ZnRuntime.isStarted) ZnModules.emit("Updates", "status", status(), latestOnly = true)
    }

    // ---- The check ------------------------------------------------------------------------------------------------

    private fun ota() = ZnBundles.otaDir(appContext)
    private fun currentFile() = File(ota(), "current")

    /** What runs from the next cold start: a bundle id, or null for the APK's own bundle. */
    private fun waitingNext(): String? = currentFile().takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }

    /**
     * One check, start to end. Never throws: problems become the result and an outcome for telemetry. [forGate]: the
     * launch gate's check; its store answer (or the saved one, when it fails) goes to the gate's [ZnStoreLauncher].
     */
    private fun runCheck(forGate: Boolean = false): JSONObject {
        val c = config ?: return JSONObject().put("action", "NONE").put("reason", "OFF")
        ZnBundles.running // the start checks run with the choice (ZnOtaHealth.atStart)
        if (ZnOtaHealth.offInProcess) {
            if (forGate) ZnOtaGate.storeAnswer(runCatching { savedStoreUpdate() }.getOrNull())
            return JSONObject().put("action", "NONE").put("reason", "OTA_OFF")
        }
        val t0 = SystemClock.elapsedRealtime()
        deliver()
        val st = synchronized(stateLock) { loadState() }
        var storeSent = !forGate
        return try {
            val builtIn = ZnBundles.builtIn ?: throw ZnOtaError("setup", "the APK has no zn-bundle.json")
            setPhase("checking")
            if (ZnOtaHealth.apkChanged && !apkCleaned) {
                apkCleaned = true
                cleanUpAfterNewApk(builtIn)
            }
            noteRunning(st)
            val answer = post(c, builtIn, st)
            st.outcomes.clear() // they reached the server
            // Before act: a bundle problem below must not lose the store answer (the catch saves this state too)
            keepStoreAnswer(st, answer)
            // Before act: the gate must know about a forced store update before it hears of an OTA update or the end.
            if (!storeSent) {
                storeSent = true
                ZnOtaGate.storeAnswer(ZnOtaStore.update(st.storeAnswer(apkVersion())))
            }
            val result = act(c, builtIn, st, answer)
            st.lastCheckAt = System.currentTimeMillis()
            st.lastResult = "${result.getString("action")} ${result.getString("reason")}"
            st.lastError = null
            synchronized(stateLock) { saveState(st) }
            setPhase("idle")
            Log.i(TAG, "check ${c.channel}: ${st.lastResult} in ${SystemClock.elapsedRealtime() - t0} ms")
            ZnOtaGate.checkDone(ready = waitingNext() != ZnBundles.running.key(), p = st.nextPriority, result = st.lastResult!!)
            result
        } catch (e: Exception) {
            val code = (e as? ZnOtaError)?.code ?: "failed"
            Log.w(TAG, "check failed ($code): ${e.message}")
            synchronized(stateLock) {
                // The same failure again (offline, every return) takes the last one's place, not a new one (#217)
                val last = st.outcomes.lastOrNull()
                if (ZnOtaOutcomes.sameFailureAgain(last?.optString("kind"), last?.has("bundle") == true, code, code in SERIOUS)) {
                    st.outcomes.removeAt(st.outcomes.size - 1)
                }
                outcome(st, code, null, e.message)
                st.lastCheckAt = System.currentTimeMillis()
                st.lastError = "$code: ${e.message}"
                saveState(st)
            }
            setPhase("failed")
            // In the catch: nothing here may throw (the worker thread would take the app down)
            if (!storeSent) ZnOtaGate.storeAnswer(runCatching { ZnOtaStore.update(st.storeAnswer(apkVersion())) }.getOrNull())
            ZnOtaGate.checkDone(ready = false, p = 0, result = "$code: ${e.message}")
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
                .put("hostApi", caps.hostApi).put("hostApiOldest", caps.hostApiOldest).put("modules", JSONObject(caps.modules)).put("os", caps.os))
            .put("running", if (running.builtIn) JSONObject.NULL else JSONObject().put("id", running.info!!.id).put("sha256", running.info.sha256))
            // sha256: so the server can use the APK's own bundle as a patch base (docs/ota-patches.md §4).
            .put("builtIn", JSONObject().put("id", builtIn.id).put("serial", builtIn.serial).put("sha256", builtIn.sha256))
            .put("kept", JSONArray(keptBundles(builtIn, caps).take(16)))
            .put("seq", st.seq(c.channel))
            .put("outcomes", JSONArray(st.outcomes.toList()))
            .put("patches", JSONArray(listOf(ZnBsPatch.FORMAT))) // the patch formats this phone applies
            // The same call answers "update from the store?" (docs/zn-updates-server.md): this APK's versionCode.
            .put("store", JSONObject().put("os", "android").put("version", apkVersion()))
        val request = Request.Builder()
            .url(c.server.trimEnd('/') + "/v1/check")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        try {
            checkClient.newCall(request).execute().use { r ->
                if (!r.isSuccessful) throw ZnOtaError("server", "check answered HTTP ${r.code}")
                val source = r.body.source()
                // Stops reading at the limit, so a huge answer never fills the memory.
                if (source.request(MAX_CHECK_ANSWER + 1)) throw ZnOtaError("server", "check answer too big")
                return JSONObject(source.buffer.readUtf8())
            }
        } catch (e: InterruptedIOException) { // OkHttp's error for a time limit
            throw ZnOtaError("server", "no full answer within ${CHECK_TIMEOUT_MS / 1000} s")
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
                st.nextPriority = priorityOf(pointer)
            }
            "BUILT_IN" -> {
                val p = pointer ?: throw ZnOtaError("pointer", "BUILT_IN without a signed pointer")
                val serial = p.target.substringAfterLast('_').toIntOrNull()
                if (p.target != ZnOtaSignature.BUILT_IN && (serial == null || serial > builtIn.serial)) {
                    throw ZnOtaError("pointer", "BUILT_IN, but the pointer names ${p.target}")
                }
                currentFile().delete()
                st.setSeq(c.channel, p.seq)
                st.nextPriority = priorityOf(p)
                outcome(st, "switched", "built-in", reason)
            }
            "USE_LOCAL", "UPDATE" -> {
                val p = pointer ?: throw ZnOtaError("pointer", "$action without a signed pointer")
                ZnOtaHealth.blocked()[p.target]?.let { why ->
                    // The safety nets blocked it on this phone (step 4.7): never run or downloaded again. The seq is
                    // saved (this pointer was handled); a fixed bundle, a new id, is the way forward.
                    st.setSeq(c.channel, p.seq)
                    outcome(st, "blocked", p.target, "the channel points to it, but it is blocked on this phone ($why)")
                    return result.put("action", "NONE").put("reason", "BLOCKED").put("bundle", p.target)
                }
                val m = answer.optJSONObject("bundle")?.let(ZnOtaInstall::parseManifest) ?: throw ZnOtaError("bundle", "$action without a bundle")
                if (m.id != p.target || m.app != builtIn.app) throw ZnOtaError("bundle", "the bundle ${m.id} isn't what the pointer names (${p.target})")
                if (!ZnOtaInstall.verifyManifest(m, c.publicKeys)) throw ZnOtaError("signature", "bad bundle signature on ${m.id}")
                if (m.serial <= builtIn.serial) throw ZnOtaError("bundle", "${m.id} isn't newer than the APK's own #${builtIn.serial}")
                ZnCapabilities.current().missing(m.requires)?.let { throw ZnOtaError("incompatible", it) }
                // The launch gate hears of a download before it starts: high and critical show the update screen.
                if (action == "UPDATE") ZnOtaGate.found(priorityOf(p))
                // UPDATE: the detail says which way it came ("patch from zerobill_11, 3.4 KB" or "full zip, 824 KB").
                val how = if (action == "UPDATE") install(c, builtIn, st, m, answer.optJSONObject("patch")) else null
                if (action != "UPDATE") switchTo(builtIn, m)
                st.setSeq(c.channel, p.seq)
                st.nextPriority = priorityOf(p)
                outcome(st, if (action == "UPDATE") "downloaded" else "switched", m.id, how)
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

    /**
     * Tests only (debug builds): the free space the client sees, in bytes, instead of the real one (step 4.9; the
     * sample sets it from `adb shell setprop debug.zn.ota_free_bytes N`). Null: the real free space.
     */
    @Volatile var freeSpaceOverride: Long? = null

    /** An unzipped bundle is about 3× its zip (hbc and templates); this leaves room. */
    private const val UNZIP_FACTOR = 4
    /** An update never leaves the phone with less free space than this: the user's photos and payments come first. */
    private const val MIN_FREE_BYTES = 50L * 1024 * 1024

    /**
     * Before downloading: is there room for the rest of the file ([name]`.part`: the zip, or the patch zip of
     * [sha] / [size]), the unzipped bundle and [MIN_FREE_BYTES]? If not, the check fails with `no_space` (nothing
     * written; the seq isn't saved, so the next check tries again).
     */
    private fun checkSpace(m: ZnOtaInstall.Manifest, name: String = "download", sha: String = m.zipSha256, size: Long = m.zipSize) {
        val partInfo = File(ota(), "$name.json")
        val same = partInfo.isFile && runCatching { JSONObject(partInfo.readText()).getString("sha256") }.getOrNull() == sha
        val have = if (same) File(ota(), "$name.part").length().coerceAtMost(size) else 0L
        val need = (size - have) + m.zipSize * UNZIP_FACTOR + MIN_FREE_BYTES
        val free = freeSpaceOverride ?: ota().usableSpace
        if (free < need) throw ZnOtaError("no_space", "${m.id} needs ${mb(need)} MB free (with ${mb(MIN_FREE_BYTES)} MB kept for the user), the phone has ${mb(free)} MB")
    }

    private fun mb(bytes: Long) = "%.1f".format(Locale.US, bytes / 1048576.0)

    /** "3.4 KB" below 10 KB, else "824 KB". */
    private fun kb(bytes: Long) = if (bytes < 10 * 1024) "%.1f KB".format(Locale.US, bytes / 1024.0) else "${(bytes + 512) / 1024} KB"

    /** True for an IOException that says the phone is full. */
    private fun isNoSpace(e: java.io.IOException) = (e.message ?: "").let { "ENOSPC" in it || "No space left" in it }

    /**
     * Downloads and installs [m]: from the check's [patch] when it has one this phone can use, else (or if the patch
     * fails in any way) from the full zip. Returns how it came, for the `downloaded` outcome.
     */
    private fun install(c: Config, builtIn: ZnBundles.Info, st: State, m: ZnOtaInstall.Manifest, patch: JSONObject?): String {
        val running = ZnBundles.running
        if (!running.builtIn && running.info?.id == m.id) throw ZnOtaError("install", "${m.id} is running already")
        ota().mkdirs()
        val tmp = File(ota(), "tmp")
        val staged = File(tmp, m.id)
        val how = patch?.let { installPatch(c, builtIn, st, m, it, tmp, staged) } ?: run {
            checkSpace(m)
            try {
                download(c, m.url, m.zipSha256, m.zipSize, m.id)
                setPhase("installing")
                tmp.deleteRecursively()
                ZnOtaInstall.extract(File(ota(), "download.part"), m, staged)
            } catch (e: java.io.IOException) {
                // The phone filled up while we wrote (another app, a big photo): give the space back at once.
                if (!isNoSpace(e)) throw e
                tmp.deleteRecursively()
                File(ota(), "download.part").delete()
                File(ota(), "download.json").delete()
                throw ZnOtaError("no_space", "the phone ran out of space while installing ${m.id}; its files were removed (${e.message})")
            }
            "full zip, ${kb(m.zipSize)}"
        }
        val dest = File(ota(), "bundles/${m.id}")
        dest.parentFile!!.mkdirs()
        if (dest.exists()) dest.deleteRecursively() // a copy left by an earlier install of the same bytes (ids never change)
        if (!staged.renameTo(dest)) throw ZnOtaError("install", "can't move ${m.id} into place")
        ZnOtaInstall.writeAtomic(currentFile(), m.id) // the last step: until here the old bundle stays current
        // Neither download is needed any more (after a patch, a cut download of the full zip is of no use either).
        for (n in listOf("download.part", "download.json", "patch.part", "patch.json")) File(ota(), n).delete()
        tmp.deleteRecursively()
        Log.i(TAG, "installed ${m.id} ($how); it runs from the next start")
        return how
    }

    /**
     * The patch way (docs/ota-patches.md §6): checks that the check's [patch] starts from a bundle this phone has (the
     * running one, a kept one or the built-in one) with the same bundle SHA, downloads the patch zip to `patch.part`
     * (resumable, like the zip), and builds the bundle into [staged] ([ZnOtaInstall.buildFromPatch]). Returns how it
     * came, or null if anything went wrong: the patch files are then deleted, outcome `patch_failed` says why, and
     * the caller downloads the full zip in the same check. Only "the phone is full" fails the check (`no_space`): the
     * full zip needs more room still.
     */
    private fun installPatch(
        c: Config, builtIn: ZnBundles.Info, st: State, m: ZnOtaInstall.Manifest, patch: JSONObject, tmp: File, staged: File,
    ): String? {
        val from = patch.optString("from")
        fun dropPatchFiles() {
            tmp.deleteRecursively()
            File(ota(), "patch.part").delete()
            File(ota(), "patch.json").delete()
        }
        val why = try {
            val format = patch.optString("format")
            if (format != ZnBsPatch.FORMAT) throw ZnOtaError("patch", "unknown patch format \"$format\"")
            val fromSha = patch.getString("fromSha256")
            val sha = patch.getString("sha256")
            val size = patch.getLong("size")
            val url = patch.getString("url")
            if (size <= 0) throw ZnOtaError("patch", "bad patch size $size")
            val base = patchBase(builtIn, from, fromSha)
            checkSpace(m, "patch", sha, size) // no_space: thrown on (the full zip needs more)
            val file = download(c, url, sha, size, "the patch for ${m.id}", name = "patch", checkedBy = "the check's patch sha256")
            setPhase("installing")
            tmp.deleteRecursively()
            ZnOtaInstall.buildFromPatch(file, m, from, fromSha, base, staged)
            return "patch from $from, ${kb(size)}"
        } catch (e: ZnOtaError) {
            if (e.code == "no_space") throw e // nothing written yet; a cut patch download stays for the next check
            "${e.code}: ${e.message}"
        } catch (e: java.io.IOException) {
            if (isNoSpace(e)) {
                dropPatchFiles()
                throw ZnOtaError("no_space", "the phone ran out of space while building ${m.id} from a patch; its files were removed (${e.message})")
            }
            "${e.javaClass.simpleName}: ${e.message}"
        } catch (e: Exception) {
            "${e.javaClass.simpleName}: ${e.message}"
        } catch (e: OutOfMemoryError) {
            // The old files are read into memory; on a phone low on memory the full zip (read in parts) can still work.
            "out of memory: ${e.message}"
        }
        dropPatchFiles()
        Log.w(TAG, "the patch for ${m.id} from $from failed, downloading the full zip: $why")
        outcome(st, "patch_failed", m.id, "from $from: $why")
        return null
    }

    /**
     * Opens files of the patch's base bundle [from], which must be the built-in bundle, the running one or a kept one
     * (bundles/<id>, passing [ZnBundles.checkBundle], not blocked unless it runs) whose bundle SHA is [fromSha]. Only
     * the files its `zn-bundle.json` lists can be opened. Throws [ZnOtaError] "patch" if there is no such bundle here.
     */
    private fun patchBase(builtIn: ZnBundles.Info, from: String, fromSha: String): (String) -> java.io.InputStream? {
        if (from == builtIn.id) {
            if (builtIn.sha256 != fromSha) throw ZnOtaError("patch", "the built-in $from has another bundle SHA-256")
            return { name -> if (builtIn.files.containsKey(name)) ZnBundles.apkAssets().open(name) else null }
        }
        val running = ZnBundles.running
        val (info, dir) = if (!running.builtIn && running.info?.id == from) {
            running.info to running.dir!!
        } else {
            if (ZnOtaHealth.isBlocked(from)) throw ZnOtaError("patch", "the base $from is blocked on this phone")
            val check = ZnBundles.checkBundle(from, builtIn, ZnCapabilities.current()) { File(ota(), "bundles/$it") }
            val ok = check as? ZnBundles.Check.Ok
                ?: throw ZnOtaError("patch", "the base $from isn't on this phone (${(check as ZnBundles.Check.No).reason})")
            ok.info to File(ota(), "bundles/$from")
        }
        if (info.sha256 != fromSha) throw ZnOtaError("patch", "the base $from has another bundle SHA-256")
        return { name -> if (info.files.containsKey(name)) File(dir, name).takeIf { it.isFile }?.inputStream() else null }
    }

    /**
     * Downloads [url] (relative to the server) to [name]`.part`, resuming a cut download of the same file ([sha]; the
     * `.json` beside it remembers which). [what] names it in logs. Returns the file, checked against [size] and [sha]
     * ([checkedBy] says where they came from).
     */
    private fun download(
        c: Config, url: String, sha: String, size: Long, what: String,
        name: String = "download", checkedBy: String = "the signed manifest",
    ): File {
        val part = File(ota(), "$name.part")
        val partInfo = File(ota(), "$name.json")
        val same = partInfo.isFile && runCatching { JSONObject(partInfo.readText()).getString("sha256") }.getOrNull() == sha
        if (!same || part.length() > size) {
            part.delete()
            ZnOtaInstall.writeAtomic(partInfo, JSONObject().put("sha256", sha).put("size", size).toString())
        }
        var have = if (part.isFile) part.length() else 0L
        if (have < size) {
            setPhase("downloading", have.toDouble() / size)
            val full = c.server.toHttpUrl().resolve(url) ?: throw ZnOtaError("bundle", "bad download url $url")
            val request = Request.Builder().url(full).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
            if (have > 0) Log.i(TAG, "resuming $what at $have of $size bytes")
            try { downloadClient.newCall(request).execute().use { r ->
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
                            if (have > size) throw ZnOtaError("download", "the download is bigger than its $size bytes")
                            out.write(buf, 0, n)
                            if (have - lastReport >= 64 * 1024) {
                                lastReport = have
                                setPhase("downloading", have.toDouble() / size)
                            }
                        }
                    }
                    out.fd.sync()
                }
            } } catch (e: InterruptedIOException) { // OkHttp's error for a time limit; download.part stays for the next check
                throw ZnOtaError("download", "no data for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} s, at $have of $size bytes")
            }
        }
        if (part.length() != size || ZnOtaInstall.sha256(part) != sha) {
            part.delete()
            partInfo.delete()
            throw ZnOtaError("zip_sha", "the downloaded ${if (name == "download") "zip" else "patch zip"} doesn't match $checkedBy")
        }
        return part
    }

    /** Installed bundles this app can still run (sent as `kept`), newest first. Blocked ones are not offered. */
    private fun keptBundles(builtIn: ZnBundles.Info, caps: ZnCapabilities): List<String> {
        val blocked = ZnOtaHealth.blocked()
        val dirs = File(ota(), "bundles").listFiles()?.filter { it.isDirectory && it.name !in blocked } ?: return emptyList()
        return dirs.mapNotNull { d ->
            (ZnBundles.checkBundle(d.name, builtIn, caps) { File(ota(), "bundles/$it") } as? ZnBundles.Check.Ok)?.info
        }.sortedByDescending { it.serial }.map { it.id }
    }

    /**
     * Keeps the running bundle, the current one, the last good one and the newest [KEEP] others; deletes the rest.
     * Blocked bundles and ones that fail their checks are deleted (they never run), unless running.
     */
    private fun prune(builtIn: ZnBundles.Info) {
        val dirs = File(ota(), "bundles").listFiles()?.filter { it.isDirectory } ?: return
        val keep = HashSet<String>()
        ZnBundles.running.let { if (!it.builtIn) it.info?.id?.let(keep::add) }
        currentFile().takeIf { it.isFile }?.readText()?.trim()?.let(keep::add)
        ZnOtaHealth.lastGood?.let(keep::add)
        val blocked = ZnOtaHealth.blocked()
        val usable = keptBundles(builtIn, ZnCapabilities.current()).toSet()
        dirs.map { it.name }.filter { it in usable }
            .sortedByDescending { it.substringAfterLast('_').toIntOrNull() ?: -1 }
            .filterNot { it in keep }.take(KEEP).let(keep::addAll)
        for (d in dirs) if (d.name !in keep) {
            d.deleteRecursively()
            Log.i(TAG, "deleted ${if (d.name in blocked) "blocked" else if (d.name in usable) "old" else "unusable"} bundle ${d.name}")
        }
    }

    /**
     * Once, at the first check after a new APK install (step 4.7): bundles that no longer fit this APK (built for older
     * native code, or not newer than the APK's own bundle) are deleted, and `current` / last good stop naming them.
     */
    private fun cleanUpAfterNewApk(builtIn: ZnBundles.Info) {
        val caps = ZnCapabilities.current()
        val fits = keptBundles(builtIn, caps).toSet()
        val running = ZnBundles.running.key()
        val current = currentFile().takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null }
        if (current != null && current !in fits && current != running) currentFile().delete()
        ZnOtaHealth.lastGood?.let { if (it !in fits) ZnOtaHealth.forgetGood(it) }
        var deleted = 0
        File(ota(), "bundles").listFiles()?.filter { it.isDirectory && it.name !in fits && it.name != running }?.forEach {
            it.deleteRecursively()
            deleted++
        }
        Log.i(TAG, "new APK: $deleted bundle(s) that no longer fit (or are blocked) deleted" +
            if (current != null && current !in fits) "; $current is no longer next" else "")
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
        /** The priority (0 / 1 / 2) of the last channel change acted on: what `current` waits with ([status]). */
        var nextPriority: Int = 0,
        /** The last store answer ([ZnOtaStore.read]: JSON text), the versionCode it was for, and when it came. */
        var store: String? = null,
        var storeFor: Long = 0L,
        var storeAt: Long = 0L,
    ) {
        /** The saved store answer with its time, only if it was for [versionCode] (this APK). */
        fun storeAnswer(versionCode: Long): String? {
            val s = store ?: return null
            if (storeFor != versionCode) return null
            return runCatching { JSONObject(s).put("at", storeAt).toString() }.getOrNull()
        }
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
            j.optLong("lastCheckAt", 0L), j.optString("lastResult").ifEmpty { null }, j.optString("lastError").ifEmpty { null },
            j.optInt("nextPriority", 0), j.optString("store").ifEmpty { null }, j.optLong("storeFor", 0L), j.optLong("storeAt", 0L))
    }

    private fun saveState(st: State) {
        val j = JSONObject().put("installId", st.installId).put("seq", st.seqs).put("outcomes", JSONArray(ZnOtaOutcomes.trim(st.outcomes, MAX_OUTCOMES) { it.optString("kind") in SERIOUS }))
            .put("lastRunning", st.lastRunning ?: "").put("lastCheckAt", st.lastCheckAt)
            .put("lastResult", st.lastResult ?: "").put("lastError", st.lastError ?: "").put("nextPriority", st.nextPriority)
            .put("store", st.store ?: "").put("storeFor", st.storeFor).put("storeAt", st.storeAt)
        ZnOtaInstall.writeAtomic(stateFile(), j.toString())
    }

    /** This APK's versionCode (what the store rules compare). */
    private val apkVersionCode by lazy {
        val info = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
        @Suppress("DEPRECATION")
        if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }
    private fun apkVersion(): Long = apkVersionCode

    /**
     * Keeps the answer's store part ([ZnOtaStore.read]). No `store` (an older server, or its rule lookup failed) or
     * one this phone can't read: the last answer stays.
     */
    private fun keepStoreAnswer(st: State, answer: JSONObject) {
        if (!answer.has("store")) return
        val s = ZnOtaStore.read(answer.opt("store"))
        if (s == null) {
            Log.w(TAG, "check: a store answer this app can't read, keeping the last one")
            return
        }
        if (s != st.store || st.storeFor != apkVersion()) Log.i(TAG, "check: store answer $s")
        st.store = s
        st.storeFor = apkVersion()
        st.storeAt = System.currentTimeMillis()
    }

    /**
     * Adds an outcome for the next check, and tells [Config.onReport] (on the main thread). [stack] and [sha]: a JS
     * error's top frames ([jsTopFrames]) and its bundle's SHA-256, for `bun run ota symbolicate --from-telemetry` (step 4.8).
     */
    private fun outcome(
        st: State, kind: String, bundle: String?, detail: String?, atMs: Long = System.currentTimeMillis(),
        stack: String? = null, sha: String? = null,
    ) {
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val o = JSONObject().put("kind", kind).put("at", iso.format(Date(atMs)))
        if (bundle != null) o.put("bundle", bundle)
        if (detail != null) o.put("detail", detail.take(300))
        if (stack != null) o.put("stack", stack.take(MAX_JS_FRAMES_CHARS))
        if (sha != null) o.put("sha", sha)
        st.outcomes += o
        val report = ZnOtaReport(kind, bundle, detail, serious = kind in SERIOUS, stack = stack)
        if (kind in SERIOUS) Log.w(TAG, "report: $report") else Log.i(TAG, "report: $report")
        val hook = config?.onReport
        if (hook == null && reportListeners.isEmpty()) return
        main.post {
            try {
                hook?.invoke(report)
            } catch (e: Exception) {
                Log.e(TAG, "onReport threw", e) // an app's logging problem must not break updates
            }
            for (l in reportListeners) {
                try {
                    l(report)
                } catch (e: Exception) {
                    Log.e(TAG, "a report listener threw", e)
                }
            }
        }
    }

    /** Outcomes where a safety net acted, or where a signed file didn't check out: worth a crash-report log. */
    private val SERIOUS = setOf(
        "error_rollback", "launch_crashed", "watchdog_block", "apply_failed", "init_failed", "ota_off", "signature", "zip_sha",
        "bundle_unusable",
    )

    /** Reports, once, that a new bundle started running (installed earlier, applied at this cold start). */
    private fun noteRunning(st: State) {
        val now = ZnBundles.running.let { if (it.builtIn) "built-in ${it.info?.id}" else it.info?.id }
        if (now != st.lastRunning) {
            if (st.lastRunning != null) outcome(st, "started", now, "was ${st.lastRunning}")
            st.lastRunning = now
        }
    }

    // ---- Applying while the app runs (step 4.6) ---------------------------------------------------------------------

    /** Open `Updates.holdApply()` calls from JS. While any is open, nothing is applied in place. */
    private val holds: MutableSet<ZnCall> = Collections.newSetFromMap(ConcurrentHashMap())
    /** Main thread: an apply is in progress. */
    private var applying = false
    /** The cover goes away by itself after this long, even if the new screens sent nothing. */
    private const val COVER_TIMEOUT_MS = 3_000L

    /** True while JS holds updates (`Updates.holdApply()`): a payment or a form in progress. */
    val isHeld: Boolean get() = holds.isNotEmpty()

    /**
     * Runs the bundle that is installed for the next start **now**, without restarting the process: the JS runtime
     * is replaced by a fresh one running that bundle, and the screens that were open are opened again by route name
     * and params (their JS state starts fresh, like after Android restored the app). Storage, SecureStore and files
     * are not touched. A cover in the top screen's colour hides the swap (usually well under a second).
     *
     * Refused while JS holds updates ([isHeld]). If the new bundle's code throws while starting, the old bundle runs
     * again the same way and stays current (outcome `apply_failed`, `status().lastError`; the server answers
     * ALREADY_DONE until the channel moves on). [done] runs on the main thread with `{ applied: true, bundle }` once the
     * new screens are opened (JS never hears it: its runtime was replaced), or `{ applied: false, reason, error? }`,
     * reason: off, held, busy, not_started, nothing (the next start runs what runs now), failed.
     * [open]: a link of this app opened on top once the screens are open again (a gate before Scan: the scanner),
     * as if it came from outside ([ZnNav.openLink]). Only when the update applies.
     */
    fun applyNow(open: Uri? = null, done: (JSONObject) -> Unit = {}) {
        main.post {
            fun no(reason: String, error: String? = null) =
                done(JSONObject().put("applied", false).put("reason", reason).apply { if (error != null) put("error", error) })
            val assets = ZnTemplates.assets()
            val refused = when {
                config == null -> "off"
                holds.isNotEmpty() || ZnLaunch.waitingHere -> "held"
                applying || ZnRuntime.isRestarting -> "busy"
                !ZnRuntime.canRestart || assets.isEmpty() || assets.any { ZnTemplates.get(it) == null } -> "not_started"
                else -> null
            }
            if (refused != null) return@post no(refused)
            applying = true
            // On the client's thread: after any check in progress, so `current` is final. Reads and checks the
            // bundle's files while the old screens keep running.
            worker.execute {
                val ready = try {
                    val c = ZnBundles.candidate()
                    if (c.running.key() == ZnBundles.running.key()) null
                    else c to assets.associateWith { ZnTemplates.load(it, c.running, c.templates[it]) }
                } catch (e: Exception) {
                    Log.w(TAG, "apply: can't apply: ${e.message}")
                    main.post { applying = false; no("failed", e.message) }
                    return@execute
                }
                main.post {
                    when {
                        ready == null -> { applying = false; no("nothing") }
                        holds.isNotEmpty() -> { applying = false; no("held") } // a hold started while the files were read
                        else -> {
                            val old = ZnBundles.Candidate(ZnBundles.running, emptyMap()) to assets.associateWith { ZnTemplates.get(it)!! }
                            openAfter = open
                            swap(ready.first, ready.second, old, SystemClock.uptimeMillis(), Swap.APPLY, done)
                        }
                    }
                }
            }
        }
    }

    /** null for the APK's own bundle, else the bundle id. */
    private fun ZnBundles.Running.key(): String? = if (builtIn) null else info?.id

    /**
     * Main thread, from [ZnNav]: the user closed the app and opened it again, and this phone kept the process alive
     * (H.6). A waiting update runs now, in place of the old stack: the start screen opens, with [link] on top if given.
     * With no waiting update, with updates held, or with OTA off, [noUpdate] starts fresh on the bundle that runs. If
     * the update throws while it starts, the bundle that ran comes back, like [applyNow]. The cover goes up at once, so
     * the old screens never flash.
     */
    internal fun startFresh(link: Uri?, noUpdate: () -> Unit) {
        coverScreens()
        main.removeCallbacks(uncover)
        main.postDelayed(uncover, COVER_TIMEOUT_MS) // [screensUp] takes the cover away; this if it never comes
        val assets = ZnTemplates.assets()
        val ready = config != null && holds.isEmpty() && !applying && !rollingBack && assets.isNotEmpty() &&
            assets.all { ZnTemplates.get(it) != null } && assets.any { ZnTemplates.get(it) === ZnNav.currentBundle }
        // No waiting update: a fresh start on the bundle that runs, and the launch gate checks now (a priority high
        // or critical update still swaps before the user is in, as at a cold start).
        val none = {
            noUpdate()
            if (config != null) ZnOtaGate.beginWarm(::checkForGate)
        }
        if (!ready) return none()
        applying = true
        // Not on [worker]: a download running there would keep the user on the cover. `current` is written last and
        // atomically, so reading it here is safe; what can't be read counts as no update.
        Thread({
            val update = try {
                val c = ZnBundles.candidate()
                if (c.running.key() == ZnBundles.running.key()) null
                else c to assets.associateWith { ZnTemplates.load(it, c.running, c.templates[it]) }
            } catch (e: Exception) {
                Log.w(TAG, "apply: no update for the fresh start: ${e.message}")
                null
            }
            main.post {
                if (update == null || holds.isNotEmpty()) {
                    applying = false
                    return@post if (update == null) none() else noUpdate()
                }
                fresh = true
                freshLink = link
                val old = ZnBundles.Candidate(ZnBundles.running, emptyMap()) to assets.associateWith { ZnTemplates.get(it)!! }
                swap(update.first, update.second, old, SystemClock.uptimeMillis(), Swap.FRESH) {}
            }
        }, "zn-ota-fresh").start()
    }

    /** Main thread: the next [swap] that reaches the end opens the start screen, not the old stack. */
    private var fresh = false
    private var freshLink: Uri? = null
    /** Main thread: [applyNow]'s link, opened once its swap has opened the screens again. */
    private var openAfter: Uri? = null

    /** Why [swap] runs: [applyNow], [startFresh], a safety-net [rollBack], or the way back after one's bundle threw. */
    private enum class Swap { APPLY, FRESH, ROLLBACK, FALLBACK }

    /** Main thread: covers the screens with the top screen's background, or white, unless a cover is up already. */
    private fun coverScreens() {
        if (ZnNav.cover != null) return
        val top = ZnNav.stack.lastOrNull()
        val background = top?.route?.templateId?.let { ZnNav.currentBundle?.templates?.getOrNull(it)?.nodes?.firstOrNull()?.background }
        ZnNav.cover = background?.takeIf { it.alpha == 1f } ?: Color.White // never see-through
    }

    /**
     * Main thread: switches the process to [target] and replaces the JS runtime. If the new code throws while it
     * starts, it is blocked on this phone (step 4.7) and [fallback] runs the same way and becomes current instead.
     */
    private fun swap(
        target: ZnBundles.Candidate,
        bundles: Map<String, ZnBundle>,
        fallback: Pair<ZnBundles.Candidate, Map<String, ZnBundle>>?,
        t0: Long,
        why: Swap,
        done: (JSONObject) -> Unit,
    ) {
        coverScreens()
        // The template file the screens are drawn from (apps load one; any others are replaced too).
        val navAsset = bundles.keys.firstOrNull { ZnTemplates.get(it) === ZnNav.currentBundle }
        val from = ZnBundles.running
        stopTimers()
        screensAreUp = false
        ZnBundles.switchTo(target)
        ZnRuntime.restart { result, attach ->
            val id = target.running.key()
            if (!result.ok && fallback != null) {
                val back = fallback.first.running
                Log.e(TAG, "apply: ${target.running} threw while starting; running $back instead: ${result.value}")
                val line = safeText(result.value.substringBefore('\n'))
                worker.execute {
                    val backId = back.key()
                    if (backId == null) currentFile().delete() else ZnOtaInstall.writeAtomic(currentFile(), backId)
                    if (id != null) ZnOtaHealth.block(id, ZnOtaHealth.ERROR, kind = null, detail = null)
                    record("apply_failed", id ?: "built-in", "$line; running ${backId ?: "built-in"}", running = null,
                        error = "apply_failed: ${id ?: "built-in"} threw while starting: $line",
                        stack = jsTopFrames(result.value), sha = target.running.info?.sha256)
                }
                return@restart swap(fallback.first, fallback.second, null, t0, Swap.FALLBACK, done)
            }
            val saved = ZnNav.resetForReload()
            ZnStore.resetForReload()
            ZnImpressions.resetForReload()
            for ((asset, bundle) in bundles) ZnTemplates.replace(asset, bundle)
            attach()
            val navBundle = navAsset?.let(bundles::get)
            if (navBundle != null && fresh) ZnNav.start(navBundle, freshLink)
            else if (navBundle != null && saved.isNotEmpty()) ZnNav.restart(navBundle, saved)
            // applyNow's link (only when the new bundle runs: a fallback goes back to where the user was).
            if (why == Swap.APPLY && result.ok) openAfter?.let(ZnNav::openLink)
            openAfter = null
            fresh = false
            freshLink = null
            applying = false
            rollingBack = false
            val ms = SystemClock.uptimeMillis() - t0
            if (!result.ok) {
                // The bundle that ran before threw too: nothing left to fall back to in place.
                ZnNav.cover = null
                ZnNav.startFailed(result.value)
                done(JSONObject().put("applied", false).put("reason", "failed").put("error", result.value))
                return@restart
            }
            main.removeCallbacks(uncover)
            main.postDelayed(uncover, COVER_TIMEOUT_MS) // [screensUp] takes the cover away; this if it never comes
            if (inFront) armFirstScreen()
            Log.i(TAG, "apply: now running ${target.running}, ${saved.size} screen(s) opened again, in $ms ms (JS ${result.millis} ms)")
            val now = if (target.running.builtIn) "built-in ${target.running.info?.id}" else id
            when (why) {
                Swap.APPLY -> {
                    worker.execute { record("applied", id ?: "built-in", "was ${from.key() ?: "built-in"}, $ms ms", running = now) }
                    done(JSONObject().put("applied", true).put("bundle", id ?: JSONObject.NULL))
                }
                Swap.FRESH -> {
                    worker.execute { record("applied", id ?: "built-in", "fresh start, was ${from.key() ?: "built-in"}, $ms ms", running = now) }
                    done(JSONObject().put("applied", true).put("bundle", id ?: JSONObject.NULL))
                }
                Swap.ROLLBACK -> {
                    worker.execute { record(null, null, null, running = now) }
                    done(JSONObject().put("applied", true).put("bundle", id ?: JSONObject.NULL))
                }
                Swap.FALLBACK -> {
                    worker.execute { record(null, null, null, running = now) }
                    done(JSONObject().put("applied", false).put("reason", "failed").put("error", "the new bundle threw while starting; ${id ?: "the built-in bundle"} runs instead"))
                }
            }
        }
    }

    /**
     * Client thread: adds an outcome for the next check (none if [kind] is null); [running] (if set) is now what runs
     * (no "started" later); [error] (if set) shows as `status().lastError` until the next check; [stack], [sha]: see
     * [outcome].
     */
    private fun record(
        kind: String?, bundle: String?, detail: String?, running: String?, error: String? = null,
        stack: String? = null, sha: String? = null,
    ) {
        synchronized(stateLock) {
            val st = loadState()
            if (kind != null) outcome(st, kind, bundle, detail, stack = stack, sha = sha)
            if (running != null) st.lastRunning = running
            if (error != null) st.lastError = error
            saveState(st)
        }
    }

    // ---- Safety nets (step 4.7, docs/ota.md §3.6; what is remembered: ZnOtaHealth) ------------------------------------

    /** Main thread: the app is in the foreground (an Activity is started). */
    private var inFront = false
    /** Main thread: the running bundle's first screens are built ([screensUp]). */
    private var screensAreUp = false
    /** Main thread: a rollback is in progress. */
    private var rollingBack = false

    /** True while a safety-net rollback runs (main thread): the error screen of the failed bundle isn't shown. */
    internal val isRollingBack: Boolean get() = rollingBack

    private val uncover = Runnable { ZnNav.cover = null }
    private val healthyTimer = Runnable { markHealthy() }
    private val firstScreenTimer = Runnable {
        val id = ZnBundles.runningIfChosen?.key() ?: return@Runnable
        val c = config ?: return@Runnable
        if (screensAreUp || !inFront || applying || rollingBack || ZnOtaHealth.healthyBundle == id) return@Runnable
        Log.w(TAG, "safety: the first screens of $id weren't up ${c.firstScreenTimeoutMs} ms after the app came on screen")
        val why = "the first screens weren't up after ${c.firstScreenTimeoutMs} ms"
        if (!ZnOtaHealth.errorsRollBack(id)) {
            // The phone's last good bundle: reported, not blocked (see errorScreen).
            worker.execute { record("error_screen", id, "$why (last good bundle: reported only)", running = null) }
            return@Runnable
        }
        rollBack(id, why)
    }

    private fun onFront() {
        inFront = true
        ZnOtaHealth.onFront()
        if (!screensAreUp) armFirstScreen() else armHealthy()
    }

    private fun onBack() {
        inFront = false
        stopTimers()
        ZnOtaHealth.onBack()
    }

    private fun stopTimers() {
        main.removeCallbacks(healthyTimer)
        main.removeCallbacks(firstScreenTimer)
    }

    /** Main thread: from now on, the first screens must be up within the time limit (a downloaded bundle only). */
    private fun armFirstScreen() {
        val c = config ?: return
        if (ZnBundles.runningIfChosen?.builtIn == true || c.firstScreenTimeoutMs <= 0) return
        main.removeCallbacks(firstScreenTimer)
        main.postDelayed(firstScreenTimer, c.firstScreenTimeoutMs)
    }

    /** Main thread: the healthy mark comes after this long in the foreground, if nothing goes wrong first. */
    private fun armHealthy() {
        val c = config ?: return
        val r = ZnBundles.runningIfChosen ?: return
        if (r.builtIn || c.healthyAfterMs <= 0 || ZnOtaHealth.healthyBundle == r.key()) return
        if (ZnOtaHealth.isBlocked(r.key()!!)) return // a blocked bundle never becomes healthy (F6)
        main.removeCallbacks(healthyTimer)
        main.postDelayed(healthyTimer, c.healthyAfterMs)
    }

    /**
     * Main thread: the running bundle's first screens are built: JS sent NAV STARTED (host API 3), or for an older
     * bundle the JS thread handled START. The cover of an apply goes away, and the healthy timer starts.
     */
    internal fun screensUp() {
        if (applying || rollingBack || ZnRuntime.isRestarting) return // the screens of a runtime being replaced
        main.removeCallbacks(uncover)
        ZnNav.cover = null
        ZnOtaGate.screensUp() // after a swap at the update screen: it goes now
        if (screensAreUp) return
        screensAreUp = true
        main.removeCallbacks(firstScreenTimer)
        if (inFront) armHealthy()
    }

    /**
     * Marks the running bundle healthy (`Updates.markHealthy()` from JS, or by itself [Config.healthyAfterMs] after
     * the first screens are up): it becomes the bundle a later rollback goes back to, and its errors no longer roll
     * back. Nothing to do for the APK's own bundle. Any thread.
     */
    fun markHealthy() {
        if (config == null) return
        val id = ZnBundles.runningIfChosen?.key() ?: return
        if (ZnOtaHealth.healthyBundle == id || ZnOtaHealth.isBlocked(id)) return
        ZnOtaHealth.healthyBundle = id // at once: an error from now on is only counted
        main.post(::stopTimers)
        worker.execute {
            if (ZnOtaHealth.markHealthy(id)) record("healthy", id, null, running = null)
            Log.i(TAG, "safety: $id is healthy")
            emitStatus()
        }
    }

    /**
     * Main thread, from [ZnRuntime.jsError]: JS failed to start, a screen failed while being built, or JS hung. On a
     * downloaded bundle that isn't healthy yet this blocks it and rolls back in place; returns true then (the error
     * screen isn't shown). Else (a healthy bundle, the APK's, or the phone's last good one) the error is only counted
     * (outcome `error_screen`) and the error screen shows.
     */
    internal fun errorScreen(kind: String, where: String, details: String): Boolean {
        if (config == null || applying || rollingBack || ZnRuntime.isRestarting) return false
        val running = ZnBundles.runningIfChosen
        val id = running?.key()
        val what = safeText("$kind in $where: ${details.substringBefore('\n')}")
        val stack = jsTopFrames(details)
        val sha = running?.info?.sha256
        if (id == null || ZnOtaHealth.healthyBundle == id) {
            worker.execute { record("error_screen", id ?: "built-in", what, running = null, stack = stack, sha = sha) }
            return false
        }
        if (!ZnOtaHealth.errorsRollBack(id)) {
            // The phone's last good bundle ran well here before: one bad moment (odd server data, a slow phone) must
            // not block it forever. Reported only; the error screen shows. Its crashes still count (watchdog). A failed
            // start repeats at every launch, so two in 24 h block it until the next APK, and the APK's bundle runs (F9).
            if (kind == "start" && ZnOtaHealth.startFailed(id)) return rollBack(id, what, stack, sha, ZnOtaHealth.WATCHDOG)
            Log.w(TAG, "safety: $id is the last good bundle: $what (reported, not blocked)")
            worker.execute { record("error_screen", id, "$what (last good bundle: reported only)", running = null, stack = stack, sha = sha) }
            return false
        }
        return rollBack(id, what, stack, sha)
    }

    /** A JS error's text as it may be stored and sent: masked, then the app's own [Config.redact]. */
    private fun safeText(text: String): String {
        val masked = ZnOtaHealth.Rules.mask(text)
        val redact = config?.redact ?: return masked
        return try {
            redact(masked)
        } catch (e: Exception) {
            Log.e(TAG, "redact threw", e) // the masked text still goes
            masked
        }
    }

    /**
     * Main thread: blocks [id] (an "error" block: forever) and runs the last good bundle (or the APK's) in its place,
     * the way [applyNow] does. If JS holds updates (a payment) or the runtime can't be replaced yet, the good bundle
     * only becomes current (it runs from the next start) and this returns false: the error screen shows meanwhile.
     * [stack], [sha]: the error's top JS frames and the bundle's SHA, for the `error_rollback` outcome. [blockAs]: how
     * the block is kept.
     */
    private fun rollBack(id: String, why: String, stack: String? = null, sha: String? = null, blockAs: String = ZnOtaHealth.ERROR): Boolean {
        val assets = ZnTemplates.assets()
        val inPlace = holds.isEmpty() && ZnRuntime.canRestart && assets.isNotEmpty()
        val later = if (inPlace) "" else " from the next start (${if (holds.isNotEmpty()) "updates are held" else "the app isn't running yet"})"
        if (inPlace) {
            rollingBack = true
            stopTimers()
            ZnNav.cover = ZnNav.cover ?: Color.White
        }
        worker.execute {
            val target = ZnBundles.fallbackCandidate(exclude = id)
            val targetId = target.running.key()
            if (targetId == null) currentFile().delete() else ZnOtaInstall.writeAtomic(currentFile(), targetId)
            ZnOtaHealth.block(id, blockAs, "error_rollback", "$why; going back to ${targetId ?: "the built-in bundle"}$later", stack, sha)
            // Telemetry after the swap is on its way (a few file writes less before it).
            val report = Runnable {
                deliver()
                record(null, null, null, running = null, error = "error_rollback: $id: $why")
            }
            if (!inPlace) return@execute report.run()
            val loaded = try {
                val builtIn = ZnBundles.Candidate(ZnBundles.Running(ZnBundles.builtIn, null), emptyMap())
                val back = if (target.running.builtIn) null else builtIn to assets.associateWith { ZnTemplates.load(it, builtIn.running) }
                assets.associateWith { ZnTemplates.load(it, target.running, target.templates[it]) } to back
            } catch (e: Exception) {
                Log.e(TAG, "safety: can't read ${target.running} for the rollback", e)
                null
            }
            main.post {
                if (loaded == null) {
                    rollingBack = false
                    ZnNav.cover = null
                    return@post ZnNav.startFailed("$why (the rollback failed; the next start runs ${targetId ?: "the built-in bundle"})")
                }
                Log.w(TAG, "safety: rolling back from $id to ${target.running}: $why")
                whenAllReady(assets) {
                    swap(target, loaded.first, loaded.second, SystemClock.uptimeMillis(), Swap.ROLLBACK) {
                        Log.i(TAG, "safety: rollback done: $it")
                    }
                }
            }
            report.run()
        }
        return inPlace
    }

    /** Main thread: runs [block] once every template file in [assets] is loaded (the first ones may still load). */
    private fun whenAllReady(assets: Set<String>, block: () -> Unit) {
        val left = assets.firstOrNull { ZnTemplates.get(it) == null } ?: return block()
        ZnTemplates.whenReady(left) { whenAllReady(assets, block) }
    }

    /** Hands the safety nets' events to the next check and [Config.onReport], on the client's thread. Any thread. */
    internal fun deliverSoon() {
        if (config != null) worker.execute(::deliver)
    }

    /** Client thread: [ZnOtaHealth] events become outcomes. */
    private fun deliver() {
        if (config == null) return
        val events = ZnOtaHealth.takeEvents()
        if (events.isEmpty()) return
        synchronized(stateLock) {
            val st = loadState()
            for (e in events) outcome(st, e.kind, e.bundle, e.detail, e.atMs, e.stack, e.sha)
            saveState(st)
        }
    }

    // ---- JS: the built-in Updates module (packages/core/src/updates.ts) ---------------------------------------------

    internal object Module : ZnModuleBase("Updates", version = 3) {
        init {
            function("status") { call -> call.resolve(status()) }
            // v3 (step 4.7).
            function("markHealthy") { call ->
                markHealthy()
                call.resolve()
            }
            function("check") { call ->
                // A15 (found building iOS): the answer always carries `status`, OTA on or off (UpdateCheckResult.status isn't optional).
                if (config == null) return@function call.resolve(JSONObject().put("action", "NONE").put("reason", "OFF").put("status", status()))
                check { result -> call.resolve(result.put("status", status())) }
            }
            // v2 (step 4.6). Both run on the main thread, so a hold sent before applyNow is always seen by it.
            // `open` (2026-11-09, no version change: an older app ignores it and just applies): a link opened after the swap.
            function("applyNow", onMain = true) { call ->
                val open = call.stringOrNull("open")?.let(Uri::parse)
                applyNow(open) { call.resolve(it) }
            }
            // Never answered: the hold lasts until JS cancels the call (release, or the screen that asked closes)
            // or the runtime is replaced.
            function("hold", onMain = true) { call ->
                holds += call
                call.onCancel { holds.remove(call) }
            }
        }
    }
}

/**
 * One outcome of the update client ([ZnOta.Config.onReport]): [kind] as sent to the server (docs/ota.md §3.7), the
 * bundle it is about, and a line of detail. [serious]: a safety net acted (a rollback, a block, OTA turned off) or a
 * signed file didn't check out; worth a crash-report log. [stack]: for error_screen, error_rollback and apply_failed,
 * the error's top JS frames (step 4.8; the full error also reached `onJsError` when it happened).
 */
class ZnOtaReport(val kind: String, val bundle: String?, val detail: String?, val serious: Boolean, val stack: String? = null) {
    override fun toString() = "$kind${bundle?.let { " $it" } ?: ""}${detail?.let { ": $it" } ?: ""}"
}

