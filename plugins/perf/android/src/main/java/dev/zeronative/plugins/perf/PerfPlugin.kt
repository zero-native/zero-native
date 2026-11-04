package dev.zeronative.plugins.perf

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.FrameMetrics
import android.view.Window
import androidx.compose.runtime.snapshotFlow
import com.google.firebase.perf.FirebasePerformance
import com.google.firebase.perf.metrics.Trace
import dev.zeronative.plugins.firebase.ZnFirebase
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnFetch
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnNav
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.boolean
import dev.zeronative.runtime.doubleOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Response
import org.json.JSONObject

private const val TAG = "zn-perf"

/**
 * Add it with `ZnPlugins.register(this, PerfPlugin())`, before the first fetch. By itself it sends:
 * - Firebase's own app start trace,
 * - a network trace for every `fetch` (an interceptor on core's client, [network]); [url] decides the URL Firebase sees
 *   (default: no query, no fragment) or leaves a request out (null),
 * - a screen trace per top route, `screen_<route>`, with frames, slow frames and frozen frames ([screens]).
 * Every trace carries `zn_bundle`, the running bundle.
 */
class PerfPlugin(
    private val network: Boolean = true,
    private val url: (HttpUrl) -> String? = PerfRules::defaultUrl,
    private val screens: Boolean = true,
) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(8)
        val perf = if (ZnFirebase.available(r.context)) FirebasePerformance.getInstance() else null
        r.module(PerfModule(perf))
        if (perf == null) {
            Log.i(TAG, "Firebase isn't set up in this app (no google-services.json): Performance is off")
            return
        }
        ZnBundles.watchRunning { label -> PerfState.bundle = PerfRules.attributeValue(label) }
        if (network && !ZnFetch.addInterceptor(NetworkTraces(perf, url))) {
            Log.w(TAG, "a fetch ran before PerfPlugin was registered: no network traces in this process")
        }
        if (screens) {
            val traces = ScreenTraces(perf)
            traces.watch()
            // The window can come after the first route, and is new when Android makes the Activity again.
            r.activityEvents(object : ZnActivityEvents {
                override fun onFront() = traces.attach()
            })
        }
    }
}

internal object PerfState {
    @Volatile var bundle: String? = null
}

/** One HttpMetric per request through core's fetch client. */
private class NetworkTraces(private val perf: FirebasePerformance, private val url: (HttpUrl) -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val name = url(request.url) ?: return chain.proceed(request)
        val metric = perf.newHttpMetric(name, request.method)
        request.body?.contentLength()?.takeIf { it >= 0 }?.let(metric::setRequestPayloadSize)
        PerfState.bundle?.let { metric.putAttribute(PerfRules.ATTR_BUNDLE, it) }
        metric.start()
        val response = try {
            chain.proceed(request)
        } catch (e: IOException) {
            metric.stop() // no response code: Firebase counts it as a network error
            throw e
        }
        metric.setHttpResponseCode(response.code)
        response.body.contentType()?.let { metric.setResponseContentType(it.toString()) }
        (response.header("Content-Length")?.toLongOrNull() ?: response.body.contentLength()).takeIf { it >= 0 }
            ?.let(metric::setResponsePayloadSize)
        metric.stop()
        return response
    }
}

/**
 * A trace per top route: from the route coming on top to leaving it, with the frames drawn meanwhile (Android's frame
 * metrics on the Activity's window). The app is one Activity, so Firebase's own screen traces would all be one screen.
 */
private class ScreenTraces(private val perf: FirebasePerformance) {
    private val total = AtomicInteger()
    private val slow = AtomicInteger()
    private val frozen = AtomicInteger()
    private var current: Trace? = null
    private var window: Window? = null
    private val frames by lazy { Handler(HandlerThread("zn-perf-frames").apply { start() }.looper) }
    private val listener = Window.OnFrameMetricsAvailableListener { _, m, _ ->
        when (PerfRules.frameKind(m.getMetric(FrameMetrics.TOTAL_DURATION))) {
            PerfRules.Frame.FROZEN -> frozen.incrementAndGet()
            PerfRules.Frame.SLOW -> slow.incrementAndGet()
            PerfRules.Frame.OK -> {}
        }
        total.incrementAndGet()
    }

    fun watch() {
        MainScope().launch {
            snapshotFlow { ZnNav.stack.lastOrNull()?.route?.name }.distinctUntilChanged().collect { route -> next(route) }
        }
    }

    private fun next(route: String?) {
        current?.let { t ->
            t.putMetric(PerfRules.METRIC_FRAMES, total.getAndSet(0).toLong())
            t.putMetric(PerfRules.METRIC_SLOW, slow.getAndSet(0).toLong())
            t.putMetric(PerfRules.METRIC_FROZEN, frozen.getAndSet(0).toLong())
            t.stop()
        }
        current = null
        attach()
        val name = route?.let(PerfRules::screenTrace) ?: return
        total.set(0); slow.set(0); frozen.set(0)
        current = perf.newTrace(name).apply {
            PerfState.bundle?.let { putAttribute(PerfRules.ATTR_BUNDLE, it) }
            start()
        }
    }

    /** The listener on the Activity's window (again after the Activity was made anew). Main thread. */
    fun attach() {
        val w = ZnActivity.current?.window ?: return
        if (w === window) return
        window?.let { old -> runCatching { old.removeOnFrameMetricsAvailableListener(listener) } }
        w.addOnFrameMetricsAvailableListener(listener, frames)
        window = w
    }
}

/** RN Firebase's `perf()`: custom traces. Each JS trace has an id (JS makes it) until it stops. */
internal class PerfModule(private val perf: FirebasePerformance?) : ZnModuleBase("Perf", version = 1) {
    private val traces = ConcurrentHashMap<String, Trace>()

    init {
        function("status") { it.resolve(JSONObject().put("available", perf != null).put("enabled", perf?.isPerformanceCollectionEnabled == true)) }

        function("setCollectionEnabled") { call ->
            perf?.isPerformanceCollectionEnabled = call.boolean("on")
            call.resolve(perf != null)
        }

        function("startTrace") { call ->
            val id = call.string("id")
            val name = call.string("name")
            PerfRules.nameProblem(name)?.let { return@function call.resolve(it) }
            if (traces.size >= PerfRules.MAX_OPEN_TRACES) return@function call.resolve("too many traces open (${PerfRules.MAX_OPEN_TRACES}): stop some")
            val p = perf ?: return@function call.resolve("")
            val t = p.newTrace(name)
            PerfState.bundle?.let { t.putAttribute(PerfRules.ATTR_BUNDLE, it) }
            t.start()
            traces[id] = t
            call.resolve("")
        }

        function("putMetric") { call -> metric(call.string("id"), call.string("name"), call.doubleOrNull("value") ?: 0.0, add = false, call) }
        function("incrementMetric") { call -> metric(call.string("id"), call.string("name"), call.doubleOrNull("by") ?: 1.0, add = true, call) }

        function("putAttribute") { call ->
            val name = call.string("name")
            val value = call.stringOrNull("value")
            PerfRules.attributeProblem(name)?.let { return@function call.resolve(it) }
            val t = traces[call.string("id")] ?: return@function call.resolve("")
            if (value == null) t.removeAttribute(name) else t.putAttribute(name, PerfRules.attributeValue(value))
            call.resolve("")
        }

        function("stopTrace") { call ->
            traces.remove(call.string("id"))?.stop()
            call.resolve("")
        }
    }

    private fun metric(id: String, name: String, value: Double, add: Boolean, call: dev.zeronative.runtime.ZnCall) {
        PerfRules.nameProblem(name)?.let { return call.resolve(it) }
        val t = traces[id] ?: return call.resolve("")
        if (add) t.incrementMetric(name, value.toLong()) else t.putMetric(name, value.toLong())
        call.resolve("")
    }
}

/** The plugin's choices with no Android in them. */
internal object PerfRules {
    const val ATTR_BUNDLE = "zn_bundle"
    const val METRIC_FRAMES = "frames"
    const val METRIC_SLOW = "frames_slow"
    const val METRIC_FROZEN = "frames_frozen"
    const val MAX_NAME = 100
    const val MAX_ATTRIBUTE_NAME = 40
    const val MAX_ATTRIBUTE_VALUE = 100
    const val MAX_OPEN_TRACES = 64
    /** Firebase's own thresholds: slower than 16 ms is slow, slower than 700 ms frozen. */
    private const val SLOW_NS = 16_000_000L
    private const val FROZEN_NS = 700_000_000L

    enum class Frame { OK, SLOW, FROZEN }

    fun frameKind(totalNs: Long): Frame = when {
        totalNs > FROZEN_NS -> Frame.FROZEN
        totalNs > SLOW_NS -> Frame.SLOW
        else -> Frame.OK
    }

    /** Firebase's rules for trace and metric names: 1..100 characters, no space at either end, no leading `_`. */
    fun nameProblem(name: String): String? = when {
        name.isEmpty() -> "the name is empty"
        name.length > MAX_NAME -> "\"$name\" is longer than $MAX_NAME characters"
        name != name.trim() -> "\"$name\" starts or ends with a space"
        name.startsWith("_") -> "\"$name\" starts with _ (Firebase keeps those)"
        else -> null
    }

    /** Attribute names: 1..40 letters, digits and _, starting with a letter; not firebase_ / google_ / ga_. */
    fun attributeProblem(name: String): String? = when {
        !Regex("^[A-Za-z][A-Za-z0-9_]{0,39}$").matches(name) -> "attribute \"$name\": 1 to 40 letters, digits and _, starting with a letter"
        listOf("firebase_", "google_", "ga_").any { name.startsWith(it) } -> "attribute \"$name\" starts with a prefix Firebase keeps"
        else -> null
    }

    fun attributeValue(value: String): String = value.take(MAX_ATTRIBUTE_VALUE)

    /** A screen trace's name: `screen_<route>`. */
    fun screenTrace(route: String): String = "screen_$route".take(MAX_NAME)

    /** What Firebase sees of a request: no query and no fragment (they may hold tokens or personal data). */
    fun defaultUrl(url: HttpUrl): String = url.newBuilder().query(null).fragment(null).build().toString()
}
