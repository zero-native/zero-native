package dev.zeronative.runtime

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the OTA safety nets remember (step 4.7, docs/ota.md §3.6), in `zn-ota/health.json`:
 * - **launch watchdog**: a UI launch on a downloaded bundle that isn't healthy yet is marked *pending*; going to the
 *   background or becoming healthy clears it. A process that dies while pending (a crash, a freeze) leaves it set,
 *   and the next start counts it, if Android says the process crashed or froze (Android 11+; older phones count every
 *   such death). Two counted launches in a row block the bundle;
 * - **last good**: the last bundle marked healthy on this phone, where a rollback goes back to;
 * - **blocked** bundles, never run, switched to or downloaded again: "error" (its JS failed before it was healthy;
 *   forever) or "watchdog" (launches ended by crashes; cleared by the next APK install, which may fix the cause);
 * - the **APK** this state is for (versionCode + install time): any new install, even of the same version, is seen;
 * - the startup guard's **fuse**: two starts in a row whose OTA start-up failed turn OTA off until the next APK;
 * - **events** not yet delivered: they become outcomes for the next check and `onReport` calls ([ZnOta]).
 *
 * The rules are [Rules] (pure, unit-tested: ZnOtaHealthTest). This object keeps one copy in memory, reads the file
 * once, and writes it on every change. Any thread.
 */
internal object ZnOtaHealth {
    private const val TAG = "zn-ota"
    const val ERROR = "error"
    const val WATCHDOG = "watchdog"

    class Event(val kind: String, val bundle: String?, val detail: String?, val atMs: Long)

    class State(
        var apkVersion: Long = -1L,
        var apkUpdated: Long = -1L,
        /** The bundle of a UI launch that hasn't ended well yet (null: none), since when (wall clock ms), its process. */
        var pending: String? = null,
        var pendingSince: Long = 0L,
        var pendingPid: Int = 0,
        /** Launches in a row of [crashBundle] that ended by a crash or a freeze. */
        var crashBundle: String? = null,
        var crashes: Int = 0,
        var lastGood: String? = null,
        /** Bundle id → [ERROR] or [WATCHDOG], oldest first. */
        val blocked: LinkedHashMap<String, String> = LinkedHashMap(),
        /** Starts in a row whose OTA start-up failed (the startup guard caught an error). */
        var guardFails: Int = 0,
        val events: MutableList<Event> = ArrayList(),
    ) {
        fun toJson(): String = JSONObject()
            .put("apkVersion", apkVersion).put("apkUpdated", apkUpdated)
            .put("pending", pending ?: "").put("pendingSince", pendingSince).put("pendingPid", pendingPid)
            .put("crashBundle", crashBundle ?: "").put("crashes", crashes)
            .put("lastGood", lastGood ?: "")
            .put("blocked", JSONObject().apply { for ((k, v) in blocked) put(k, v) })
            .put("blockedOrder", JSONArray(blocked.keys.toList()))
            .put("guardFails", guardFails)
            .put("events", JSONArray(events.map { e ->
                JSONObject().put("kind", e.kind).put("bundle", e.bundle ?: "").put("detail", e.detail ?: "").put("at", e.atMs)
            }))
            .toString()

        companion object {
            fun fromJson(text: String): State {
                val j = JSONObject(text)
                val b = j.optJSONObject("blocked") ?: JSONObject()
                val order = j.optJSONArray("blockedOrder")?.let { a -> List(a.length()) { a.getString(it) } } ?: b.keys().asSequence().toList()
                val blocked = LinkedHashMap<String, String>()
                for (id in order) if (b.has(id)) blocked[id] = b.getString(id)
                val ev = j.optJSONArray("events")
                val events = MutableList(ev?.length() ?: 0) { i ->
                    val e = ev!!.getJSONObject(i)
                    Event(e.getString("kind"), e.optString("bundle").ifEmpty { null }, e.optString("detail").ifEmpty { null }, e.optLong("at"))
                }
                return State(
                    apkVersion = j.optLong("apkVersion", -1L), apkUpdated = j.optLong("apkUpdated", -1L),
                    pending = j.optString("pending").ifEmpty { null }, pendingSince = j.optLong("pendingSince"), pendingPid = j.optInt("pendingPid"),
                    crashBundle = j.optString("crashBundle").ifEmpty { null }, crashes = j.optInt("crashes"),
                    lastGood = j.optString("lastGood").ifEmpty { null }, blocked = blocked,
                    guardFails = j.optInt("guardFails"), events = events,
                )
            }
        }
    }

    /** How the process of a pending launch ended: [Counts] (a crash or a freeze), or [Ignored] (low memory, stopped...). */
    sealed interface Exit {
        val reason: String
        class Counts(override val reason: String) : Exit
        class Ignored(override val reason: String) : Exit
    }

    /** The rules, on a [State]. No Android, no files: ZnOtaHealthTest checks each one. */
    object Rules {
        /** Launches in a row ended by a crash or a freeze before a bundle is blocked. */
        const val WATCHDOG_LIMIT = 2
        /** At most this many blocked ids are remembered (oldest dropped; their folders are gone by then). */
        const val MAX_BLOCKED = 32
        const val MAX_EVENTS = 20

        /**
         * Once per process, before the bundle is chosen: notices a new APK install (resets the counts, clears watchdog
         * blocks and the fuse) and judges a launch the last process left pending ([exit] says how that process, its
         * [State.pendingPid], ended). Returns true if the APK changed.
         */
        fun atStart(s: State, apkVersion: Long, apkUpdated: Long, now: Long, exit: (since: Long, pid: Int) -> Exit): Boolean {
            val first = s.apkVersion == -1L && s.apkUpdated == -1L
            val changed = !first && (s.apkVersion != apkVersion || s.apkUpdated != apkUpdated)
            if (changed) {
                val how = if (s.apkVersion == apkVersion) "versionCode $apkVersion installed again" else "versionCode ${s.apkVersion} → $apkVersion"
                event(s, "apk_changed", null, how, now)
                s.pending = null
                s.crashBundle = null
                s.crashes = 0
                s.guardFails = 0
                s.blocked.entries.removeAll { it.value == WATCHDOG }
            }
            s.apkVersion = apkVersion
            s.apkUpdated = apkUpdated
            val p = s.pending ?: return changed
            s.pending = null
            when (val e = exit(s.pendingSince, s.pendingPid)) {
                is Exit.Ignored -> Unit // not the bundle's fault: the count stays as it was
                is Exit.Counts -> {
                    s.crashes = if (s.crashBundle == p) s.crashes + 1 else 1
                    s.crashBundle = p
                    event(s, "launch_crashed", p, "${e.reason} (${s.crashes} of $WATCHDOG_LIMIT)", now)
                    if (s.crashes >= WATCHDOG_LIMIT) {
                        block(s, p, WATCHDOG)
                        s.crashBundle = null
                        s.crashes = 0
                        event(s, "watchdog_block", p, "$WATCHDOG_LIMIT launches in a row ended by a crash or a freeze; last: ${e.reason}", now)
                    }
                }
            }
            return changed
        }

        /** A UI launch (or a return to the front) on [bundle], not healthy yet, in process [pid]. */
        fun launch(s: State, bundle: String, now: Long, pid: Int) {
            s.pending = bundle
            s.pendingSince = now
            s.pendingPid = pid
        }

        /** The launch ended well before the healthy mark (the app went to the background): not counted. */
        fun ended(s: State, bundle: String) {
            if (s.pending == bundle) s.pending = null
            if (s.crashBundle == bundle) {
                s.crashBundle = null
                s.crashes = 0
            }
        }

        /** [bundle] is healthy: it becomes the last good bundle. Returns true if that changed. */
        fun healthy(s: State, bundle: String): Boolean {
            ended(s, bundle)
            if (s.lastGood == bundle) return false
            s.lastGood = bundle
            return true
        }

        /** Blocks [bundle] for [why]; an "error" block is never turned into a "watchdog" one. */
        fun block(s: State, bundle: String, why: String) {
            val kind = if (s.blocked[bundle] == ERROR) ERROR else why
            s.blocked.remove(bundle)
            s.blocked[bundle] = kind
            while (s.blocked.size > MAX_BLOCKED) s.blocked.remove(s.blocked.keys.first())
            if (s.lastGood == bundle) s.lastGood = null
            if (s.pending == bundle) s.pending = null
        }

        fun event(s: State, kind: String, bundle: String?, detail: String?, now: Long) {
            s.events += Event(kind, bundle, detail, now)
            while (s.events.size > MAX_EVENTS) s.events.removeAt(0)
        }

        /** The startup guard caught an error. Returns true when the fuse is now blown (OTA off until the next APK). */
        fun guardFailed(s: State): Boolean {
            s.guardFails++
            return fuseBlown(s)
        }

        fun fuseBlown(s: State) = s.guardFails >= 2
    }

    // ---- The state, in memory and in the file ---------------------------------------------------------------------

    private val lock = Any()
    private var state: State? = null
    private var file: File? = null

    /** The bundle marked healthy in this process (null: none). Errors of a healthy bundle are only counted. */
    @Volatile var healthyBundle: String? = null
    /** True when OTA is off in this process: the startup guard caught an error, or the fuse is blown. */
    @Volatile var offInProcess = false
        private set
    /** True if this process is the first since a new APK install (bundles that no longer fit are cleaned up). */
    @Volatile var apkChanged = false
        private set
    @Volatile private var inFront = false
    @Volatile private var chosen: ZnBundles.Running? = null

    private fun <T> edit(sync: Boolean = true, block: (State) -> T): T = synchronized(lock) {
        val s = load()
        val result = block(s)
        file?.let { ZnOtaInstall.writeAtomic(it, s.toJson(), sync) }
        result
    }

    private fun <T> read(block: (State) -> T): T = synchronized(lock) { block(load()) }

    private fun load(): State {
        state?.let { return it }
        val f = file ?: return State() // before [atStart]: nothing is known yet, and nothing is kept
        val s = try {
            if (f.isFile) State.fromJson(f.readText()) else State()
        } catch (e: Exception) {
            Log.w(TAG, "health: ${f.name} can't be read (${e.message}); starting fresh")
            State()
        }
        state = s
        return s
    }

    fun isBlocked(id: String): Boolean = read { it.blocked.containsKey(id) }
    fun blocked(): Map<String, String> = read { LinkedHashMap(it.blocked) }
    val lastGood: String? get() = read { it.lastGood }

    /** Events not yet delivered, oldest first; they are removed. */
    fun takeEvents(): List<Event> = synchronized(lock) {
        val s = load()
        if (s.events.isEmpty()) return emptyList()
        val out = s.events.toList()
        s.events.clear()
        file?.let { ZnOtaInstall.writeAtomic(it, s.toJson()) }
        out
    }

    /**
     * Once per process, when the bundle is chosen ([ZnBundles], off the main thread): the APK check and the watchdog.
     * Returns true if OTA must stay off (the fuse is blown). Throws on errors: the caller's guard catches them.
     */
    fun atStart(context: Context): Boolean {
        val t0 = SystemClock.elapsedRealtimeNanos()
        synchronized(lock) { file = File(ZnBundles.otaDir(context), "health.json") }
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val version = PackageInfoCompat.getLongVersionCode(info)
        // On the startup path: the file is written only if something changed, and synced only if a block did (a lost
        // count after a power cut costs one more crash; a lost block could cost many).
        val fuse = synchronized(lock) {
            val s = load()
            val before = s.toJson()
            val blockedBefore = s.blocked.toMap()
            apkChanged = Rules.atStart(s, version, info.lastUpdateTime, System.currentTimeMillis()) { since, pid -> exitOf(context, since, pid) }
            val after = s.toJson()
            if (after != before) file?.let { ZnOtaInstall.writeAtomic(it, after, sync = s.blocked != blockedBefore) }
            Rules.fuseBlown(s)
        }
        if (fuse) {
            offInProcess = true
            Log.w(TAG, "health: OTA is off until the next APK install (its start-up failed twice in a row)")
        }
        Log.i(TAG, "health: start checks in %.2f ms".format((SystemClock.elapsedRealtimeNanos() - t0) / 1e6) +
            if (apkChanged) " (new APK install)" else "")
        ZnOta.deliverSoon()
        return fuse
    }

    /** The choice of the bundle worked: the fuse count goes back to 0. */
    fun guardOk() {
        if (read { it.guardFails } != 0) edit(sync = false) { it.guardFails = 0 }
    }

    /** The startup guard caught [e]. Never throws. */
    fun guardFailed(e: Exception) {
        offInProcess = true
        try {
            edit { s ->
                Rules.event(s, "init_failed", null, "${e::class.java.simpleName}: ${e.message}", System.currentTimeMillis())
                if (Rules.guardFailed(s)) Rules.event(s, "ota_off", null, "OTA start-up failed twice in a row; off until the next APK install", System.currentTimeMillis())
            }
        } catch (t: Exception) {
            Log.e(TAG, "health: can't record the start-up failure", t)
        }
        ZnOta.deliverSoon()
    }

    /**
     * How process [pid], which left a pending launch at [since], ended (Android 11+ knows; older phones: counted).
     * Matched by pid: the record of an earlier process (one force-stopped just before this launch) must not count.
     */
    private fun exitOf(context: Context, since: Long, pid: Int): Exit {
        if (Build.VERSION.SDK_INT < 30) return Exit.Counts("ended while on screen (Android < 11 can't say why)")
        val am = context.getSystemService(ActivityManager::class.java) ?: return Exit.Counts("ended while on screen")
        val e = am.getHistoricalProcessExitReasons(context.packageName, 0, 8)
            .firstOrNull { it.pid == pid && it.processName == context.packageName && it.timestamp >= since }
            ?: return Exit.Counts("ended while on screen (no exit record)")
        return when (e.reason) {
            ApplicationExitInfo.REASON_CRASH -> Exit.Counts("crash")
            ApplicationExitInfo.REASON_CRASH_NATIVE -> Exit.Counts("native crash")
            ApplicationExitInfo.REASON_ANR -> Exit.Counts("not responding (ANR)")
            else -> Exit.Ignored("exit reason ${e.reason}${e.description?.let { ": $it" } ?: ""}")
        }.also { Log.i(TAG, "health: the last launch ended: ${it.reason} (${if (it is Exit.Counts) "counted" else "not counted"})") }
    }

    // ---- Launches (UI) --------------------------------------------------------------------------------------------

    /** The process now runs [r] (chosen at start, or switched while running). */
    fun onChosen(r: ZnBundles.Running) {
        chosen = r
        if (inFront) markLaunch()
    }

    /** Main thread: the app came on screen (its first Activity, or back from the background). */
    fun onFront() {
        inFront = true
        markLaunch()
    }

    /** Main thread: no Activity is on screen any more (a normal exit to the background). */
    fun onBack() {
        inFront = false
        val id = chosen?.takeUnless { it.builtIn }?.info?.id ?: return
        if (read { it.pending == id }) edit(sync = false) { Rules.ended(it, id) }
    }

    private fun markLaunch() {
        val r = chosen ?: return
        val id = r.info?.id
        if (r.builtIn || id == null || healthyBundle == id || offInProcess) return
        if (read { it.pending == id }) return
        val t0 = SystemClock.elapsedRealtimeNanos()
        edit(sync = false) { Rules.launch(it, id, System.currentTimeMillis(), android.os.Process.myPid()) }
        Log.i(TAG, "health: launch of $id marked in %.2f ms".format((SystemClock.elapsedRealtimeNanos() - t0) / 1e6))
    }

    /** [id] is healthy (main thread or the client's). Returns true if it became the last good bundle. */
    fun markHealthy(id: String): Boolean {
        healthyBundle = id
        return edit { Rules.healthy(it, id) }
    }

    /** Blocks [id] for [why] ([ERROR] or [WATCHDOG]), with an event of [kind] if set (any thread but main). */
    fun block(id: String, why: String, kind: String?, detail: String?) {
        edit { s ->
            Rules.block(s, id, why)
            if (kind != null) Rules.event(s, kind, id, detail, System.currentTimeMillis())
        }
    }

    /** Forgets [id] as the last good bundle (it no longer fits this APK). */
    fun forgetGood(id: String) {
        if (read { it.lastGood == id }) edit { it.lastGood = null }
    }
}
