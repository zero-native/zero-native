package dev.zeronative.plugins.webview

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.string
import org.json.JSONObject

/** The views on screen, by `ZnViewScope.id`, and what they share. Main thread. */
internal class WebViewPages(val inspect: Boolean = false) : ZnActivityEvents {
    private val pages = LinkedHashMap<String, PageHost>()
    private var timersPaused = false

    fun add(id: String, page: PageHost) {
        pages[id] = page
    }

    fun remove(id: String, page: PageHost) {
        if (pages[id] === page) pages.remove(id)
    }

    fun get(id: String): PageHost? = pages[id]

    /** Timers paused with the last view gone would freeze the next page for good. */
    fun onNewWebView(web: WebView) {
        if (timersPaused) web.resumeTimers()
        timersPaused = false
    }

    // pauseTimers stops all WebViews in the app, so it goes with the app, not with each view's screen.
    override fun onBack() {
        val web = pages.values.firstNotNullOfOrNull { it.web } ?: return
        web.pauseTimers()
        timersPaused = true
    }

    override fun onFront() {
        if (!timersPaused) return
        val web = pages.values.firstNotNullOfOrNull { it.web } ?: return
        web.resumeTimers()
        timersPaused = false
    }
}

/**
 * Commands for a view, by its id (`ready` gives it to JS). Functions, not a command counter in props: a command happens
 * once, but props are state. A prop would run again when the view is made again, two commands in one tick would become
 * one, and JS would get no answer. docs/plugins.md §4 says the same.
 *
 * No `evaluate`: running script from the app in a page means the app builds code from text, and a mistake there hands the
 * page's data and login to whoever wrote that text. postMessage does the job, and the page chooses what it listens to.
 */
class WebViewModule internal constructor(private val pages: WebViewPages) : ZnModuleBase("WebView", version = 1) {
    private val main = Handler(Looper.getMainLooper())

    init {
        function("goBack", onMain = true) { call ->
            call.resolve(pages.get(call.string("view"))?.goBack() ?: false)
        }

        function("reload", onMain = true) { call ->
            call.resolve(pages.get(call.string("view"))?.reload() ?: false)
        }

        function("postMessage", onMain = true) { call ->
            val text = call.string("text")
            call.resolve(pages.get(call.string("view"))?.postMessage(text) ?: JSONObject().put("sent", false).put("reason", "no_view"))
        }

        function("openLink", onMain = true) { call ->
            val url = call.string("url")
            call.resolve(pages.get(call.string("view"))?.openLink(url) ?: JSONObject().put("opened", false).put("reason", "no_view"))
        }

        // On the main thread, and only here: CookieManager loads all of WebView, so nothing touches it at app start.
        function("clearCookies", onMain = true) { call ->
            val cookies = CookieManager.getInstance()
            cookies.removeAllCookies { removed ->
                cookies.flush()
                call.resolve(removed)
            }
        }

        function("clearStorage", onMain = true) { call ->
            WebStorage.getInstance().deleteAllData()
            call.resolve(true)
        }

        // Debug builds only: the lab's dead renderer. how: "crash" or "terminate".
        function("debugRenderer", onMain = true) { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "debugRenderer is for debug builds only")
            val how = call.string("how")
            call.resolve(pages.get(call.string("view"))?.debugRenderer(how) ?: false)
        }
    }
}
