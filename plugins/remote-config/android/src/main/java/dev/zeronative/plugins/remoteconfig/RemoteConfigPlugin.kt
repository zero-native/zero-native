package dev.zeronative.plugins.remoteconfig

import android.util.Log
import com.google.firebase.remoteconfig.ConfigUpdate
import com.google.firebase.remoteconfig.ConfigUpdateListener
import com.google.firebase.remoteconfig.ConfigUpdateListenerRegistration
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import com.google.firebase.remoteconfig.FirebaseRemoteConfigException
import com.google.firebase.remoteconfig.FirebaseRemoteConfigSettings
import dev.zeronative.plugins.firebase.ZnFirebase
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.doubleOrNull
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "zn-remote-config"

/** Add it with `ZnPlugins.register(this, RemoteConfigPlugin())`. JS: `RemoteConfig` (plugins/remote-config/src). */
class RemoteConfigPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        val rc = if (ZnFirebase.available(r.context)) FirebaseRemoteConfig.getInstance() else null
        if (rc == null) Log.i(TAG, "Firebase isn't set up in this app (no google-services.json): Remote Config is off")
        r.module(RemoteConfigModule(rc))
    }
}

/**
 * RN Firebase's `remoteConfig()`. Values go to JS all at once (`getAll` after `activate`), so JS reads them with no
 * call. With no Firebase every call answers with the defaults JS set, and `available: false`.
 */
internal class RemoteConfigModule(private val rc: FirebaseRemoteConfig?) : ZnModuleBase("RemoteConfig", version = 1) {
    private var updates: ConfigUpdateListenerRegistration? = null

    init {
        function("setDefaults") { call ->
            val rc = rc ?: return@function call.resolve(false)
            val defaults = RemoteConfigRules.defaults(toMap(call.args.optJSONObject("defaults")))
            rc.setDefaultsAsync(defaults).addOnCompleteListener { call.resolve(it.isSuccessful) }
        }

        function("setConfigSettings") { call ->
            val rc = rc ?: return@function call.resolve(false)
            val b = FirebaseRemoteConfigSettings.Builder()
            call.doubleOrNull("minimumFetchIntervalMillis")?.let { b.setMinimumFetchIntervalInSeconds(RemoteConfigRules.seconds(it)) }
            call.doubleOrNull("fetchTimeMillis")?.let { b.setFetchTimeoutInSeconds(RemoteConfigRules.seconds(it).coerceAtLeast(1)) }
            rc.setConfigSettingsAsync(b.build()).addOnCompleteListener { call.resolve(it.isSuccessful) }
        }

        // Each answers { ok, reason, values, info }: JS keeps the values, so reads need no call.
        function("fetch") { call ->
            val rc = rc ?: return@function call.resolve(off())
            val expiry = call.doubleOrNull("expirationSeconds")?.toLong()
            val task = if (expiry != null) rc.fetch(expiry) else rc.fetch()
            task.addOnCompleteListener { t -> answer(call, t.isSuccessful, t.exception) }
        }

        function("activate") { call ->
            val rc = rc ?: return@function call.resolve(off())
            rc.activate().addOnCompleteListener { t -> answer(call, t.isSuccessful, t.exception, changed = t.result == true) }
        }

        function("fetchAndActivate") { call ->
            val rc = rc ?: return@function call.resolve(off())
            rc.fetchAndActivate().addOnCompleteListener { t -> answer(call, t.isSuccessful, t.exception, changed = t.isSuccessful && t.result == true) }
        }

        // The values Firebase has now: activated remote ones, else the defaults. Also at start, from its cache.
        function("getAll") { call -> call.resolve(if (rc == null) off() else result(true, null, false)) }

        function("reset") { call ->
            val rc = rc ?: return@function call.resolve(false)
            rc.reset().addOnCompleteListener { call.resolve(it.isSuccessful) }
        }

        // Real-time updates: Firebase keeps a connection open only while JS listens (startUpdates .. stopUpdates).
        function("startUpdates", onMain = true) { call ->
            val rc = rc ?: return@function call.resolve(false)
            if (updates == null) {
                updates = rc.addOnConfigUpdateListener(object : ConfigUpdateListener {
                    override fun onUpdate(configUpdate: ConfigUpdate) {
                        emit("updated", JSONObject().put("updatedKeys", JSONArray(configUpdate.updatedKeys.sorted())))
                    }

                    override fun onError(error: FirebaseRemoteConfigException) {
                        Log.w(TAG, "real-time updates: ${error.code}")
                        emit("updated", JSONObject().put("updatedKeys", JSONArray()).put("error", error.code.name.lowercase()))
                    }
                })
            }
            call.resolve(true)
        }

        function("stopUpdates", onMain = true) { call ->
            updates?.remove()
            updates = null
            call.resolve(true)
        }
    }

    private fun answer(call: ZnCall, ok: Boolean, error: Exception?, changed: Boolean = false) {
        if (!ok) Log.w(TAG, "Remote Config: ${error?.javaClass?.simpleName} ${error?.message}")
        call.resolve(result(ok, if (ok) null else RemoteConfigRules.reason(error), changed))
    }

    private fun result(ok: Boolean, reason: String?, changed: Boolean): JSONObject {
        val rc = rc!!
        val values = JSONObject()
        for ((key, v) in rc.all) values.put(key, JSONObject().put("value", v.asString()).put("source", RemoteConfigRules.source(v.source)))
        val info = rc.info
        return JSONObject()
            .put("available", true)
            .put("ok", ok)
            .put("reason", reason ?: JSONObject.NULL)
            .put("changed", changed)
            .put("values", values)
            .put("lastFetchStatus", RemoteConfigRules.fetchStatus(info.lastFetchStatus))
            .put("fetchTimeMillis", info.fetchTimeMillis)
    }

    private fun off() = JSONObject().put("available", false).put("ok", false).put("reason", "unavailable").put("changed", false)
        .put("values", JSONObject()).put("lastFetchStatus", "no_fetch_yet").put("fetchTimeMillis", -1)

    private fun toMap(o: JSONObject?): Map<String, Any?> {
        if (o == null) return emptyMap()
        val out = LinkedHashMap<String, Any?>()
        for (k in o.keys()) out[k] = o.opt(k).takeUnless { it == JSONObject.NULL }
        return out
    }
}

/** The plugin's choices with no Android in them. */
internal object RemoteConfigRules {
    /** Firebase takes strings, numbers and booleans as defaults; a JS object or array goes as its JSON text. */
    fun defaults(raw: Map<String, Any?>): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        for ((k, v) in raw) when (v) {
            null -> {}
            is String, is Boolean, is Long, is Double -> out[k] = v
            is Int -> out[k] = v.toLong()
            is Number -> out[k] = v.toDouble()
            else -> out[k] = v.toString() // a JSONObject or JSONArray: its JSON text
        }
        return out
    }

    fun seconds(ms: Double): Long = (ms / 1000).toLong().coerceAtLeast(0)

    /** FirebaseRemoteConfig.VALUE_SOURCE_*: 0 static (no value at all), 1 default, 2 remote. */
    fun source(value: Int): String = when (value) {
        2 -> "remote"
        1 -> "default"
        else -> "static"
    }

    /** FirebaseRemoteConfig.LAST_FETCH_STATUS_*: -1 success, 0 none yet, 1 failure, 2 throttled. */
    fun fetchStatus(value: Int): String = when (value) {
        -1 -> "success"
        1 -> "failure"
        2 -> "throttled"
        else -> "no_fetch_yet"
    }

    /** Why a fetch failed, from Firebase's exception class name (no network, too many fetches, other). */
    fun reason(error: Exception?): String {
        val name = error?.javaClass?.simpleName ?: return "failed"
        return when {
            name.contains("Throttled") -> "throttled"
            name.contains("Client") || error.message?.contains("network", ignoreCase = true) == true -> "no_network"
            else -> "failed"
        }
    }
}
