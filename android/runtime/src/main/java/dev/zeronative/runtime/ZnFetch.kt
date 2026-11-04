package dev.zeronative.runtime

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
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
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

    private val plugins = java.util.concurrent.CopyOnWriteArrayList<(OkHttpClient.Builder) -> Unit>()

    /**
     * Add-only, for plugins (a performance monitor's interceptor): runs after the app's [configure], in the order
     * added, so a plugin never replaces the app's own setup (pins, Chucker). Before the first fetch, like [configure];
     * after it, the block is left out and this answers false.
     */
    fun addClientSetup(block: (OkHttpClient.Builder) -> Unit): Boolean {
        if (built) return false
        plugins += block
        return true
    }

    /** The shared client (also for app code that wants the same pool and settings). Built on first use. */
    val client: OkHttpClient by lazy { build() }
    private val noRedirectClient: OkHttpClient by lazy { client.newBuilder().followRedirects(false).build() }
    private val idleLimitClient: OkHttpClient by lazy {
        client.newBuilder().readTimeout(IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(IDLE_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    }

    internal fun init(context: Context) {
        appContext = context.applicationContext
    }

    private fun build(): OkHttpClient {
        built = true
        userAgent = buildUserAgent()
        val builder = OkHttpClient.Builder()
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
            .connectionPool(ConnectionPool(5, 30, TimeUnit.SECONDS))
            .dispatcher(Dispatcher().apply { maxRequestsPerHost = 10 }) // default 5: the 6th call to a host waits
            .cookieJar(okhttp3.CookieJar.NO_COOKIES) // cookies are off (ARCHITECTURE §14)
        configure?.invoke(builder)
        for (p in plugins) p(builder)
        val built = builder.build()
        watchNetwork(built)
        return built
    }

    /** Closes pooled connections when the default network changes: they belong to the old network and would hang. */
    private fun watchNetwork(client: OkHttpClient) {
        val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                private var current: Network? = null
                override fun onAvailable(network: Network) {
                    val previous = current
                    current = network
                    if (previous != null && previous != network) client.connectionPool.evictAll()
                }

                override fun onLost(network: Network) {
                    if (network == current) {
                        current = null
                        client.connectionPool.evictAll()
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
            builder.method(method, requestBody(method, call)).build()
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
                response.use { answer(call, it, where, redirect, maxBody, t0) }
            }
        })
    }

    private fun answer(call: ZnCall, response: Response, where: String, redirect: String, maxBody: Long, t0: Long) {
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
            readBody(response, maxBody)
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
    private fun readBody(response: Response, max: Long): ByteArray {
        val body = response.body ?: return ByteArray(0)
        val declared = body.contentLength()
        if (declared > max) throw TooLarge("the body is $declared bytes; maxBodySize is $max")
        val source = body.source()
        val buffer = Buffer()
        while (source.read(buffer, 8192) != -1L) {
            if (buffer.size > max) throw TooLarge("the body is over maxBodySize ($max bytes)")
        }
        return buffer.readByteArray()
    }

    private fun requestBody(method: String, call: ZnCall): RequestBody? {
        val oneShot = method.uppercase() !in IDEMPOTENT
        val form = call.args.optJSONArray("form")
        val inner: RequestBody = when {
            form != null -> multipart(form)
            call.bytes != null -> BytesBody(call.bytes!!)
            method.uppercase() in NEEDS_BODY -> BytesBody(ByteArray(0)) // OkHttp refuses POST without a body
            else -> return null
        }
        return Guarded(inner, oneShot)
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
    private class Guarded(private val inner: RequestBody, private val oneShot: Boolean) : RequestBody() {
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
