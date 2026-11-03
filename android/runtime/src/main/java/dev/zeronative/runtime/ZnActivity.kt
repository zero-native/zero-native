package dev.zeronative.runtime

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.CopyOnWriteArrayList

/** What a plugin can hear about the app (`r.activityEvents`). Main thread. Keep each one short. */
interface ZnActivityEvents {
    /** A new intent for the Activity on screen. */
    fun onNewIntent(intent: Intent) {}
    /** The app came into view. */
    fun onFront() {}
    /** The app left the screen. */
    fun onBack() {}
    /** Android wants memory: drop what can be made again. */
    fun onLowMemory() {}
    /** New JS took over (an update applied in place): forget what the old JS asked for. */
    fun onRuntimeReplaced() {}
}

/**
 * The app's Activity, for everything that needs one: permissions, opening another app, a plugin's dialogs. Main thread
 * only. The host makes one call in `onCreate`, right after [ZnNav.handleExtraActivity]:
 *
 *     ZnActivity.attach(this)
 *
 * It registers the result launchers there because Android drops a result for a launcher registered after `onStart`.
 * The keys are fixed, so Android finds the launcher again when it brings the Activity back after killing the process.
 */
object ZnActivity {
    /** The Activity that is alive now, even if another app is on top of it. Null before [attach] and after it is destroyed. */
    var current: ComponentActivity? = null
        private set

    internal var permissions: ActivityResultLauncher<Array<String>>? = null
        private set
    internal var launchIntent: ActivityResultLauncher<Intent>? = null
        private set
    internal var launchSender: ActivityResultLauncher<IntentSenderRequest>? = null
        private set

    private val listeners = CopyOnWriteArrayList<ZnActivityEvents>()

    internal fun addEvents(events: ZnActivityEvents) {
        listeners += events
    }

    internal fun fire(event: (ZnActivityEvents) -> Unit) {
        for (l in listeners) runCatching { event(l) }.onFailure { Log.e("zn", "a plugin's activity event threw", it) }
    }

    /** Main process, once. */
    internal fun init(context: Context) {
        context.applicationContext.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                // UI_HIDDEN (20) only says the app left the screen.
                if (level != ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) lowMemory()
            }
            override fun onConfigurationChanged(newConfig: Configuration) {
                ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.COLOR_SCHEME, colorScheme(newConfig))
            }
            @Deprecated("Deprecated in Android")
            override fun onLowMemory() = lowMemory()
        })
    }

    // Coil clears its own memory cache: it listens to Android too.
    private fun lowMemory() {
        fire { it.onLowMemory() }
        ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.LOW_MEMORY)
    }

    /** "light" or "dark", as JS's colorScheme() says it. */
    internal fun colorScheme(config: Configuration): String =
        if (config.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"

    fun attach(activity: ComponentActivity) {
        current = activity
        val registry = activity.activityResultRegistry
        permissions = registry.register("zn.permissions", activity, ActivityResultContracts.RequestMultiplePermissions()) {
            ZnPermissions.onResult()
        }
        launchIntent = registry.register("zn.launch.intent", activity, ActivityResultContracts.StartActivityForResult()) {
            ZnLaunch.onResult(it.resultCode, it.data)
        }
        launchSender = registry.register("zn.launch.sender", activity, ActivityResultContracts.StartIntentSenderForResult()) {
            ZnLaunch.onResult(it.resultCode, it.data)
        }
        ZnLaunch.onAttach(activity)
        activity.addOnNewIntentListener { intent -> fire { it.onNewIntent(intent) } }
        activity.lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onResume(owner: LifecycleOwner) = ZnLaunch.onResumed()

            override fun onStart(owner: LifecycleOwner) {
                if (!activity.isChangingConfigurations) fire { it.onFront() }
            }

            override fun onStop(owner: LifecycleOwner) {
                if (!activity.isChangingConfigurations) fire { it.onBack() }
            }

            override fun onDestroy(owner: LifecycleOwner) {
                if (activity.isFinishing) {
                    ZnLaunch.onHostFinished()
                    ZnPermissions.onHostFinished()
                }
                if (current === activity) {
                    current = null
                    permissions = null
                    launchIntent = null
                    launchSender = null
                }
            }
        })
    }
}
