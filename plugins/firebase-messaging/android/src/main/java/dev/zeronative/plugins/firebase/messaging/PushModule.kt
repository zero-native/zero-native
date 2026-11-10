package dev.zeronative.plugins.firebase.messaging

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.boolean
import dev.zeronative.runtime.string
import org.json.JSONObject

/**
 * FCM for JS (plugins/firebase-messaging/src/index.ts): the token and topics. Messages and new tokens reach JS as tasks
 * ([ZnMessagingService]), not through this module. With no Firebase in the app (no google-services.json) every call
 * answers `unavailable` and nothing else happens.
 */
internal class PushModule(context: Context) : ZnModuleBase("FirebaseMessaging", version = 2) {
    private val available = try {
        FirebaseApp.getApps(context).isNotEmpty()
    } catch (e: Exception) {
        Log.e(TAG, "Firebase failed to start", e)
        false
    }

    init {
        if (!available) Log.i(TAG, "Firebase isn't set up in this app (no google-services.json): push is off")

        function("status") { it.resolve(JSONObject().put("available", available)) }

        function("getToken") { call ->
            if (!available) return@function call.resolve(noToken("unavailable"))
            FirebaseMessaging.getInstance().token.addOnCompleteListener { t ->
                if (t.isSuccessful && !t.result.isNullOrEmpty()) {
                    call.resolve(JSONObject().put("token", t.result).put("reason", JSONObject.NULL))
                } else {
                    val reason = PushRules.tokenReason(t.exception?.message)
                    Log.w(TAG, "no FCM token ($reason): ${t.exception?.message}")
                    call.resolve(noToken(reason))
                }
            }
        }

        function("deleteToken") { call ->
            if (!available) return@function call.resolve(false)
            FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { t -> call.resolve(t.isSuccessful) }
        }

        function("subscribe") { call -> topic(call, subscribe = true) }
        function("unsubscribe") { call -> topic(call, subscribe = false) }

        // A tap on a notification FCM showed itself (Opens.kt; the tap rules are in plugins/notifications). Also with no
        // Firebase: it reads only the Intent.
        function("getInitialNotification", onMain = true) { call -> Opens.initial { call.resolve(it) } }
        Opens.emit = { message -> emit("opened", message) }

        // FCM makes a token at the first start by itself. Off (here, or firebase_messaging_auto_init_enabled=false
        // in the manifest): no token until getToken(). Firebase keeps it across starts.
        function("setAutoInitEnabled") { call ->
            val on = call.boolean("on")
            if (available) FirebaseMessaging.getInstance().isAutoInitEnabled = on
            call.resolve(available)
        }
        function("isAutoInitEnabled") { call -> call.resolve(available && FirebaseMessaging.getInstance().isAutoInitEnabled) }
    }

    private fun topic(call: ZnCall, subscribe: Boolean) {
        val topic = call.string("topic")
        if (!PushRules.validTopic(topic)) return call.reject("invalid_args", "\"$topic\" is not a valid FCM topic name")
        if (!available) return call.resolve(false)
        val m = FirebaseMessaging.getInstance()
        val task = if (subscribe) m.subscribeToTopic(topic) else m.unsubscribeFromTopic(topic)
        task.addOnCompleteListener { t ->
            if (!t.isSuccessful) Log.w(TAG, "${if (subscribe) "subscribe" else "unsubscribe"} $topic failed: ${t.exception?.message}")
            call.resolve(t.isSuccessful)
        }
    }

    private fun noToken(reason: String) = JSONObject().put("token", JSONObject.NULL).put("reason", reason)

    companion object {
        private const val TAG = "zn-push"
    }
}
