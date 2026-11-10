package dev.zeronative.runtime

import coil3.request.crossfade
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.ProtocolException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.UnknownServiceException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import okio.source
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native side of the global `fetch` (docs/fetch.md; JS side: packages/core/src/fetch.ts). A built-in module:
 * JS calls `Fetch.send` with the request head as JSON and the body as raw bytes; the answer is the response head
 * plus the whole body as bytes (`resolveBytes`).
 *
 * The rules that matter (each one fixes a problem RN / Flutter apps had in production, see docs/fetch.md §3):
 * - One shared OkHttpClient, built on first use (not at app start). Calls run on OkHttp's own threads.
 * - `timeout` is the limit for the whole call (OkHttp's call timeout). Connecting alone is capped at 15 s.
 * - Only idempotent methods may be retried by OkHttp. Other bodies are "one-shot": OkHttp never sends them twice.
 * - Redirects: followed (OkHttp drops `Authorization` across hosts), but never from HTTPS to HTTP.
 * - Pooled connections are closed when the default network changes (Wi-Fi ↔ mobile), and live only 30 s idle.
 *   An HTTP/2 connection in use is checked every 10 s (ping); one that stops answering is dropped.
 * - Errors get a code (offline, dns, timeout, tls, ...), so apps and crash reports can tell them apart.
 */
object ZnFetch : ZnModuleBase("Fetch") {
    private const val TAG = "zn"
    /** zero-native's version in the default User-Agent. */
    private const val FRAMEWORK_VERSION = "0.1.0"
    private const val DEFAULT_TIMEOUT_MS = 30_000L
    private const val CONNECT_TIMEOUT_MS = 15_000L
    /** With `timeout: 0` (no limit), a request still fails after this long without receiving or sending a byte. */
    private const val IDLE_TIMEOUT_MS = 60_000L
    private const val DEFAULT_MAX_BODY = 10_000_000L

    /** Methods that are safe to send twice (RFC 9110). Everything else gets a one-shot body. */
    private val IDEMPOTENT = setOf("GET", "HEAD", "OPTIONS", "PUT", "DELETE")
    /** Methods OkHttp refuses without a body; they get an empty one. */
    private val NEEDS_BODY = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")
    /** Set by the network stack only (same list as fetch.ts; checked again here for direct module callers). */
    private val TRANSPORT_HEADERS = setOf(
        "accept-encoding", "connection", "content-length", "expect", "host", "keep-alive", "proxy-connection", "te",
        "trailer", "transfer-encoding", "upgrade",
    )

    private lateinit var appContext: Context
    private var configure: ((OkHttpClient.Builder) -> Unit)? = null
    @Volatile private var built = false
    private var userAgent = "zero-native/$FRAMEWORK_VERSION"

    init {
        function("send", body = ::send)
    }

    /**
     * Changes the shared OkHttpClient: certificate pinning, an extra trusted root, interceptors (Chucker in debug
     * builds), a proxy. Call it before the first fetch, e.g. in Application.onCreate. Pins can't be changed by OTA:
     * pin CA keys and keep a backup pin. Don't turn retries back on for POST (docs/fetch.md §5).
     */
    fun configure(block: (OkHttpClient.Builder) -> Unit) {
        check(!built) { "ZnFetch.configure must be called before the first fetch" }
        configure = block
    }

    private val plugins = java.util.concurrent.CopyOnWriteArrayList<Interceptor>()

    /**
     * For plugins (a performance monitor, later a Cronet transport): adds an interceptor to the shared client, after
     * the app's [configure] and its interceptors, in the order added. A plugin gets no builder, so it can't change the
     * app's pins, redirects, retries or timeouts. Before the first fetch, like [configure]; after it, the interceptor is
     * left out and this answers false. If the interceptor throws a runtime error, that fetch fails as
     * `connection_lost` instead of crashing the app (OkHttp throws such errors again on its own thread).
     */
    fun addInterceptor(interceptor: Interceptor): Boolean {
        if (built) return false
        plugins += interceptor
        return true
    }

    /**
     * Turns a plugin interceptor's runtime error into an IOException, so the call fails and the app keeps running.
     * The request is not sent again: the error may come after it reached the server.
     */
    internal class PluginInterceptor(
        private val inner: Interceptor,
        private val warn: (String, Throwable) -> Unit = { message, e -> Log.w(TAG, message, e) },
    ) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response = try {
            inner.intercept(chain)
        } catch (e: IOException) {
            throw e
        } catch (e: RuntimeException) {
            warn("fetch: a plugin's interceptor (${inner::class.java.name}) failed", e)
            throw IOException("a plugin's interceptor failed (${inner::class.java.simpleName}): ${e.message}", e)
        }
    }

    @Volatile private var current: OkHttpClient? = null
    /** Goes up at each fresh pool ([freshPool]): the clients [derived] made before it are built again. */
    @Volatile private var generation = 0
    private val derivedClients = java.util.concurrent.ConcurrentHashMap<String, Pair<Int, OkHttpClient>>()

    /**
     * The shared client (also for app code that wants the same pool and settings). Built on first use. After a change
     * of the default network (Wi-Fi ↔ mobile) this is a new client with a fresh connection pool (same settings,
     * interceptors and dispatcher): read it for each call, don't keep it. For your own settings on top, use [derived].
     */
    val client: OkHttpClient
        get() = current ?: synchronized(this) { current ?: build().also { current = it } }

    /**
     * A client made from [client] by [change] (another timeout, no redirects, ...), kept under [key] and built again
     * after a network change, so it gets the fresh pool too. Read it for each call.
     */
    fun derived(key: String, change: (OkHttpClient.Builder) -> Unit): OkHttpClient {
        val gen = generation // before `client`: a fresh pool in between only makes the next read build it again
        val base = client
        derivedClients[key]?.let { (g, c) -> if (g == gen) return c }
        return base.newBuilder().also(change).build().also { derivedClients[key] = gen to it }
    }

    /** The User-Agent fetch sends by default (WebSocket handshakes send it too). Builds the client first if needed. */
    internal val defaultUserAgent: String get() = client.let { userAgent }
    private val noRedirectClient: OkHttpClient get() = derived("zn.noRedirect") { it.followRedirects(false) }
    private val idleLimitClient: OkHttpClient
        get() = derived("zn.idleLimit") {
            it.readTimeout(IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS).writeTimeout(IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        }

    internal fun init(context: Context) {
        appContext = context.applicationContext
    }

    /** No idle limit on [client] (each fetch sets its own): an image that stops arriving must still end. */
    private const val IMAGE_READ_TIMEOUT_S = 30L
    /**
     * Images loaded at once from one host: 10, as before they had a queue of their own (with 6, 5 of the 11 pictures on
     * the lab's screen waited for a second round; with 10, one). Fetch keeps its own 10 per host.
     */
    internal const val IMAGE_MAX_PER_HOST = 10

    /**
     * Images wait in a queue of their own, not in fetch's: a screen of pictures from the API host (ZeroBill's merchant
     * icons) took all 10 of fetch's slots for that host, and an API call (a payment verify too) waited for one, 2 s in
     * the sample's image lab (docs/http-stall-investigation.md §6). One for the whole process: kept across network changes.
     */
    private val imageDispatcher = Dispatcher().apply { maxRequestsPerHost = IMAGE_MAX_PER_HOST }

    /**
     * Pictures loaded before their List row is on screen (ZnImagePreload) wait in a queue of their own with a low
     * limit, 3 at once in all, so they never crowd an on-screen picture or an API call (image plan C1, 2026-11-10).
     */
    internal const val PRELOAD_MAX = 3
    private val preloadDispatcher = Dispatcher().apply { maxRequests = PRELOAD_MAX; maxRequestsPerHost = PRELOAD_MAX }

    /** Marks a Coil request as a preload (ZnImagePreload); taken off before the request goes out. */
    internal const val PRELOAD_HEADER = "X-Zn-Preload"

    /** True once Coil's shared loader is ours ([useForImages]): only then can preloads use the preload queue. */
    @Volatile internal var ownImageLoader = false
        private set

    /**
     * The client for pictures: its own connection pool (image plan C2, 2026-11-10), so an API call never shares an
     * HTTP/2 connection with picture bytes (on a mobile network one lost packet of a picture stalls everything on that
     * connection, a payment verify too). It costs one more TLS setup for a host that serves both (ZeroBill's merchant
     * icons came from the API host). Made in [derived], so it is new, with a new pool, after each network change.
     */
    private fun imageClient(): OkHttpClient =
        derived("zn.images") {
            it.readTimeout(IMAGE_READ_TIMEOUT_S, TimeUnit.SECONDS).dispatcher(imageDispatcher).connectionPool(newPool())
        }

    @Volatile private var preloadClient: Pair<OkHttpClient, OkHttpClient>? = null

    /** The image client with the preload queue: the same pool, so the on-screen request can reuse its connection. */
    private fun preloadClientFor(images: OkHttpClient): OkHttpClient =
        preloadClient?.takeIf { it.first === images }?.second
            ?: images.newBuilder().dispatcher(preloadDispatcher).build().also { preloadClient = images to it }

    /**
     * Coil's shared image loader (Image, the image viewer) on [client], read for each call: the same fresh pool after a
     * network change, the app's pins and interceptors. Coil's default was its own OkHttpClient (5 min idle pool, kept
     * across Wi-Fi ↔ mobile: images stalled after a switch; review 2026-11-09, finding 8). `setSafe`: an app that set
     * its own loader keeps it. The client itself is still built on the first image or fetch, not here.
     */
    internal fun useForImages() {
        val calls = okhttp3.Call.Factory { request ->
            val images = imageClient()
            if (request.header(PRELOAD_HEADER) == null) images.newCall(request)
            else preloadClientFor(images).newCall(request.newBuilder().removeHeader(PRELOAD_HEADER).build())
        }
        coil3.SingletonImageLoader.setSafe { context ->
            ownImageLoader = true
            coil3.ImageLoader.Builder(context)
                .components { add(coil3.network.okhttp.OkHttpNetworkFetcherFactory(callFactory = calls)) }
                // A short fade instead of a pop (image plan B, 2026-11-10). Coil never fades a memory-cache hit.
                .crossfade(IMAGE_FADE_MS)
                .build()
        }
    }

    internal const val IMAGE_FADE_MS = 150

    private fun build(): OkHttpClient {
        built = true
        userAgent = buildUserAgent()
        val builder = baseBuilder()
        configure?.invoke(builder)
        for (p in plugins) builder.addInterceptor(PluginInterceptor(p))
        val built = builder.build()
        watchNetwork()
        return built
    }

    /**
     * The default network changed: new calls get a new client with an empty pool. `evictAll` alone closes only idle
     * connections: an HTTP/2 connection still in use on the old network kept taking new calls (they hung until its
     * ping failed, 10-20 s: a verify right after the UPI app failed). Calls already running finish on the old client;
     * its connections close when idle (30 s) or when their ping fails. Review 2026-11-09, finding 3.
     */
    internal fun freshPool(why: String) {
        synchronized(this) {
            val old = current ?: return
            current = old.newBuilder().connectionPool(newPool()).build()
            generation++ // after `current`: see derived()
            old.connectionPool.evictAll()
            // Derived clients with a pool of their own (pictures): close its idle connections too
            for ((_, c) in derivedClients.values) if (c.connectionPool !== old.connectionPool) c.connectionPool.evictAll()
        }
        Log.i(TAG, "fetch: $why: new calls use new connections")
    }

    /** Mobile carriers drop idle NAT mappings after 30–60 s; reusing such a connection hangs. Default: 5 min. */
    private fun newPool() = ConnectionPool(5, 30, TimeUnit.SECONDS)

    /**
     * How often an open HTTP/2 connection is checked. With no answer by the next check, OkHttp drops the connection and
     * fails the calls on it, and the next call opens a new one. Without it a silently dead connection is used forever:
     * ZeroBill PAY-5 (2026-11-07), a start in the background from the UPI result, every verify for minutes was written
     * onto one connection the server never acknowledged, while a new connection worked.
     */
    internal const val PING_INTERVAL_MS = 10_000L

    /** The shared client's own settings, before the app's [configure] and plugins (tests build it as it is). */
    internal fun baseBuilder(pingIntervalMs: Long = PING_INTERVAL_MS): OkHttpClient.Builder =
        OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            // Try IPv6 and IPv4 addresses together (RFC 8305) instead of waiting out a broken IPv6 route first.
            .fastFallback(true)
            // No idle read/write limit: the per-call `timeout` covers the whole call (a slow server answering after
            // 20 s must not fail at OkHttp's default 10 s read timeout).
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(0, TimeUnit.MILLISECONDS)
            .followRedirects(true)
            .followSslRedirects(false) // never follow HTTPS → HTTP; send() turns it into an error
            // Mobile carriers drop idle NAT mappings after 30–60 s; reusing such a connection hangs. Default: 5 min.
            .connectionPool(newPool())
            // A connection still in use is never idle, so the 30 s above never drops a dead one: check it (PAY-5).
            .pingInterval(pingIntervalMs, TimeUnit.MILLISECONDS)
            .dispatcher(Dispatcher().apply { maxRequestsPerHost = 10 }) // default 5: the 6th call to a host waits
            .cookieJar(okhttp3.CookieJar.NO_COOKIES) // cookies are off (ARCHITECTURE §14)

    /**
     * A fresh pool when the default network changes: the old connections belong to the old network and would hang.
     * Once per process (the first client build); [freshPool] works on whatever client is current.
     */
    private fun watchNetwork() {
        val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                private var now: Network? = null
                override fun onAvailable(network: Network) {
                    val previous = now
                    now = network
                    if (previous != null && previous != network) freshPool("the default network changed")
                }

                override fun onLost(network: Network) {
                    if (network == now) {
                        now = null
                        freshPool("the network was lost")
                    }
                }
            })
        } catch (e: SecurityException) {
            Log.w(TAG, "fetch: can't watch network changes (ACCESS_NETWORK_STATE missing?)", e)
        }
    }

    private fun isOnline(): Boolean = try {
        appContext.getSystemService(ConnectivityManager::class.java)?.activeNetwork != null
    } catch (e: SecurityException) {
        true // can't tell: don't claim "offline"
    }

    /** `<app label>/<versionName> (Android <release>) zero-native/<version>`, ASCII only. No device model. */
    private fun buildUserAgent(): String {
        val pm = appContext.packageManager
        val label = appContext.applicationInfo.loadLabel(pm).toString()
        val name = label.filter { it.isLetterOrDigit() && it.code < 0x80 || it in "._-" }
            .ifEmpty { appContext.packageName }
        val version = try {
            val info = if (Build.VERSION.SDK_INT >= 33) {
                pm.getPackageInfo(appContext.packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION") pm.getPackageInfo(appContext.packageName, 0)
            }
            info.versionName ?: "0"
        } catch (e: PackageManager.NameNotFoundException) {
            "0"
        }
        val ascii = { s: String -> s.filter { it.code in 0x20..0x7e } }
        return "${ascii(name)}/${ascii(version)} (Android ${ascii(Build.VERSION.RELEASE)}) zero-native/$FRAMEWORK_VERSION"
    }

    // ---- One request --------------------------------------------------------------------------------------------

    private class TooLarge(message: String) : IOException(message)

    internal class ProgressThrottler(
        private val minIntervalMs: Long = 100L,
        private val clock: () -> Long = { SystemClock.elapsedRealtime() },
        private val onEmit: (loaded: Long, total: Long) -> Unit,
    ) {
        private var lastEmitTime = 0L
        private var lastLoaded = -1L

        fun update(loaded: Long, total: Long) {
            val now = clock()
            if (now - lastEmitTime >= minIntervalMs) {
                lastEmitTime = now
                lastLoaded = loaded
                onEmit(loaded, total)
            }
        }

        fun finish(loaded: Long, total: Long) {
            if (lastLoaded != loaded) {
                lastLoaded = loaded
                onEmit(loaded, total)
            }
        }
    }

    private fun send(call: ZnCall) {
        val shared = client // builds the client (and the User-Agent) on the first fetch
        val a = call.args
        val method = a.optString("method", "GET")
        val rawUrl = a.optString("url")
        val url = rawUrl.toHttpUrlOrNull()
            ?: return call.reject("invalid_request", "\"$rawUrl\" is not a valid http(s) URL")
        val where = "$method ${url.newBuilder().query(null).fragment(null).build()}" // for messages: no query (tokens)
        val timeoutMs = a.optLong("timeout", DEFAULT_TIMEOUT_MS)
        val maxBody = a.optLong("maxBodySize", DEFAULT_MAX_BODY)
        val redirect = a.optString("redirect", "follow")
        val reqId = a.optInt("reqId", -1)
        val trackUpload = a.optBoolean("uploadProgress", false)
        val trackDownload = a.optBoolean("downloadProgress", false)

        val request = try {
            val builder = Request.Builder().url(url)
            val headers = a.optJSONArray("headers") ?: JSONArray()
            var hasUserAgent = false
            var hasAccept = false
            for (i in 0 until headers.length() - 1 step 2) {
                val name = headers.getString(i)
                val lower = name.lowercase()
                if (lower in TRANSPORT_HEADERS) continue
                if (lower == "user-agent") hasUserAgent = true
                if (lower == "accept") hasAccept = true
                builder.addHeader(name, headers.getString(i + 1))
            }
            if (!hasUserAgent) builder.header("User-Agent", userAgent)
            if (!hasAccept) builder.header("Accept", "*/*") // what browsers send; some servers need an Accept
            builder.method(method, requestBody(method, call, reqId, trackUpload)).build()
        } catch (e: IllegalArgumentException) {
            return call.reject("invalid_request", "$where: ${e.message}")
        }

        val base = when {
            redirect != "follow" -> noRedirectClient
            timeoutMs == 0L -> idleLimitClient
            else -> shared
        }
        val okCall = base.newCall(request)
        okCall.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS) // 0 = no limit (OkHttp's meaning too)
        call.onCancel { okCall.cancel() }
        val t0 = SystemClock.elapsedRealtime()

        okCall.enqueue(object : Callback {
            override fun onFailure(c: Call, e: IOException) {
                if (call.isCancelled) return // JS aborted; nobody is waiting for this answer
                val code = errorCode(e, isOnline())
                val reason = when (code) {
                    "timeout" -> "no complete answer within $timeoutMs ms"
                    "cleartext_blocked" -> "plain HTTP is blocked on Android 9+. Use https://, or allow this host " +
                        "in the app's network security config (debug only)"
                    else -> e.message ?: e::class.java.simpleName
                }
                debugLog("$where → failed ($code) in ${SystemClock.elapsedRealtime() - t0} ms")
                call.reject(code, "Network request failed ($code): $where: $reason")
            }

            override fun onResponse(c: Call, response: Response) {
                response.use { answer(call, it, where, redirect, maxBody, t0, reqId, trackDownload) }
            }
        })
    }

    private fun answer(
        call: ZnCall,
        response: Response,
        where: String,
        redirect: String,
        maxBody: Long,
        t0: Long,
        reqId: Int,
        trackDownload: Boolean,
    ) {
        if (call.isCancelled) return
        if (response.isRedirect) {
            if (redirect == "error") {
                return call.reject("redirect_not_allowed", "$where: got a ${response.code} redirect, and redirect is \"error\"")
            }
            // followSslRedirects(false) stops an HTTPS → HTTP redirect and hands us the 3xx: refuse it.
            val target = response.header("Location")?.let { response.request.url.resolve(it) }
            if (redirect == "follow" && target != null && response.request.url.isHttps && !target.isHttps) {
                return call.reject("insecure_redirect", "$where: refused a redirect from HTTPS to plain HTTP ($target)")
            }
        }
        val bytes = try {
            readBody(response, maxBody, reqId, trackDownload, call)
        } catch (e: TooLarge) {
            return call.reject("too_large", "$where: ${e.message}")
        } catch (e: IOException) {
            if (call.isCancelled) return
            val code = errorCode(e, isOnline())
            return call.reject(code, "Network request failed ($code): $where: ${e.message ?: e::class.java.simpleName}")
        }
        val headers = JSONArray()
        for ((name, value) in response.headers) headers.put(name).put(value)
        val head = JSONObject()
            .put("status", response.code)
            .put("statusText", response.message)
            .put("url", response.request.url.newBuilder().fragment(null).build().toString())
            .put("redirected", response.priorResponse != null)
            .put("headers", headers)
        debugLog("$where → ${response.code} in ${SystemClock.elapsedRealtime() - t0} ms (${size(bytes.size)})")
        call.resolveBytes(head, bytes)
    }

    /** The whole body, refusing more than [max] bytes (early when Content-Length says so). */
    private fun readBody(
        response: Response,
        max: Long,
        reqId: Int = -1,
        trackDownload: Boolean = false,
        call: ZnCall? = null,
    ): ByteArray {
        val body = response.body ?: run {
            if (trackDownload && reqId != -1 && call != null && !call.isCancelled) {
                emit("downloadProgress", JSONObject().put("id", reqId).put("loaded", 0L).put("total", 0L))
            }
            return ByteArray(0)
        }
        val declared = body.contentLength()
        if (declared > max) throw TooLarge("the body is $declared bytes; maxBodySize is $max")

        val throttler = if (trackDownload && reqId != -1 && call != null) {
            ProgressThrottler { loaded, total ->
                if (!call.isCancelled) {
                    emit("downloadProgress", JSONObject().put("id", reqId).put("loaded", loaded).put("total", total))
                }
            }
        } else null

        val source = body.source()
        val buffer = Buffer()
        while (source.read(buffer, 8192) != -1L) {
            if (buffer.size > max) throw TooLarge("the body is over maxBodySize ($max bytes)")
            throttler?.update(buffer.size, declared)
        }
        throttler?.finish(buffer.size, declared)
        return buffer.readByteArray()
    }

    private fun requestBody(method: String, call: ZnCall, reqId: Int, trackUpload: Boolean): RequestBody? {
        val oneShot = method.uppercase() !in IDEMPOTENT
        val form = call.args.optJSONArray("form")
        val inner: RequestBody = when {
            form != null -> multipart(form)
            call.bytes != null -> BytesBody(call.bytes!!)
            method.uppercase() in NEEDS_BODY -> BytesBody(ByteArray(0)) // OkHttp refuses POST without a body
            else -> return null
        }
        val guarded = Guarded(inner, oneShot)
        if (!trackUpload || reqId == -1) return guarded

        val throttler = ProgressThrottler { loaded, total ->
            if (!call.isCancelled) {
                emit("uploadProgress", JSONObject().put("id", reqId).put("loaded", loaded).put("total", total))
            }
        }
        return uploadProgressBody(guarded, throttler)
    }

    /**
     * [guarded] with upload progress. The last event is the bytes really written and the same total as the others
     * (-1 when the size is unknown), never `-1 / -1`. If OkHttp writes the body again (a retry of an idempotent
     * request) or an interceptor reads it first, counting starts again from 0.
     */
    internal fun uploadProgressBody(guarded: RequestBody, throttler: ProgressThrottler): RequestBody =
        CountingRequestBody(
            inner = guarded,
            onProgress = { loaded, total -> throttler.update(loaded, total) },
            onDone = { written, total -> throttler.finish(written, total) },
        )

    /**
     * Wraps a body to track upload progress using Okio ForwardingSink.
     * Delegates isOneShot() and contentType() to [inner].
     * [onDone] gets the bytes written by this writeTo and the total it reported (-1 when unknown).
     */
    internal class CountingRequestBody(
        internal val inner: RequestBody,
        private val onProgress: (loaded: Long, total: Long) -> Unit,
        private val onDone: (written: Long, total: Long) -> Unit = { _, _ -> },
    ) : RequestBody() {
        override fun contentType(): MediaType? = inner.contentType()
        override fun contentLength(): Long = inner.contentLength()
        override fun isOneShot(): Boolean = inner.isOneShot()

        override fun writeTo(sink: BufferedSink) {
            val total = contentLength()
            var bytesWritten = 0L
            val countingSink = object : ForwardingSink(sink) {
                override fun write(source: Buffer, byteCount: Long) {
                    super.write(source, byteCount)
                    bytesWritten += byteCount
                    onProgress(bytesWritten, total)
                }
            }
            val bufferedSink = countingSink.buffer()
            inner.writeTo(bufferedSink)
            bufferedSink.flush()
            onDone(bytesWritten, total)
        }
    }

    private fun multipart(parts: JSONArray): RequestBody {
        val builder = MultipartBody.Builder().setType(MultipartBody.FORM)
        for (i in 0 until parts.length()) {
            val p = parts.getJSONArray(i)
            val name = p.getString(0)
            if (p.length() == 2) {
                builder.addFormDataPart(name, p.getString(1))
            } else {
                val uri = Uri.parse(p.getString(1))
                builder.addFormDataPart(name, p.getString(2), UriBody(appContext, uri, p.getString(3).toMediaTypeOrNull()))
            }
        }
        return builder.build()
    }

    private fun debugLog(line: String) {
        if (BuildConfig.DEBUG) Log.i(TAG, "fetch $line")
    }

    private fun size(n: Int) = if (n < 1024) "$n B" else String.format(java.util.Locale.ROOT, "%.1f KB", n / 1024.0)

    /** Maps a network failure to the error code JS gets (FetchErrorCode in fetch.ts). */
    internal fun errorCode(e: IOException, online: Boolean): String = when {
        e is TooLarge -> "too_large"
        e is SocketTimeoutException -> "timeout"
        e is InterruptedIOException && e.message == "timeout" -> "timeout" // OkHttp's call timeout
        e is UnknownHostException -> if (online) "dns" else "offline"
        e is UnknownServiceException && e.message?.contains("CLEARTEXT") == true -> "cleartext_blocked"
        e is SSLException -> "tls"
        e is ConnectException || e is NoRouteToHostException -> if (online) "connect" else "offline"
        e is ProtocolException && e.message?.startsWith("Too many follow-up requests") == true -> "too_many_redirects"
        else -> if (online) "connection_lost" else "offline"
    }

    // ---- Bodies -------------------------------------------------------------------------------------------------

    private class BytesBody(private val data: ByteArray) : RequestBody() {
        // No type here: the Content-Type header from JS is used as it is.
        override fun contentType(): MediaType? = null
        override fun contentLength() = data.size.toLong()
        override fun writeTo(sink: BufferedSink) {
            sink.write(data)
        }
    }

    /** Wraps a body to mark it one-shot: OkHttp then never sends it a second time (no silent POST retry). */
    internal class Guarded(private val inner: RequestBody, private val oneShot: Boolean) : RequestBody() {
        override fun contentType() = inner.contentType()
        override fun contentLength() = inner.contentLength()
        override fun isOneShot() = oneShot || inner.isOneShot()
        override fun writeTo(sink: BufferedSink) = inner.writeTo(sink)
    }

    /** A file part streamed from a content:// or file:// URI; its bytes never enter memory as a whole. */
    private class UriBody(private val context: Context, private val uri: Uri, private val type: MediaType?) : RequestBody() {
        override fun contentType() = type
        override fun contentLength(): Long = try {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        } catch (e: Exception) {
            -1L // unknown: sent without a length
        }

        override fun writeTo(sink: BufferedSink) {
            val input = context.contentResolver.openInputStream(uri) ?: throw FileNotFoundException("can't open $uri")
            input.source().use { sink.writeAll(it) }
        }
    }
}
