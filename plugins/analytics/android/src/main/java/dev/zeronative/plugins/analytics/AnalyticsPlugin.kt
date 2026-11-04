package dev.zeronative.plugins.analytics

import android.content.Context
import android.os.Bundle
import android.util.Log
import androidx.compose.runtime.snapshotFlow
import com.google.firebase.analytics.FirebaseAnalytics
import dev.zeronative.plugins.firebase.ZnFirebase
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnNav
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.boolean
import dev.zeronative.runtime.booleanOrNull
import dev.zeronative.runtime.long
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "zn-analytics"

/**
 * Add it with `ZnPlugins.register(this, AnalyticsPlugin())`. Analytics stays off until JS calls
 * `Analytics.setAnalyticsCollectionEnabled(true)` (after the user agrees); Firebase keeps that across starts.
 *
 * By itself it sends a `screen_view` for each top route ([screenViews]): the whole app is one Activity, so Firebase's
 * own screen views would all say "MainActivity". [screenName] renames a route or leaves it out (null).
 * Every event also carries `zn_bundle`, the running bundle ([bundleParam]), to compare OTA bundles.
 */
class AnalyticsPlugin(
    private val screenViews: Boolean = true,
    private val screenName: (route: String) -> String? = { it },
    private val bundleParam: Boolean = true,
) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        val analytics = if (ZnFirebase.available(r.context)) FirebaseAnalytics.getInstance(r.context) else null
        val module = AnalyticsModule(analytics)
        r.module(module) // also with no Firebase: bundles that use the plugin still run, and every call answers
        if (analytics == null) {
            Log.i(TAG, "Firebase isn't set up in this app (no google-services.json): Analytics is off")
            return
        }
        if (bundleParam) ZnBundles.watchRunning { label -> module.setBundle(AnalyticsRules.bundleValue(label)) }
        if (screenViews) watchRoute(analytics)
    }

    private fun watchRoute(analytics: FirebaseAnalytics) {
        MainScope().launch {
            snapshotFlow { ZnNav.stack.lastOrNull()?.route?.name }.distinctUntilChanged().collect { route ->
                val name = route?.let(screenName) ?: return@collect // before the first screen, or left out
                analytics.logEvent(FirebaseAnalytics.Event.SCREEN_VIEW, Bundle().apply {
                    putString(FirebaseAnalytics.Param.SCREEN_NAME, name.take(AnalyticsRules.MAX_STRING))
                    putString(FirebaseAnalytics.Param.SCREEN_CLASS, name.take(AnalyticsRules.MAX_STRING))
                })
            }
        }
    }
}

/** RN Firebase's `analytics()` calls. A call with a bad name answers its reason ("" when sent). */
internal class AnalyticsModule(private val analytics: FirebaseAnalytics?) : ZnModuleBase("Analytics", version = 1) {
    // The bundle parameter is kept here so the app's setDefaultEventParameters(null) doesn't clear it.
    private var bundle: String? = null

    init {
        function("status") { it.resolve(JSONObject().put("available", analytics != null)) }

        function("setCollectionEnabled") { call ->
            val on = call.boolean("on")
            analytics?.setAnalyticsCollectionEnabled(on)
            call.resolve(analytics != null)
        }

        function("setConsent") { call ->
            val a = analytics ?: return@function call.resolve(false)
            val map = HashMap<FirebaseAnalytics.ConsentType, FirebaseAnalytics.ConsentStatus>()
            fun put(arg: String, type: FirebaseAnalytics.ConsentType) {
                call.booleanOrNull(arg)?.let { map[type] = if (it) FirebaseAnalytics.ConsentStatus.GRANTED else FirebaseAnalytics.ConsentStatus.DENIED }
            }
            put("analyticsStorage", FirebaseAnalytics.ConsentType.ANALYTICS_STORAGE)
            put("adStorage", FirebaseAnalytics.ConsentType.AD_STORAGE)
            put("adUserData", FirebaseAnalytics.ConsentType.AD_USER_DATA)
            put("adPersonalization", FirebaseAnalytics.ConsentType.AD_PERSONALIZATION)
            a.setConsent(map)
            call.resolve(true)
        }

        function("logEvent") { call ->
            val name = call.string("name")
            val problem = AnalyticsRules.eventNameProblem(name)
            if (problem != null) return@function refuse(call, problem)
            val p = AnalyticsRules.params(toMap(call.args.optJSONObject("params")))
            if (p.problem != null) return@function refuse(call, "$name: ${p.problem}")
            analytics?.logEvent(name, toBundle(p.values))
            call.resolve("")
        }

        function("setUserId") { call ->
            val id = call.stringOrNull("id")
            if (id != null) AnalyticsRules.userIdProblem(id)?.let { return@function refuse(call, it) }
            analytics?.setUserId(id?.ifEmpty { null })
            call.resolve("")
        }

        function("setUserProperty") { call ->
            val name = call.string("name")
            AnalyticsRules.propertyNameProblem(name)?.let { return@function refuse(call, it) }
            analytics?.setUserProperty(name, call.stringOrNull("value")?.let(AnalyticsRules::propertyValue))
            call.resolve("")
        }

        function("setUserProperties") { call ->
            val values = call.args.optJSONObject("values") ?: JSONObject()
            for (name in values.keys()) AnalyticsRules.propertyNameProblem(name)?.let { return@function refuse(call, it) }
            for (name in values.keys()) {
                val v = values.opt(name).takeUnless { it == JSONObject.NULL }?.toString()
                analytics?.setUserProperty(name, v?.let(AnalyticsRules::propertyValue))
            }
            call.resolve("")
        }

        function("setDefaultEventParameters") { call ->
            val raw = call.args.optJSONObject("params")
            if (raw == null) {
                analytics?.setDefaultEventParameters(null)
                bundle?.let { setBundle(it) }
                return@function call.resolve("")
            }
            val p = AnalyticsRules.params(toMap(raw), allowItems = false)
            if (p.problem != null) return@function refuse(call, p.problem)
            analytics?.setDefaultEventParameters(toBundle(p.values))
            call.resolve("")
        }

        function("getAppInstanceId") { call ->
            val a = analytics ?: return@function call.resolve(null)
            a.appInstanceId.addOnCompleteListener { t -> call.resolve(if (t.isSuccessful) t.result else null) }
        }

        function("resetAnalyticsData") { call ->
            analytics?.resetAnalyticsData()
            call.resolve(analytics != null)
        }

        function("setSessionTimeoutDuration") { call ->
            analytics?.setSessionTimeoutDuration(call.long("ms"))
            call.resolve(analytics != null)
        }
    }

    fun setBundle(label: String) {
        bundle = label
        analytics?.setDefaultEventParameters(Bundle().apply { putString(AnalyticsRules.PARAM_BUNDLE, label) })
    }

    private fun refuse(call: ZnCall, problem: String) {
        Log.w(TAG, problem)
        call.resolve(problem)
    }

    private fun toMap(o: JSONObject?): Map<String, Any?> {
        if (o == null) return emptyMap()
        val out = LinkedHashMap<String, Any?>()
        for (k in o.keys()) out[k] = plain(o.opt(k))
        return out
    }

    private fun plain(v: Any?): Any? = when (v) {
        JSONObject.NULL, null -> null
        is JSONObject -> toMap(v)
        is JSONArray -> List(v.length()) { plain(v.opt(it)) }
        else -> v
    }

    private fun toBundle(values: Map<String, Any>): Bundle = Bundle().apply {
        for ((k, v) in values) when (v) {
            is String -> putString(k, v)
            is Long -> putLong(k, v)
            is Double -> putDouble(k, v)
            is List<*> -> putParcelableArray(k, v.map { @Suppress("UNCHECKED_CAST") toBundle(it as Map<String, Any>) }.toTypedArray())
        }
    }
}
