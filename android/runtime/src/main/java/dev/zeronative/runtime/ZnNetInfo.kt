package dev.zeronative.runtime

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * The built-in NetInfo module: `@react-native-community/netinfo`'s state (packages/core/src/netinfo.ts). `fetch` reads
 * the default network now. Event "change" sends the state when it changes, only while JS listens: the network
 * callback is registered for the first listener and removed after the last one.
 */
internal object ZnNetInfo : ZnModuleBase("NetInfo", version = 1) {
    private const val TAG = "zn"
    /** Android sends a burst of callbacks for one change (lost, available, capabilities, ...): send once it settles. */
    private const val SETTLE_MS = 250L

    private lateinit var app: Context
    private val main by lazy { Handler(Looper.getMainLooper()) } // lazy: the JVM tests have no Looper

    // Main thread. What the callback has seen of the default network; [sent]: the last state sent to JS.
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var network: Network? = null
    private var caps: NetworkCapabilities? = null
    /** Android 10+ says the app is blocked on [network] (onBlockedStatusChanged). */
    private var blocked = false
    private var sent: String? = null
    private val send = Runnable { sendIfChanged() }

    /** Main process, once. */
    fun init(context: Context) {
        app = context.applicationContext
    }

    /** One reading of a network, apart from Android (ZnNetInfoTest). [transports]: NetworkCapabilities.TRANSPORT_*. */
    class Reading(val transports: Set<Int>, val internet: Boolean, val validated: Boolean, val notMetered: Boolean)

    /**
     * The library's order: a real transport wins over VPN. On Android 9+ a VPN's network also lists the transport it
     * runs on, so a VPN over Wi-Fi reads "wifi", which is what an app wants to know (cost, speed). "vpn" only when
     * Android names no other transport.
     */
    fun typeOf(transports: Set<Int>): String = when {
        NetworkCapabilities.TRANSPORT_BLUETOOTH in transports -> "bluetooth"
        NetworkCapabilities.TRANSPORT_CELLULAR in transports -> "cellular"
        NetworkCapabilities.TRANSPORT_ETHERNET in transports -> "ethernet"
        NetworkCapabilities.TRANSPORT_WIFI in transports -> "wifi"
        NetworkCapabilities.TRANSPORT_VPN in transports -> "vpn"
        else -> "other"
    }

    /**
     * The state JS gets (NetInfoState). [r] null: no network. [blocked]: Android blocks this app on the network
     * (data saver, background data off, a phone maker's per-app switch): the same as no network, as `fetch` reads it
     * (`activeNetwork` is null for a blocked app).
     */
    fun stateJson(r: Reading?, blocked: Boolean = false): JSONObject {
        if (r == null || blocked) {
            return JSONObject().put("type", "none").put("isConnected", false).put("isInternetReachable", false)
                .put("details", JSONObject.NULL)
        }
        return JSONObject().put("type", typeOf(r.transports)).put("isConnected", r.internet)
            .put("isInternetReachable", r.internet && r.validated)
            .put("details", JSONObject().put("isConnectionExpensive", !r.notMetered))
    }

    /** Android won't say (no ACCESS_NETWORK_STATE, or a network without capabilities yet). */
    fun unknownJson(): JSONObject = JSONObject().put("type", "unknown").put("isConnected", JSONObject.NULL)
        .put("isInternetReachable", JSONObject.NULL).put("details", JSONObject.NULL)

    private val TRANSPORTS = intArrayOf(
        NetworkCapabilities.TRANSPORT_CELLULAR, NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_BLUETOOTH,
        NetworkCapabilities.TRANSPORT_ETHERNET, NetworkCapabilities.TRANSPORT_VPN,
    )

    private fun reading(c: NetworkCapabilities) = Reading(
        transports = TRANSPORTS.filter(c::hasTransport).toSet(),
        internet = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
        validated = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
        notMetered = c.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
    )

    private fun json(network: Network?, caps: NetworkCapabilities?, blocked: Boolean = false): JSONObject = when {
        network == null || blocked -> stateJson(null)
        caps == null -> unknownJson()
        else -> stateJson(reading(caps))
    }

    private fun connectivity(): ConnectivityManager? = app.getSystemService(ConnectivityManager::class.java)

    init {
        function("fetch") { call ->
            val state = try {
                val cm = connectivity()
                val now = cm?.activeNetwork
                if (cm == null) unknownJson() else json(now, now?.let(cm::getNetworkCapabilities))
            } catch (e: SecurityException) {
                unknownJson()
            }
            call.resolve(state)
        }
    }

    /** Main thread (ZnModules). */
    override fun onListenerCount(event: String, count: Int) {
        if (event != "change") return
        if (count > 0) watch() else unwatch()
    }

    private fun watch() {
        if (callback != null) return
        val cm = connectivity() ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            // Callbacks come on Android's own thread: the state lives on the main thread.
            private fun onMain(block: () -> Unit) {
                main.post { if (callback === this) block() }
            }

            override fun onAvailable(n: Network) = onMain {
                if (n != network) {
                    network = n
                    blocked = false // Android 10+ sends the new network's blocked status next
                    // Android 8+ sends the capabilities next; Android 7 may not.
                    caps = try { cm.getNetworkCapabilities(n) } catch (e: SecurityException) { null }
                }
                settle()
            }

            // Android 10+. Without it a lifted block sends no other callback, so JS kept "offline" (review 2026-11-09).
            override fun onBlockedStatusChanged(n: Network, isBlocked: Boolean) = onMain {
                if (n != network && network != null) return@onMain
                network = n
                if (blocked != isBlocked) Log.i(TAG, "NetInfo: Android ${if (isBlocked) "blocks" else "no longer blocks"} this app on the network")
                blocked = isBlocked
                settle()
            }

            override fun onCapabilitiesChanged(n: Network, c: NetworkCapabilities) = onMain {
                network = n
                caps = c
                settle()
            }

            override fun onLost(n: Network) = onMain {
                if (n == network) {
                    network = null
                    caps = null
                    blocked = false
                }
                settle()
            }
        }
        try {
            callback = cb
            cm.registerDefaultNetworkCallback(cb)
        } catch (e: Exception) { // SecurityException (no ACCESS_NETWORK_STATE), or too many callbacks
            callback = null
            Log.w(TAG, "NetInfo: can't watch the network", e)
        }
    }

    private fun unwatch() {
        val cb = callback ?: return
        callback = null
        main.removeCallbacks(send)
        network = null
        caps = null
        blocked = false
        sent = null // a new listener hears the state again
        try {
            connectivity()?.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            Log.w(TAG, "NetInfo: can't stop watching the network", e)
        }
    }

    private fun settle() {
        main.removeCallbacks(send)
        main.postDelayed(send, SETTLE_MS)
    }

    private fun sendIfChanged() {
        if (callback == null) return
        val state = json(network, caps, blocked)
        val text = state.toString()
        if (text == sent) return
        sent = text
        emit("change", state, latestOnly = true)
    }
}
