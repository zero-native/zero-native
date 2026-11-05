package dev.zeronative.plugins.lottie

import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/** Lottie animations from the app's assets, drawn with Airbnb's lottie-compose. No thread or file work here. */
class LottiePlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        val files = LottieFiles(r.context)
        r.module(LottieModule(files))
        r.view("lottie.view") { scope -> LottieViewContent(scope, files) }
        r.activityEvents(object : ZnActivityEvents {
            override fun onLowMemory() = files.trim()
        })
    }
}
