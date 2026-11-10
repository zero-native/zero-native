package dev.zeronative.plugins.firebase

import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.installations.FirebaseInstallations
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.boolean
import dev.zeronative.runtime.booleanOrNull
import org.json.JSONObject

/**
 * Add it with `ZnPlugins.register(this, FirebaseAppPlugin())` when JS uses `Firebase.app()` or `installations()`. The
 * other Firebase plugins need only its Gradle project (for the Firebase version), not this registration.
 */
class FirebaseAppPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        r.module(FirebaseModule(r.context))
        r.module(InstallationsModule(r.context))
    }
}

/** Firebase's state for every zero-native Firebase plugin. */
object ZnFirebase {
    /** True when Firebase started: the app was built with its google-services.json. */
    fun available(context: Context): Boolean = try {
        FirebaseApp.getApps(context).isNotEmpty()
    } catch (e: Exception) {
        Log.e("zn-firebase", "Firebase failed to start", e)
        false
    }
}

/** `Firebase.app()` and the data collection default (RN Firebase's `app` module). */
internal class FirebaseModule(private val context: Context) : ZnModuleBase("FirebaseApp", version = 1) {
    init {
        function("app") { it.resolve(info()) }

        function("setDataCollectionDefault") { call ->
            val on = call.boolean("on")
            if (ZnFirebase.available(context)) FirebaseApp.getInstance().setDataCollectionDefaultEnabled(on)
            call.resolve(info())
        }
    }

    private fun info(): JSONObject {
        if (!ZnFirebase.available(context)) return JSONObject().put("available", false)
        val app = FirebaseApp.getInstance()
        val o = app.options
        return JSONObject()
            .put("available", true)
            .put("name", app.name)
            .put("projectId", o.projectId ?: JSONObject.NULL)
            .put("appId", o.applicationId)
            .put("senderId", o.gcmSenderId ?: JSONObject.NULL)
            .put("storageBucket", o.storageBucket ?: JSONObject.NULL)
            .put("dataCollectionDefault", app.isDataCollectionDefaultEnabled)
    }
}

/** RN Firebase's `installations`: the install id Firebase services know this app by. */
internal class InstallationsModule(private val context: Context) : ZnModuleBase("FirebaseInstallations", version = 1) {
    init {
        function("getId") { call ->
            if (!ZnFirebase.available(context)) return@function call.resolve(null)
            FirebaseInstallations.getInstance().id.addOnCompleteListener { t -> call.resolve(if (t.isSuccessful) t.result else null) }
        }

        function("getToken") { call ->
            if (!ZnFirebase.available(context)) return@function call.resolve(null)
            val force = call.booleanOrNull("forceRefresh") ?: false
            FirebaseInstallations.getInstance().getToken(force).addOnCompleteListener { t ->
                val r = t.result.takeIf { t.isSuccessful }
                call.resolve(r?.let { JSONObject().put("token", it.token).put("expiresAt", FirebaseRules.expiresAtMs(it.tokenExpirationTimestamp)) })
            }
        }

        function("delete") { call ->
            if (!ZnFirebase.available(context)) return@function call.resolve(false)
            FirebaseInstallations.getInstance().delete().addOnCompleteListener { t -> call.resolve(t.isSuccessful) }
        }
    }
}

/** The plugin's choices with no Android in them. */
internal object FirebaseRules {
    /** Installations gives seconds since 1970; JS wants ms. */
    fun expiresAtMs(seconds: Long): Long = seconds * 1000
}
