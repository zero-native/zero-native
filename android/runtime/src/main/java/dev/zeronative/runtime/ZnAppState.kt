package dev.zeronative.runtime

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle

/**
 * Tells JS if the user can touch the app: "active" or "background" (packages/core/src/app-state.ts). It follows the
 * Activity's resume and pause, not start and stop: a see-through window from another app, as some payment apps use,
 * pauses us without stopping us, and JS must still hear that the user came back.
 */
internal object ZnAppState {
    private var resumed = 0
    private var everResumed = false

    /** Main process only, once. */
    fun init(context: Context) {
        (context.applicationContext as Application).registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                everResumed = true
                if (resumed++ == 0) send()
            }
            override fun onActivityPaused(activity: Activity) {
                resumed = (resumed - 1).coerceAtLeast(0)
                if (resumed == 0 && !activity.isChangingConfigurations) send()
            }
            override fun onActivityCreated(activity: Activity, savedState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    /** Main thread, after START: a new JS runtime must hear the state. Before the first resume JS assumes "active". */
    fun sendAfterStart() {
        if (everResumed) send()
    }

    private fun send() {
        ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.APP_STATE, if (resumed > 0) "active" else "background")
    }
}
