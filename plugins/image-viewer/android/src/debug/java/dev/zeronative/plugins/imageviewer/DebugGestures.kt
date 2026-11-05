package dev.zeronative.plugins.imageviewer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import androidx.core.content.ContextCompat
import dev.zeronative.runtime.ZnActivity

/**
 * Debug builds only (the release source set has an empty one). Two-finger gestures from adb, for phones where
 * `sendevent` needs root (the Lava) and for scripts. Real MotionEvents go through the Activity, so the viewer's own
 * gesture code runs. Pixels are the screen's.
 *
 *     adb shell am broadcast -a dev.zeronative.imageviewer.DEBUG_GESTURE --es kind pinch --ei x 360 --ei y 800 --ei from 150 --ei to 450 --ei ms 400
 *     ... --es kind pinch --ei x 360 --ei y 800 --ei from 300 --ei to 300 --ei dx 200 --ei dy 0      (two fingers move together)
 */
internal object DebugGestures {
    private const val ACTION = "dev.zeronative.imageviewer.DEBUG_GESTURE"
    private const val FRAME = 16L

    fun install(context: Context) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.getStringExtra("kind")) {
                    "pinch" -> pinch(i)
                    else -> Log.w("zn", "image-viewer debug gesture: unknown kind")
                }
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED)
    }

    private fun pinch(i: Intent) {
        val x = i.getIntExtra("x", 360).toFloat()
        val y = i.getIntExtra("y", 800).toFloat()
        val from = i.getIntExtra("from", 150).toFloat()
        val to = i.getIntExtra("to", 450).toFloat()
        val dx = i.getIntExtra("dx", 0).toFloat()
        val dy = i.getIntExtra("dy", 0).toFloat()
        val steps = (i.getIntExtra("ms", 400) / FRAME).toInt().coerceAtLeast(2)
        val down = SystemClock.uptimeMillis()
        val events = ArrayList<() -> MotionEvent>()
        fun at(k: Int) = Triple(from + (to - from) * k / steps, x + dx * k / steps, y + dy * k / steps)
        val (g0, x0, y0) = at(0)
        events += { event(down, MotionEvent.ACTION_DOWN, 1, g0, x0, y0) }
        events += { event(down, MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, g0, x0, y0) }
        for (k in 1..steps) {
            val (g, cx, cy) = at(k)
            events += { event(down, MotionEvent.ACTION_MOVE, 2, g, cx, cy) }
        }
        val (g1, x1, y1) = at(steps)
        events += { event(down, MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 2, g1, x1, y1) }
        events += { event(down, MotionEvent.ACTION_UP, 1, g1, x1, y1) }
        play(events)
    }

    /** One event per frame, each made when it is sent (its time is then). */
    private fun play(events: List<() -> MotionEvent>) {
        val main = Handler(Looper.getMainLooper())
        events.forEachIndexed { n, make ->
            main.postDelayed({
                val activity = ZnActivity.current ?: return@postDelayed
                val e = make()
                activity.dispatchTouchEvent(e)
                e.recycle()
            }, n * FRAME)
        }
    }

    /** [count] fingers: one at the middle less half the gap, the second at the middle plus half the gap (for one: at x, y). */
    private fun event(down: Long, action: Int, count: Int, gap: Float, x: Float, y: Float): MotionEvent {
        val props = Array(count) { MotionEvent.PointerProperties().apply { id = it; toolType = MotionEvent.TOOL_TYPE_FINGER } }
        val coords = Array(count) { k ->
            MotionEvent.PointerCoords().apply {
                this.x = if (count == 1) x else if (k == 0) x - gap / 2 else x + gap / 2
                this.y = y
                pressure = 1f
                size = 1f
            }
        }
        return MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, count, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
    }
}
