package dev.zeronative.runtime

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.Surface
import androidx.compose.animation.core.Animation
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorConverter
import androidx.compose.runtime.withFrameNanos
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The native extension point for motion (docs/gestures-and-motion-v1.md §2.10, D8): what a plugin uses for work a
 * formula can't express (custom physics, an audio level, a video's position). Main thread only, like all motion.
 *
 * - **Values:** JS makes the id (core `nativeMotion((id) => callNative("MyPlugin", "start", { id }))`); the plugin
 *   gets a [Handle] with [value] and sets it from its own events, or each frame with [onFrame]. JS binds it like any
 *   motion value. When JS drops it, the plugin's `onDispose` runs.
 * - **Drivers:** a custom curve for `v.to(x, { driver: "physics.orbit", params })`, registered once with
 *   [registerDriver]. The JS helper that names a driver should live in the plugin's package and call its module, so a
 *   bundle that uses it needs the plugin (an older app refuses the bundle; an unknown driver fails the command).
 * - **Native view props:** a motion value in `<NativeView props>` reaches the view as a reference; [reader] turns it
 *   into a function the view reads in its draw or layout phase each frame (ZnViewScope.motion).
 *
 * Rules: what runs each frame must not allocate; never block the main thread. APK only, never from OTA.
 */
object ZnMotionApi {
    /** A plugin's motion value. */
    class Handle internal constructor(private val v: ZnValue) {
        /** The value now. Setting it moves everything bound to it in the same frame. NaN / Infinity are ignored. */
        var value: Float
            get() = v.value
            set(x) {
                v.value = x
            }

        /** Called once when JS drops the value (its screen closed) or the JS reloads. */
        fun onDispose(block: () -> Unit) {
            v.onDispose = block
        }
    }

    /**
     * The value JS made with id [id] for this plugin (core nativeMotion), made here if JS hasn't sent it yet.
     * [initial] is used only when it is made here.
     */
    fun value(id: Int, initial: Float = 0f): Handle {
        val v = ZnMotion.find(id) as? ZnValue ?: ZnMotion.putValue(id, initial)
        return Handle(v)
    }

    /**
     * Calls [block] once per frame with the frame time (ns) until it returns false or the job is cancelled. For physics
     * that steps each frame. Must not allocate.
     */
    fun onFrame(block: (frameNanos: Long) -> Boolean): Job = ZnMotion.scope.launch {
        while (isActive) {
            val goOn = withFrameNanos { block(it) }
            if (!goOn) break
        }
    }

    /**
     * A custom curve. [make] is called on each `v.to(x, { driver: name, params })` with where it starts, where it
     * goes, the speed it has, and JS's params.
     */
    fun interface DriverFactory {
        fun make(from: Float, to: Float, velocity: Float, params: JSONObject): Driver
    }

    /** One run of a custom curve. Pure functions of time: called each frame, must not allocate. */
    interface Driver {
        /** How long it runs (ns). */
        val durationNanos: Long
        fun value(timeNanos: Long): Float
        fun velocity(timeNanos: Long): Float
    }

    private val drivers = HashMap<String, DriverFactory>()

    /** Registers a driver under [name] ("plugin.name"), usually in the plugin's `register`. */
    fun registerDriver(name: String, factory: DriverFactory) {
        drivers[name] = factory
    }

    internal fun driver(name: String): DriverFactory? = drivers[name]

    /**
     * For a native view: a prop that JS gave as a motion value ("\u0000m<id>" in the props JSON) as a function to read
     * each frame (in a draw or layout block, so the view isn't composed again); null when it isn't one.
     */
    fun reader(prop: Any?): (() -> Float)? {
        val src = (prop as? String)?.let { ZnMotion.ref(it) } ?: return null
        return { src.read(null) }
    }
}

/** A plugin driver as a Compose Animation, so ZnValue.run steps it like a spring or a tween. */
internal class ZnDriverAnimation(private val d: ZnMotionApi.Driver, override val targetValue: Float) :
    Animation<Float, AnimationVector1D> {
    override val durationNanos: Long get() = d.durationNanos.coerceAtLeast(0L)
    override val typeConverter: TwoWayConverter<Float, AnimationVector1D> get() = Float.VectorConverter
    override val isInfinite: Boolean get() = false
    override fun getValueFromNanos(playTimeNanos: Long): Float =
        if (playTimeNanos >= durationNanos) targetValue else d.value(playTimeNanos).takeIf { it.isFinite() } ?: targetValue
    override fun getVelocityVectorFromNanos(playTimeNanos: Long): AnimationVector1D =
        AnimationVector1D(if (playTimeNanos >= durationNanos) 0f else d.velocity(playTimeNanos).takeIf { it.isFinite() } ?: 0f)
}

/**
 * useTilt() (phase 3, Reanimated's useAnimatedSensor for tilt cards and gyro parallax): how the phone leans, from the
 * gravity sensor (the accelerometer when there is none), as x (left -1 … right 1) and y (away -1 … towards 1), turned
 * with the screen and smoothed. It listens only while some JS holds it and the app is in front.
 */
internal object ZnTilt : SensorEventListener {
    private val users = HashMap<Int, Pair<ZnValue, ZnValue>>()
    private var manager: SensorManager? = null
    private var sensor: Sensor? = null
    private var listening = false
    private var observing: LifecycleOwner? = null
    private var sx = 0f
    private var sy = 0f

    private val lifecycle = object : DefaultLifecycleObserver {
        override fun onResume(owner: LifecycleOwner) = update()
        override fun onPause(owner: LifecycleOwner) = stop()
    }

    fun add(id: Int, x: ZnValue, y: ZnValue) {
        users[id] = x to y
        val a = ZnActivity.current
        if (a != null && observing !== a) {
            (observing)?.lifecycle?.removeObserver(lifecycle)
            observing = a
            a.lifecycle.addObserver(lifecycle)
        }
        update()
    }

    fun remove(id: Int) {
        users.remove(id)
        if (users.isEmpty()) stop()
    }

    private fun update() {
        if (users.isEmpty() || listening) return
        val ctx: Context = ZnActivity.current ?: return
        val m = manager ?: (ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager)?.also { manager = it } ?: return
        val s = sensor ?: (m.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: m.getDefaultSensor(Sensor.TYPE_ACCELEROMETER))?.also { sensor = it } ?: return
        listening = m.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME)
    }

    private fun stop() {
        if (!listening) return
        manager?.unregisterListener(this)
        listening = false
    }

    override fun onSensorChanged(e: SensorEvent) {
        val g = SensorManager.GRAVITY_EARTH
        var ax = -e.values[0] / g
        var ay = e.values[1] / g
        // The sensor's axes are the phone's natural ones: turn them with the screen.
        @Suppress("DEPRECATION")
        when (ZnActivity.current?.windowManager?.defaultDisplay?.rotation) {
            Surface.ROTATION_90 -> { val t = ax; ax = -ay; ay = t }
            Surface.ROTATION_180 -> { ax = -ax; ay = -ay }
            Surface.ROTATION_270 -> { val t = ax; ax = ay; ay = -t }
        }
        // A light low-pass: the hand's shake goes, the lean stays.
        sx += (ax.coerceIn(-1f, 1f) - sx) * 0.2f
        sy += (ay.coerceIn(-1f, 1f) - sy) * 0.2f
        for ((x, y) in users.values) {
            x.value = sx
            y.value = sy
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    fun reset() {
        users.clear()
        stop()
    }
}
