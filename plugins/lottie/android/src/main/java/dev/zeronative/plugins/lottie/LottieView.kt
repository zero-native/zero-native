package dev.zeronative.plugins.lottie

import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.LottieProperty
import com.airbnb.lottie.RenderMode
import com.airbnb.lottie.SimpleColorFilter
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieClipSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.LottieDynamicProperties
import com.airbnb.lottie.compose.LottieDynamicProperty
import com.airbnb.lottie.compose.rememberLottieAnimatable
import com.airbnb.lottie.model.KeyPath
import dev.zeronative.runtime.ZnViewScope
import kotlin.math.abs
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** What JS asked for in `props` (api.ts lottieProps). */
internal data class LottieSpec(
    val source: String?,
    val autoPlay: Boolean,
    val loop: Boolean,
    val speed: Float,
    val progress: Float?,
    val contentScale: ContentScale,
    val renderMode: RenderMode,
    val mergePaths: Boolean,
    val opacityToLayers: Boolean,
    val safeMode: Boolean,
    val cache: Boolean,
    val colorFilters: List<Pair<List<String>, Int>>,
    val mode: String,
    val restart: Int,
    val plays: Int,
    val from: Int?,
    val to: Int?,
) {
    companion object {
        fun of(p: JSONObject): LottieSpec {
            val filters = p.optJSONArray("colorFilters")
            return LottieSpec(
                source = if (p.isNull("source")) null else p.optString("source"),
                autoPlay = p.optBoolean("autoPlay", false),
                loop = p.optBoolean("loop", true),
                speed = p.optDouble("speed", 1.0).toFloat().takeIf { it.isFinite() } ?: 1f,
                progress = if (p.isNull("progress")) null else p.optDouble("progress", 0.0).toFloat().coerceIn(0f, 1f),
                contentScale = when (p.optString("resizeMode")) {
                    "cover" -> ContentScale.Crop
                    "center" -> ContentScale.None
                    else -> ContentScale.Fit // "contain", RN's default
                },
                renderMode = when (p.optString("renderMode")) {
                    "HARDWARE" -> RenderMode.HARDWARE
                    "SOFTWARE" -> RenderMode.SOFTWARE
                    else -> RenderMode.AUTOMATIC
                },
                mergePaths = p.optBoolean("mergePaths", false),
                opacityToLayers = p.optBoolean("opacityToLayers", false),
                safeMode = p.optBoolean("safeMode", false),
                cache = p.optBoolean("cache", true),
                colorFilters = (0 until (filters?.length() ?: 0)).mapNotNull { i ->
                    val f = filters!!.optJSONObject(i) ?: return@mapNotNull null
                    val keypath = f.optString("keypath")
                    if (keypath.isEmpty() || !f.has("color")) null else LottieRules.keyPath(keypath) to f.optLong("color").toInt()
                },
                mode = p.optString("mode", "auto"),
                restart = p.optInt("restart", 0),
                plays = p.optInt("plays", 0),
                from = if (p.isNull("from")) null else p.optInt("from"),
                to = if (p.isNull("to")) null else p.optInt("to"),
            )
        }
    }
}

/** What the last play effect saw; plain fields, not state: only the next effect reads them. */
private class Last {
    var composition: LottieComposition? = null
    var target: Target? = null
    /** A play was running. It stays true when its effect is cancelled, so the next effect knows a play was cut. */
    var running = false
    /** (restart, plays) of the play without loop that reached its end; null when none did. */
    var ended: Pair<Int, Int>? = null
}

/**
 * The `lottie.view` view. Plays only while its screen shows: Compose stops frames while the app is in the background, and
 * a covered screen is not drawn at all (coming back starts the view again, as a new one).
 */
@Composable
internal fun LottieViewContent(scope: ZnViewScope, files: LottieFiles) {
    val context = LocalContext.current
    val spec = remember(scope.props) { LottieSpec.of(scope.props) }
    var composition by remember { mutableStateOf<LottieComposition?>(null) }
    val anim = rememberLottieAnimatable()
    val last = remember { Last() }

    // The animator scale is read again each time the app comes back: the user may have turned animations off meanwhile.
    var scale by remember { mutableFloatStateOf(animatorScale(context)) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) scale = animatorScale(context) }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(spec.source, spec.cache) {
        composition = null
        if (spec.source == null) return@LaunchedEffect
        when (val r = withContext(LottieThread.dispatcher) { files.load(spec.source, spec.cache) }) {
            is LottieLoad.Ok -> {
                composition = r.composition
                scope.emit("loaded", infoJson(r.composition))
            }
            is LottieLoad.Failed -> scope.emit("failure", JSONObject().put("error", r.reason))
        }
    }

    val target = Target(
        mode = spec.mode,
        playing = LottieRules.playing(spec.mode, spec.autoPlay),
        restart = spec.restart,
        plays = spec.plays,
        progress = spec.progress,
        backwards = LottieRules.backwards(spec.speed, spec.from, spec.to),
        loop = spec.loop,
        speed = spec.speed,
        from = spec.from,
        to = spec.to,
    )
    val motionOff = LottieRules.motionOff(scale)
    LaunchedEffect(composition, target, scale) {
        val c = composition ?: return@LaunchedEffect
        val same = last.composition === c
        val prev = last.target.takeIf { same }
        val wasRunning = last.running && prev != null
        // A play that reached its end stays over until the next play(), resume() or reset() (LottieRules.afterEnd).
        val t = LottieRules.afterEnd(target, last.ended.takeIf { same })
        last.composition = c
        last.target = t
        last.running = false
        if (!same) last.ended = null
        if (LottieRules.cancelled(prev, t, wasRunning)) scope.emit("finish", finishJson(cancelled = true))

        val part = LottieRules.part(t.from, t.to)
        val clip = part?.let { LottieClipSpec.Frame(min = it.first, max = it.last) }
        // As LottieClipSpec.Frame works them out (its own functions are internal).
        val min = part?.let { c.getProgressForFrame(it.first.toFloat()).coerceIn(0f, 1f) } ?: 0f
        val max = part?.let { c.getProgressForFrame(it.last.toFloat()).coerceIn(0f, 1f) } ?: 1f
        val start = LottieRules.start(prev, t, anim.progress, min, max)

        if (!t.playing) {
            if (start != null) anim.snapTo(c, start, iteration = 1)
            return@LaunchedEffect
        }
        if (motionOff) {
            // "Remove animations" is on: show where the play would end, at once (Lottie's own LottieAnimationView does
            // this too). An animation with a "reduced motion" marker shows that frame instead (LottieAnimation draws it).
            anim.snapTo(c, if (t.backwards) min else max, iteration = 1)
            if (!t.loop && LottieRules.newPlay(prev, t)) {
                last.ended = t.restart to t.plays
                scope.emit("finish", finishJson(cancelled = false))
            }
            return@LaunchedEffect
        }
        val speed = LottieRules.speed(abs(t.speed), scale).let { if (t.backwards) -it else it }
        last.running = true
        anim.animate(
            c,
            iteration = 1,
            iterations = if (t.loop) LottieConstants.IterateForever else 1,
            speed = speed,
            clipSpec = clip,
            initialProgress = start ?: anim.progress,
            // Never true: it keeps the last frame's time, so after a pause (or a play that ended long ago) the first
            // frame would count the whole gap and jump ahead, or finish at once (seen on the emulator).
            continueFromPreviousAnimate = false,
            ignoreSystemAnimationsDisabled = true, // handled above, with RN's events
        )
        // Only a play without loop gets here: it reached its end.
        last.running = false
        last.ended = t.restart to t.plays
        scope.emit("finish", finishJson(cancelled = false))
    }

    val dynamic = remember(spec.colorFilters) {
        if (spec.colorFilters.isEmpty()) null else LottieDynamicProperties(
            spec.colorFilters.map { (keys, color) ->
                LottieDynamicProperty(LottieProperty.COLOR_FILTER, KeyPath(*keys.toTypedArray()), SimpleColorFilter(color))
            },
        )
    }
    LottieAnimation(
        composition = composition,
        progress = { anim.progress },
        modifier = Modifier.fillMaxSize(),
        applyOpacityToLayers = spec.opacityToLayers,
        enableMergePaths = spec.mergePaths,
        renderMode = spec.renderMode,
        dynamicProperties = dynamic,
        contentScale = spec.contentScale,
        safeMode = spec.safeMode,
    )
}

private fun finishJson(cancelled: Boolean) = JSONObject().put("isCancelled", cancelled)

/** 1 normally; 0 with "Remove animations" (accessibility) or battery saver; other values from developer options. */
private fun animatorScale(context: Context): Float =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
