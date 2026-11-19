package __APP_ID__

import android.app.Application
import android.util.Log
import dev.zeronative.runtime.ZnRuntime
import dev.zeronative.runtime.ZnTemplates

class MainApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Everything here only posts work to other threads and returns at once.
        // Plugins first, before the bundle runs: ZnPlugins.register(this, LocationPlugin()) (docs/plugins.md).
        // OTA updates stay off until you call ZnOta.configure here (docs/ota.md): the APK's own bundle runs.
        // Every JS error, hang or start failure: where an app sends it to its crash reporter (e.asThrowable()).
        ZnRuntime.onJsError = { e -> Log.w(TAG, "JS error (${e.kind}) in ${e.where}:\n${e.details}", e.asThrowable()) }
        ZnTemplates.preload(this, "main.zn.ui")
        ZnRuntime.start(this)
        ZnRuntime.evalAsset("main.hbc")
    }

    private companion object {
        const val TAG = "__APP_NAME__"
    }
}
