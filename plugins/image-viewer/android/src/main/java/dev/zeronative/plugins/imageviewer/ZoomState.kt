package dev.zeronative.plugins.imageviewer

import androidx.compose.animation.core.AnimationState
import androidx.compose.animation.core.DecayAnimationSpec
import androidx.compose.animation.core.EaseOutCubic
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.unit.Velocity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlin.math.abs

/** One picture's zoom and move. Main thread. The rules are in [ViewerRules]. */
@Stable
internal class ZoomState(private val ui: CoroutineScope) {
    var camera by mutableStateOf(Camera.FIT)
        private set
    /** The page's size. */
    var screen by mutableStateOf(Dims(0f, 0f))
    /** The loaded picture's size (any scale: only its shape counts), or null while there is none. */
    var content by mutableStateOf<Dims?>(null)
    /** Fingers are on the picture. */
    var touching by mutableStateOf(false)
        private set
    /** An animation or a fling runs. */
    var moving by mutableStateOf(false)
        private set
    private var motion: Job? = null

    val zoomed: Boolean get() = camera.z > ViewerRules.ZOOMED
    val still: Boolean get() = !touching && !moving

    /** The picture's size on screen at zoom 1. */
    fun fitted(): Dims = content?.let { ViewerRules.fitted(it, screen) } ?: screen

    fun stop() {
        motion?.cancel()
        motion = null
        moving = false
    }

    /** Back to fit, at once: another page was chosen, or the screen turned. */
    fun reset() {
        stop()
        camera = Camera.FIT
    }

    fun zoomBy(factor: Float, fx: Float, fy: Float) {
        camera = ViewerRules.clamp(ViewerRules.zoomAround(camera, factor, fx, fy, screen), fitted(), screen)
    }

    fun panBy(dx: Float, dy: Float) {
        camera = ViewerRules.clamp(camera.copy(x = camera.x + dx, y = camera.y + dy), fitted(), screen)
    }

    fun doubleTap(x: Float, y: Float) {
        if (content == null) return
        animateTo(ViewerRules.doubleTap(camera, x, y, fitted(), screen))
    }

    fun settle() = animateTo(ViewerRules.settle(camera, fitted(), screen))

    /** 240 ms, ease out: the same as the React Native screen. */
    fun animateTo(target: Camera) {
        stop()
        val from = camera
        if (from == target) return
        run {
            animate(0f, 1f, animationSpec = tween(240, easing = EaseOutCubic)) { t, _ ->
                camera = Camera(lerp(from.z, target.z, t), lerp(from.x, target.x, t), lerp(from.y, target.y, t))
            }
            camera = target
        }
    }

    /** Keeps moving after the fingers leave a zoomed picture, slowing down, until it stops or reaches an edge. */
    fun fling(velocity: Velocity, decay: DecayAnimationSpec<Float>) {
        stop()
        if (abs(velocity.x) < MIN_FLING && abs(velocity.y) < MIN_FLING) return
        run {
            coroutineScope {
                launch { glide(velocity.x, decay) { panBy(it, 0f) } }
                launch { glide(velocity.y, decay) { panBy(0f, it) } }
            }
        }
    }

    private suspend fun glide(speed: Float, decay: DecayAnimationSpec<Float>, move: (Float) -> Unit) {
        if (abs(speed) < MIN_FLING) return
        var last = 0f
        AnimationState(0f, speed).animateDecay(decay) {
            val before = camera
            move(value - last)
            last = value
            if (camera == before) cancelAnimation()
        }
    }

    /** Runs [block] as the one motion: a newer one cancels it, and [moving] belongs to the newest. */
    private fun run(block: suspend () -> Unit) {
        moving = true
        // Lazy, so [motion] is set before the block runs: a block that ends at once still clears [moving].
        val job = ui.launch(start = CoroutineStart.LAZY) {
            val me = currentCoroutineContext()[Job]
            try {
                block()
            } finally {
                if (motion === me) {
                    motion = null
                    moving = false
                }
            }
        }
        motion = job
        job.start()
    }

    /**
     * Two fingers zoom around their middle and move the picture. One finger moves a zoomed picture. One finger on a
     * picture that isn't zoomed is left alone: the pager (left / right) and the swipe to close (up / down) get it.
     */
    suspend fun PointerInputScope.gestures(decay: DecayAnimationSpec<Float>) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            stop()
            touching = true
            val tracker = VelocityTracker()
            var owned = false
            var fingers = 1
            var zoomSum = 1f
            var panSum = Offset.Zero
            var at = Offset.Zero // the fingers' middle, from the pans: no jump when a finger comes or goes
            try {
                while (true) {
                    val e = awaitPointerEvent()
                    val down = e.changes.count { it.pressed }
                    if (down == 0) break
                    val zoom = e.calculateZoom()
                    val pan = e.calculatePan()
                    if (!owned) {
                        if (down != fingers) {
                            fingers = down
                            zoomSum = 1f
                            panSum = Offset.Zero
                        }
                        zoomSum *= zoom
                        panSum += pan
                        val slop = viewConfiguration.touchSlop
                        val spread = abs(1 - zoomSum) * e.calculateCentroidSize(useCurrent = false)
                        val far = panSum.getDistance() > slop
                        if (content != null && ((down > 1 && (spread > slop || far)) || (down == 1 && zoomed && far))) owned = true
                    }
                    if (owned) {
                        val centroid = e.calculateCentroid(useCurrent = false)
                        if (zoom != 1f && centroid.x.isFinite() && centroid.y.isFinite()) zoomBy(zoom, centroid.x, centroid.y)
                        panBy(pan.x, pan.y)
                        for (c in e.changes) if (c.positionChanged()) c.consume()
                    }
                    at += pan
                    e.changes.firstOrNull { it.pressed }?.let { tracker.addPosition(it.uptimeMillis, at) }
                }
            } finally {
                touching = false
            }
            if (owned && camera.z >= 1f && zoomed) {
                fling(tracker.calculateVelocity(), decay)
            } else if (camera != ViewerRules.settle(camera, fitted(), screen)) {
                settle() // under 1, or a touch stopped the spring back half way
            }
        }
    }

    private companion object {
        const val MIN_FLING = 50f
        fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t
    }
}
