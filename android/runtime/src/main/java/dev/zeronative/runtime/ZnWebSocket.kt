package dev.zeronative.runtime

import android.util.Log
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.utf8Size
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The built-in WebSocket module (browser WebSocket API): packages/core/src/websocket.ts.
 * Built on OkHttp using the shared ZnFetch.client so pins, interceptors and user-agent apply.
 *
 * Order: `connect`, `send` and `close` run on the main thread (the main Handler keeps the order JS called them in),
 * which only hands each one to [worker], a single thread, so they also run there in that order. The worker, not the
 * main thread, builds `ZnFetch.client` the first time (that can take tens of ms). Before this, the 2-thread call pool
 * could run a `close` before its `connect`.
 *
 * Stale sockets: each socket is an [Entry] in [sockets], keyed by the JS id. Every listener callback first checks that
 * its own entry is still the one in the map; if not (a JS reset cleared it), the event is dropped. JS ids also start
 * at a random number in each JS runtime, so a late event of an old runtime can't reach a new socket.
 */
internal object ZnWebSocket : ZnModuleBase("WebSocket", version = 1) {
    private const val TAG = "zn"
    private const val MAX_MESSAGE_SIZE = 1_048_576L // 1 MB cap in UTF-8 bytes (second-opinions 161)

    /** One socket, as JS knows it. [ws] is set (under [lock]) right after OkHttp creates it. */
    private class Entry {
        @Volatile var ws: WebSocket? = null
        /** OkHttp called onOpen. Before that, a close from JS cancels the connect (what browsers do). */
        @Volatile var open = false
        /** We already sent JS an error for this socket (binary frame, message too big) and started closing it. */
        @Volatile var gaveUp = false
    }

    private val sockets = ConcurrentHashMap<Int, Entry>()
    /** Guards changes to [epoch] and adding to [sockets], so a reset can't miss a socket that is being created. */
    private val lock = Any()
    /** Goes up on each JS reset. Work queued by an older JS is dropped. */
    @Volatile private var epoch = 0
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-websocket").apply { isDaemon = true } }

    init {
        function("connect", onMain = true) { call ->
            val id = call.int("id")
            val url = call.string("url")
            val protocols = call.args.optJSONArray("protocols")
            val list = mutableListOf<String>()
            if (protocols != null) for (i in 0 until protocols.length()) list.add(protocols.getString(i))
            val e = epoch
            worker.execute { guarded(call, "connect") { connect(call, e, id, url, list) } }
        }

        function("send", onMain = true) { call ->
            val id = call.int("id")
            val data = call.string("data")
            val e = epoch
            worker.execute { guarded(call, "send") { send(call, e, id, data) } }
        }

        function("close", onMain = true) { call ->
            val id = call.int("id")
            val code = call.intOrNull("code") ?: 1000
            val reason = call.stringOrNull("reason")
            // true: JS called close() while CONNECTING. Older JS doesn't send it; then [Entry.open] decides.
            val abort = call.args.optBoolean("abort", false)
            val e = epoch
            worker.execute { guarded(call, "close") { close(call, e, id, code, reason, abort) } }
        }
    }

    /** Runs [block] on the worker; an exception rejects the call instead of killing the worker thread. */
    private inline fun guarded(call: ZnCall, what: String, block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            Log.e(TAG, "WebSocket.$what threw", t)
            call.reject("failed", "WebSocket.$what failed: ${t.message ?: t::class.java.simpleName}")
        }
    }

    private fun connect(call: ZnCall, e: Int, id: Int, url: String, protocols: List<String>) {
        if (e != epoch) return // the JS that asked is gone
        // The shared client and the same User-Agent fetch sends. Built here (worker), never on the main thread.
        val client = ZnFetch.client
        val userAgent = ZnFetch.defaultUserAgent
        val request = try {
            val builder = Request.Builder().url(url).header("User-Agent", userAgent)
            if (protocols.isNotEmpty()) builder.header("Sec-WebSocket-Protocol", protocols.joinToString(", "))
            builder.build()
        } catch (ex: IllegalArgumentException) {
            call.reject("invalid_url", "Invalid WebSocket URL: ${ex.message}")
            return
        }

        val entry = Entry()
        val listener = object : WebSocketListener() {
            /** Our entry is still the live one (not cleared by a JS reset, not replaced). */
            private fun live() = sockets[id] === entry

            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!live()) return
                entry.open = true
                val selectedProtocol = response.header("Sec-WebSocket-Protocol") ?: ""
                emit("open", JSONObject().put("id", id).put("protocol", selectedProtocol))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!live() || entry.gaveUp) return
                // OkHttp has already read the whole message into memory here: this cap protects JS, not native memory.
                if (text.utf8Size() > MAX_MESSAGE_SIZE) {
                    giveUp(webSocket, 1009, "Message too big", "Message received from server exceeds 1 MB limit")
                    return
                }
                emit("message", JSONObject().put("id", id).put("data", text))
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (!live() || entry.gaveUp) return
                // v1 is text frames only: binary frames reported once as error event (second-opinions 161), then we
                // close with 1003 ("Unsupported Data"), so JS sees error → close, like in a browser.
                giveUp(webSocket, 1003, "Unsupported Data", "binary WebSocket frames are not supported in zero-native v1")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (!live()) return
                emit("closing", JSONObject().put("id", id).put("code", code).put("reason", reason))
                // Finish the close handshake now: send our close frame back. OkHttp then calls onClosed with the
                // server's code. Without this, JS heard nothing until a ping failed (10-20 s), then got 1006.
                // If we already sent a close (JS called close()), this returns false and changes nothing.
                try {
                    webSocket.close(if (canSend(code)) code else 1000, null)
                } catch (ex: IllegalArgumentException) {
                    webSocket.cancel()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!sockets.remove(id, entry)) return // not ours any more (JS reset): drop the event
                emit("close", JSONObject().put("id", id).put("code", code).put("reason", reason).put("wasClean", true))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!sockets.remove(id, entry)) return
                emit("error", JSONObject().put("id", id).put("message", t.message ?: "WebSocket failure"))
                emit("close", JSONObject().put("id", id).put("code", 1006).put("reason", t.message ?: "Abnormal Closure").put("wasClean", false))
            }

            private fun giveUp(webSocket: WebSocket, code: Int, closeReason: String, message: String) {
                entry.gaveUp = true
                emit("error", JSONObject().put("id", id).put("message", message))
                webSocket.close(code, closeReason)
            }
        }

        synchronized(lock) {
            if (e != epoch) return
            // The entry goes into the map before OkHttp starts, so an onFailure that comes at once still finds it.
            sockets.put(id, entry)?.ws?.cancel() // the same id twice would be a JS bug: don't leak the old socket
            entry.ws = client.newWebSocket(request, listener) // doesn't block: OkHttp connects on its own threads
        }
        call.resolve(null)
    }

    private fun send(call: ZnCall, e: Int, id: Int, data: String) {
        if (e != epoch) return
        if (data.utf8Size() > MAX_MESSAGE_SIZE) {
            call.reject("too_large", "Message exceeds 1 MB limit (second-opinions 161)")
            return
        }
        val ws = sockets[id]?.ws
        if (ws == null) {
            call.reject("not_found", "WebSocket $id not found or already closed")
            return
        }
        if (!ws.send(data)) {
            call.reject("send_failed", "Failed to enqueue WebSocket message")
            return
        }
        call.resolve(null)
    }

    private fun close(call: ZnCall, e: Int, id: Int, code: Int, reason: String?, abort: Boolean) {
        if (e != epoch) return
        val entry = sockets[id]
        val ws = entry?.ws
        // No entry: the socket already closed or failed (its close event is on the way), or connect failed (JS
        // already closed itself). The worker runs calls in order, so a close can't come before its connect.
        if (entry != null && ws != null) {
            if (abort || !entry.open) {
                ws.cancel() // still connecting: fail it (browsers give error, then close 1006)
            } else {
                try {
                    ws.close(code, reason?.ifEmpty { null })
                } catch (t: IllegalArgumentException) {
                    ws.cancel()
                }
            }
        }
        call.resolve(null)
    }

    /** A close code we may put in our own close frame (RFC 6455 §7.4; the same rule OkHttp checks). */
    private fun canSend(code: Int) = code in 1000..4999 && code !in 1004..1006 && code !in 1015..2999

    /**
     * JS reset (dev reload, OTA restart), main thread. Every socket is cancelled at once (no close handshake: the JS
     * that would hear it is gone), and the map is cleared, so late events of these sockets are dropped.
     */
    fun reset() {
        val old = synchronized(lock) {
            epoch++
            sockets.values.toList().also { sockets.clear() }
        }
        for (entry in old) entry.ws?.cancel()
    }
}
