package dev.zeronative.runtime

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Bundle
import android.os.Looper
import android.util.Log
import androidx.activity.result.IntentSenderRequest
import java.io.File
import java.io.IOException
import org.json.JSONObject

/**
 * Opens another app and gets its result, even if our process dies while it is open (docs/guide-notes.md §31). A plugin
 * calls [start] on the main thread; only Kotlin builds the Intent, so an OTA bundle can't open any app with any data.
 * JS reads the result: `launches.pending(key)`, `launches.onResult(key, ...)`, then `launches.ack(key, id)`
 * (packages/core/src/launches.ts).
 *
 * One record per key in the store "zn.launch". It is written before the other app opens, the result is written before
 * JS hears it, and it stays until JS calls ack, so a kill or a rollback at any point loses nothing. One launch at a time.
 *
 * After a kill, Android recreates the Activity and delivers the result just before `onResume`, while JS may already be
 * building the first screen. So [whenSettled] holds START until that resume when a launch from an earlier process is
 * waiting, and a screen always reads the true state. A normal start only looks for the [marker] file.
 */
object ZnLaunch : ZnModuleBase("Launches", version = 1) {
    private const val TAG = "zn"
    private const val STORE = "zn.launch"
    private const val CURRENT = "launch.current"
    private const val RECORD = "launch.record."
    private const val MARKER = "zn-launch-waiting"

    /** [launched] false: the other app didn't open, so nothing can have happened there. [reason]: no_app, no_activity, no_storage, busy, unacked. */
    class Started(val launched: Boolean, val reason: String? = null) {
        fun toJson(): JSONObject = JSONObject().put("launched", launched).apply { if (reason != null) put("reason", reason) }
    }

    /** The rules, apart from Android (ZnLaunchTest). A record is a JSON object: key, id, status, and with a result resultCode, data, extras. */
    internal object Rules {
        const val WAITING = "waiting"
        const val RESULT = "result"
        const val LOST = "lost"
        /** A result this big is not a normal one: the other app's data is outside input. */
        const val MAX_EXTRAS_CHARS = 16 * 1024

        fun waiting(key: String, id: String): JSONObject = JSONObject().put("key", key).put("id", id).put("status", WAITING)

        /** Why a new launch can't start, or null. [current]: the launch in flight; [same]: the record of the new launch's key. */
        fun refusal(current: JSONObject?, same: JSONObject?): String? = when {
            current?.optString("status") == WAITING -> "busy"
            same != null -> "unacked" // never replaced in silence: the app acks a result it has acted on
            else -> null
        }

        /** No result came, and none is on its way as far as we can tell. Null if the record isn't waiting. */
        fun lost(record: JSONObject): JSONObject? =
            if (record.optString("status") == WAITING) JSONObject(record.toString()).put("status", LOST) else null

        /** A result wins over "lost": a see-through window can let us resume before the result comes. Null: already has one. */
        fun result(record: JSONObject, resultCode: Int, data: String?, extras: JSONObject): JSONObject? {
            if (record.optString("status") == RESULT) return null
            return JSONObject(record.toString()).put("status", RESULT).put("resultCode", resultCode)
                .put("data", data ?: JSONObject.NULL).put("extras", extras)
        }

        /** Only the id it answers clears a record, so an old screen can't clear a new payment; a waiting one has nothing to confirm. */
        fun canAck(record: JSONObject, id: String) = record.optString("id") == id && record.optString("status") != WAITING

        /**
         * The other app's answer as JSON. Anything but text, a boolean, an int or a normal double becomes text: a long
         * would lose digits in JS, and JSON refuses NaN. A value that can't be read is skipped. All go if it is too big.
         */
        fun extras(values: Map<String, Any?>): JSONObject {
            val out = JSONObject()
            for ((k, v) in values) {
                try {
                    when {
                        v == null -> Unit
                        v is String || v is Boolean || v is Int -> out.put(k, v)
                        v is Double && v.isFinite() -> out.put(k, v)
                        else -> out.put(k, v.toString())
                    }
                } catch (_: Throwable) {
                    // Skipped: the rest of the answer and the result code still count.
                }
            }
            return if (out.toString().length > MAX_EXTRAS_CHARS) JSONObject() else out
        }
    }

    private var app: Context? = null
    /** A launch made by this process waits for its result. */
    private var launchedHere = false
    /** A launch from an earlier process, or from an Activity that is gone, may be waiting: settled at the next resume. */
    private var unsettled = false
    private val afterSettled = ArrayList<Runnable>()

    /** True while a launch made in this process waits and its Activity lives: JS must not be replaced now (H.1, P.2). */
    internal val waitingHere: Boolean get() = launchedHere && ZnActivity.current != null

    init {
        // On the main thread, so an ack always comes before a new launch made after it.
        function("ack", onMain = true) { call ->
            val key = call.string("key")
            val id = call.string("id")
            val store = store(ZnActivity.current ?: app ?: return@function call.reject("no_activity", "no Activity"))
            val record = read(store, key)
            val ok = record != null && Rules.canAck(record, id)
            if (ok) {
                store.delete(RECORD + key)
                if (store.getString(CURRENT) == key) store.delete(CURRENT)
                store.flush()
            }
            call.resolve(ok)
        }
    }

    /** Opens [intent] for a result. [key]: which feature ("upi"); [id]: this launch (a txn ref), saved by the app first. */
    fun start(key: String, id: String, intent: Intent): Started =
        begin(key, id) { ZnActivity.launchIntent!!.launch(intent) }

    /** The same for an [IntentSender] (the phone number hint gives one). */
    fun start(key: String, id: String, sender: IntentSender): Started =
        begin(key, id) { ZnActivity.launchSender!!.launch(IntentSenderRequest.Builder(sender).build()) }

    private fun begin(key: String, id: String, launch: () -> Unit): Started {
        check(Looper.myLooper() == Looper.getMainLooper()) { "ZnLaunch.start must run on the main thread" }
        val activity = ZnActivity.current ?: return Started(false, "no_activity")
        val store = store(activity)
        // Only a launch of this process can be in flight: by the first resume an older one is settled.
        val current = if (launchedHere) store.getString(CURRENT)?.let { read(store, it) } else null
        Rules.refusal(current, read(store, key))?.let { return Started(false, it) }
        store.set(RECORD + key, Rules.waiting(key, id).toString())
        store.set(CURRENT, key)
        store.flush()
        launchedHere = true
        try {
            marker(activity).createNewFile()
            launch()
        } catch (e: IOException) { // with no marker, a kill would leave a waiting record nothing settles
            undo(activity, store, key, e)
            return Started(false, "no_storage")
        } catch (e: ActivityNotFoundException) {
            undo(activity, store, key, e)
            return Started(false, "no_app")
        } catch (e: SecurityException) {
            undo(activity, store, key, e)
            return Started(false, "no_app")
        }
        Log.i(TAG, "launch $key: opened, waiting for its result")
        return Started(true)
    }

    private fun undo(context: Context, store: ZnStorage.Store, key: String, e: Exception) {
        Log.w(TAG, "launch $key: the other app didn't open: $e")
        store.delete(RECORD + key)
        store.delete(CURRENT)
        store.flush()
        marker(context).delete()
        launchedHere = false
    }

    /** Main thread: Android's answer. The record is on disk before JS hears it. */
    internal fun onResult(resultCode: Int, data: Intent?) {
        val context = ZnActivity.current ?: app ?: return
        launchedHere = false
        marker(context).delete()
        val store = store(context)
        val key = store.getString(CURRENT)
        val record = key?.let { read(store, it) }
        if (record == null) {
            Log.w(TAG, "launch: a result with no launch waiting; dropped")
            return
        }
        val next = Rules.result(record, resultCode, data?.dataString, Rules.extras(extrasOf(data))) ?: return
        store.set(RECORD + key, next.toString())
        store.delete(CURRENT)
        store.flush()
        Log.i(TAG, "launch $key: result $resultCode saved")
        emit("result", next)
    }

    /** Main thread, in [ZnActivity.attach]. Only a stat of the [marker]: a normal start must not touch storage here. */
    internal fun onAttach(activity: Context) {
        app = activity.applicationContext
        unsettled = !launchedHere && marker(activity).exists()
    }

    /** Main thread: Android has delivered any result it had by now. */
    internal fun onResumed() {
        if (!unsettled) return
        unsettled = false
        val context = app ?: return
        marker(context).delete()
        val store = store(context)
        val key = store.getString(CURRENT)
        val lost = key?.let { read(store, it) }?.let(Rules::lost)
        if (lost != null) {
            store.set(RECORD + key, lost.toString())
            store.flush()
            Log.w(TAG, "launch $key: no result came; the app must ask its server")
            emit("result", lost)
        }
        afterSettled.toList().also { afterSettled.clear() }.forEach { it.run() }
    }

    /** Main thread: the Activity that launched is finishing for good (swiped away), so no result can reach it. */
    internal fun onHostFinished() {
        launchedHere = false // the marker stays: the next Activity's first resume marks the record lost
    }

    /** Main thread: runs [block] now, or after the next resume if a launch from before may still get its result. */
    internal fun whenSettled(block: Runnable) {
        if (unsettled) afterSettled += block else block.run()
    }

    private fun store(context: Context) = ZnStorage.store(context, STORE)

    private fun read(store: ZnStorage.Store, key: String): JSONObject? = store.getString(RECORD + key)?.let { raw ->
        try {
            JSONObject(raw)
        } catch (e: Exception) {
            Log.e(TAG, "launch $key: the saved record can't be read", e)
            null
        }
    }

    private fun marker(context: Context) = File(context.noBackupFilesDir, MARKER)

    /**
     * The other app's answer is outside input, and this runs as the user comes back from paying. Each step has its own
     * guard: a value that can't be read is skipped and the rest are kept; the result code always gets through.
     */
    private fun extrasOf(data: Intent?): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        val extras: Bundle
        val keys: List<String>
        try {
            extras = data?.extras ?: return out
            keys = extras.keySet().toList()
        } catch (t: Throwable) {
            Log.w(TAG, "launch: the result's extras can't be read: $t")
            return out
        }
        for (key in keys) {
            try {
                @Suppress("DEPRECATION")
                out[key] = extras.get(key)
            } catch (t: Throwable) {
                Log.w(TAG, "launch: the result's extra '$key' can't be read; skipped: $t")
            }
        }
        return out
    }
}
