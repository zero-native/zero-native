package dev.zeronative.plugins.auth

import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/** Add it with `ZnPlugins.register(this, AuthPlugin())`. */
class AuthPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(6)
        val module = AuthModule(r.context)
        r.module(module)
        // Here and not at the launch: after a kill, this is the only code of ours that has run when Android gives the answer.
        ZnLaunch.readResult(AuthRules.HINT_KEY, module::readHint)
        r.activityEvents(object : ZnActivityEvents {
            override fun onRuntimeReplaced() = module.onRuntimeReplaced()
        })
    }
}
