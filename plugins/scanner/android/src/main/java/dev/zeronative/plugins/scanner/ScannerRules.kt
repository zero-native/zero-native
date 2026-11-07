package dev.zeronative.plugins.scanner

/** The scanner's rules, apart from Android and the camera, so they run on the JVM (ScannerRulesTest). */
internal object ScannerRules {
    /** After the camera starts, the phone can still hand us an old picture, like the last counter's QR. */
    const val WARMUP_MS = 500L

    /** ML Kit's numbers for each format (Barcode.FORMAT_*). JS uses the names. */
    private val FORMATS = linkedMapOf(
        "qr" to 256,
        "aztec" to 4096,
        "datamatrix" to 16,
        "pdf417" to 2048,
        "ean13" to 32,
        "ean8" to 64,
        "upca" to 512,
        "upce" to 1024,
        "code128" to 1,
        "code39" to 2,
        "code93" to 4,
        "codabar" to 8,
        "itf" to 128,
    )

    /** The codes to look for. QR only unless the app asks: fewer false reads, and each frame is read faster. */
    fun formatCodes(names: List<String>): List<Int> = names.mapNotNull { FORMATS[it] }.distinct().ifEmpty { listOf(FORMATS.getValue("qr")) }

    fun formatName(code: Int): String = FORMATS.entries.firstOrNull { it.value == code }?.key ?: "unknown"

    /** Only web links: an OTA bundle sets this text, and it must not be able to open a payment link. */
    fun safeLink(url: String?): String? = url?.takeIf { it.startsWith("https://") || it.startsWith("http://") }

    enum class Permission(val jsName: String) {
        /** Show the camera. */
        GRANTED("granted"),
        /** Never asked: Android's dialog comes next. */
        ASK("denied"),
        /** Android's dialog is open. */
        ASKING("denied"),
        /** Refused: we can ask again. */
        DENIED("denied"),
        /** Android won't show the dialog again: only the settings page can change it. */
        BLOCKED("blocked"),
    }

    /** [asked]: the user has answered the dialog on this screen. [rationale]: Android's shouldShowRequestPermissionRationale. */
    fun permission(granted: Boolean, asking: Boolean, asked: Boolean, rationale: Boolean): Permission = when {
        granted -> Permission.GRANTED
        asking -> Permission.ASKING
        !asked -> Permission.ASK
        rationale -> Permission.DENIED
        else -> Permission.BLOCKED // a dialog closed with no answer lands here too; settings still works as a way out
    }
}

/**
 * Decides which frames count and which code wins. [start] and [stop] come from the main thread, [frame] from the camera's,
 * and [claim] from the main thread, so every step takes the same lock.
 *
 * A locked gate stays locked through [stop] and [start]: going to the background and back must not scan again while the
 * app handles the first code. Only [release] opens it.
 */
internal class ScanGate(private val clock: () -> Long, private val warmupMs: Long = ScannerRules.WARMUP_MS) {
    private var run = 0
    private var open = false
    private var firstFrameAt = NO_FRAME
    private var locked = false
    private var dropped = false

    /** The camera (re)starts. The stale window starts at its first real frame, not now: the camera can take a second to open. */
    @Synchronized
    fun start() {
        run++
        open = true
        firstFrameAt = NO_FRAME
    }

    /** No frame counts until [start]. A read still running is stale from now on. */
    @Synchronized
    fun stop() {
        run++
        open = false
    }

    /** A new frame. The run to pass to [claim] if it should be read, or [SKIP] if not. */
    @Synchronized
    fun frame(): Int {
        if (!open || locked) return SKIP
        val now = clock()
        if (firstFrameAt == NO_FRAME) firstFrameAt = now
        return if (now - firstFrameAt < warmupMs) SKIP else run
    }

    /** A code was read from a frame of [run]. True for the first one only: a second code, or one from before a stop, loses. */
    @Synchronized
    fun claim(run: Int): Boolean {
        if (run != this.run || !open || locked) return false
        locked = true
        return true
    }

    /** True once per lock if another code came after the first: for the log only. */
    @Synchronized
    fun droppedOne(): Boolean {
        if (dropped) return false
        dropped = true
        return true
    }

    /** Ms from the first frame of this run: for the log only. */
    @Synchronized
    fun sinceFirstFrame(): Long = if (firstFrameAt == NO_FRAME) 0 else clock() - firstFrameAt

    /** "Scan again": the next code counts. */
    @Synchronized
    fun release() {
        locked = false
        dropped = false
    }

    companion object {
        const val SKIP = -1
        private const val NO_FRAME = Long.MIN_VALUE
    }
}

/**
 * The torch of a view, which JS turns on with a prop. Leaving the screen turns it off, and it must not come back by surprise
 * on return while the prop still says on. So it stays off until JS sets the prop to false and then to true again.
 */
internal object TorchRule {
    /** [held]: the torch went off when the screen left, and the prop hasn't been set to false since. */
    fun isOn(wanted: Boolean, held: Boolean) = wanted && !held

    fun heldAfterLeaving(wanted: Boolean, held: Boolean) = wanted || held

    fun heldAfterProp(wanted: Boolean, held: Boolean) = wanted && held
}

/**
 * What the app asks of the zoom. [start]: the ratio when the camera starts (null: the camera's own, 1x). [auto]: ML Kit
 * says how far to zoom when a code is small or far. [pinch]: two fingers on the preview.
 */
internal data class ZoomWish(val start: Float?, val auto: Boolean, val pinch: Boolean) {
    companion object {
        /** From a prop or param: a start that isn't a positive number means none. */
        fun of(start: Double, auto: Boolean, pinch: Boolean) =
            ZoomWish(start.takeIf { it.isFinite() && it > 0.0 }?.toFloat(), auto, pinch)
    }
}

internal object ZoomRule {
    /** A ratio the camera can take: phones differ (some go below 1x with a wide lens, most stop at 8x or 10x). */
    fun clamp(ratio: Float, min: Float, max: Float): Float = if (max <= min) min else ratio.coerceIn(min, max)

    /** After a pinch: the user's zoom, so ML Kit's suggestions stop for this scan. */
    fun autoAllowed(wish: ZoomWish, pinched: Boolean) = wish.auto && !pinched
}
