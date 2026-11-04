package dev.zeronative.plugins.crashlytics

import android.content.Context
import android.util.Log
import androidx.compose.runtime.snapshotFlow
import com.google.firebase.FirebaseApp
import com.google.firebase.crashlytics.FirebaseCrashlytics
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnJsError
import dev.zeronative.runtime.ZnNav
import dev.zeronative.runtime.ZnOta
import dev.zeronative.runtime.ZnOtaReport
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.ZnPlugins
import dev.zeronative.runtime.ZnRuntime
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Add it with `ZnPlugins.register(this, CrashlyticsPlugin())`, first thing in `Application.onCreate`. By itself it sends:
 * - Kotlin and Java crashes (Crashlytics' own handler; core's crash mark runs before it and hands each crash on),
 * - every JS error as a non-fatal, with its JS stack ([jsErrors]; like RN Firebase, no app code needed),
 * - serious OTA outcomes (a rollback, a blocked bundle) as non-fatals, and the others as log lines,
 * - keys on every report: the running bundle, host API, the top route.
 *
 * [redact]: runs on every text that goes to Crashlytics from JS (error messages, stacks, logs, string keys). For
 * private data your app knows the shape of. Nothing is masked without it: what goes in an error is the app's choice.
 */
class CrashlyticsPlugin(
    private val jsErrors: Boolean = true,
    private val redact: ((String) -> String)? = null,
) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        val crashlytics = instance(r.context)
        val module = CrashlyticsModule(crashlytics, redact)
        r.module(module) // also with no Firebase: bundles that use the plugin still run, and every call answers
        if (crashlytics == null) {
            Log.i(TAG, "Firebase isn't set up in this app (no google-services.json): Crashlytics is off")
            return
        }
        crashlytics.setCustomKey(CrashlyticsRules.KEY_HOST_API, ZnPlugins.HOST_API)
        ZnBundles.watchRunning { label ->
            crashlytics.setCustomKey(CrashlyticsRules.KEY_BUNDLE, label)
            crashlytics.setCustomKey(CrashlyticsRules.KEY_BUNDLE_ID, CrashlyticsRules.bundleId(label))
            crashlytics.setCustomKey(CrashlyticsRules.KEY_BUILT_IN, ZnBundles.running.builtIn)
            crashlytics.log("bundle: $label")
        }
        if (jsErrors) {
            val budget = CrashlyticsRules.Budget()
            ZnRuntime.addJsErrorListener { e -> recordJsError(crashlytics, module, budget, e) }
        }
        ZnOta.addReportListener { report -> recordOta(crashlytics, report) }
        watchRoute(crashlytics)
    }

    private fun recordJsError(c: FirebaseCrashlytics, module: CrashlyticsModule, budget: CrashlyticsRules.Budget, e: ZnJsError) {
        if (!budget.take()) {
            if (budget.dropped == 1 || budget.dropped % 100 == 0) c.log("js: ${budget.dropped} more JS errors not sent (limit ${CrashlyticsRules.MAX_JS_ERRORS} per launch)")
            return
        }
        val error = if (redact == null) e else ZnJsError(e.kind, e.where, module.cleanText(e.details), e.screen, e.bundle, e.bundleLabel)
        c.setCustomKey(CrashlyticsRules.KEY_JS_KIND, error.kind)
        c.log(error.details.take(CrashlyticsRules.MAX_LOG_CHARS)) // the full JS stack, with columns
        c.recordException(error.asThrowable())
    }

    private fun recordOta(c: FirebaseCrashlytics, report: ZnOtaReport) {
        c.log(CrashlyticsRules.otaLog(report.kind, report.bundle, report.detail))
        if (report.serious) c.recordException(ZnOtaEventException(report.kind, report.bundle, report.detail))
    }

    /** The top route as a key, and each change as a log line (the screens before a crash). */
    private fun watchRoute(c: FirebaseCrashlytics) {
        MainScope().launch {
            var last: String? = null
            snapshotFlow { ZnNav.stack.lastOrNull()?.route?.name }.distinctUntilChanged().collect { name ->
                if (name == last) return@collect // the first value, before any screen: nothing changed yet
                c.setCustomKey(CrashlyticsRules.KEY_ROUTE, name ?: "")
                c.log(CrashlyticsRules.routeLog(last, name))
                last = name
            }
        }
    }

    private fun instance(context: Context): FirebaseCrashlytics? = try {
        if (FirebaseApp.getApps(context).isEmpty()) null else FirebaseCrashlytics.getInstance()
    } catch (e: Exception) {
        Log.e(TAG, "Crashlytics failed to start", e)
        null
    }

    private companion object {
        const val TAG = "zn-crashlytics"
    }
}
