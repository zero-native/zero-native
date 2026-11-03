package dev.zeronative.plugins.webview

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnViewScope
import java.io.ByteArrayInputStream
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "zn"
private const val BRIDGE = "ZeroNative"

/** What JS asked for in `props`. Compared as a whole, so only a real change does anything. */
internal data class PageSpec(
    val url: String?,
    val html: String?,
    val baseUrl: String?,
    val headers: Map<String, String>,
    val hosts: List<String>,
    val leaveSchemes: List<String>,
    val javaScript: Boolean,
    val thirdPartyCookies: Boolean,
    val fileUpload: Boolean,
    val backInPage: Boolean,
) {
    /** What is on screen: only a change here loads a page again. */
    val source: List<Any?> get() = listOf(url, html, baseUrl, headers)

    companion object {
        fun of(p: JSONObject) = PageSpec(
            url = p.text("url"),
            html = p.text("html"),
            baseUrl = p.text("baseUrl"),
            headers = p.optJSONObject("headers")?.let { h -> h.keys().asSequence().associateWith { h.optString(it) } }.orEmpty(),
            hosts = p.optJSONArray("allowedHosts").strings(),
            leaveSchemes = p.optJSONArray("leaveSchemes").strings(),
            // On by default: a page with no script can't use the bridge, and most pages break. What keeps it safe is the
            // list of allowed hosts, https only, and no Java object in the page.
            javaScript = p.optBoolean("javaScript", true),
            thirdPartyCookies = p.optBoolean("thirdPartyCookies", false),
            fileUpload = p.optBoolean("fileUpload", true),
            backInPage = p.optBoolean("backInPage", true),
        )

        private fun JSONObject.text(key: String): String? = if (isNull(key)) null else optString(key)

        private fun JSONArray?.strings(): List<String> =
            if (this == null) emptyList() else (0 until length()).mapNotNull { i -> optString(i).takeIf { it.isNotEmpty() } }
    }
}

/** A web page inside a screen. Back in the page wins over the screen's `useBack` while the page can go back; `backInPage: false` turns that off. */
@Composable
internal fun WebViewPage(scope: ZnViewScope, pages: WebViewPages) {
    val page = remember(scope) { PageHost(scope, pages) }
    val spec = remember(scope.props) { PageSpec.of(scope.props) }
    var inFront by remember { mutableStateOf(false) }
    DisposableEffect(page) {
        pages.add(scope.id, page)
        onDispose { pages.remove(scope.id, page) }
    }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> {
                    inFront = true
                    page.resume()
                }
                Lifecycle.Event.ON_PAUSE -> {
                    inFront = false
                    page.pause()
                }
                Lifecycle.Event.ON_STOP -> page.flushCookies()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    // inFront: a page on a covered screen must not take the Back press of the screen on top.
    BackHandler(enabled = inFront && spec.backInPage && page.canGoBack && !page.gone) { page.web?.goBack() }
    if (!page.gone) {
        AndroidView(
            factory = { page.create(it) },
            modifier = Modifier.fillMaxSize(),
            update = { page.apply(it, spec) },
            onRelease = { page.release(it) },
        )
    }
}

/** One view's WebView and everything that hangs on it. Main thread, but for [Client.shouldInterceptRequest]. */
internal class PageHost(private val scope: ZnViewScope, private val pages: WebViewPages) {
    var web: WebView? = null
        private set
    var canGoBack by mutableStateOf(false)
        private set
    /** The renderer died: the WebView is dropped, and [reload] makes a new one. */
    var gone by mutableStateOf(false)
        private set

    @Volatile private var policy = WebViewRules.NONE
    @Volatile private var inline = false
    private var spec: PageSpec? = null
    private var shown: List<Any?>? = null
    private var bridgeOrigins: Set<String> = emptySet()
    private var hasBridge = false
    /** The way to the main frame of the page on screen. It only reaches that one page, so a late send can't land on the next page. */
    private var reply: JavaScriptReplyProxy? = null
    private val upload = OneAnswer<Array<Uri>>()
    private var uploadLauncher: ActivityResultLauncher<Intent>? = null
    private val leaveGate = LeaveGate()
    private var lastError: JSONObject? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun create(context: Context): View {
        val view = try {
            WebView(context) // the Activity, not the Application: a page's <select> and alert() need it
        } catch (t: Throwable) { // the system WebView can be missing or in the middle of an update
            Log.e(TAG, "webview: can't make a WebView: $t")
            scope.emit("loadError", JSONObject().put("kind", "no_webview").put("url", "").put("description", "$t"))
            return View(context)
        }
        web = view
        pages.onNewWebView(view)
        if (BuildConfig.DEBUG && pages.inspect) WebView.setWebContentsDebuggingEnabled(true) // WebViewPlugin(inspect = true)
        with(view.settings) {
            allowFileAccess = false // no file:// pages
            allowContentAccess = false // no content:// pages
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            domStorageEnabled = true // most login pages need it; clear it with clearStorage()
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false) // window.open stays in this view and goes through the same link rules
            javaScriptCanOpenWindowsAutomatically = false
            @Suppress("DEPRECATION")
            saveFormData = false // no card numbers in WebView's form store
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            WebSettingsCompat.setSafeBrowsingEnabled(view.settings, true)
        }
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        CookieManager.getInstance().setAcceptCookie(true)
        return view
    }

    /** Runs after [create] and at each change of props. */
    @SuppressLint("SetJavaScriptEnabled")
    fun apply(view: View, next: PageSpec) {
        val web = view as? WebView ?: return
        if (next != spec) {
            spec = next
            policy = WebViewRules.policy(next.hosts, next.leaveSchemes, BuildConfig.DEBUG)
            web.settings.javaScriptEnabled = next.javaScript
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, next.thirdPartyCookies)
            setBridge(web)
            scope.emit("ready", JSONObject().put("view", scope.id).put("bridge", hasBridge).put("refused", JSONArray(policy.refused)))
        }
        if (next.source != shown) {
            shown = next.source
            load(web, next)
        }
    }

    /**
     * The bridge is androidx.webkit's addWebMessageListener, not addJavascriptInterface. WebView itself puts the object
     * only in frames whose origin is on the list, also in iframes and after a redirect, and tells us the real origin. A
     * JavascriptInterface goes into every frame of every page and can't tell who called. If this phone's WebView is too
     * old for it, there is no bridge: we never fall back to the weaker way.
     */
    private fun setBridge(web: WebView) {
        val origins = policy.hosts.map { it.origin }.toSet()
        if (origins == bridgeOrigins) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w(TAG, "webview: this WebView has no message listener; no bridge")
            return
        }
        if (hasBridge) WebViewCompat.removeWebMessageListener(web, BRIDGE)
        hasBridge = false
        bridgeOrigins = origins
        if (origins.isEmpty()) return
        try {
            WebViewCompat.addWebMessageListener(web, BRIDGE, origins) { _, message, origin, mainFrame, proxy ->
                onPageMessage(message, origin.toString(), mainFrame, proxy)
            }
            hasBridge = true
        } catch (e: IllegalArgumentException) { // only a rule WebView reads differently from ours
            Log.e(TAG, "webview: WebView refused the allowed hosts: $e")
        }
    }

    private fun onPageMessage(message: WebMessageCompat, origin: String, mainFrame: Boolean, proxy: JavaScriptReplyProxy) {
        // Second check: the list may have changed since this page loaded, and WebView's rule is not the last word.
        if (!policy.allowsOrigin(origin)) {
            Log.w(TAG, "webview: a message from ${WebViewRules.hostOf(origin)} dropped")
            return
        }
        val text = if (message.type == WebMessageCompat.TYPE_STRING) message.data else null
        if (text == null || text.length > WebViewRules.MAX_MESSAGE_CHARS) {
            Log.w(TAG, "webview: a message that is not text, or too long, dropped")
            return
        }
        if (mainFrame) reply = proxy
        scope.emit("message", JSONObject().put("text", text).put("origin", origin).put("mainFrame", mainFrame))
    }

    private fun load(web: WebView, s: PageSpec) {
        lastError = null
        reply = null
        val html = s.html
        val url = s.url
        when {
            html != null -> {
                if (s.baseUrl != null && !policy.allowsPage(s.baseUrl)) return refuseLoad(s.baseUrl)
                inline = true
                web.loadDataWithBaseURL(s.baseUrl, html, "text/html", "UTF-8", s.baseUrl)
            }
            url != null -> {
                if (!policy.allowsPage(url)) return refuseLoad(url)
                inline = false
                web.loadUrl(url, s.headers)
            }
        }
    }

    private fun refuseLoad(url: String) {
        Log.w(TAG, "webview: ${WebViewRules.hostOf(url)} is not on the allowed list; not loaded")
        scope.emit("loadError", JSONObject().put("kind", "blocked").put("url", WebViewRules.short(url)).put("description", "host not allowed"))
    }

    fun resume() {
        val web = web ?: return
        web.onResume()
        scope.emit("resumed")
    }

    fun pause() {
        val web = web ?: return
        web.onPause()
        scope.emit("paused")
    }

    /** At each stop, so a kill in the background can't lose cookies: WebView itself only writes every 30 seconds or so. */
    fun flushCookies() {
        if (web != null) CookieManager.getInstance().flush()
    }

    fun release(view: View) {
        upload.answer(null)
        uploadLauncher?.unregister()
        uploadLauncher = null
        reply = null
        canGoBack = false
        val w = view as? WebView ?: return
        CookieManager.getInstance().flush()
        if (!gone) w.stopLoading()
        (w.parent as? ViewGroup)?.removeView(w)
        w.destroy() // the WebView holds the Activity until this
        if (web === w) web = null
        shown = null
        spec = null
        bridgeOrigins = emptySet()
        hasBridge = false
        Log.i(TAG, "webview: gone")
    }

    // ---- What the module calls ----------------------------------------------------------------------------------------

    fun goBack(): Boolean {
        val w = web ?: return false
        if (!w.canGoBack()) return false
        w.goBack()
        return true
    }

    /** After a dead renderer, this makes a new WebView, and [apply] loads the page again. */
    fun reload(): Boolean {
        if (gone) {
            gone = false
            return true
        }
        val w = web ?: return false
        w.reload()
        return true
    }

    fun postMessage(text: String): JSONObject {
        if (text.length > WebViewRules.MAX_MESSAGE_CHARS) return answer("sent", "too_long")
        val proxy = reply ?: return answer("sent", "no_page")
        if (!policy.allowsPage(web?.url)) return answer("sent", "no_page")
        proxy.postMessage(text)
        return JSONObject().put("sent", true)
    }

    /** The link is checked again here: JS can only open what the rule allows, and only Kotlin builds the Intent. */
    fun openLink(url: String): JSONObject {
        if (WebViewRules.decide(url, true, policy).action != WebViewRules.Action.LEAVE) return answer("opened", "refused")
        val activity = ZnActivity.current ?: return answer("opened", "no_activity")
        // Only an action and a link: no extras, no target app and no flags that a page could choose.
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        return try {
            activity.startActivity(intent)
            JSONObject().put("opened", true)
        } catch (e: ActivityNotFoundException) {
            answer("opened", "no_app")
        } catch (e: SecurityException) {
            answer("opened", "no_app")
        }
    }

    /** Debug builds only (WebViewModule): lab test of a dead renderer. */
    fun debugRenderer(how: String): Boolean {
        val w = web ?: return false
        if (how == "crash") {
            w.loadUrl("chrome://crash")
            return true
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_VIEW_RENDERER_TERMINATE)) return false
        return WebViewCompat.getWebViewRenderProcess(w)?.terminate() ?: false
    }

    private fun answer(key: String, reason: String) = JSONObject().put(key, false).put("reason", reason)

    // ---- File upload ---------------------------------------------------------------------------------------------------

    /**
     * The Activity's result registry, not ZnLaunch. ZnLaunch keeps a record on disk until JS acks it, for things that must
     * live through a kill, like a payment. An upload can't: WebView's callback is in memory, so after a kill there is no one
     * to give the file to. Its record would only block the next launch with "unacked", and one upload would make a UPI
     * launch answer "busy". After a kill the restored screen loads its page again, and the user picks the file again.
     * The key is new each time: Android keeps an answer that found no callback, and a fixed key would hand a
     * later upload that old file.
     */
    private fun pickFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        val activity = ZnActivity.current
        val allowed = spec?.fileUpload == true && policy.allowsPage(web?.url)
        if (activity == null || !allowed || params.mode == WebChromeClient.FileChooserParams.MODE_SAVE) {
            callback.onReceiveValue(null)
            emitUpload(0)
            return true
        }
        upload.open { files ->
            callback.onReceiveValue(files)
            emitUpload(files?.size ?: 0)
        }
        val launcher = activity.activityResultRegistry.register(
            "zn.webview.upload.${SystemClock.elapsedRealtimeNanos()}",
            ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            uploadLauncher?.unregister()
            uploadLauncher = null
            upload.answer(if (result.resultCode == android.app.Activity.RESULT_OK) pickedFiles(activity, result.data) else null)
        }
        uploadLauncher?.unregister()
        uploadLauncher = launcher
        try {
            val intent = params.createIntent()
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            launcher.launch(intent)
        } catch (e: Exception) { // no picker on this phone, or a page's accept list it can't read
            Log.w(TAG, "webview: the file picker didn't open: $e")
            launcher.unregister()
            uploadLauncher = null
            upload.answer(null)
        }
        return true
    }

    private fun pickedFiles(context: Context, data: Intent?): Array<Uri>? {
        data ?: return null
        val picked = ArrayList<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { picked += it } }
        if (picked.isEmpty()) data.data?.let { picked += it }
        val ours: (String) -> Boolean = { authority ->
            context.packageManager.resolveContentProvider(authority, 0)?.packageName == context.packageName
        }
        return picked.filter { WebViewRules.uploadAllowed(it.scheme, it.authority, ours) }.toTypedArray().takeIf { it.isNotEmpty() }
    }

    private fun emitUpload(count: Int) {
        Log.i(TAG, "webview: upload answered with $count files")
        scope.emit("upload", JSONObject().put("count", count))
    }

    // ---- WebView's callbacks -------------------------------------------------------------------------------------------

    private fun mayShow(url: String?) =
        WebViewRules.pageMayShow(url, policy, inline) || (BuildConfig.DEBUG && url == "chrome://crash/") // the lab's dead renderer

    private fun emitRefused(url: String, reason: String?) {
        Log.w(TAG, "webview: link to ${WebViewRules.hostOf(url)} refused: $reason")
        scope.emit("linkRefused", JSONObject().put("url", WebViewRules.short(url)).put("reason", reason ?: "scheme"))
    }

    private fun emitNav(view: WebView) {
        canGoBack = view.canGoBack()
        scope.emit("nav", JSONObject().put("canGoBack", canGoBack).put("url", WebViewRules.short(view.url)))
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            val decision = WebViewRules.decide(url, request.isForMainFrame, policy)
            when (decision.action) {
                WebViewRules.Action.STAY -> return false
                WebViewRules.Action.REFUSE -> emitRefused(url, decision.reason)
                WebViewRules.Action.LEAVE -> {
                    if (leaveGate.allow(SystemClock.uptimeMillis())) {
                        // Only a question to JS: the page can't open another app by itself.
                        scope.emit(
                            "linkOutside",
                            JSONObject().put("url", url).put("scheme", url.substringBefore(':').lowercase()).put("gesture", request.hasGesture()),
                        )
                    } else {
                        Log.w(TAG, "webview: link out dropped: too soon after the last one")
                    }
                }
            }
            return true
        }

        // Any thread. A form POST never comes to shouldOverrideUrlLoading, so without this, a page could send what the
        // user typed to a host the app didn't allow.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (!request.isForMainFrame) return null
            val url = request.url.toString()
            if (mayShow(url)) return null
            emitRefused(url, "host")
            return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            reply = null
            lastError = null
            // The last net: nothing above should let this through, and if it does, the page goes.
            if (!mayShow(url)) {
                view.stopLoading()
                view.loadUrl("about:blank")
                emitRefused(url.orEmpty(), "host")
                return
            }
            scope.emit("loadStart", JSONObject().put("url", WebViewRules.short(url)))
        }

        override fun onPageFinished(view: WebView, url: String?) {
            val error = lastError
            scope.emit(
                "loadFinish",
                JSONObject().put("url", WebViewRules.short(url)).put("ok", error == null).put("status", error?.opt("status") ?: JSONObject.NULL)
                    .put("title", view.title.orEmpty()).put("canGoBack", view.canGoBack()),
            )
            emitNav(view)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            emitNav(view) // also for a single-page app, where no new page starts
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            report(JSONObject().put("kind", "network").put("code", error.errorCode).put("description", error.description.toString()), request)
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (!request.isForMainFrame) return
            report(JSONObject().put("kind", "http").put("status", response.statusCode).put("description", response.reasonPhrase.orEmpty()), request)
        }

        private fun report(error: JSONObject, request: WebResourceRequest) {
            lastError = error
            scope.emit("loadError", error.put("url", WebViewRules.short(request.url.toString())))
        }

        // Never proceed past a bad certificate: there is no option for it, not even in debug builds.
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            scope.emit("loadError", JSONObject().put("kind", "ssl").put("code", error.primaryError).put("url", WebViewRules.short(error.url)).put("description", "bad certificate"))
        }

        // True, or the whole app dies with the renderer. The WebView can't be used after this: `gone` takes it out of the
        // screen, and AndroidView's onRelease destroys it. Android below 8 has no such callback.
        @RequiresApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "webview: renderer gone, crashed=${detail.didCrash()}")
            upload.answer(null)
            reply = null
            canGoBack = false
            gone = true
            scope.emit("renderGone", JSONObject().put("crashed", detail.didCrash()))
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            scope.emit("progress", newProgress)
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            scope.emit("title", title.orEmpty())
        }

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
            pickFiles(callback, params)

        // A page's console can print tokens: only debug builds show it. True means "handled".
        override fun onConsoleMessage(message: ConsoleMessage): Boolean = !BuildConfig.DEBUG
    }
}
