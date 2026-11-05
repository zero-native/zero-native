package dev.zeronative.plugins.documentscanner

import org.json.JSONArray
import org.json.JSONObject

/** One scan: written before ML Kit opens, given its answer before JS hears, removed after JS acks (DocScanModule). */
internal data class DocScanJob(
    val id: String,
    /** The app's own word for this scan (an order id), given back in the result. Never used by native. */
    val tag: String?,
    /** Set when ML Kit answered: Activity.RESULT_OK (-1), RESULT_CANCELED (0), or another code. */
    val resultCode: Int? = null,
    /** ML Kit's links, in page order. Native only reads them; JS gets our own copies. */
    val pages: List<String> = emptyList(),
    val pdf: String? = null,
    val pdfPages: Int = 0,
) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("tag", tag ?: JSONObject.NULL)
        .put("resultCode", resultCode ?: JSONObject.NULL).put("pages", JSONArray(pages))
        .put("pdf", pdf ?: JSONObject.NULL).put("pdfPages", pdfPages)

    companion object {
        /** Null for a record that can't be read: a broken job must not stop the next scan. */
        fun fromJson(raw: String): DocScanJob? = try {
            val o = JSONObject(raw)
            val pages = o.optJSONArray("pages") ?: JSONArray()
            DocScanJob(
                id = o.getString("id"),
                tag = o.optString("tag").takeUnless { o.isNull("tag") },
                resultCode = if (o.isNull("resultCode") || !o.has("resultCode")) null else o.getInt("resultCode"),
                pages = (0 until pages.length()).map { pages.getString(it) },
                pdf = o.optString("pdf").takeUnless { o.isNull("pdf") || !o.has("pdf") },
                pdfPages = o.optInt("pdfPages", 0),
            )
        } catch (_: Exception) {
            null
        }
    }
}

/** The plugin's rules, apart from Android and ML Kit, so they have unit tests (DocScanRulesTest). */
internal object DocScanRules {
    // ML Kit's numbers (GmsDocumentScannerOptions, checked with javap on 16.0.0).
    const val MODE_FULL = 1
    const val MODE_BASE_WITH_FILTER = 2
    const val MODE_BASE = 3
    const val FORMAT_JPEG = 101
    const val FORMAT_PDF = 102

    /** More pages than any receipt or form has; ML Kit itself has no upper limit. */
    const val MAX_PAGES = 100
    /** Files of ours older than this go after each scan. */
    const val KEEP_MS = 7L * 24 * 3600 * 1000
    const val PREFIX = "docscanner-"

    /** What `scanDocument` asks ML Kit for. [pageLimit] null: no limit. */
    data class Options(val pageLimit: Int?, val gallery: Boolean, val formats: List<Int>, val mode: Int)

    /** Wrong values throw [IllegalArgumentException] with a message for JS (invalid_args). */
    fun options(pageLimit: Int?, gallery: Boolean?, formats: List<String>?, mode: String?): Options {
        require(pageLimit == null || pageLimit in 1..MAX_PAGES) { "\"maxNumDocuments\" must be 1 to $MAX_PAGES" }
        val list = formats ?: listOf("jpeg")
        require(list.isNotEmpty()) { "\"formats\" must have \"jpeg\", \"pdf\" or both" }
        val codes = list.distinct().map {
            when (it) {
                "jpeg" -> FORMAT_JPEG
                "pdf" -> FORMAT_PDF
                else -> throw IllegalArgumentException("\"formats\" can't have \"$it\": only \"jpeg\" and \"pdf\"")
            }
        }
        val m = when (mode ?: "full") {
            "full" -> MODE_FULL
            "filter" -> MODE_BASE_WITH_FILTER
            "base" -> MODE_BASE
            else -> throw IllegalArgumentException("\"mode\" must be \"full\", \"filter\" or \"base\", got \"$mode\"")
        }
        return Options(pageLimit, gallery ?: false, codes, m)
    }

    /** A tag is the app's own text: short and printable, so it can't fill the disk or the log. */
    fun tag(tag: String?): String? {
        if (tag == null) return null
        require(tag.length <= 200) { "\"tag\" must be 200 characters or fewer" }
        return tag
    }

    /** ML Kit's answer, joined to the job. Null: no job of ours, or it has an answer already (the first one wins). */
    fun withResult(job: DocScanJob?, resultCode: Int, pages: List<String>, pdf: String?, pdfPages: Int): DocScanJob? {
        if (job == null || job.resultCode != null) return null
        return job.copy(resultCode = resultCode, pages = pages, pdf = pdf, pdfPages = pdfPages.coerceAtLeast(0))
    }

    /** What `collect` must do for [id]. */
    enum class Collect { LOST, CANCEL, FILES, EMPTY }

    fun collect(job: DocScanJob?, id: String, ok: Int): Collect = when {
        job == null || job.id != id || job.resultCode == null -> Collect.LOST
        job.resultCode != ok -> Collect.CANCEL
        job.pages.isEmpty() && job.pdf == null -> Collect.EMPTY
        else -> Collect.FILES
    }

    /** Only a job's own id clears it, so an old screen can't clear a new scan. */
    fun canForget(job: DocScanJob?, id: String) = job != null && job.id == id

    fun pageName(id: String, index: Int) = "$PREFIX$id-$index.jpg"
    fun pdfName(id: String) = "$PREFIX$id.pdf"
    /** A dot name: no handle can name it, so JS never sees a half-written file. */
    fun partName(name: String) = ".$name.part"

    /** Links ML Kit gave: only file and content links, the rest is outside input we don't open. */
    fun usableLink(scheme: String?) = scheme == "file" || scheme == "content"

    /** Which of our files go: older than [maxAgeMs], or [maxAgeMs] 0 for all. Never [keep] or a file of [openJob]. */
    fun toDelete(files: List<Pair<String, Long>>, now: Long, maxAgeMs: Long, keep: Set<String>, openJob: String?): List<String> =
        files.filter { (name, modified) ->
            val ours = name.startsWith(PREFIX) || (name.startsWith(".$PREFIX") && name.endsWith(".part"))
            ours && name !in keep && (openJob == null || !name.contains("$PREFIX$openJob")) && now - modified >= maxAgeMs
        }.map { it.first }

    // ---- The module's state (download) ------------------------------------------------------------------------------

    // ModuleAvailabilityResponse.AvailabilityStatus (play-services-base 18.5.0).
    const val ALREADY_AVAILABLE = 0
    const val READY_TO_DOWNLOAD = 1
    const val UNKNOWN_MODULE = 2

    // ModuleInstallStatusUpdate.InstallState.
    const val STATE_UNKNOWN = 0
    const val STATE_PENDING = 1
    const val STATE_DOWNLOADING = 2
    const val STATE_CANCELED = 3
    const val STATE_COMPLETED = 4
    const val STATE_FAILED = 5
    const val STATE_INSTALLING = 6
    const val STATE_DOWNLOAD_PAUSED = 7

    // ConnectionResult (Play services on the phone).
    const val PLAY_SUCCESS = 0
    const val PLAY_MISSING = 1
    const val PLAY_UPDATE_REQUIRED = 2
    const val PLAY_DISABLED = 3
    const val PLAY_INVALID = 9
    const val PLAY_UPDATING = 18

    /** Why the scanner can't work at all on this phone, from Play services' own check. Null: Play services is fine. */
    fun playProblem(code: Int): String? = when (code) {
        PLAY_SUCCESS -> null
        PLAY_MISSING, PLAY_INVALID -> "no_play_services"
        PLAY_UPDATE_REQUIRED -> "play_services_old"
        PLAY_DISABLED -> "play_services_disabled"
        PLAY_UPDATING -> "play_services_updating"
        else -> "play_services_error"
    }

    fun availability(code: Int): String = when (code) {
        ALREADY_AVAILABLE -> "available"
        READY_TO_DOWNLOAD -> "not_downloaded"
        else -> "unavailable"
    }

    /** A download step, as JS sees it. */
    fun stateName(state: Int): String = when (state) {
        STATE_PENDING -> "pending"
        STATE_DOWNLOADING -> "downloading"
        STATE_INSTALLING -> "installing"
        STATE_DOWNLOAD_PAUSED -> "paused"
        STATE_COMPLETED -> "completed"
        STATE_FAILED -> "failed"
        STATE_CANCELED -> "canceled"
        else -> "unknown"
    }

    fun terminal(state: Int) = state == STATE_COMPLETED || state == STATE_FAILED || state == STATE_CANCELED

    /** ModuleInstallStatusCodes and CommonStatusCodes (play-services-basement 18.9.0), in a word. */
    fun installError(code: Int): String = when (code) {
        46003 -> "no_space" // INSUFFICIENT_STORAGE
        46000, 46001, 46002 -> "unknown_module" // UNKNOWN_MODULE, NOT_ALLOWED_MODULE, MODULE_NOT_FOUND
        2 -> "play_services_old" // SERVICE_VERSION_UPDATE_REQUIRED
        3 -> "play_services_disabled" // SERVICE_DISABLED
        7 -> "network" // NETWORK_ERROR
        15 -> "timeout" // TIMEOUT
        16 -> "canceled" // CANCELED
        17 -> "play_services_old" // API_NOT_CONNECTED: this Play services has no ModuleInstall API
        else -> "error_$code"
    }

    /**
     * The status JS sees. [download]: the last update of a download this process started, or null. A download that
     * failed is "failed" only while the module is still missing: a later download from another app may have put it there.
     */
    fun status(availability: String, download: Int?, error: Int, bytes: Long, total: Long): JSONObject {
        val out = JSONObject()
        when {
            availability == "available" -> out.put("status", "available")
            availability == "unavailable" -> out.put("status", "unavailable").put("reason", "unknown_module")
            download != null && !terminal(download) && download != STATE_UNKNOWN ->
                out.put("status", "downloading").put("state", stateName(download))
            download == STATE_FAILED -> out.put("status", "failed").put("reason", installError(error))
            download == STATE_CANCELED -> out.put("status", "failed").put("reason", "canceled")
            else -> out.put("status", "not_downloaded")
        }
        if (out.getString("status") == "downloading") out.put("bytes", bytes.coerceAtLeast(0)).put("total", total.coerceAtLeast(0))
        return out
    }

    /**
     * Why ML Kit refused to give the scan Intent. [mlKitCode]: MlKitException's code (com.google.mlkit:common 18.11.0),
     * or null for another exception. 14 UNAVAILABLE means the module isn't on the phone yet.
     */
    fun scanRefusal(mlKitCode: Int?, apiCode: Int?): String = when (mlKitCode) {
        14 -> "not_downloaded" // UNAVAILABLE
        101 -> "no_space" // NOT_ENOUGH_SPACE
        17 -> "network" // NETWORK_ISSUE
        3 -> "invalid_args" // INVALID_ARGUMENT
        null -> if (apiCode != null) installError(apiCode) else "failed"
        else -> "mlkit_$mlKitCode"
    }

    /** These reasons mean "not on this phone now", so JS gets status "unavailable", not "failed". */
    fun meansUnavailable(reason: String) = reason == "not_downloaded" || reason == "unknown_module" ||
        reason.startsWith("play_services_") || reason == "no_play_services"
}
