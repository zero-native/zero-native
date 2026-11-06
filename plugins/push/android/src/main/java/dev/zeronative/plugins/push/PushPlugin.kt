package dev.zeronative.plugins.push

import android.content.Intent
import android.content.pm.ApplicationInfo
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/**
 * Add it with `ZnPlugins.register(this, PushPlugin())`. Two modules: "Push" (FCM token, topics; messages arrive as the
 * JS task "push.message") and "Notifications" (channels and notifications the app shows itself, with no FCM needed).
 * The app's Activity needs `ZnActivity.attach(this)`: messages say whether the app was in front.
 *
 * [otaCheck]: a data message `zn_ota=check` runs core's OTA check now (ZnOta.check), natively, and doesn't reach JS.
 */
class PushPlugin(private val otaCheck: Boolean = true) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        PushState.otaCheck = otaCheck
        Groups.init(r.context)
        val debug = (r.context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        r.module(PushModule(r.context))
        r.module(NotificationsModule(r.context, debug))
        Schedule.restoreLater(r.context) // Android drops alarms on a force-stop: set the scheduled ones again
        r.activityEvents(object : ZnActivityEvents {
            override fun onFront() {
                PushState.inFront = true
                Opens.onFront()
                Presses.onFront()
            }

            override fun onNewIntent(intent: Intent) {
                Opens.onNewIntent(intent)
                Presses.onNewIntent(intent)
            }

            override fun onBack() {
                PushState.inFront = false
            }
        })
    }
}
