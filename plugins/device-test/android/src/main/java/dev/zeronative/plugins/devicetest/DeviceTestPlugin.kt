package dev.zeronative.plugins.devicetest

import android.util.Log
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnMotionApi
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/** The test plugin. */
class DeviceTestPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(DeviceModule(r.context))
        r.screen("device.fake-screen") { scope -> FakeScreen(scope) }
        r.view("device.fake-view") { scope -> FakeView(scope) }
        // A custom motion curve (lab 9): v.to(x, wobble()) overshoots and rings like a struck bell, `rings` times.
        ZnMotionApi.registerDriver("device.wobble") { from, to, _, p ->
            val rings = p.optDouble("rings", 3.0).toFloat().coerceIn(1f, 10f)
            val ms = p.optLong("ms", 900L).coerceIn(50L, 10_000L)
            object : ZnMotionApi.Driver {
                override val durationNanos = ms * 1_000_000L
                private val w = rings * 2f * Math.PI.toFloat()
                override fun value(timeNanos: Long): Float {
                    val t = timeNanos / durationNanos.toFloat()
                    return to + (from - to) * kotlin.math.exp(-5f * t) * kotlin.math.cos(w * t)
                }
                override fun velocity(timeNanos: Long): Float {
                    val t = timeNanos / durationNanos.toFloat()
                    val e = kotlin.math.exp(-5f * t)
                    val d = (from - to) * e * (-5f * kotlin.math.cos(w * t) - w * kotlin.math.sin(w * t))
                    return d * 1e9f / durationNanos
                }
            }
        }
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
