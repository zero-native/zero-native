package dev.zeronative.plugins.notifications

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Log
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/**
 * Add it with `ZnPlugins.register(this, NotificationsPlugin())`. One module, "Notifications": channels and notifications
 * the app shows itself (show, schedule, groups, buttons, taps). No Firebase and no push service in it.
 * The app's Activity needs `ZnActivity.attach(this)`: taps and [PushEvents.inFront] come from its events.
 *
 * `PushPlugin()` (plugins/push) adds this plugin itself. Listing both is fine: the second one does nothing.
 */
class NotificationsPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        if (added) {
            Log.i(TAG, "already added (PushPlugin adds it too)")
            return
        }
        r.requireHostApi(8)
        Groups.init(r.context)
        val debug = (r.context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        r.module(NotificationsModule(r.context, debug))
        Schedule.restoreLater(r.context) // Android drops alarms on a force-stop: set the scheduled ones again
        r.activityEvents(object : ZnActivityEvents {
            override fun onFront() {
                PushEvents.inFront = true
                NotificationTaps.each { it.onFront() }
            }

            override fun onNewIntent(intent: Intent) {
                NotificationTaps.each { it.onNewIntent(intent) }
            }

            override fun onBack() {
                PushEvents.inFront = false
            }
        })
        added = true
    }

    private companion object {
        const val TAG = "zn-notifications"
        @Volatile var added = false
    }
}
