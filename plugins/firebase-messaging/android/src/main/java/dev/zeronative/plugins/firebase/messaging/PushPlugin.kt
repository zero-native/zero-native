package dev.zeronative.plugins.firebase.messaging

import dev.zeronative.plugins.notifications.NotificationsPlugin
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/**
 * Add it with `ZnPlugins.register(this, PushPlugin())`. The "Push" module: FCM's token and topics; messages arrive as the
 * JS task "push.message" through the notifications plugin's PushEvents. It adds [NotificationsPlugin] ("Notifications")
 * itself, so an app that lists only PushPlugin keeps its notifications. The app's Activity needs
 * `ZnActivity.attach(this)`: messages say whether the app was in front.
 *
 * [otaCheck]: a data message `zn_ota=check` runs core's OTA check now (ZnOta.check), natively, and doesn't reach JS.
 */
class PushPlugin(private val otaCheck: Boolean = true) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        NotificationsPlugin().register(r) // does nothing when the app listed it already
        PushState.otaCheck = otaCheck
        r.module(PushModule(r.context))
    }
}
