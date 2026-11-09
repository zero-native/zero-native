package dev.zeronative.plugins.pdf

import android.content.Context
import android.net.Uri
import android.util.Log
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnFetch
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnInvalidArgs
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.doubleOrNull
import dev.zeronative.runtime.longOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "zn"

/**
 * Downloads to [ZnHandles.fileDir] and checks files. JS side: ../../src/api.ts of this plugin. Nothing rejects for a bad
 * file or network: JS gets `{ status: "failed", reason }`, so a screen shows Retry instead of catching.
 *
 * A download is written to a dot name ([PdfRules.partName]) and renamed only once PdfRenderer has opened it. So a kill in
 * the middle leaves nothing a handle can point at, and the next try writes the part file again.
 */
internal class PdfModule(private val context: Context, private val views: PdfViews) : ZnModuleBase("Pdf", version = 1) {
    /** One download per file: a second call for the same file (the success card and the receipt screen) joins it. */
    private val running = HashMap<String, Download>()

    /**
     * The app's own client (pinning and interceptors from ZnFetch.configure), but redirects are followed here, so a
     * redirect to another host can't take the app's headers with it. ZnFetch has no read limit: a stalled download must end.
     */
    private val client: OkHttpClient
        get() = ZnFetch.derived("zn.pdf") { // per call: built again on the fresh pool after a network change
            it.followRedirects(false).followSslRedirects(false).readTimeout(30, TimeUnit.SECONDS).callTimeout(5, TimeUnit.MINUTES)
        }

    init {
        function("download") { call ->
            val url = call.string("url")
            val key = call.stringOrNull("key")
            val maxBytes = (call.longOrNull("maxBytes") ?: PdfRules.DEFAULT_MAX_BYTES).coerceIn(1, PdfRules.MAX_BYTES)
            val headers = headers(call)
            if (!PdfRules.urlAllowed(url, BuildConfig.DEBUG)) return@function call.resolve(failed("not_allowed"))
            download(call, url, PdfRules.fileName(url, key), headers, maxBytes)
        }

        function("open") { call ->
            val file = ZnHandles.fileOf(context, call.string("handle")) ?: return@function call.resolve(failed("not_found"))
            PdfThread.run { call.resolve(check(file, cached = true)) }
        }

        function("cleanup") { call ->
            val age = (call.longOrNull("olderThanMs") ?: PdfRules.KEEP_MS).coerceAtLeast(0)
            val list = call.args.optJSONArray("keep") ?: JSONArray()
            val keep = (0 until list.length()).mapNotNull { ZnHandles.fileOf(context, list.optString(it))?.name }.toSet()
            PdfThread.run { call.resolve(cleanup(age, keep)) }
        }

        // Debug builds: adb can't pinch, so the phone test zooms this way.
        function("debugZoom", onMain = true) { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "debugZoom is for debug builds only")
            val scale = call.doubleOrNull("scale") ?: 2.0
            call.resolve(views.zoom(call.string("view"), scale.toFloat()))
        }
    }

    private fun headers(call: ZnCall): Headers {
        val h = call.args.optJSONObject("headers") ?: return Headers.headersOf()
        val b = Headers.Builder()
        try {
            for (name in h.keys()) b.add(name, h.optString(name))
        } catch (e: IllegalArgumentException) {
            throw ZnInvalidArgs("a header is not valid: ${e.message}")
        }
        return b.build()
    }

    private fun download(call: ZnCall, url: String, name: String, headers: Headers, maxBytes: Long) {
        val dir = ZnHandles.fileDir(context)
        val target = File(dir, name)
        val join: Download
        val first: Boolean
        synchronized(running) {
            val now = running[name]
            first = now == null
            join = now ?: Download(name).also { running[name] = it }
            join.calls += call
        }
        call.onCancel { join.leave(call) }
        if (!first) return
        // A file from an earlier time: checked, not trusted. A broken one is downloaded again.
        PdfThread.run {
            if (target.isFile) {
                val answer = check(target, cached = true)
                if (answer.optString("status") == "ok") {
                    target.setLastModified(System.currentTimeMillis()) // cleanup goes by last use
                    return@run finish(join, answer)
                }
                target.delete()
            }
            fetch(join, url, headers, 0, target, maxBytes)
        }
    }

    /** Any thread. Follows redirects by hand, up to [PdfRules.MAX_REDIRECTS]; [headers] only go to the first origin. */
    private fun fetch(job: Download, url: String, headers: Headers, hops: Int, target: File, maxBytes: Long) {
        if (job.gone) return
        val request = try {
            Request.Builder().url(url).headers(headers).build()
        } catch (e: IllegalArgumentException) {
            return finish(job, failed("not_allowed"))
        }
        val http = client.newCall(request)
        job.http = http
        http.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "pdf: download from ${host(url)} failed: ${e::class.java.simpleName}")
                finish(job, failed("network"))
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { r ->
                    if (r.isRedirect) {
                        val next = r.header("Location")?.let { r.request.url.resolve(it)?.toString() }
                        return when {
                            next == null || hops >= PdfRules.MAX_REDIRECTS -> finish(job, failed("http", r.code))
                            !PdfRules.urlAllowed(next, BuildConfig.DEBUG) -> finish(job, failed("not_allowed"))
                            else -> fetch(job, next, if (PdfRules.sameOrigin(url, next)) headers else Headers.headersOf(), hops + 1, target, maxBytes)
                        }
                    }
                    if (!r.isSuccessful) {
                        Log.w(TAG, "pdf: ${host(url)} answered ${r.code}")
                        return finish(job, failed("http", r.code))
                    }
                    finish(job, save(r, target, maxBytes))
                }
            }
        })
    }

    /** On OkHttp's thread. The body goes to the part file, is checked, then takes the file's real name. */
    private fun save(r: Response, target: File, maxBytes: Long): JSONObject {
        val body = r.body
        if (body.contentLength() > maxBytes) return failed("too_big")
        val part = File(target.parentFile, PdfRules.partName(target.name))
        try {
            val head = ByteArray(1024)
            var headSize = 0
            var total = 0L
            body.byteStream().use { input ->
                part.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buffer) // an IOException here is the network's
                        if (n < 0) break
                        if (headSize < head.size) {
                            val take = minOf(n, head.size - headSize)
                            System.arraycopy(buffer, 0, head, headSize, take)
                            headSize += take
                            if (headSize == head.size && !PdfRules.looksLikePdf(head, headSize)) throw PdfFailure("not_pdf")
                        }
                        total += n
                        if (total > maxBytes) throw PdfFailure("too_big")
                        try {
                            out.write(buffer, 0, n)
                        } catch (e: IOException) {
                            throw PdfFailure(if (e.message.orEmpty().contains("ENOSPC")) "no_space" else "failed", "can't write: $e")
                        }
                    }
                    if (!PdfRules.looksLikePdf(head, headSize)) throw PdfFailure("not_pdf")
                    out.fd.sync()
                }
            }
            val pages = PdfThread.await { PdfDoc.check(part) }
            if (!part.renameTo(target)) throw PdfFailure("failed", "can't move the file into place")
            return describe(target, pages, cached = false)
        } catch (e: PdfFailure) {
            part.delete()
            Log.w(TAG, "pdf: a download can't be used: ${e.code}")
            return failed(e.code)
        } catch (e: IOException) {
            part.delete()
            return failed("network")
        }
    }

    /** On [PdfThread]. */
    private fun check(file: File, cached: Boolean): JSONObject = try {
        describe(file, PdfDoc.check(file), cached)
    } catch (e: PdfFailure) {
        Log.w(TAG, "pdf: ${file.name} can't be used: ${e.code}")
        failed(e.code)
    }

    private fun describe(file: File, pages: List<PageSize>, cached: Boolean): JSONObject {
        val first = pages.first()
        return JSONObject().put("status", "ok").put("handle", ZnHandles.file(context, file)).put("uri", Uri.fromFile(file).toString())
            .put("size", file.length()).put("pages", pages.size).put("width", first.width.toDouble()).put("height", first.height.toDouble())
            .put("cached", cached)
    }

    private fun finish(job: Download, answer: JSONObject) {
        val calls = synchronized(running) {
            if (running[job.name] === job) running.remove(job.name) // a new download of the same file may have started
            job.gone = true
            job.calls.toList()
        }
        for (c in calls) c.resolve(answer)
    }

    private fun cleanup(age: Long, keep: Set<String>): JSONObject {
        val busy = synchronized(running) { running.keys.flatMap { listOf(it, PdfRules.partName(it)) }.toSet() }
        val files = ZnHandles.fileDir(context).listFiles().orEmpty().filter { it.isFile }
        val names = PdfRules.toDelete(files.map { Stored(it.name, it.lastModified()) }, System.currentTimeMillis(), age) { it in keep || it in busy }.toSet()
        var deleted = 0
        var bytes = 0L
        for (f in files) {
            if (f.name !in names) continue
            val size = f.length()
            if (f.delete()) {
                deleted++
                bytes += size
            }
        }
        if (deleted > 0) Log.i(TAG, "pdf: cleanup removed $deleted files")
        return JSONObject().put("deleted", deleted).put("bytes", bytes)
    }

    /** The host only: a link can carry a token. */
    private fun host(url: String) = try {
        URI(url).host ?: "?"
    } catch (e: Exception) {
        "?"
    }

    private fun failed(reason: String, status: Int? = null): JSONObject =
        JSONObject().put("status", "failed").put("reason", reason).apply { if (status != null) put("httpStatus", status) }

    /** The calls waiting for one file. Guarded by [running]. */
    private inner class Download(val name: String) {
        val calls = ArrayList<ZnCall>()
        @Volatile var http: Call? = null
        var gone = false

        /** JS stopped waiting (the screen closed). The last one to leave stops the download. */
        fun leave(call: ZnCall) {
            val stop = synchronized(running) {
                calls.remove(call)
                if (calls.isEmpty() && !gone) {
                    gone = true
                    if (running[name] === this) running.remove(name)
                    true
                } else {
                    false
                }
            }
            if (stop) http?.cancel()
        }
    }
}
