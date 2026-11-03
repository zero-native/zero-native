package dev.zeronative.plugins.webview

/**
 * The rules of the webview plugin, kept apart from Android so they run on the JVM (WebViewRulesTest). A page is outside
 * input: every answer here falls to "refuse" when something can't be read.
 */
internal object WebViewRules {
    /** A message or a link longer than this is not a normal one. It is dropped, not cut, so the app never reads half of it. */
    const val MAX_MESSAGE_CHARS = 64 * 1024
    const val MAX_URL_CHARS = 8 * 1024
    /** A page that sends links out in a loop must not trap the user in other apps. */
    const val LEAVE_GAP_MS = 800L

    /** Never leave the app and never open as a page, even if the app lists them. `intent:` can name any Activity in any app. */
    private val NEVER = setOf("intent", "android-app", "javascript", "file", "content", "data", "blob", "about", "filesystem", "chrome", "view-source")
    /** These don't start a new page and can't reach anything new, so a page may use them inside its own frames. */
    private val FRAME_ONLY = setOf("about", "data", "blob")

    /** [host] is null for a link with no host (`tel:`) and for one that can't be trusted (`https://a@b`). [port] -1: the scheme's default. */
    class Url(val scheme: String, val host: String?, val port: Int)

    /**
     * Our own small parser, as android.net.Uri is not on the JVM and java.net.URI refuses many real links. It is strict on
     * purpose: `https://good.com\@bad.com` and `https://good.com@bad.com` are the known ways to fool a host check, so a
     * backslash, a space or an `@` in the host part is refused.
     */
    fun parseUrl(raw: String): Url? {
        if (raw.length > MAX_URL_CHARS || raw.any { it <= ' ' || it == '\\' || it == '\u007f' }) return null
        val colon = raw.indexOf(':')
        if (colon <= 0) return null
        val scheme = raw.substring(0, colon).lowercase()
        if (!scheme[0].isAsciiLetter() || !scheme.all { it.isAsciiLetter() || it.isAsciiDigit() || it in "+-." }) return null
        val rest = raw.substring(colon + 1)
        if (!rest.startsWith("//")) return Url(scheme, null, -1)
        val authority = rest.substring(2).takeWhile { it !in "/?#" }
        if ('@' in authority) return Url(scheme, null, -1)
        val hostAndPort = authority.lowercase()
        val portAt = hostAndPort.lastIndexOf(':')
        val host = if (portAt >= 0) hostAndPort.substring(0, portAt) else hostAndPort
        var port = -1
        if (portAt >= 0) {
            val text = hostAndPort.substring(portAt + 1)
            port = if (text.isEmpty()) -1 else text.toIntOrNull()?.takeIf { it in 1..65535 && text.all { c -> c in '0'..'9' } } ?: return null
        }
        if (host.isEmpty() || !host.all { it.isAsciiLetter() || it.isAsciiDigit() || it in ".-_" }) return Url(scheme, null, -1)
        if ((scheme == "https" && port == 443) || (scheme == "http" && port == 80)) port = -1
        return Url(scheme, host, port)
    }

    /** One entry of `allowedHosts`. [wild]: `*.example.com`, any depth under it, and not example.com itself. */
    class HostRule(val scheme: String, val host: String, val port: Int, val wild: Boolean) {
        fun matches(url: Url): Boolean {
            val h = url.host ?: return false
            return url.scheme == scheme && url.port == port && (if (wild) h.endsWith(".$host") else h == host)
        }

        /** The same rule in androidx.webkit's words, for addWebMessageListener. */
        val origin: String get() = "$scheme://${if (wild) "*." else ""}$host${if (port >= 0) ":$port" else ""}"
    }

    /**
     * `example.com`, `example.com:8443`, `*.example.com` or `https://example.com`; null if it is refused. Plain http only
     * for this computer's test server, and only when [localHttp] is on (debug builds): http can be changed on the way.
     */
    fun hostRule(raw: String, localHttp: Boolean): HostRule? {
        val text = raw.trim().lowercase()
        val schemeEnd = text.indexOf("://")
        val scheme = if (schemeEnd >= 0) text.substring(0, schemeEnd) else "https"
        val rest = if (schemeEnd >= 0) text.substring(schemeEnd + 3) else text
        val wild = rest.startsWith("*.")
        val plain = if (wild) rest.substring(2) else rest
        if (plain.any { it in "/?#*" }) return null
        val url = parseUrl("$scheme://$plain") ?: return null
        val host = url.host ?: return null
        when (scheme) {
            "https" -> Unit
            "http" -> if (!localHttp || wild || host !in setOf("localhost", "127.0.0.1")) return null
            else -> return null
        }
        // `*.com` would allow the whole web, and a star makes no sense on a number address.
        if (wild && (host.count { it == '.' } < 1 || host.substringAfterLast('.').all { c -> c in '0'..'9' })) return null
        return HostRule(scheme, host, url.port, wild)
    }

    /** What the app allows, made from the view's props. [refused]: entries that were dropped, so the app can hear about a typo. */
    class Policy(val hosts: List<HostRule>, val leaveSchemes: Set<String>, val refused: List<String>) {
        /** May this link be shown as a whole page? */
        fun allowsPage(url: String?): Boolean {
            val u = url?.let(::parseUrl) ?: return false
            return hosts.any { it.matches(u) }
        }

        /** The page's origin as WebView gives it to a message listener, like `https://example.com`. */
        fun allowsOrigin(origin: String): Boolean = allowsPage(origin)
    }

    val NONE = Policy(emptyList(), emptySet(), emptyList())

    fun policy(hosts: List<String>, leaveSchemes: List<String>, localHttp: Boolean): Policy {
        val rules = ArrayList<HostRule>()
        val refused = ArrayList<String>()
        for (raw in hosts) hostRule(raw, localHttp)?.let { rules += it } ?: run { refused += raw }
        val schemes = LinkedHashSet<String>()
        for (raw in leaveSchemes) {
            val s = raw.trim().lowercase().removeSuffix(":")
            if (s.isEmpty() || s in NEVER || !s[0].isAsciiLetter() || !s.all { it.isAsciiLetter() || it.isAsciiDigit() || it in "+-." }) refused += raw else schemes += s
        }
        return Policy(rules, schemes, refused)
    }

    enum class Action { STAY, LEAVE, REFUSE }

    /** [reason] says why a link was refused: bad_url, scheme, host or frame. */
    class Decision(val action: Action, val reason: String? = null)

    /** Where a link in the page goes. Called for each link and each redirect; [mainFrame]: the whole page, not an iframe. */
    fun decide(url: String, mainFrame: Boolean, policy: Policy): Decision {
        val u = parseUrl(url) ?: return Decision(Action.REFUSE, "bad_url")
        val web = u.scheme == "https" || u.scheme == "http"
        if (!mainFrame) {
            // An iframe can't take the user away, and the bridge is off in any frame from a host the app didn't allow.
            return if (web || u.scheme in FRAME_ONLY) Decision(Action.STAY) else Decision(Action.REFUSE, "frame")
        }
        if (u.scheme in NEVER) return Decision(Action.REFUSE, "scheme")
        if (web && policy.allowsPage(url)) return Decision(Action.STAY)
        if (u.scheme in policy.leaveSchemes) return Decision(Action.LEAVE)
        return Decision(Action.REFUSE, if (web) "host" else "scheme")
    }

    /**
     * The last check as a page starts, for ways in that [decide] doesn't see (a form POST is never asked about).
     * `about:blank` is where a refused page ends up. [inline]: we loaded the app's own html, which has no real address.
     */
    fun pageMayShow(url: String?, policy: Policy, inline: Boolean): Boolean {
        val u = url?.let(::parseUrl) ?: return false
        if (url == "about:blank") return true
        if (inline && u.scheme == "data") return true
        return policy.allowsPage(url)
    }

    /** A file a picker app gave back. `file:` is the known attack (a bad picker names our own private files), and so is our own content provider. */
    fun uploadAllowed(scheme: String?, authority: String?, ours: (String) -> Boolean): Boolean {
        if (scheme != "content" || authority.isNullOrEmpty()) return false
        return !ours(authority.substringAfter('@'))
    }

    /** Text for events and logs. Log only [hostOf]: a link can carry a token. */
    fun short(url: String?): String = url.orEmpty().let { if (it.length > 2048) it.substring(0, 2048) else it }

    fun hostOf(url: String?): String = url?.let(::parseUrl)?.let { it.host ?: it.scheme } ?: "?"

    private fun Char.isAsciiLetter() = this in 'a'..'z' || this in 'A'..'Z'
    private fun Char.isAsciiDigit() = this in '0'..'9'
}

/** At most one link out per [gapMs], so a page can't loop. Main thread. */
internal class LeaveGate(private val gapMs: Long = WebViewRules.LEAVE_GAP_MS) {
    private var last = Long.MIN_VALUE

    fun allow(nowMs: Long): Boolean {
        if (last != Long.MIN_VALUE && nowMs - last < gapMs) return false
        last = nowMs
        return true
    }
}

/**
 * A callback that must be answered once. The page's upload button stays dead until WebView hears an answer, so a new
 * request closes the old one, and closing the view answers with null. Main thread.
 */
internal class OneAnswer<T> {
    private var waiting: ((T?) -> Unit)? = null

    val open: Boolean get() = waiting != null

    fun open(callback: (T?) -> Unit) {
        answer(null)
        waiting = callback
    }

    fun answer(value: T?) {
        val w = waiting ?: return
        waiting = null
        w(value)
    }
}
