package dev.zeronative.plugins.media

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnInvalidArgs
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnStorage
import dev.zeronative.runtime.intOrNull
import dev.zeronative.runtime.longOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/**
 * Photos and files from other apps, as files in [ZnHandles.fileDir]. JS side: ../../src/index.ts of this plugin.
 *
 * Every other app is opened through [ZnLaunch], so a kill can't lose the result, in three steps:
 * 1. Before the app opens, the [MediaJob] is on disk: sizes, and the camera's file name.
 * 2. Android answers ([onResult]): the links go in the job, on disk, before JS hears. Nothing is copied here: it is the main thread.
 * 3. JS calls `collect`. On the media thread each link is copied and written out. Calling it again is safe: a whole file
 *    already there is used as it is. So a kill during step 3 only means the rest is done at the next start.
 *
 * What was found about a kill (README, "After a kill"): the right to read a link is given to our Activity, not our process. It
 * survives a kill while Android keeps the Activity, and ends when the user swipes the app away, so step 2 also asks to keep it
 * ([holdGrants]). If it is gone all the same, that file answers `access_lost` and the user picks again. A half-copied file never
 * has a handle: it has a dot name, is copied over by the retry, and [trim] removes what is left.
 */
class MediaModule(private val context: Context) : ZnModuleBase("Media", version = 1) {
    /** One thread: two big photos at once would run a low-end phone out of memory. Not the shared I/O pool, which fetch needs. */
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-media").apply { isDaemon = true } }
    private val authority get() = "${context.packageName}.zn.media"
    private val count = AtomicInteger()

    init {
        function("pickPhotos", onMain = true) { call ->
            val max = (call.intOrNull("max") ?: 1).coerceIn(1, MediaRules.MAX_PHOTOS)
            val job = MediaJob(newId(), MediaJob.PHOTOS, maxSize(call), quality(call), max)
            val activity = ZnActivity.current ?: return@function call.resolve(ZnLaunch.Started(false, "no_activity").toJson()) // JS: failed("no_activity")
            // These contracts choose Android's photo picker, and fall back to the file picker on phones without one. No permission.
            val images = PickVisualMediaRequest(PickVisualMedia.ImageOnly)
            val intent = if (max > 1) PickMultipleVisualMedia(max).createIntent(activity, images) else PickVisualMedia().createIntent(activity, images)
            launch(call, job, intent)
        }

        function("pickFile", onMain = true) { call ->
            val types = types(call)
            val maxBytes = (call.longOrNull("maxBytes") ?: MediaRules.MAX_BYTES).coerceIn(1, MediaRules.MAX_BYTES)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(types.singleOrNull() ?: "*/*")
            if (types.size > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            launch(call, MediaJob(newId(), MediaJob.FILE, maxBytes = maxBytes), intent)
        }

        function("takePhoto", onMain = true) { call ->
            val maxSize = maxSize(call)
            val quality = quality(call)
            val activity = ZnActivity.current ?: return@function call.resolve(ZnLaunch.Started(false, "no_activity").toJson()) // JS: failed("no_activity")
            // A trap: the camera app needs no permission from us, but if our manifest lists CAMERA (the scanner plugin adds it)
            // and it isn't granted, Android refuses the launch with a SecurityException. JS asks, then tries again.
            if (MediaRules.cameraPermissionMissing(declaresCamera(activity), hasCamera(activity))) {
                return@function call.resolve(ZnLaunch.Started(false, "camera_permission").toJson())
            }
            val id = newId()
            val name = MediaRules.captureName(id)
            val file = File(ZnHandles.fileDir(activity), name)
            file.createNewFile() // the other app writes through our provider, so this must exist
            val uri = FileProvider.getUriForFile(activity, authority, file)
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.clipData = ClipData.newRawUri(null, uri)
            if (!launch(call, MediaJob(id, MediaJob.CAMERA, maxSize, quality, capture = name), intent)) file.delete()
        }

        function("collect") { call ->
            val id = call.string("id")
            work(call) { collect(call, id) }
        }

        // JS is done with this launch. The files stay until [trim] or cleanup removes them.
        function("forget") { call ->
            val id = call.string("id")
            work(call) {
                val job = read()
                if (job?.id == id) {
                    release(job)
                    job.capture?.let { File(ZnHandles.fileDir(context), it).delete() }
                    // Checked again, on the main thread where every new job is written: a pick started while the work
                    // above ran has its own job by now, and deleting it would make that pick come back "lost".
                    ContextCompat.getMainExecutor(context).execute {
                        if (read()?.id == id) {
                            store().delete(JOB)
                            store().flush()
                        }
                        call.resolve(true)
                    }
                    return@work
                }
                call.resolve(true)
            }
        }

        function("edit") { call ->
            val source = ZnHandles.fileOf(context, call.string("handle"))
            val maxSize = maxSize(call)
            val quality = quality(call)
            val rotate = rule { MediaRules.rotate(call.intOrNull("rotate")) }
            val crop = crop(call)
            work(call) {
                if (source == null) throw MediaFailure("not_found", "no file for this handle")
                val dir = ZnHandles.fileDir(context)
                val id = newId()
                val target = File(dir, MediaRules.fileName(id, 0, "jpg"))
                MediaImage.write(source, File(dir, MediaRules.partName(id, 0, "out")), target, maxSize, quality, rotate, crop)
                call.resolve(describe(target, target.name, JPEG))
            }
        }

        function("cleanup") { call ->
            val age = (call.longOrNull("olderThanMs") ?: DAY_MS).coerceAtLeast(0)
            val list = call.args.optJSONArray("keep") ?: JSONArray()
            val keep = (0 until list.length()).map { list.optString(it) }.mapNotNull { ZnHandles.fileOf(context, it)?.name }.toSet()
            work(call) { call.resolve(trim(age, Long.MAX_VALUE, keep)) }
        }

        // Debug builds: a big photo that is stored sideways and has a location, so the phone test needs no hands.
        function("debugPhoto") { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "debugPhoto is for debug builds only")
            work(call) { call.resolve(debugPhoto()) }
        }

        function("debugExif") { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "debugExif is for debug builds only")
            val file = ZnHandles.fileOf(context, call.string("handle"))
            work(call) {
                val exif = ExifInterface(file ?: throw MediaFailure("not_found"))
                call.resolve(JSONObject().put("orientation", exif.rotationDegrees).put("location", exif.latLong != null))
            }
        }
    }

    /** Runs [block] on the media thread. A [MediaFailure] rejects with its code. */
    private fun work(call: ZnCall, block: () -> Unit) {
        worker.execute {
            try {
                block()
            } catch (e: MediaFailure) {
                call.reject(e.code, e.message ?: e.code)
            } catch (e: Throwable) { // an Error too: the thread must live on for the next call
                Log.e(TAG, "media: failed", e)
                call.reject("failed", "media failed: ${e.message ?: e::class.java.simpleName}")
            }
        }
    }

    /** Main thread. True if the other app opened. */
    private fun launch(call: ZnCall, job: MediaJob, intent: Intent): Boolean {
        val store = store()
        val before = store.getString(JOB)
        store.set(JOB, job.toJson().toString())
        store.flush()
        val started = ZnLaunch.start(KEY, job.id, intent)
        if (started.launched) {
            before?.let(MediaJob::fromJson)?.let { old -> worker.execute { release(old) } }
        } else { // a refused launch must not wipe a result still waiting for JS
            if (before != null) store.set(JOB, before) else store.delete(JOB)
            store.flush()
        }
        call.resolve(started.toJson().put("id", job.id))
        return started.launched
    }

    /** Main thread, from [ZnLaunch]: the other app answered. The record's extras only count; the links stay here. */
    internal fun onResult(resultCode: Int, data: Intent?): JSONObject {
        val job = read() ?: return JSONObject()
        val uris = if (resultCode == Activity.RESULT_OK) MediaRules.usableUris(answerUris(data), job.max) else emptyList()
        store().set(JOB, job.copy(resultCode = resultCode, uris = uris).toJson().toString())
        store().flush()
        worker.execute { holdGrants(uris) }
        return JSONObject().put("count", uris.size)
    }

    /** The other app's answer is outside input. */
    private fun answerUris(data: Intent?): List<String> {
        if (data == null) return emptyList()
        val all = ArrayList<Uri>()
        data.data?.let(all::add)
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(all::add) }
        return all.filter { MediaRules.usableUri(it.scheme, it.authority, authority) }.map { it.toString() }
    }

    /**
     * Android gives the read right to our Activity. The photo picker's guide says it ends when the app stops, so ask to keep
     * it until we have the copy. Android refuses this for most apps' links, and then nothing changes.
     */
    private fun holdGrants(uris: List<String>) {
        for (uri in uris) {
            try {
                context.contentResolver.takePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: SecurityException) {
                // A link with no lasting right. The copy comes in a moment anyway.
            }
        }
    }

    private fun release(job: MediaJob) {
        for (uri in job.uris) {
            try {
                context.contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: SecurityException) {
                // We never held it: see holdGrants.
            }
        }
    }

    private fun collect(call: ZnCall, id: String) {
        val job = read()?.takeIf { it.id == id }
        val code = job?.resultCode
        if (job == null || code == null) return call.resolve(JSONObject().put("status", "lost").put("files", JSONArray()))
        if (code != Activity.RESULT_OK) {
            job.capture?.let { File(ZnHandles.fileDir(context), it).delete() }
            return call.resolve(JSONObject().put("status", "cancelled").put("files", JSONArray()))
        }
        val files = JSONArray()
        var reason: String? = null
        var skipped = 0
        val one = { block: () -> JSONObject ->
            try {
                files.put(block())
            } catch (e: MediaFailure) {
                Log.w(TAG, "media: a file failed: ${e.code}")
                reason = reason ?: e.code
                skipped++
            }
        }
        when (job.kind) {
            MediaJob.CAMERA -> one { camera(job) }
            MediaJob.PHOTOS -> job.uris.forEachIndexed { i, uri -> if (!call.isCancelled) one { photo(job, i, Uri.parse(uri)) } }
            else -> job.uris.firstOrNull()?.let { uri -> one { file(job, Uri.parse(uri)) } }
        }
        val out = JSONObject().put("status", if (files.length() > 0) "ok" else "failed").put("files", files).put("skipped", skipped)
        if (files.length() == 0) out.put("reason", reason ?: "no_file")
        call.resolve(out)
        trim(MediaRules.KEEP_MS, MediaRules.KEEP_BYTES, emptySet())
    }

    private fun camera(job: MediaJob): JSONObject {
        val dir = ZnHandles.fileDir(context)
        val target = File(dir, MediaRules.fileName(job.id, 0, "jpg"))
        val source = File(dir, job.capture ?: throw MediaFailure("no_photo"))
        if (!target.isFile) {
            // Some camera apps answer OK, ignore our file and give only a small preview.
            if (source.length() == 0L) throw MediaFailure("no_photo", "the camera app gave no photo")
            MediaImage.write(source, File(dir, MediaRules.partName(job.id, 0, "out")), target, job.maxSize, job.quality)
            source.delete()
        }
        return describe(target, target.name, JPEG)
    }

    private fun photo(job: MediaJob, index: Int, uri: Uri): JSONObject {
        val dir = ZnHandles.fileDir(context)
        val target = File(dir, MediaRules.fileName(job.id, index, "jpg"))
        val name = MediaRules.withExtension(MediaRules.displayName(queryName(uri), target.name), "jpg")
        if (!target.isFile) {
            val copy = File(dir, MediaRules.partName(job.id, index, "part"))
            try {
                copyTo(uri, copy, job.maxBytes)
                MediaImage.write(copy, File(dir, MediaRules.partName(job.id, index, "out")), target, job.maxSize, job.quality)
            } finally {
                copy.delete()
            }
        }
        return describe(target, name, JPEG)
    }

    private fun file(job: MediaJob, uri: Uri): JSONObject {
        val dir = ZnHandles.fileDir(context)
        val name = MediaRules.displayName(queryName(uri), "file")
        val start = MediaRules.fileName(job.id, 0, "")
        // A retry after a kill: the other app may no longer answer, so its type can't be what finds the file.
        dir.list()?.firstOrNull { it.startsWith(start) }?.let { done ->
            val mime = MediaRules.mimeOr(queryType(uri), MediaRules.mimeOf(done))
            return describe(File(dir, done), name, mime)
        }
        val mime = MediaRules.mimeOr(queryType(uri), "application/octet-stream")
        val target = File(dir, MediaRules.fileName(job.id, 0, MediaRules.extension(mime, name)))
        val work = File(dir, MediaRules.partName(job.id, 0, "part"))
        copyTo(uri, work, job.maxBytes)
        if (!work.renameTo(target)) {
            work.delete()
            throw MediaFailure("write_failed", "can't move the copy into place")
        }
        return describe(target, name, mime)
    }

    /** A half copy of the last try is overwritten. Exact bytes: a picked file isn't touched. */
    private fun copyTo(uri: Uri, work: File, maxBytes: Long) {
        try {
            val input = context.contentResolver.openInputStream(uri) ?: throw FileNotFoundException("no stream")
            input.use { source ->
                work.outputStream().use {
                    pump(source, it, maxBytes)
                    it.fd.sync()
                }
            }
        } catch (e: MediaFailure) {
            work.delete()
            throw e
        } catch (e: SecurityException) { // the read right is gone: the Activity that got it was closed
            work.delete()
            throw MediaFailure("access_lost", "the link can no longer be read; pick again: $e")
        } catch (e: FileNotFoundException) {
            work.delete()
            throw MediaFailure("access_lost", "the file is gone; pick again: $e")
        } catch (e: IOException) {
            work.delete()
            val full = e.message.orEmpty().contains("ENOSPC")
            throw MediaFailure(if (full) "no_space" else "read_failed", "the copy failed: $e")
        } catch (e: RuntimeException) { // the other app's provider can throw anything across Binder
            work.delete()
            throw MediaFailure("read_failed", "the copy failed: $e")
        }
    }

    private fun pump(input: InputStream, output: OutputStream, maxBytes: Long) {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) return
            total += n
            if (total > maxBytes) throw MediaFailure("too_big", "the file is over $maxBytes bytes")
            output.write(buffer, 0, n)
        }
    }

    /** The other app's own answer: a provider can throw anything here, and a name is not worth a failed pick. */
    private fun queryName(uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    } catch (e: Exception) {
        Log.w(TAG, "media: no name for a file: $e")
        null
    }

    private fun queryType(uri: Uri): String? = try {
        context.contentResolver.getType(uri)
    } catch (e: Exception) {
        Log.w(TAG, "media: no type for a file: $e")
        null
    }

    private fun describe(file: File, name: String, mime: String): JSONObject {
        val (width, height) = if (mime.startsWith("image/")) MediaImage.size(file) else 0 to 0
        return JSONObject().put("handle", ZnHandles.file(context, file)).put("uri", Uri.fromFile(file).toString())
            .put("width", width).put("height", height).put("size", file.length()).put("mime", mime).put("name", name)
    }

    /** The folder's limit. Never a file of the job still open, as the camera app may be writing it. */
    private fun trim(maxAgeMs: Long, maxBytes: Long, keep: Set<String>): JSONObject {
        val job = read()?.id
        val files = ZnHandles.fileDir(context).listFiles().orEmpty().filter { it.isFile }
        val stored = files.map { Stored(it.name, it.length(), it.lastModified()) }
        val names = MediaRules.toDelete(stored, System.currentTimeMillis(), maxAgeMs, maxBytes) { it in keep || (job != null && job in it) }.toSet()
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
        if (deleted > 0) Log.i(TAG, "media: cleanup removed $deleted files")
        return JSONObject().put("deleted", deleted).put("bytes", bytes)
    }

    private fun debugPhoto(): JSONObject {
        val dir = ZnHandles.fileDir(context)
        val id = newId()
        val target = File(dir, MediaRules.fileName(id, 0, "jpg"))
        val bitmap = Bitmap.createBitmap(1600, 1200, Bitmap.Config.RGB_565).apply { eraseColor(0xFF2266CC.toInt()) }
        target.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
        bitmap.recycle()
        ExifInterface(target).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString())
            setLatLong(12.9, 77.6)
            saveAttributes()
        }
        return describe(target, target.name, JPEG)
    }

    private fun read(): MediaJob? = store().getString(JOB)?.let(MediaJob::fromJson)

    private fun store() = ZnStorage.store(context, STORE)

    private fun newId() = java.lang.Long.toString(System.currentTimeMillis(), 36) + "x" + java.lang.Long.toString(count.incrementAndGet().toLong(), 36)

    private fun declaresCamera(context: Context) =
        context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions?.contains(Manifest.permission.CAMERA) == true

    private fun hasCamera(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun maxSize(call: ZnCall) = rule { MediaRules.maxSize(call.intOrNull("maxSize")) }
    private fun quality(call: ZnCall) = rule { MediaRules.quality(call.intOrNull("quality")) }

    /** A rule's refusal, as a wrong argument. */
    private inline fun <T> rule(read: () -> T): T = try {
        read()
    } catch (e: IllegalArgumentException) {
        throw ZnInvalidArgs(e.message ?: "bad argument")
    }

    private fun crop(call: ZnCall): Crop? {
        if (call.args.isNull("crop")) return null
        val c = call.args.optJSONObject("crop") ?: throw ZnInvalidArgs("\"crop\" must be { x, y, width, height }")
        val whole = { name: String ->
            val n = c.opt(name) as? Number ?: throw ZnInvalidArgs("\"crop.$name\" must be a number")
            n.toDouble().also { if (it != Math.rint(it) || it < 0 || it > Int.MAX_VALUE) throw ZnInvalidArgs("\"crop.$name\" must be a whole number") }.toInt()
        }
        return Crop(whole("x"), whole("y"), whole("width"), whole("height"))
    }

    private fun types(call: ZnCall): List<String> {
        val list = call.args.optJSONArray("types") ?: return listOf("*/*")
        val types = (0 until list.length()).map { list.optString(it) }
        types.firstOrNull { MediaRules.mimeOr(it, "") == "" }?.let { throw ZnInvalidArgs("\"$it\" isn't a file type") }
        return types.ifEmpty { listOf("*/*") }
    }

    companion object {
        /** The launch key. One key: one pick at a time, and every result takes the same path in JS. */
        const val KEY = "media"
        private const val TAG = "zn"
        private const val STORE = "zn.media"
        private const val JOB = "job"
        private const val JPEG = "image/jpeg"
        private const val DAY_MS = 24L * 3600 * 1000
    }
}
