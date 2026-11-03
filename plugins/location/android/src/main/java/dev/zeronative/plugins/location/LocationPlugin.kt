package dev.zeronative.plugins.location

import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import org.json.JSONObject

/** Add it with `ZnPlugins.register(this, LocationPlugin())`. */
class LocationPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(6)
        val module = LocationModule(r.context)
        r.module(module)
        // The result code says it all (-1: turned on). Here and not at the launch: after a kill this is the only code of
        // ours that has run when Android gives the answer. Play's extras are parcels JS can't use.
        ZnLaunch.readResult(LocationRules.TURN_ON_KEY) { _, _ -> JSONObject() }
        r.activityEvents(object : ZnActivityEvents {
            override fun onFront() = module.onFront()
            override fun onBack() = module.onBack()
            override fun onRuntimeReplaced() = module.onRuntimeReplaced()
        })
    }
}
