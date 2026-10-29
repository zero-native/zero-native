package dev.zeronative.runtime

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * Impressions (feeds proposal, step 2.4d): which `impressionKey`s were seen, measured natively.
 *
 * - A screen turns it on with `useImpressions(handler, { threshold, minMs })` (a NAV IMPRESSIONS op).
 * - Every composed node with an `impressionKey` reports its visible fraction from its layout position (no
 *   measureInWindow calls, no JS per frame). Rows and cards that aren't composed (off screen) cost nothing.
 * - A key counts once it is ≥ threshold visible (for minMs, if set), only while its screen is on top and the app is
 *   resumed, once per screen visit.
 * - Counted keys go to JS in batches: at most every [FLUSH_MS], and at once when the app pauses or the screen leaves.
 *
 * Main thread only.
 */
internal object ZnImpressions {
    private const val APP = 0
    private const val EVENT_IMPRESSIONS = 6
    private const val FLUSH_MS = 500L

    private class Track(val threshold: Float, val minMs: Long) {
        val counted = HashSet<String>()
        val fraction = HashMap<String, Float>()
        val visibleSince = HashMap<String, Long>()
        val pending = ArrayList<String>()
    }

    private val main = Handler(Looper.getMainLooper())
    private val tracks = HashMap<Int, Track>()
    private var flushScheduled = false

    /** False while the app is paused (set by the host from the Activity lifecycle). */
    var resumed = true
        set(value) {
            field = value
            if (value) refresh() else flush()
        }

    /** NAV IMPRESSIONS: the screen [entry] tracks impressions with these settings. */
    fun configure(entry: Int, params: String?) {
        val json = runCatching { JSONObject(params ?: "{}") }.getOrDefault(JSONObject())
        val threshold = json.optDouble("threshold", 0.35).toFloat().coerceIn(0.01f, 1f)
        tracks[entry] = Track(threshold, json.optLong("minMs", 0L).coerceAtLeast(0L))
    }

    fun tracking(entry: Int): Boolean = tracks.containsKey(entry)

    /** True once [key] was counted on [entry]'s screen: the node can skip measuring itself. */
    fun done(entry: Int, key: String): Boolean = tracks[entry]?.counted?.contains(key) ?: true

    /** A node with [key] on [entry]'s screen is now [fraction] visible (0 when it left the screen). */
    fun report(entry: Int, key: String, fraction: Float) {
        val t = tracks[entry] ?: return
        if (key in t.counted) return
        t.fraction[key] = fraction
        evaluate(entry, t, key)
    }

    private fun active(entry: Int) = resumed && ZnNav.stack.lastOrNull()?.id == entry

    private fun evaluate(entry: Int, t: Track, key: String) {
        val f = t.fraction[key] ?: 0f
        if (!active(entry) || f < t.threshold) {
            t.visibleSince.remove(key)
            return
        }
        if (t.minMs <= 0L) return count(t, key)
        val now = SystemClock.uptimeMillis()
        val since = t.visibleSince.getOrPut(key) {
            main.postDelayed({ tracks[entry]?.let { evaluate(entry, it, key) } }, t.minMs)
            now
        }
        if (now - since >= t.minMs) count(t, key)
    }

    private fun count(t: Track, key: String) {
        if (!t.counted.add(key)) return
        t.visibleSince.remove(key)
        t.fraction.remove(key)
        t.pending += key
        if (!flushScheduled) {
            flushScheduled = true
            main.postDelayed({ flush() }, FLUSH_MS)
        }
    }

    /** The top screen or the app state changed: count what is already visible on the screen now on top. */
    fun refresh() {
        for ((entry, t) in tracks) {
            if (!active(entry)) continue
            for (key in t.fraction.keys.toList()) evaluate(entry, t, key)
        }
    }

    /** Sends every counted key to JS now. */
    fun flush() {
        flushScheduled = false
        for ((entry, t) in tracks) {
            if (t.pending.isEmpty()) continue
            val payload = JSONObject().put("entry", entry.toLong() and 0xFFFFFFFFL).put("keys", JSONArray(t.pending))
            t.pending.clear()
            ZnRuntime.dispatchEvent(APP, EVENT_IMPRESSIONS, payload.toString())
        }
    }

    /** The screen left the back stack: send what it counted and forget it. */
    fun release(entry: Int) {
        flush()
        tracks.remove(entry)
    }
}
