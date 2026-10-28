package dev.zeronative.exp4

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit

object DevClient {
    private const val TAG = "zn-DevClient"
    private var webSocket: WebSocket? = null
    private var isConnected = false
    private var isStarted = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // keep-alive for WebSocket
        .build()

    fun start(serverUrl: String = "ws://127.0.0.1:8082") {
        isStarted = true
        if (isConnected) return

        val request = Request.Builder().url(serverUrl).build()
        Log.i(TAG, "[DEV_CLIENT] Connecting to Fast Refresh server at $serverUrl...")

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                isConnected = true
                Log.i(TAG, "[DEV_CLIENT] Connected to Bun Dev Server! Fast Refresh active.")
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                val byteArr = bytes.toByteArray()
                Log.i(TAG, "[DEV_CLIENT] Received bytecode update (${byteArr.size} bytes). Triggering Hot Reload...")
                ZnBridge.reloadBytecode(byteArr)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                Log.i(TAG, "[DEV_CLIENT] Server message: $text")
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "[DEV_CLIENT] Closing connection: $code / $reason")
                isConnected = false
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isConnected = false
                if (isStarted) {
                    // Retry after 3 seconds
                    ZnBridge.mainHandler.postDelayed({
                        if (isStarted && !isConnected) {
                            start(serverUrl)
                        }
                    }, 3000)
                }
            }
        })
    }

    fun stop() {
        isStarted = false
        webSocket?.close(1000, "App paused")
        webSocket = null
        isConnected = false
    }
}

