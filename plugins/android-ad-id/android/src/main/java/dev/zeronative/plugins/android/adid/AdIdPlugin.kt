package dev.zeronative.plugins.android.adid

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.ads.identifier.AdvertisingIdClient
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import java.util.concurrent.Executors
import org.json.JSONObject

private const val TAG = "zn-ad-id"

/** Add it with `ZnPlugins.register(this, AdIdPlugin())`. */
class AdIdPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(AdIdModule(r.context.applicationContext))
    }
}

/**
 * The Google advertising id (2026-11-07, for ad attribution). `get` answers `{ id, limitAdTracking }` and never
 * rejects: no Play services, a Play services error or an id the user deleted all answer `id: null`.
 */
internal class AdIdModule(private val app: Context) : ZnModuleBase("AndroidAdId", version = 1) {
    /**
     * Its own thread: the read is a call into Play services that can wait (a busy phone, Play services updating). On
     * the shared call pool (2 threads) it would hold up other modules' calls meanwhile.
     */
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-ad-id").apply { isDaemon = true } }

    init {
        function("get") { call ->
            worker.execute {
                val t0 = SystemClock.uptimeMillis()
                val answer = try {
                    val info = AdvertisingIdClient.getAdvertisingIdInfo(app)
                    AdIdRules.answer(info.id, info.isLimitAdTrackingEnabled)
                } catch (t: Throwable) {
                    // GooglePlayServicesNotAvailableException (no Play services: Huawei, some cheap phones),
                    // ...RepairableException (Play services to update), IOException, IllegalStateException.
                    Log.w(TAG, "advertising id not read: $t")
                    AdIdRules.answer(null, false)
                }
                Log.d(TAG, "advertising id read in ${SystemClock.uptimeMillis() - t0} ms (id ${if (answer.id == null) "none" else "given"}, limit ${answer.limitAdTracking})")
                call.resolve(JSONObject().put("id", answer.id ?: JSONObject.NULL).put("limitAdTracking", answer.limitAdTracking))
            }
        }
    }
}
