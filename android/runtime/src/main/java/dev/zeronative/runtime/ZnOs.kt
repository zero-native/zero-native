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
internal object ZnOs : ZnModuleBase("Os", version = 2) { // 2: share's subject and dialogTitle, canOpenUrl (RN basics pack)
    private lateinit var app: Context

    /**
     * Links JS can't open. Any other scheme opens, as RN's Linking.openURL does (`whatsapp:`, `upi:`, `sms:`, `geo:`,
     * `market:`; since 2026-11-08, before only http, https, mailto and tel). Which links to open is the app's job, as in
     * RN: an app that shows links written by others (merchants, a server) filters them itself (guide-notes §39).
     * `intent:` would need Intent.parseUri and can name any part of any app; RN doesn't open it either. `file:` throws
     * on Android 7+ (FileUriExposedException). `javascript:` opens nothing.
     */
    private val BLOCKED_SCHEMES = setOf("intent", "file", "javascript")

    /** A URI scheme: a letter, then letters, digits, `+`, `-` or `.` (RFC 3986). */
    private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*$")

    /** Main process, once. */
    fun init(context: Context) {
        app = context.applicationContext
    }

    /** The rule, apart from Android (ZnOsTest): a link with a scheme, and not a blocked one. */
    fun allowsUrl(url: String): Boolean {
        if (!url.contains(':')) return false
        val scheme = url.substringBefore(':')
        return SCHEME.matches(scheme) && scheme.lowercase() !in BLOCKED_SCHEMES
    }

    init {
        function("info") { call ->
            val info = app.packageManager.getPackageInfo(app.packageName, 0)
            @Suppress("DEPRECATION")
            val build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
            call.resolve(
                JSONObject().put("appVersion", info.versionName ?: "").put("appBuild", build)
                    .put("packageName", app.packageName)
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
            // Like React Native: `subject` is the title of an email or a post, `dialogTitle` the title of the share sheet.
            call.stringOrNull("subject")?.let { send.putExtra(Intent.EXTRA_SUBJECT, it) }
            open(call) { activity.startActivity(Intent.createChooser(send, call.stringOrNull("dialogTitle"))) }
        }

        function("openUrl", onMain = true) { call ->
            val url = call.string("url")
            if (!allowsUrl(url)) return@function call.reject("not_allowed", "openUrl can't open intent:, file: or javascript: links, or a link with no scheme")
            val activity = ZnActivity.current ?: return@function call.reject("no_activity", "no Activity")
            open(call) { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }

        // Some app can open it. Android 11+ answers only for the link kinds in a manifest's <queries>: the runtime lists
        // http, https, mailto and tel; an app adds the others it asks about (e.g. whatsapp), as in RN. Without that,
        // false even when openUrl would work. A blocked link: false.
        function("canOpenUrl") { call ->
            val url = call.string("url")
            if (!allowsUrl(url)) return@function call.resolve(false)
            val view = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            call.resolve(view.resolveActivity(app.packageManager) != null)
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
