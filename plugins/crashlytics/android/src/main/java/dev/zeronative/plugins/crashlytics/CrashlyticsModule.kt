package dev.zeronative.plugins.crashlytics

import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import com.google.firebase.crashlytics.FirebaseCrashlytics
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnJsError
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnNav
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import dev.zeronative.runtime.boolean
import org.json.JSONObject

/**
 * The JS side's calls (plugins/crashlytics/src/index.ts). [crashlytics] is null when Firebase isn't set up (no
 * google-services.json): every call then answers at once and does nothing, and `status` says `available: false`.
 */
internal class CrashlyticsModule(
    private val crashlytics: FirebaseCrashlytics?,
    private val redact: ((String) -> String)?,
) : ZnModuleBase("Crashlytics", version = 1) {
    private val main = Handler(Looper.getMainLooper())

    init {
        function("status") { it.resolve(status()) }

        function("setCollectionEnabled") { call ->
            val on = call.boolean("on")
            crashlytics?.isCrashlyticsCollectionEnabled = on
            call.resolve(status())
        }

        function("log") { call ->
            val message = call.string("message")
            crashlytics?.log(clean(message))
            call.resolve(true)
        }

        // On the main thread: it reads the top route (ZnNav.stack), as the runtime does for its own JS errors.
        function("recordError", onMain = true) { call ->
            val details = CrashlyticsRules.details(call.stringOrNull("name"), call.string("message"), call.stringOrNull("stack"))
            val where = call.stringOrNull("tag") ?: "recordError"
            val c = crashlytics ?: return@function call.resolve(false)
            val running = ZnBundles.running
            val error = ZnJsError("recorded", where, clean(details), ZnNav.stack.lastOrNull()?.route?.name, running.info?.id, running.label)
            c.setCustomKey(CrashlyticsRules.KEY_JS_KIND, error.kind)
            c.log(error.details.take(CrashlyticsRules.MAX_LOG_CHARS))
            c.recordException(error.asThrowable())
            call.resolve(true)
        }

        function("setAttribute") { call ->
            val key = call.string("key")
            setKey(key, call.args.opt("value"))
            call.resolve(true)
        }

        function("setAttributes") { call ->
            val values = call.args.optJSONObject("values") ?: JSONObject()
            for (key in values.keys()) setKey(key, values.opt(key))
            call.resolve(true)
        }

        function("setUserId") { call ->
            crashlytics?.setUserId(call.stringOrNull("id").orEmpty().take(CrashlyticsRules.MAX_KEY_CHARS))
            call.resolve(true)
        }

        // A real crash, for testing the setup (RN Firebase's crash()). Answers first, then crashes on the main thread.
        function("crash") { call ->
            val kind = call.stringOrNull("kind") ?: "kotlin"
            call.resolve(true)
            Log.w(TAG, "crash($kind) asked: the app will now crash on purpose")
            main.postDelayed({
                if (kind == "native") {
                    // A native crash (SIGSEGV) as Hermes or C++ code would cause. Seen by Crashlytics only with
                    // firebase-crashlytics-ndk (opt-in, README); without it the app just closes.
                    Process.sendSignal(Process.myPid(), 11)
                } else {
                    throw RuntimeException("Test crash from Crashlytics.crash()")
                }
            }, 300)
        }
    }

    private fun status() = JSONObject()
        .put("available", crashlytics != null)
        .put("enabled", crashlytics?.isCrashlyticsCollectionEnabled ?: false)

    private fun setKey(key: String, raw: Any?) {
        val c = crashlytics ?: return
        if (!CrashlyticsRules.validKey(key)) return
        when (val v = CrashlyticsRules.keyValue(raw)) {
            is String -> c.setCustomKey(key, clean(v))
            is Boolean -> c.setCustomKey(key, v)
            is Long -> c.setCustomKey(key, v)
            is Double -> c.setCustomKey(key, v)
            else -> Log.w(TAG, "setAttribute(\"$key\"): only a string, number or boolean can be a key's value")
        }
    }

    /** The app's [redact], if any. If it throws, the text is dropped: never send what the app meant to hide. */
    private fun clean(text: String): String {
        val r = redact ?: return text
        return try {
            r(text)
        } catch (e: Exception) {
            Log.e(TAG, "redact threw; the text is left out", e)
            "(left out: redact threw)"
        }
    }

    internal fun cleanText(text: String) = clean(text)

    companion object {
        private const val TAG = "zn-crashlytics"
    }
}
