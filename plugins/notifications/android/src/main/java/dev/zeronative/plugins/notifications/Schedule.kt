package dev.zeronative.plugins.notifications

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.util.Log
import dev.zeronative.runtime.ZnCall
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Notifications shown later (notifee's trigger notifications): `Notifications.schedule(options, { at, repeat })`.
 * Each one is saved (prefs "zn-notifications-scheduled") and set as an alarm. The alarm shows it with the same code as `show`,
 * with no JS at all, then sets the next one for a repeat.
 *
 * Android drops every alarm on a reboot and when the user force-stops the app. The plugin sets them again at each app
 * start, and after a reboot if the app declares [ZnNotificationBoot] (opt-in, README). Unless `exact` is asked for and
 * allowed, an alarm shows within 10 minutes of its time (in deep Doze: when the phone wakes).
 */
internal object Schedule {
    private const val TAG = "zn-notifications"
    private const val PREFS = "zn-notifications-scheduled"
    private const val ACTION = "dev.zeronative.notifications.TRIGGER"
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-notifications-schedule").apply { isDaemon = true } }

    /** Saves and sets it. Null when set, else why not. */
    fun add(context: Context, options: JSONObject, at: Long, repeat: String?, exact: Boolean): String? {
        val id = options.optString("id").takeIf { it.isNotEmpty() } ?: return "no_id"
        if (repeat != null && NotificationRules.repeatMs(repeat) == null) return "bad_repeat"
        val entry = JSONObject().put("options", options).put("at", at).put("exact", exact)
        if (repeat != null) entry.put("repeat", repeat)
        prefs(context).edit().putString(id, entry.toString()).apply()
        setAlarm(context, id, entry)
        return null
    }

    fun remove(context: Context, id: String) {
        prefs(context).edit().remove(id).apply()
        alarms(context).cancel(pending(context, id))
    }

    fun removeAll(context: Context) {
        for (id in prefs(context).all.keys) alarms(context).cancel(pending(context, id))
        prefs(context).edit().clear().apply()
    }

    /** `[{ id, at, repeat }]`, soonest first. */
    fun list(context: Context): JSONArray {
        val rows = prefs(context).all.mapNotNull { (id, v) ->
            val e = (v as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return@mapNotNull null
            JSONObject().put("id", id).put("at", e.optLong("at")).put("repeat", e.optString("repeat").ifEmpty { JSONObject.NULL })
        }.sortedBy { it.optLong("at") }
        return JSONArray(rows)
    }

    /** At an app start: off the main thread (startup rules). */
    fun restoreLater(context: Context) = worker.execute { restoreAll(context, "app start") }

    /** At an app start or after a reboot: Android dropped the alarms. A repeat that was missed moves to its next time. */
    fun restoreAll(context: Context, why: String) {
        val all = prefs(context).all
        if (all.isEmpty()) return
        val now = System.currentTimeMillis()
        for ((id, v) in all) {
            val e = (v as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: continue
            val repeat = e.optString("repeat").ifEmpty { null }
            if (repeat != null) {
                val next = NotificationRules.nextAt(e.optLong("at"), repeat, now)
                if (next != e.optLong("at")) {
                    e.put("at", next)
                    prefs(context).edit().putString(id, e.toString()).apply()
                }
            }
            setAlarm(context, id, e) // a one-time one that was missed fires at once (an alarm in the past does)
        }
        Log.i(TAG, "${all.size} scheduled notification(s) set again ($why)")
    }

    /** The alarm went off: show it natively, then set the next one or forget it. */
    internal fun fire(context: Context, id: String, done: () -> Unit) {
        val raw = prefs(context).getString(id, null) ?: return done()
        worker.execute {
            try {
                val e = JSONObject(raw)
                val result = showNow(context, e.getJSONObject("options"))
                Log.i(TAG, "scheduled notification $id: $result")
                val repeat = e.optString("repeat").ifEmpty { null }
                if (repeat != null) {
                    e.put("at", NotificationRules.nextAt(e.optLong("at"), repeat, System.currentTimeMillis()))
                    prefs(context).edit().putString(id, e.toString()).apply()
                    setAlarm(context, id, e)
                } else {
                    prefs(context).edit().remove(id).apply()
                }
            } catch (ex: Exception) {
                Log.w(TAG, "scheduled notification $id failed", ex)
            } finally {
                done()
            }
        }
    }

    /** True when exact alarms are allowed (Android 12+ asks the user; the app must declare SCHEDULE_EXACT_ALARM). */
    fun canExact(context: Context): Boolean = Build.VERSION.SDK_INT < 31 || alarms(context).canScheduleExactAlarms()

    private fun setAlarm(context: Context, id: String, e: JSONObject) {
        val at = e.optLong("at")
        val p = pending(context, id)
        val am = alarms(context)
        // Not exact: a window of 10 minutes after `at` (Android's smallest). setAndAllowWhileIdle would let Android move
        // it by up to 3/4 of the wait (a reminder set for tomorrow could show many hours late; seen on the emulator,
        // 2026-11-04). The cost: in deep Doze it waits for the phone to wake, when the user would see it anyway.
        try {
            if (e.optBoolean("exact") && canExact(context)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p)
            else am.setWindow(AlarmManager.RTC_WAKEUP, at, NotificationRules.TRIGGER_WINDOW_MS, p)
        } catch (ex: SecurityException) { // exact taken away between the check and here
            am.setWindow(AlarmManager.RTC_WAKEUP, at, NotificationRules.TRIGGER_WINDOW_MS, p)
        }
    }

    private fun pending(context: Context, id: String): PendingIntent {
        val intent = Intent(context, ZnNotificationTrigger::class.java)
            .setAction(ACTION)
            .setData(Uri.Builder().scheme("zn-trigger").appendPath(id).build())
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    internal fun idOf(intent: Intent): String? = intent.data?.lastPathSegment

    /** `show`'s own code, through a call that answers here instead of to JS. */
    private fun showNow(context: Context, options: JSONObject): String {
        val debug = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val call = StoredCall(options)
        NotificationsModule(context, debug).call("show", call)
        call.done.await(NotificationRules.TRIGGER_SHOW_WAIT_MS, TimeUnit.MILLISECONDS)
        return call.answer ?: "no answer"
    }

    private class StoredCall(override val args: JSONObject) : ZnCall {
        val done = CountDownLatch(1)
        @Volatile var answer: String? = null
        override val bytes: ByteArray? = null
        override val isCancelled = false
        override fun resolve(value: Any?) {
            answer = value.toString()
            done.countDown()
        }
        override fun resolveBytes(value: Any?, bytes: ByteArray) = resolve(value)
        override fun reject(code: String, message: String) {
            answer = "$code: $message"
            done.countDown()
        }
        override fun onCancel(block: () -> Unit) {}
    }

    private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/** A scheduled notification's alarm. */
class ZnNotificationTrigger : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = Schedule.idOf(intent) ?: return
        val pending = goAsync()
        Schedule.fire(context.applicationContext, id) { pending.finish() }
    }
}

/**
 * Opt-in: the app declares it in its own manifest (with RECEIVE_BOOT_COMPLETED) to set scheduled notifications again
 * after a reboot (README). Without it they come back at the next app start.
 */
class ZnNotificationBoot : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Schedule.restoreAll(context.applicationContext, intent.action!!.substringAfterLast('.'))
    }
}
