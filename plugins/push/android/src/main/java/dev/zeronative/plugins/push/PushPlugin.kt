package dev.zeronative.plugins.push

import android.content.pm.ApplicationInfo
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/**
 * Add it with `ZnPlugins.register(this, PushPlugin())`. Two modules: "Push" (FCM token, topics; messages arrive as the
 * JS task "push.message") and "Notifications" (channels and notifications the app shows itself, with no FCM needed).
 * The app's Activity needs `ZnActivity.attach(this)`: messages say whether the app was in front.
 */
class PushPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        val debug = (r.context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        r.module(PushModule(r.context))
        r.module(NotificationsModule(r.context, debug))
        r.activityEvents(object : ZnActivityEvents {
            override fun onFront() {
                PushState.inFront = true
            }

            override fun onBack() {
                PushState.inFront = false
            }
        })
    }
}
