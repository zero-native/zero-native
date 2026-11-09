package dev.zeronative.runtime

import android.content.Context
import android.util.Log
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import coil3.SingletonImageLoader
import coil3.request.Disposable
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.request.target
import coil3.toBitmap
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// <Canvas> draw.image (ZnCanvas.kt ImageOp): loaded with the app's Coil image loader (the one <Image> uses), decoded at
// about the drawn size, kept with the command list, drawn when loaded. Nothing is drawn while it loads or after an
// error (a warning). Loads are cancelled when the list changes or the canvas leaves, so nothing leaks.

/**
 * What Coil loads for [src]: the same forms as <Image> (ZnRenderer.kt imageModel, which is private there): `asset:path`
 * (or `asset://path`) is the running bundle's image, `zn://` a native handle, http(s) as it is.
 */
private fun canvasImageModel(src: String, context: Context): Any = when {
    src.startsWith("zn://") -> ZnHandles.request(context, src)
    src.startsWith("asset://") -> ZnBundles.assetModel(src.removePrefix("asset://"))
    src.startsWith("asset:") -> ZnBundles.assetModel(src.removePrefix("asset:"))
    else -> src
}

/**
 * Starts the loads for [commands]' images. An image the last list had at the same size ([kept]) is used at once, so a
 * list that changes every 500 ms doesn't blink. [onLoaded] runs on the main thread after a load (the canvas redraws).
 */
internal fun startCanvasImages(context: Context, commands: CanvasCommands, kept: HashMap<String, ImageBitmap>, onLoaded: () -> Unit): List<Disposable> {
    val loads = ArrayList<Disposable>()
    val pending = HashMap<String, ArrayList<CanvasOp.ImageOp>>()
    val used = HashSet<String>()
    for (op in commands.ops) {
        if (op !is CanvasOp.ImageOp) continue
        val key = op.key
        used.add(key)
        val have = kept[key]
        if (have != null) {
            op.bitmap = have
            continue
        }
        // The same image twice in one list: one load.
        pending[key]?.let {
            it.add(op)
            continue
        }
        val waiting = arrayListOf(op)
        pending[key] = waiting
        try {
            val model = canvasImageModel(op.src, context)
            val builder = (model as? ImageRequest)?.newBuilder(context) ?: ImageRequest.Builder(context).data(model)
            val request = builder
                .size(op.decodeW, op.decodeH)
                // At most this size, keeping the picture's shape; never blown up past its own pixels.
                .precision(coil3.size.Precision.INEXACT)
                // A software bitmap: a hardware one throws when this canvas is drawn into a software canvas.
                .allowHardware(false)
                .listener(onError = { _, result -> Log.w("zn", "<Canvas> image failed: ${op.src} — ${result.throwable}") })
                .target(onSuccess = { image ->
                    val bmp = image.toBitmap().asImageBitmap()
                    kept[key] = bmp
                    for (o in waiting) o.bitmap = bmp
                    onLoaded()
                })
                .build()
            loads.add(SingletonImageLoader.get(context).enqueue(request))
        } catch (e: Exception) {
            Log.w("zn", "<Canvas> image ${op.src} can't load: $e")
        }
    }
    // Only this list's images stay.
    kept.keys.retainAll(used)
    return loads
}

/** Draws a loaded image with its fit, corner radius and opacity. No allocation. */
internal fun DrawScope.drawCanvasImage(op: CanvasOp.ImageOp, bmp: ImageBitmap) {
    val x = op.x.value
    val y = op.y.value
    val w = op.w.value
    val h = op.h.value
    val bw = bmp.width
    val bh = bmp.height
    if (!(w > 0f && h > 0f) || bw <= 0 || bh <= 0) return
    var sx = 0
    var sy = 0
    var sw = bw
    var sh = bh
    var dx = x
    var dy = y
    var dw = w
    var dh = h
    when (op.fit) {
        FIT_COVER -> { // cover: the middle of the image, cut to the box's shape
            val s = max(w / bw, h / bh)
            sw = (w / s).roundToInt().coerceIn(1, bw)
            sh = (h / s).roundToInt().coerceIn(1, bh)
            sx = (bw - sw) / 2
            sy = (bh - sh) / 2
        }
        FIT_CONTAIN -> { // contain: all of it, centred in the box
            val s = min(w / bw, h / bh)
            dw = bw * s
            dh = bh * s
            dx = x + (w - dw) / 2
            dy = y + (h - dh) / 2
        }
        else -> {} // fill: stretched
    }
    val r = op.radius?.value ?: 0f
    val canvas = drawContext.canvas
    if (r > 0f) {
        canvas.save()
        val p = op.clip.asAndroidPath()
        p.reset()
        p.addRoundRect(dx, dy, dx + dw, dy + dh, r, r, android.graphics.Path.Direction.CW)
        canvas.clipPath(op.clip)
    }
    drawImage(
        image = bmp,
        srcOffset = IntOffset(sx, sy),
        srcSize = IntSize(sw, sh),
        dstOffset = IntOffset(dx.roundToInt(), dy.roundToInt()),
        dstSize = IntSize(dw.roundToInt().coerceAtLeast(1), dh.roundToInt().coerceAtLeast(1)),
        alpha = op.opacity.value.coerceIn(0f, 1f),
    )
    if (r > 0f) canvas.restore()
}
