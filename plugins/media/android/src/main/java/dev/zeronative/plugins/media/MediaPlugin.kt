package dev.zeronative.plugins.media

import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

class MediaPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        val module = MediaModule(r.context)
        r.module(module)
        ZnLaunch.readResult(MediaModule.KEY, module::onResult) // here, so it is there when a result comes after a kill
    }
}
