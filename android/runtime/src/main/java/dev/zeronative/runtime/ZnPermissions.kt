package dev.zeronative.runtime

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * The built-in Permissions module (packages/core/src/permissions.ts, docs/guide-notes.md §32): "granted", "denied", or
 * "blocked" when Android will no longer show the dialog, so only the app's settings page can change it.
 */
internal object ZnPermissions : ZnModuleBase("Permissions", version = 1) {
    private const val STORE = "zn.launch"
    private const val ASKED = "permission.asked."

    /** Short names JS can use. A full `android.permission.X` works too. */
    private val NAMES = mapOf(
        "camera" to Manifest.permission.CAMERA,
        "contacts" to Manifest.permission.READ_CONTACTS,
        "location" to Manifest.permission.ACCESS_FINE_LOCATION,
        "microphone" to Manifest.permission.RECORD_AUDIO,
        "notifications" to "android.permission.POST_NOTIFICATIONS",
    )

    private class Pending(val call: ZnCall, val names: List<String>)

    /** The request Android is showing now. It lives in the process, so an Activity rebuilt under the dialog still answers. */
    private var pending: Pending? = null

    /** The rules, apart from Android (ZnPermissionsTest). */
    object Rules {
        /**
         * Android can't tell "never asked" from "don't ask again": `rationale` is false for both. So [asked] is kept: true
         * once the user has really refused. Closing the dialog without an answer leaves it false, and stays "denied".
         */
        fun state(granted: Boolean, asked: Boolean, rationale: Boolean): String = when {
            granted -> "granted"
            asked && !rationale -> "blocked"
            else -> "denied"
        }

        /** A value of [asked] after a request: a rationale means the user said no at least once. */
        fun askedAfter(asked: Boolean, rationale: Boolean) = asked || rationale

        fun androidName(name: String): String? = NAMES[name] ?: name.takeIf { it.startsWith("android.permission.") }
    }

    init {
        function("status", onMain = true) { call ->
            val names = names(call)
            val activity = ZnActivity.current ?: return@function call.reject("no_activity", "no Activity")
            call.resolve(answer(activity, names))
        }

        function("request", onMain = true) { call ->
            val names = names(call)
            val activity = ZnActivity.current
            val launcher = ZnActivity.permissions
            if (activity == null || launcher == null) return@function call.reject("no_activity", "no Activity")
            if (pending != null) return@function call.reject("busy", "a permission request is open")
            val ask = names.map { Rules.androidName(it)!! }.filter { !isGranted(activity, it) && exists(it) }
            val undeclared = ask.filterNot { declared(activity).contains(it) }
            if (undeclared.isNotEmpty()) return@function call.reject("not_declared", "not in the manifest: ${undeclared.joinToString()}")
            if (ask.isEmpty()) return@function call.resolve(answer(activity, names))
            pending = Pending(call, names)
            launcher.launch(ask.toTypedArray())
        }
    }

    /** Main thread: Android answered, or dropped the request (the answer is then read from what is true now). */
    internal fun onResult() {
        val p = pending ?: return
        pending = null
        val activity = ZnActivity.current ?: return p.call.reject("no_activity", "no Activity")
        val store = ZnStorage.store(activity, STORE)
        for (name in p.names) {
            val android = Rules.androidName(name)!!
            val asked = store.getBoolean(ASKED + android) == true
            if (Rules.askedAfter(asked, activity.shouldShowRequestPermissionRationale(android)) != asked) store.set(ASKED + android, true)
        }
        p.call.resolve(answer(activity, p.names))
    }

    /** Main thread: the Activity is gone for good, so Android will never answer. */
    internal fun onHostFinished() {
        pending?.call?.reject("no_activity", "the Activity closed")
        pending = null
    }

    private fun answer(activity: ComponentActivity, names: List<String>): JSONObject {
        val store = ZnStorage.store(activity, STORE)
        val out = JSONObject()
        for (name in names) {
            val android = Rules.androidName(name)!!
            val state = Rules.state(
                granted = isGranted(activity, android),
                asked = store.getBoolean(ASKED + android) == true,
                rationale = activity.shouldShowRequestPermissionRationale(android),
            )
            out.put(name, state)
        }
        return out
    }

    private fun names(call: ZnCall): List<String> {
        val list = call.args.optJSONArray("names") ?: JSONArray()
        val names = (0 until list.length()).map { list.optString(it) }
        if (names.isEmpty()) throw ZnInvalidArgs("\"names\" must be a list of permissions")
        names.firstOrNull { Rules.androidName(it) == null }?.let { throw ZnInvalidArgs("unknown permission \"$it\"") }
        return names
    }

    /** Android has no notification permission before 13: notifications are simply on. */
    private fun exists(permission: String) = permission != NAMES["notifications"] || Build.VERSION.SDK_INT >= 33

    private fun isGranted(context: Context, permission: String) =
        !exists(permission) || ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun declared(context: Context): Set<String> =
        context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions?.toSet() ?: emptySet()
}
