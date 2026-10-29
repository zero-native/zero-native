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

/**
 * A loaded .zn.ui file: all its templates, plus what the manifest says about them (component name → template id,
 * and the route table). A bundle without a manifest has neither.
 */
class ZnBundle(val templates: List<ZnTemplate>, val components: Map<String, Int>, val routes: ZnRoutes) {
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
    private val waiting = HashMap<String, MutableList<(ZnBundle) -> Unit>>() // main thread only

    /** Starts loading [asset] if it isn't loaded or loading yet. Call from the main thread. */
    fun preload(context: Context, asset: String) {
        if (files.containsKey(asset)) return
        val state = mutableStateOf<ZnBundle?>(null)
        files[asset] = state
        val appContext = context.applicationContext
        io.post {
            val t0 = System.nanoTime()
            val templates = TemplateReader.read(map(appContext, asset)).templates.map(::ZnTemplate)
            val bundle = readManifest(appContext, "$asset.json", templates)
            val ms = (System.nanoTime() - t0) / 1e6
            Log.i(TAG, "template $asset: ${templates.size} template(s), ${bundle.routes.all.size} route(s) " +
                "read and prepared in %.2f ms".format(ms))
            main.post {
                state.value = bundle
                waiting.remove(asset)?.forEach { it(bundle) }
            }
        }
    }

    /** Runs [block] on the main thread once [asset] is loaded: now if it already is. Call [preload] first. */
    fun whenReady(asset: String, block: (ZnBundle) -> Unit) {
        val ready = files[asset]?.value
        if (ready != null) block(ready) else waiting.getOrPut(asset) { ArrayList() } += block
    }

    /** The prepared bundle, or null while it is loading. Reading this from a composable subscribes to it. */
    fun get(asset: String): ZnBundle? = files[asset]?.value

    private fun readManifest(context: Context, name: String, templates: List<ZnTemplate>): ZnBundle {
        val json = try {
            JSONObject(context.assets.open(name).bufferedReader().use { it.readText() })
        } catch (_: java.io.IOException) {
            return ZnBundle(templates, emptyMap(), ZnRoutes(emptyList()))
        }
        val c = json.getJSONObject("components")
        val components = c.keys().asSequence().associateWith { c.getInt(it) }
        val list = json.optJSONArray("routes")
        val routes = (0 until (list?.length() ?: 0)).map { i ->
            val r = list!!.getJSONObject(i)
            val templateId = r.getInt("screen")
            require(templateId in templates.indices) { "$name: route ${r.getString("name")} points at template $templateId" }
            val safe = r.get("safeArea")
            ZnRoute(
                index = i,
                name = r.getString("name"),
                path = r.getString("path"),
                templateId = templateId,
                transition = ZnRoute.Transition.valueOf(r.getString("transition").uppercase()),
                safeTop = if (safe is JSONObject) safe.getBoolean("top") else safe == "all",
                safeBottom = if (safe is JSONObject) safe.getBoolean("bottom") else safe == "all",
                darkBarIcons = r.getString("statusBar") == "dark",
                deepLink = r.getBoolean("deepLink"),
            )
        }
        return ZnBundle(templates, components, ZnRoutes(routes))
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
