package dev.zeronative.runtime

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import java.nio.ByteBuffer
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
        ZnBundles.init(context)
        val posted = SystemClock.uptimeMillis()
        io.post {
            val t0 = System.nanoTime()
            val queued = SystemClock.uptimeMillis() - posted
            val startedAt = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
            // From the running bundle: the APK's assets or a downloaded OTA bundle (ZnBundles, docs/ota.md). A downloaded
            // bundle's templates were already read (and their ids checked) while choosing it.
            // The same steps as [load], timed one by one (R53, 2026-11-07: where a big app's start time goes).
            val r = ZnBundles.running
            val preRead = ZnBundles.takeTemplateFile(asset)
            val f = preRead ?: TemplateReader.read(checkNotNull(ZnBundles.map(asset, r)) { "bundle $r has no $asset" })
            val t1 = System.nanoTime()
            val templates = templatesOf(f)
            val t2 = System.nanoTime()
            val bundle = readManifest("$asset.json", templates, r)
            val t3 = System.nanoTime()
            val ms = (t3 - t0) / 1e6
            Log.i(TAG, "template $asset: ${bundle.templates.size} template(s), ${bundle.routes.all.size} route(s) " +
                "read and prepared in %.2f ms".format(ms))
            Log.i(TAG, ("template $asset timing: started %d ms after process start (waited %d ms for zn-io); " +
                "read %.2f ms (%s), prepare %.2f ms (%d nodes), manifest %.2f ms").format(
                    startedAt, queued,
                    (t1 - t0) / 1e6, if (preRead != null) "already read while choosing the bundle" else "from the file",
                    (t2 - t1) / 1e6, f.templates.sumOf { it.component.size }, (t3 - t2) / 1e6))
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

    /** Debug builds (`zn dev`): reads and prepares a bundle sent by the dev server. Any thread. */
    internal fun prepare(name: String, templates: ByteArray, manifest: String): ZnBundle =
        readManifest(name, manifest, templatesOf(TemplateReader.read(ByteBuffer.wrap(templates))))

    /**
     * Reads and prepares template file [asset] of bundle [r] (any thread but main). [file]: the file already read
     * (and checked) while choosing the bundle, if it was.
     */
    internal fun load(asset: String, r: ZnBundles.Running, file: TemplateFile? = null): ZnBundle {
        val f = file ?: TemplateReader.read(checkNotNull(ZnBundles.map(asset, r)) { "bundle $r has no $asset" })
        return readManifest("$asset.json", templatesOf(f), r)
    }

    /** The file's templates, sharing one SVG cache: it lives as long as the bundle that holds them (ZnSvg.kt). */
    private fun templatesOf(f: TemplateFile): List<ZnTemplate> {
        val svgs = ZnSvgCache()
        return f.templates.map { ZnTemplate(it, svgs) }.also { svgs.big = ZnSvgCache.bigOf(it) }
    }

    /** The template files loaded or loading (main thread): an update applied while the app runs reloads each. */
    internal fun assets(): Set<String> = files.keys.toSet()

    /**
     * Main thread, after a `zn dev` reload or an update applied while the app runs: [asset] now means [bundle];
     * screens reading [get] redraw.
     */
    internal fun replace(asset: String, bundle: ZnBundle) {
        files.getOrPut(asset) { mutableStateOf(null) }.value = bundle
        waiting.remove(asset)?.forEach { it(bundle) }
    }

    private fun readManifest(name: String, templates: List<ZnTemplate>, r: ZnBundles.Running): ZnBundle {
        val text = ZnBundles.readText(name, r) ?: return ZnBundle(templates, emptyMap(), ZnRoutes(emptyList()))
        return readManifest(name, text, templates)
    }

    private fun readManifest(name: String, text: String, templates: List<ZnTemplate>): ZnBundle {
        val json = JSONObject(text)
        val c = json.getJSONObject("components")
        val components = c.keys().asSequence().associateWith { c.getInt(it) }
        val list = json.optJSONArray("routes")
        val routes = (0 until (list?.length() ?: 0)).map { i ->
            val r = list!!.getJSONObject(i)
            val templateId = r.getInt("screen")
            val native = r.optString("native").ifEmpty { null }
            require(native != null || templateId in templates.indices) { "$name: route ${r.getString("name")} points at template $templateId" }
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
                resizeForKeyboard = r.optString("keyboard", "resize") != "none",
                restore = r.optBoolean("restore", true),
                native = native,
                secure = r.optBoolean("secure", false),
                transparent = r.optBoolean("transparent", false),
                tabs = r.optJSONArray("tabs")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList(),
            )
        }
        return ZnBundle(templates, components, ZnRoutes(routes))
    }
}
