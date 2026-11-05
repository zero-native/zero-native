package dev.zeronative.plugins.lottie

/**
 * The plugin's decisions, with no Android in them, so JVM tests cover them (LottieRulesTest). The view (LottieView.kt)
 * only carries them out.
 */
internal object LottieRules {
    /**
     * The path inside the bundle's assets for `asset:lottie/x.json` (or `asset://...`), or null. Only plain paths:
     * no `..`, no leading `/`, no `\`. The source comes from JS, and JS can come over the air.
     */
    fun assetPath(source: String?): String? {
        if (source == null) return null
        val path = when {
            source.startsWith("asset://") -> source.removePrefix("asset://")
            source.startsWith("asset:") -> source.removePrefix("asset:")
            else -> return null
        }
        if (path.isEmpty() || path.startsWith("/") || path.contains('\\') || path.endsWith("/")) return null
        if (path.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        return path
    }

    /** Is it meant to play now. `auto`: no method was called yet, so `autoPlay` decides. */
    fun playing(mode: String, autoPlay: Boolean): Boolean = when (mode) {
        "play" -> true
        "auto" -> autoPlay
        else -> false // "pause", "stop"
    }

    /** The speed to animate at: the phone's animator scale (developer options) applies, as for Android's own animations. */
    fun speed(speed: Float, animatorScale: Float): Float = if (animatorScale > 0f) speed / animatorScale else speed

    /** Android's "Remove animations" (or battery saver) sets the animator scale to 0. */
    fun motionOff(animatorScale: Float): Boolean = animatorScale == 0f

    /**
     * Where a play goes from, as progress (0 to 1), or null to stay where it is. [prev] is null for the first answer
     * after a file loads. [min] and [max]: the part being played (the whole animation is 0 and 1).
     */
    fun start(prev: Target?, next: Target, current: Float, min: Float, max: Float): Float? {
        val fromStart = if (next.playing && next.backwards) max else min
        // First time: autoPlay starts at the start, as RN's playAnimation() does; else the `progress` frame (RN default 0).
        if (prev == null) return if (next.playing) fromStart else (next.progress ?: 0f).coerceIn(min, max)
        // reset(), or play(startFrame, endFrame).
        if (next.restart != prev.restart) return fromStart
        // A new `progress` jumps there, also while playing.
        if (next.progress != null && next.progress != prev.progress) return next.progress.coerceIn(min, max)
        // play() or resume(): on from here, or from the start if it is at the end (Lottie's resumeAnimation()).
        if (next.playing && (!prev.playing || next.plays != prev.plays)) {
            val atEnd = if (next.backwards) current <= min else current >= max
            return if (atEnd) fromStart else null
        }
        // A new part with no restart can't happen (play() without frames keeps the place), so: stay.
        return if (current < min || current > max) current.coerceIn(min, max) else null
    }

    /** RN sends `onAnimationFinish(true)` only when reset() stops a play that was running. */
    fun cancelled(prev: Target?, next: Target, wasRunning: Boolean): Boolean =
        wasRunning && prev != null && next.mode == "stop" && (prev.mode != "stop" || prev.restart != next.restart)

    /**
     * With animations off: is this a new play (so a play without `loop` ends with `onAnimationFinish(false)` at once)? Not
     * for a change of speed or loop while it already shows its end.
     */
    fun newPlay(prev: Target?, next: Target): Boolean =
        next.playing && (prev == null || !prev.playing || prev.restart != next.restart || prev.plays != next.plays)

    /**
     * A play without `loop` that reached its end is over, as on RN: the view then acts as not playing (a new `progress`
     * only shows that frame) until the next play(), resume() or reset(). [ended] is the (restart, plays) of that play.
     */
    fun afterEnd(target: Target, ended: Pair<Int, Int>?): Target =
        if (target.playing && ended == (target.restart to target.plays)) target.copy(playing = false) else target

    /** The part to play, in frames, low to high; null for the whole animation. A first frame above the second plays backwards. */
    fun part(from: Int?, to: Int?): IntRange? = if (from == null || to == null) null else minOf(from, to)..maxOf(from, to)

    /** With a part, its frames say the way (RN turns the speed's sign to match them); else the speed's sign does. */
    fun backwards(speed: Float, from: Int?, to: Int?): Boolean =
        if (from != null && to != null) from > to else speed < 0f

    /**
     * A colour filter's key path, as lottie-react-native builds it: "Layer.Group" → ["Layer", "Group", "**"], so
     * everything under it is painted. Empty parts are dropped.
     */
    fun keyPath(keypath: String): List<String> = "$keypath.**".split('.').filter { it.isNotEmpty() }
}

/** What the props and the controller ask for, in the terms [LottieRules.start] needs. */
internal data class Target(
    val mode: String,
    val playing: Boolean,
    val restart: Int,
    /** Raised by each play() and resume() in JS. */
    val plays: Int,
    val progress: Float?,
    val backwards: Boolean,
    val loop: Boolean,
    val speed: Float,
    val from: Int?,
    val to: Int?,
)
