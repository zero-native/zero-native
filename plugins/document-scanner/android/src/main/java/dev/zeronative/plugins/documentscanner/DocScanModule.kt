package dev.zeronative.plugins.documentscanner

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.moduleinstall.InstallStatusListener
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate
import com.google.mlkit.common.MlKit
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnInvalidArgs
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnStorage
import dev.zeronative.runtime.booleanOrNull
import dev.zeronative.runtime.intOrNull
import dev.zeronative.runtime.longOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * Google ML Kit's document scanner, as a launch through [ZnLaunch]. JS side: ../../../../../../../../src/index.ts.
 *
 * ML Kit's scanner is a Google Play services module: Play downloads it the first time an app needs it. So there are two parts.
 *
 * **The module's state** (`getStatus`, `download`, the `status` event) comes from Play's ModuleInstall API. Every Play
 * failure is an answer with a reason, never a throw: the app then lets the user type by hand.
 *
 * **A scan** goes the way the media plugin's picks go, so a kill can't lose it (README, "After a kill"):
 * 1. Before ML Kit opens, the [DocScanJob] is on disk (id, tag), and ZnLaunch has its own "waiting" record.
 * 2. ML Kit answers ([onResult], main thread, also in a new process after a kill): its links go in the job, on disk, before
 *    JS hears. ZnLaunch then saves its record and sends JS the `result` event.
 * 3. JS calls `collect`: on our own thread each page and the PDF move into [ZnHandles.fileDir]. Calling it again is safe: a
 *    whole file already there is used as it is.
 * 4. JS acks the launch and calls `forget`. Until then the result comes again at each start.
 */
class DocScanModule(private val context: Context) : ZnModuleBase("DocumentScanner", version = 1) {
    /** One thread for files: never the shared I/O pool, which fetch needs. */
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-docscan").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val count = AtomicInteger()

    /** Main thread only. The scan waiting for ML Kit's Intent; one at a time. */
    private var asking: Ask? = null

    // Main thread only. The download this process started, as Play last told us.
    private var downloadState: Int? = null
    private var downloadError = 0
    private var downloadBytes = 0L
    private var downloadTotal = 0L
    private val downloadCalls = ArrayList<ZnCall>()
    private var listener: InstallStatusListener? = null

    private class Ask(val call: ZnCall, val id: String, val tag: String?) {
        lateinit var giveUp: Runnable
    }

    init {
        function("getStatus", onMain = true) { call -> status { call.resolve(it) } }

        function("download", onMain = true) { call -> download(call) }

        function("scanDocument", onMain = true) { call ->
            val options = rule {
                DocScanRules.options(call.intOrNull("maxNumDocuments"), call.booleanOrNull("galleryImport"), formats(call), call.stringOrNull("mode"))
            }
            val tag = rule { DocScanRules.tag(call.stringOrNull("tag")) }
            scan(call, options, tag)
        }

        function("collect") { call ->
            val id = call.string("id")
            work(call) { collect(call, id) }
        }

        // JS has acked this launch. The files stay until cleanup or the 7-day trim removes them.
        function("forget", onMain = true) { call ->
            val id = call.string("id")
            if (DocScanRules.canForget(read(), id)) {
                store().delete(JOB)
                store().flush()
                scanMarker(context).delete() // a "lost" scan never got an answer, so onResult never removed it
            }
            call.resolve(true)
        }

        function("cleanup") { call ->
            val age = (call.longOrNull("olderThanMs") ?: DAY_MS).coerceAtLeast(0)
            val list = call.args.optJSONArray("keep") ?: JSONArray()
            val keep = (0 until list.length()).mapNotNull { ZnHandles.fileOf(context, list.optString(it))?.name }.toSet()
            work(call) { call.resolve(trim(age, keep)) }
        }
    }

    // ---- The module's state -----------------------------------------------------------------------------------------

    /** Main thread. Play's answer, or a reason. [done] is called once, on the main thread. */
    private fun status(done: (JSONObject) -> Unit) {
        var answered = false
        val once = { o: JSONObject ->
            if (!answered) {
                answered = true
                done(o)
            }
        }
        val play = try {
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
        } catch (t: Throwable) {
            Log.w(TAG, "docscanner: can't check Play services: $t")
            -1
        }
        DocScanRules.playProblem(play)?.let { return once(unavailable(it)) }
        if (!mlKitReady) return startMlKit { status(done) }
        // Play services can be slow to answer, or busy updating itself: a Task may never finish.
        val giveUp = Runnable { once(JSONObject().put("status", "failed").put("reason", "timeout")) }
        main.postDelayed(giveUp, ASK_MS)
        try {
            ModuleInstall.getClient(context).areModulesAvailable(scanner())
                .addOnSuccessListener { r ->
                    main.removeCallbacks(giveUp)
                    once(DocScanRules.status(DocScanRules.availability(r.availabilityStatus), downloadState, downloadError, downloadBytes, downloadTotal))
                }
                .addOnFailureListener { e ->
                    main.removeCallbacks(giveUp)
                    Log.w(TAG, "docscanner: no module status: $e")
                    once(failure(e))
                }
                .addOnCanceledListener {
                    main.removeCallbacks(giveUp)
                    once(JSONObject().put("status", "failed").put("reason", "canceled"))
                }
        } catch (t: Throwable) {
            main.removeCallbacks(giveUp)
            Log.w(TAG, "docscanner: can't ask for the module status", t)
            once(unavailable("play_services_error"))
        }
    }

    /** Main thread. Joins a download already running; answers when it ends. Progress goes out as `status` events. */
    private fun download(call: ZnCall) {
        downloadCalls += call
        if (downloadCalls.size > 1) return // one is running: this call waits for its end
        status { now ->
            if (now.getString("status") != "not_downloaded" && now.getString("status") != "failed") return@status endDownload(now)
            val l = InstallStatusListener { update -> onUpdate(update) }
            listener = l
            downloadState = DocScanRules.STATE_PENDING
            downloadError = 0
            emitStatus()
            try {
                val request = ModuleInstallRequest.newBuilder().addApi(scanner()).setListener(l, ContextCompat.getMainExecutor(context)).build()
                ModuleInstall.getClient(context).installModules(request)
                    .addOnSuccessListener { r ->
                        if (r.areModulesAlreadyInstalled()) {
                            downloadState = DocScanRules.STATE_COMPLETED
                            finishDownload()
                        }
                        // Otherwise the listener hears each step and the end.
                    }
                    .addOnFailureListener { e ->
                        Log.w(TAG, "docscanner: the download didn't start: $e")
                        downloadState = DocScanRules.STATE_FAILED
                        downloadError = (e as? ApiException)?.statusCode ?: 8
                        finishDownload()
                    }
            } catch (t: Throwable) {
                Log.w(TAG, "docscanner: can't start the download", t)
                downloadState = DocScanRules.STATE_FAILED
                downloadError = 8
                finishDownload()
            }
        }
    }

    /** Main thread (the listener's executor). */
    private fun onUpdate(update: ModuleInstallStatusUpdate) {
        if (listener == null) return
        downloadState = update.installState
        downloadError = update.errorCode
        update.progressInfo?.let {
            downloadBytes = it.bytesDownloaded
            downloadTotal = it.totalBytesToDownload
        }
        Log.i(TAG, "docscanner: download ${DocScanRules.stateName(update.installState)} $downloadBytes / $downloadTotal")
        if (DocScanRules.terminal(update.installState)) finishDownload() else emitStatus()
    }

    private fun finishDownload() {
        listener?.let { l ->
            try {
                ModuleInstall.getClient(context).unregisterListener(l)
            } catch (_: Throwable) {
                // Play is gone: nothing more will come anyway.
            }
        }
        listener = null
        // Ask Play again: "completed" is Play's word, availability is what a scan needs.
        status { endDownload(it) }
    }

    private fun endDownload(status: JSONObject) {
        emit("status", status)
        downloadCalls.toList().also { downloadCalls.clear() }.forEach { it.resolve(status) }
    }

    private fun emitStatus() =
        emit("status", DocScanRules.status("not_downloaded", downloadState, downloadError, downloadBytes, downloadTotal), latestOnly = true)

    private fun unavailable(reason: String) = JSONObject().put("status", "unavailable").put("reason", reason)

    /** A failed Play Task as a status. */
    private fun failure(e: Exception): JSONObject {
        val code = (e as? ApiException)?.statusCode
        val reason = if (code != null) DocScanRules.installError(code) else "play_services_error"
        // These mean "not on this phone", not "try again".
        return if (DocScanRules.meansUnavailable(reason)) unavailable(reason)
        else JSONObject().put("status", "failed").put("reason", reason)
    }

    // ---- A scan -----------------------------------------------------------------------------------------------------

    /** Main thread. */
    private fun scan(call: ZnCall, options: DocScanRules.Options, tag: String?) {
        if (!mlKitReady) return startMlKit { scan(call, options, tag) }
        if (asking != null) return call.resolve(refused("busy"))
        val activity = ZnActivity.current ?: return call.resolve(refused("no_activity"))
        DocScanRules.playProblem(playCode())?.let { return call.resolve(refused(it, unavailable = true)) }
        val ask = Ask(call, newId(), tag)
        ask.giveUp = Runnable { endAsk(ask, refused("timeout")) }
        asking = ask
        main.postDelayed(ask.giveUp, ASK_MS)
        try {
            scanner(options).getStartScanIntent(activity)
                .addOnSuccessListener { sender -> open(ask, sender) }
                .addOnFailureListener { e ->
                    val reason = DocScanRules.scanRefusal((e as? MlKitException)?.errorCode, (e as? ApiException)?.statusCode)
                    Log.w(TAG, "docscanner: no scan Intent ($reason): $e")
                    // "not_downloaded": ML Kit has asked Play for the module; getStatus / onStatus show it.
                    endAsk(ask, refused(reason, unavailable = DocScanRules.meansUnavailable(reason)))
                }
                .addOnCanceledListener { endAsk(ask, refused("canceled")) }
        } catch (t: Throwable) {
            Log.w(TAG, "docscanner: can't ask ML Kit for the scan", t)
            endAsk(ask, refused("failed"))
        }
    }

    /** Main thread: ML Kit gave the Intent. The job goes on disk, then ZnLaunch opens it. */
    private fun open(ask: Ask, sender: IntentSender) {
        if (asking !== ask) return // timed out already
        if (ask.call.isCancelled) return endAsk(ask, null) // the JS that asked is gone: a scanner now would answer nobody
        val store = store()
        val before = store.getString(JOB)
        store.set(JOB, DocScanJob(ask.id, ask.tag).toJson().toString())
        store.flush()
        try {
            scanMarker(context).createNewFile() // see startIfScanOpen: a new process must start ML Kit before Android rebuilds its Activity
        } catch (e: java.io.IOException) {
            Log.w(TAG, "docscanner: no marker file: $e") // ZnLaunch then refuses with no_storage too
        }
        val started = try {
            ZnLaunch.start(KEY, ask.id, sender)
        } catch (t: Throwable) {
            Log.w(TAG, "docscanner: can't open the scanner", t)
            ZnLaunch.Started(false, "failed")
        }
        if (!started.launched) { // a refused launch must not wipe a result still waiting for JS
            if (before != null) store.set(JOB, before) else store.delete(JOB)
            store.flush()
            scanMarker(context).delete()
        }
        endAsk(ask, started.toJson().put("id", ask.id))
    }

    private fun endAsk(ask: Ask, answer: JSONObject?) {
        if (asking !== ask) return
        asking = null
        main.removeCallbacks(ask.giveUp)
        if (answer != null) ask.call.resolve(answer)
    }

    private fun refused(reason: String, unavailable: Boolean = false) =
        ZnLaunch.Started(false, reason).toJson().apply { if (unavailable) put("unavailable", true) }

    /**
     * Main thread, from [ZnLaunch] (also in a new process after a kill): ML Kit answered. Its links go in the job, on disk,
     * before JS hears. Nothing is copied here. The record's extras are only counts.
     */
    internal fun onResult(resultCode: Int, data: Intent?): JSONObject {
        scanMarker(context).delete() // ML Kit's Activity has answered: a later start needs no early ML Kit
        val job = read() ?: return JSONObject()
        var pages = emptyList<String>()
        var pdf: String? = null
        var pdfPages = 0
        if (resultCode == Activity.RESULT_OK && data != null) {
            try {
                val result = GmsDocumentScanningResult.fromActivityResultIntent(data)
                pages = result?.pages.orEmpty().mapNotNull { it.imageUri }.filter { DocScanRules.usableLink(it.scheme) }.map { it.toString() }
                result?.pdf?.let { p -> p.uri.takeIf { DocScanRules.usableLink(it.scheme) }?.let { pdf = it.toString(); pdfPages = p.pageCount } }
            } catch (t: Throwable) { // ML Kit's answer is outside input
                Log.w(TAG, "docscanner: ML Kit's answer can't be read: $t")
            }
        }
        val next = DocScanRules.withResult(job, resultCode, pages, pdf, pdfPages) ?: return JSONObject()
        store().set(JOB, next.toJson().toString())
        store().flush()
        Log.i(TAG, "docscanner: result $resultCode, ${pages.size} pages, pdf ${pdf != null}")
        return JSONObject().put("pages", pages.size).put("pdf", pdf != null)
    }

    /** The plugin's thread. */
    private fun collect(call: ZnCall, id: String) {
        val job = read()
        val base = JSONObject().put("id", id).put("pages", JSONArray()).put("pdf", JSONObject.NULL)
        job?.tag?.takeIf { job.id == id }?.let { base.put("tag", it) }
        when (DocScanRules.collect(job, id, Activity.RESULT_OK)) {
            DocScanRules.Collect.LOST -> return call.resolve(base.put("status", "lost"))
            DocScanRules.Collect.CANCEL -> return call.resolve(base.put("status", "cancel"))
            DocScanRules.Collect.EMPTY -> return call.resolve(base.put("status", "failed").put("reason", "no_file"))
            DocScanRules.Collect.FILES -> Unit
        }
        job!!
        val dir = ZnHandles.fileDir(context)
        try {
            val pages = JSONArray()
            job.pages.forEachIndexed { i, link -> pages.put(page(take(link, File(dir, DocScanRules.pageName(id, i))))) }
            base.put("pages", pages)
            job.pdf?.let { link ->
                val file = take(link, File(dir, DocScanRules.pdfName(id)))
                base.put("pdf", JSONObject().put("handle", ZnHandles.file(context, file)).put("uri", Uri.fromFile(file).toString())
                    .put("pageCount", job.pdfPages).put("size", file.length()))
            }
            call.resolve(base.put("status", "success"))
        } catch (e: DocScanFailure) {
            Log.w(TAG, "docscanner: a file failed: ${e.code}: ${e.message}")
            call.resolve(base.put("status", "failed").put("reason", e.code).put("pages", JSONArray()).put("pdf", JSONObject.NULL))
        }
        trim(DocScanRules.KEEP_MS, emptySet())
    }

    /**
     * ML Kit's file, as ours at [target]. A file in our own storage is moved (no second copy on a full phone), anything
     * else is copied. Whole files only: a retry after a kill finds [target] and uses it.
     */
    private fun take(link: String, target: File): File {
        if (target.isFile) return target
        val uri = Uri.parse(link)
        val part = File(target.parentFile, DocScanRules.partName(target.name))
        if (uri.scheme == "file") {
            val source = File(uri.path ?: throw DocScanFailure("no_file", "a link with no path"))
            if (!source.isFile) throw DocScanFailure("access_lost", "ML Kit's file is gone; scan again")
            if (ours(source) && source.renameTo(target)) return target
        }
        try {
            val input = context.contentResolver.openInputStream(uri) ?: throw FileNotFoundException("no stream")
            input.use { from -> part.outputStream().use { to -> from.copyTo(to, 64 * 1024); to.fd.sync() } }
            if (!part.renameTo(target)) throw DocScanFailure("write_failed", "can't move the copy into place")
            if (uri.scheme == "file") File(uri.path!!).takeIf(::ours)?.delete()
            return target
        } catch (e: DocScanFailure) {
            part.delete()
            throw e
        } catch (e: SecurityException) {
            part.delete()
            throw DocScanFailure("access_lost", "the link can no longer be read; scan again: $e")
        } catch (e: FileNotFoundException) {
            part.delete()
            throw DocScanFailure("access_lost", "ML Kit's file is gone; scan again: $e")
        } catch (e: IOException) {
            part.delete()
            throw DocScanFailure(if (e.message.orEmpty().contains("ENOSPC")) "no_space" else "read_failed", "the copy failed: $e")
        } catch (e: RuntimeException) { // a provider can throw anything across Binder
            part.delete()
            throw DocScanFailure("read_failed", "the copy failed: $e")
        }
    }

    /** Inside our app's own folders. ML Kit's delegate Activity runs in our process and writes to our cache. */
    private fun ours(file: File): Boolean {
        val path = file.canonicalPath
        return listOf(context.cacheDir, context.filesDir).any { path.startsWith(it.canonicalPath + File.separator) }
    }

    private fun page(file: File): JSONObject {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, o)
        return JSONObject().put("handle", ZnHandles.file(context, file)).put("uri", Uri.fromFile(file).toString())
            .put("width", o.outWidth.coerceAtLeast(0)).put("height", o.outHeight.coerceAtLeast(0)).put("size", file.length())
    }

    /** Our files only (the `docscanner-` names), never one of the open job. */
    private fun trim(maxAgeMs: Long, keep: Set<String>): JSONObject {
        val open = read()?.id
        val files = ZnHandles.fileDir(context).listFiles().orEmpty().filter { it.isFile }
        val names = DocScanRules.toDelete(files.map { it.name to it.lastModified() }, System.currentTimeMillis(), maxAgeMs, keep, open).toSet()
        var bytes = 0L
        var deleted = 0
        for (file in files) {
            if (file.name !in names) continue
            val size = file.length()
            if (file.delete()) {
                bytes += size
                deleted++
            }
        }
        if (deleted > 0) Log.i(TAG, "docscanner: cleanup removed $deleted files")
        return JSONObject().put("deleted", deleted).put("bytes", bytes)
    }

    // ---- Small helpers ----------------------------------------------------------------------------------------------

    /** Main thread only. */
    private var mlKitReady = false

    /**
     * ML Kit must be started before any client. Its own start (a ContentProvider at app start) is often removed: the
     * scanner plugin's manifest removes it, to keep app start fast. Then `GmsDocumentScanning.getClient` throws
     * "MlKitContext has not been initialized" (seen on the emulator, 2026-11-05). So start it here, once, off the main
     * thread (it looks up ML Kit's parts by reflection), then run [then] on the main thread.
     */
    private fun startMlKit(then: () -> Unit) {
        worker.execute {
            synchronized(MlKitOnce) {
                if (!MlKitOnce.done) {
                    MlKitOnce.done = true
                    try {
                        MlKit.initialize(context.applicationContext)
                    } catch (_: IllegalStateException) {
                        // Started already: by ML Kit's own provider, or another plugin (the scanner's MlKitStart). Fine.
                    } catch (t: Throwable) {
                        Log.w(TAG, "docscanner: can't start ML Kit: $t") // the client then fails, and says why
                    }
                }
            }
            main.post {
                mlKitReady = true
                then()
            }
        }
    }

    private object MlKitOnce {
        var done = false
    }

    /**
     * Main thread, in [DocumentScannerPlugin.register], so in `Application.onCreate`. If our process died while the scanner was
     * open, Android starts a new process to hand back ML Kit's answer and first rebuilds ML Kit's own invisible Activity, whose
     * constructor needs ML Kit started. With ML Kit's start-up provider removed (the scanner plugin does that), that crashed:
     * "Unable to instantiate activity GmsDocumentScanningDelegateActivity: MlKitContext has not been initialized", and the scan
     * was lost (found on the emulator, 2026-11-05). So: only a stat of our marker file at every start; ML Kit is started here,
     * on the main thread, only when a scan was open.
     */
    internal fun startIfScanOpen() {
        if (!scanMarker(context).exists()) return
        synchronized(MlKitOnce) {
            if (MlKitOnce.done) return
            MlKitOnce.done = true
            val t0 = System.nanoTime()
            try {
                MlKit.initialize(context.applicationContext)
            } catch (_: IllegalStateException) {
                // Started already (ML Kit's own provider). Fine.
            } catch (t: Throwable) {
                Log.w(TAG, "docscanner: can't start ML Kit: $t")
            }
            Log.i(TAG, "docscanner: a scan was open; ML Kit started early in ${(System.nanoTime() - t0) / 1_000_000} ms")
        }
        mlKitReady = true
    }

    /** Exists while ML Kit's scanner is open (between the launch and its answer). */
    private fun scanMarker(context: Context) = File(context.noBackupFilesDir, MARKER)

    private fun work(call: ZnCall, block: () -> Unit) {
        worker.execute {
            try {
                block()
            } catch (e: Throwable) { // an Error too: the thread must live on for the next call
                Log.e(TAG, "docscanner: failed", e)
                call.reject("failed", "document scanner failed: ${e.message ?: e::class.java.simpleName}")
            }
        }
    }

    /** Only for asking about the module: these options don't change which module it is. */
    private fun scanner(): GmsDocumentScanner = GmsDocumentScanning.getClient(GmsDocumentScannerOptions.Builder().build())

    private fun scanner(o: DocScanRules.Options): GmsDocumentScanner {
        val b = GmsDocumentScannerOptions.Builder().setGalleryImportAllowed(o.gallery).setScannerMode(o.mode)
            .setResultFormats(o.formats.first(), *o.formats.drop(1).toIntArray())
        o.pageLimit?.let { b.setPageLimit(it) }
        return GmsDocumentScanning.getClient(b.build())
    }

    private fun playCode() = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
    } catch (t: Throwable) {
        -1
    }

    private fun formats(call: ZnCall): List<String>? {
        if (call.args.isNull("formats")) return null
        val list = call.args.optJSONArray("formats") ?: throw ZnInvalidArgs("\"formats\" must be a list, like [\"jpeg\", \"pdf\"]")
        return (0 until list.length()).map { list.opt(it) as? String ?: throw ZnInvalidArgs("\"formats\" must hold text") }
    }

    /** A rule's refusal, as a wrong argument. */
    private inline fun <T> rule(read: () -> T): T = try {
        read()
    } catch (e: IllegalArgumentException) {
        throw ZnInvalidArgs(e.message ?: "bad argument")
    }

    private fun read(): DocScanJob? = store().getString(JOB)?.let(DocScanJob::fromJson)

    private fun store() = ZnStorage.store(context, STORE)

    private fun newId() = java.lang.Long.toString(System.currentTimeMillis(), 36) + "x" + java.lang.Long.toString(count.incrementAndGet().toLong(), 36)

    private class DocScanFailure(val code: String, message: String) : Exception(message)

    companion object {
        /** The launch key: one scan at a time, and every result takes the same path in JS. */
        const val KEY = "docscanner"
        private const val TAG = "zn"
        /** JS reads the job too (src/index.ts, `pending`): keep these names. */
        private const val STORE = "zn.docscanner"
        private const val JOB = "job"
        private const val DAY_MS = 24L * 3600 * 1000
        private const val MARKER = "zn-docscanner-open"
        /** How long Play services may take to answer before we say "timeout". */
        private const val ASK_MS = 15_000L
    }
}
