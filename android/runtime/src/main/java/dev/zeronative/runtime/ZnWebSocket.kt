package dev.zeronative.runtime

import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * The built-in WebSocket module (browser WebSocket API): packages/core/src/websocket.ts.
 * Built on OkHttp using the shared ZnFetch.client so pins, interceptors and user-agent apply.
 */
internal object ZnWebSocket : ZnModuleBase("WebSocket", version = 1) {
    private const val MAX_MESSAGE_SIZE = 1_048_576 // 1 MB cap (second-opinions 161)

    private val sockets = ConcurrentHashMap<Int, WebSocket>()

    init {
        function("connect") { call ->
            val id = call.int("id")
            val url = call.string("url")
            val protocols = call.args.optJSONArray("protocols")

            val reqBuilder = try {
                Request.Builder().url(url)
            } catch (e: IllegalArgumentException) {
                call.reject("invalid_url", "Invalid WebSocket URL: ${e.message}")
                return@function
            }

            if (protocols != null && protocols.length() > 0) {
                val list = mutableListOf<String>()
                for (i in 0 until protocols.length()) {
                    list.add(protocols.getString(i))
                }
                reqBuilder.header("Sec-WebSocket-Protocol", list.joinToString(", "))
            }

            val client = ZnFetch.client
            val request = reqBuilder.build()

            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val selectedProtocol = response.header("Sec-WebSocket-Protocol") ?: ""
                    emit("open", JSONObject().put("id", id).put("protocol", selectedProtocol))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text.length > MAX_MESSAGE_SIZE) {
                        emit("error", JSONObject().put("id", id).put("message", "Message received from server exceeds 1 MB limit"))
                        webSocket.close(1009, "Message too big")
                        return
                    }
                    emit("message", JSONObject().put("id", id).put("data", text))
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    // v1 is text frames only: binary frames reported once as error event (second-opinions 161)
                    emit("error", JSONObject().put("id", id).put("message", "binary WebSocket frames are not supported in zero-native v1"))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    emit("closing", JSONObject().put("id", id).put("code", code).put("reason", reason))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    sockets.remove(id)
                    emit("close", JSONObject().put("id", id).put("code", code).put("reason", reason).put("wasClean", true))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    sockets.remove(id)
                    emit("error", JSONObject().put("id", id).put("message", t.message ?: "WebSocket failure"))
                    emit("close", JSONObject().put("id", id).put("code", 1006).put("reason", t.message ?: "Abnormal Closure").put("wasClean", false))
                }
            }

            val ws = client.newWebSocket(request, listener)
            sockets[id] = ws
            call.resolve(null)
        }

        function("send") { call ->
            val id = call.int("id")
            val data = call.string("data")
            if (data.length > MAX_MESSAGE_SIZE) {
                call.reject("too_large", "Message exceeds 1 MB limit (second-opinions 161)")
                return@function
            }
            val ws = sockets[id]
            if (ws == null) {
                call.reject("not_found", "WebSocket $id not found or already closed")
                return@function
            }
            val sent = ws.send(data)
            if (!sent) {
                call.reject("send_failed", "Failed to enqueue WebSocket message")
                return@function
            }
            call.resolve(null)
        }

        function("close") { call ->
            val id = call.int("id")
            val code = call.intOrNull("code") ?: 1000
            val reason = call.stringOrNull("reason")
            val ws = sockets[id]
            if (ws != null) {
                try {
                    ws.close(code, reason)
                } catch (t: Throwable) {
                    ws.cancel()
                }
            }
            call.resolve(null)
        }
    }

    fun reset() {
        for ((_, ws) in sockets) {
            try {
                ws.close(1001, "Reload / Teardown")
            } catch (_: Throwable) {
                ws.cancel()
            }
        }
        sockets.clear()
    }
}
