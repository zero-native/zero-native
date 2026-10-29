package dev.zeronative.runtime

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import org.json.JSONObject

/**
 * The dev client for `zn dev` (ARCHITECTURE §17). **Debug builds only**: every entry point is behind
 * `BuildConfig.DEBUG`, so R8 removes this class from release builds.
 *
 * - Connects to the dev server on the computer through `adb reverse tcp:8082 tcp:8082` (a plain TCP socket, so no
 *   cleartext-HTTP settings are needed in the app). Retries every 2 s while the server isn't running.
 * - A new build replaces templates and JS in place ([applyBuild]): you stay on the same screens.
 * - JS errors and build errors show on a dev error screen ([Overlay]); the server maps JS stacks back to TSX lines.
 *
 * Wire format, both ways: `u32 length` (big endian) then `u8 type` and the body (tools/zn-dev.ts has the same list).
 */
internal object ZnDev {
    private const val TAG = "zn-dev"
    private const val PORT = 8082

    // Server → phone
    private const val BUILD = 1 // u32 header length, header JSON {asset, hash, templates, manifest, hbc}, then bytes
    private const val BUILD_FAILED = 2 // JSON {message}
    private const val ERROR_MAPPED = 3 // JSON {id, text}
    // Phone → server
    private const val HELLO = 10 // JSON {device, hash}
    private const val ERROR = 11 // JSON {id, text}
    private const val RELOAD = 12 // JSON {}: send the current build again

    private class Problem(val id: Int, val title: String, val text: String)

    private val main = Handler(Looper.getMainLooper())
    private val problem = mutableStateOf<Problem?>(null) // main thread
    private var nextErrorId = 1
    @Volatile private var out: DataOutputStream? = null
    /** The dev server's hash of the build now running ("apk" until the first build arrives). */
    @Volatile private var runningHash = "apk"
    private var started = false

    fun start(context: Context) {
        if (started) return
        started = true
        Thread({ loop() }, "zn-dev").apply { isDaemon = true }.start()
    }

    /** Main thread: JS threw ("where\nmessage and stack"). Shown now, replaced by the TSX-mapped text if it comes. */
    fun onJsError(text: String) {
        val where = text.substringBefore('\n')
        val id = nextErrorId++
        problem.value = Problem(id, where, text.substringAfter('\n'))
        send(ERROR, JSONObject().put("id", id).put("text", text).toString().toByteArray())
    }

    // ---- Connection (zn-dev thread) ------------------------------------------------------------------------------

    private fun loop() {
        var warned = false
        while (true) {
            try {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress("127.0.0.1", PORT), 1000)
                    socket.tcpNoDelay = true
                    Log.i(TAG, "connected to the dev server")
                    warned = false
                    val input = DataInputStream(socket.getInputStream().buffered())
                    out = DataOutputStream(socket.getOutputStream().buffered())
                    val hello = JSONObject().put("device", "${Build.MANUFACTURER} ${Build.MODEL}").put("hash", runningHash)
                    send(HELLO, hello.toString().toByteArray())
                    while (true) {
                        val length = input.readInt()
                        val type = input.readUnsignedByte()
                        val body = ByteArray(length - 1).also(input::readFully)
                        receive(type, body)
                    }
                }
            } catch (e: Exception) {
                if (out != null) Log.i(TAG, "dev server disconnected (${e.message})")
                else if (!warned) Log.i(TAG, "no dev server on port $PORT (run `bun run dev`); retrying every 2 s")
                warned = true
                out = null
            }
            Thread.sleep(2000)
        }
    }

    private fun send(type: Int, body: ByteArray) {
        val o = out ?: return
        Thread {
            try {
                synchronized(o) {
                    o.writeInt(body.size + 1)
                    o.writeByte(type)
                    o.write(body)
                    o.flush()
                }
            } catch (e: Exception) {
                Log.w(TAG, "send failed: ${e.message}")
            }
        }.start()
    }

    private fun receive(type: Int, body: ByteArray) {
        when (type) {
            BUILD -> {
                val headerLength = java.nio.ByteBuffer.wrap(body, 0, 4).int
                val header = JSONObject(String(body, 4, headerLength, Charsets.UTF_8))
                var at = 4 + headerLength
                fun take(n: Int) = body.copyOfRange(at, at + n).also { at += n }
                val templates = take(header.getInt("templates"))
                val manifest = String(take(header.getInt("manifest")), Charsets.UTF_8)
                val hbc = take(header.getInt("hbc"))
                val asset = header.getString("asset")
                val bundle = ZnTemplates.prepare("$asset.json", templates, manifest) // off the main thread
                main.post { applyBuild(asset, bundle, hbc, header.getString("hash")) }
            }
            BUILD_FAILED -> {
                val message = JSONObject(String(body, Charsets.UTF_8)).getString("message")
                main.post { problem.value = Problem(0, "Build failed", message) }
            }
            ERROR_MAPPED -> {
                val json = JSONObject(String(body, Charsets.UTF_8))
                main.post {
                    val p = problem.value
                    if (p != null && p.id == json.getInt("id")) problem.value = Problem(p.id, p.title, json.getString("text"))
                }
            }
            else -> Log.w(TAG, "unknown message type $type")
        }
    }

    // ---- Reload (main thread) ------------------------------------------------------------------------------------

    private fun applyBuild(asset: String, bundle: ZnBundle, hbc: ByteArray, hash: String) {
        val t0 = SystemClock.uptimeMillis()
        problem.value = null
        ZnRuntime.reload(hbc) { result, attach ->
            val saved = ZnNav.resetForReload()
            ZnStore.resetForReload()
            ZnImpressions.resetForReload()
            ZnTemplates.replace(asset, bundle)
            attach()
            ZnNav.restart(bundle, saved)
            runningHash = hash
            val where = saved.lastOrNull()?.first ?: "start"
            Log.i(TAG, "reloaded in ${SystemClock.uptimeMillis() - t0} ms (JS ${result.millis} ms), on $where" +
                if (result.ok) "" else " — the new code threw, see the error screen")
        }
    }

    // ---- Error screen --------------------------------------------------------------------------------------------

    /** Drawn over the screens by [ZnNavHost] in debug builds. Empty unless there is an error. */
    @Composable
    fun Overlay() {
        val p = problem.value ?: return
        val mono = TextStyle(color = Color(0xFFE5E7EB), fontSize = 12.sp, fontFamily = FontFamily.Monospace, lineHeight = 17.sp)
        // Opaque, and it takes every touch: the screens under it may be broken.
        Box(Modifier.fillMaxSize().background(Color(0xFF111827)).clickable(enabled = true, onClick = {})) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp)) {
                BasicText(p.title, style = TextStyle(color = Color(0xFFF87171), fontSize = 17.sp, fontWeight = FontWeight.SemiBold))
                BasicText(
                    p.text.trim(),
                    style = mono,
                    modifier = Modifier.weight(1f).fillMaxWidth().padding(vertical = 12.dp).verticalScroll(rememberScrollState()),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button("Dismiss") { problem.value = null }
                    Button("Reload") {
                        problem.value = null
                        send(RELOAD, "{}".toByteArray())
                    }
                }
            }
        }
    }

    @Composable
    private fun Button(label: String, onClick: () -> Unit) {
        BasicText(
            label,
            style = TextStyle(color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium),
            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Color(0xFF374151)).clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}
