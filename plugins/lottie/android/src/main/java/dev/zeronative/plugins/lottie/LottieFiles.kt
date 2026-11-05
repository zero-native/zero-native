package dev.zeronative.plugins.lottie

import android.content.Context
import android.content.res.Resources
import android.util.Log
import com.airbnb.lottie.LottieComposition
import com.airbnb.lottie.LottieCompositionFactory
import dev.zeronative.runtime.ZnBundles
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.util.concurrent.Executors
import kotlin.math.roundToInt
import kotlinx.coroutines.asCoroutineDispatcher
import org.json.JSONObject

/** One thread for reading and parsing files: four Welcome slides parse one after the other, not all at once at start. */
internal object LottieThread {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-lottie").apply { isDaemon = true } }
    val dispatcher = executor.asCoroutineDispatcher()

    fun run(block: () -> Unit) = executor.execute(block)
}

internal sealed interface LottieLoad {
    class Ok(val composition: LottieComposition) : LottieLoad
    class Failed(val reason: String) : LottieLoad
}

/**
 * Files from the running bundle: a downloaded OTA bundle's copy if it has the file, else the APK's assets (the same rule
 * as `<Image src="asset:...">`, ZnBundles.assetModel). JSON and `.lottie` (a zip) are both read: Lottie looks at the
 * first bytes, not the name.
 */
internal class LottieFiles(private val context: Context) {
    /** On [LottieThread], never the main thread: it reads and parses the file (tens of ms for a big one). */
    fun load(source: String?, cache: Boolean): LottieLoad {
        val path = LottieRules.assetPath(source) ?: return LottieLoad.Failed("bad_source")
        val running = ZnBundles.running
        val file = running.dir?.takeIf { running.info?.files?.containsKey(path) == true }?.let { File(it, path) }
        // The key names the bundle's copy, so an OTA update with a new file never shows the old one from the cache.
        val key = if (!cache) null else "zn-lottie:" + (file?.path ?: "apk:$path")
        val stream: InputStream = try {
            file?.inputStream() ?: context.assets.open(path)
        } catch (e: FileNotFoundException) {
            return LottieLoad.Failed("not_found")
        } catch (e: Exception) {
            Log.w(TAG, "lottie: can't open $path", e)
            return LottieLoad.Failed("failed")
        }
        val result = try {
            stream.use { LottieCompositionFactory.fromInputStreamSync(context, it, key) }
        } catch (e: Exception) {
            Log.w(TAG, "lottie: can't read $path", e)
            return LottieLoad.Failed("failed")
        }
        val composition = result.value
        if (composition == null || composition.duration <= 0f) {
            Log.w(TAG, "lottie: $path is not a Lottie animation", result.exception)
            return LottieLoad.Failed("broken")
        }
        return LottieLoad.Ok(composition)
    }

    /** Lottie keeps up to 20 parsed animations in memory; this empties that list (they are parsed again when shown). */
    fun trim() {
        LottieCompositionFactory.clearCache(context, false)
    }
}

/**
 * Lottie keeps `bounds` in screen pixels (the file's size × density) and ends one hundredth of a frame early (`op - 0.01`),
 * so the numbers are turned back into the file's own: 200 × 200, 36 frames, 1200 ms.
 */
internal fun infoJson(c: LottieComposition): JSONObject {
    val density = Resources.getSystem().displayMetrics.density.takeIf { it > 0f } ?: 1f
    val frames = c.durationFrames.roundToInt()
    return JSONObject()
        .put("width", (c.bounds.width() / density).roundToInt())
        .put("height", (c.bounds.height() / density).roundToInt())
        // Not c.duration: it is cut to a whole ms from the early end (1199 for 36 frames at 30 per second).
        .put("durationMs", if (c.frameRate > 0f) (frames * 1000f / c.frameRate).roundToInt() else 0)
        .put("frames", frames)
        .put("frameRate", c.frameRate.toDouble())
}

internal const val TAG = "zn"
