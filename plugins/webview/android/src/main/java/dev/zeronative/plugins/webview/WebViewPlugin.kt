package dev.zeronative.plugins.webview

import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry

/**
 * [inspect]: lets Chrome on the computer look into pages (chrome://inspect), in debug builds only. Off by default, as in
 * react-native-webview (`webviewDebuggingEnabled`): it is one switch for the whole app, and a page can show private data.
 */
class WebViewPlugin(private val inspect: Boolean = false) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        // Nothing here touches WebView: it is slow to load, and an app may never open a page.
        val pages = WebViewPages(inspect)
        r.module(WebViewModule(pages))
        r.view("webview.page") { scope -> WebViewPage(scope, pages) }
        r.activityEvents(pages)
    }
}
