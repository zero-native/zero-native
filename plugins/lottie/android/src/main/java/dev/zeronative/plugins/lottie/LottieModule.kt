package dev.zeronative.plugins.lottie

import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.string
import org.json.JSONObject

/** The "Lottie" module. JS side: ../../src/api.ts of this plugin. Its views are in LottieView.kt. */
internal class LottieModule(private val files: LottieFiles) : ZnModuleBase("Lottie", version = 1) {
    init {
        // Parses a file into Lottie's cache now, so a view shows it at once later. Never rejects for a bad file.
        function("preload") { call ->
            val source = call.string("source")
            LottieThread.run {
                call.resolve(
                    when (val r = files.load(source, cache = true)) {
                        is LottieLoad.Ok -> infoJson(r.composition).put("ok", true)
                        is LottieLoad.Failed -> JSONObject().put("ok", false).put("reason", r.reason)
                    },
                )
            }
        }
    }
}
