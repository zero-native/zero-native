package dev.zeronative.runtime

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import org.json.JSONObject

/** The built-in Os module: small things about the phone (packages/core/src/os.ts, docs/guide-notes.md §33). */
internal object ZnOs : ZnModuleBase("Os", version = 1) {
    private lateinit var app: Context

    /** Only these open from JS, so an OTA bundle can't use [Os.openUrl] to open `upi:` or `intent:` links. */
    private val URL_SCHEMES = setOf("https", "http", "mailto", "tel")

    /** Main process, once. */
    fun init(context: Context) {
        app = context.applicationContext
    }

    /** The rule, apart from Android (ZnOsTest). */
    fun allowsUrl(url: String): Boolean = url.substringBefore(':', "").lowercase() in URL_SCHEMES

    init {
        function("info") { call ->
            val info = app.packageManager.getPackageInfo(app.packageName, 0)
            @Suppress("DEPRECATION")
            val build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
            call.resolve(
                JSONObject().put("appVersion", info.versionName ?: "").put("appBuild", build)
                    .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                    .put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER)
                    .put("rtl", app.resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL),
            )
        }

        function("haptic", onMain = true) { call ->
            val constant = when (val kind = call.string("kind")) {
                "light" -> HapticFeedbackConstants.KEYBOARD_TAP
                "medium" -> HapticFeedbackConstants.VIRTUAL_KEY
                "success" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
                "error" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
                else -> throw ZnInvalidArgs("unknown haptic \"$kind\"")
            }
            call.resolve(ZnActivity.current?.window?.decorView?.performHapticFeedback(constant) == true)
        }

        function("openSettings", onMain = true) { call ->
            val activity = ZnActivity.current ?: return@function call.reject("no_activity", "no Activity")
            val page = Uri.fromParts("package", activity.packageName, null)
            open(call) { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, page)) }
        }

        function("share", onMain = true) { call ->
            val text = call.string("text")
            val activity = ZnActivity.current ?: return@function call.reject("no_activity", "no Activity")
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            open(call) { activity.startActivity(Intent.createChooser(send, null)) }
        }

        function("openUrl", onMain = true) { call ->
            val url = call.string("url")
            if (!allowsUrl(url)) return@function call.reject("not_allowed", "openUrl takes http, https, mailto and tel links")
            val activity = ZnActivity.current ?: return@function call.reject("no_activity", "no Activity")
            open(call) { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
    }

    private fun open(call: ZnCall, start: () -> Unit) {
        try {
            start()
            call.resolve(true)
        } catch (e: ActivityNotFoundException) {
            call.reject("no_app", "no app can open this")
        }
    }
}
