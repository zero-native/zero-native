package dev.zeronative.runtime

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import org.json.JSONObject

/** A loaded .zn.ui file: all its templates, plus the manifest (component name → template id), if there is one. */
class ZnBundle(val templates: List<ZnTemplate>, val components: Map<String, Int>) {
    /** The template id a screen's root uses (from the compiler's manifest), or null if unknown. */
    fun templateOf(component: String): Int? = components[component]
}

/**
 * Loads and prepares .zn.ui files off the main thread (startup rule 2, docs/startup-and-performance.md), once per
 * process. The UI observes [get] and draws the skeleton as soon as the bundle is ready, without waiting for JS.
 * The manifest is `<asset>.json` next to the template file (written by the compiler, compiler/src/plugin.ts).
 */
object ZnTemplates {
    private const val TAG = "zn"
    private val io = Handler(HandlerThread("zn-io").apply { start() }.looper)
    private val main = Handler(Looper.getMainLooper())
    private val files = HashMap<String, MutableState<ZnBundle?>>() // main thread only

    /** Starts loading [asset] if it isn't loaded or loading yet. Call from the main thread. */
    fun preload(context: Context, asset: String) {
        if (files.containsKey(asset)) return
        val state = mutableStateOf<ZnBundle?>(null)
        files[asset] = state
        val appContext = context.applicationContext
        io.post {
            val t0 = System.nanoTime()
            val templates = TemplateReader.read(map(appContext, asset)).templates.map(::ZnTemplate)
            val components = readManifest(appContext, "$asset.json")
            val ms = (System.nanoTime() - t0) / 1e6
            Log.i(TAG, "template $asset: ${templates.size} template(s) read and prepared in %.2f ms".format(ms))
            main.post { state.value = ZnBundle(templates, components) }
        }
    }

    /** The prepared bundle, or null while it is loading. Reading this from a composable subscribes to it. */
    fun get(asset: String): ZnBundle? = files[asset]?.value

    private fun readManifest(context: Context, name: String): Map<String, Int> = try {
        val json = JSONObject(context.assets.open(name).bufferedReader().use { it.readText() })
        val c = json.getJSONObject("components")
        c.keys().asSequence().associateWith { c.getInt(it) }
    } catch (_: java.io.IOException) {
        emptyMap()
    }

    /** Maps the asset from the APK when it is stored uncompressed (apps mark *.zn.ui noCompress); else reads it. */
    private fun map(context: Context, asset: String): ByteBuffer = try {
        context.assets.openFd(asset).use { fd ->
            FileInputStream(fd.fileDescriptor).channel.use { ch ->
                ch.map(FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.length)
            }
        }
    } catch (_: java.io.FileNotFoundException) {
        // openFd fails for compressed assets.
        ByteBuffer.wrap(context.assets.open(asset).use { it.readBytes() })
    }
}
