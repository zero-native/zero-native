package dev.zeronative.plugins.devicetest

import android.util.Log
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/** The test plugin. */
class DeviceTestPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(DeviceModule(r.context))
        // Log lines the phone test reads.
        r.activityEvents(object : ZnActivityEvents {
            override fun onFront() = say("front")
            override fun onBack() = say("back")
            override fun onRuntimeReplaced() = say("runtime replaced")
            private fun say(what: String) {
                Log.i("zn-sample", "activity event: $what")
            }
        })
    }
}
