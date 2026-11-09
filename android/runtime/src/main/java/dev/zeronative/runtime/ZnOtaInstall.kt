package dev.zeronative.runtime

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.ZipFile
import org.json.JSONObject

/** Why an update was refused or failed. [code] goes to telemetry (`docs/ota.md` §3.7). */
internal class ZnOtaError(val code: String, message: String) : Exception(message)

/**
 * Checking and installing a downloaded bundle (step 4.5, docs/ota.md §3.5). Plain Java I/O only, so every rule is
 * tested on the JVM (ZnOtaInstallTest); [ZnOta] does the network and the Android side.
 *
 * Nothing is trusted unless it was signed: the pointer (this channel chose this bundle, at this seq), the manifest
 * (the bundle is these bytes and needs this), then the zip's SHA, then every file's SHA and the bundle's own SHA.
 */
internal object ZnOtaInstall {
    /** The signed manifest of a released bundle (tools/ota/core.ts `Manifest`). */
    class Manifest(
        val app: String,
        val id: String,
        val serial: Int,
        val bundleSha256: String,
        val requires: ZnBundles.Requires,
        val zipSha256: String,
        val zipSize: Long,
        /** Where to download it, relative to the server (the check's `bundle.url`). */
        val url: String,
        val signature: String,
    )

    /** A signed channel pointer (tools/ota/core.ts `Pointer`). Rollout and priority aren't signed. */
    class Pointer(val app: String, val channel: String, val seq: Long, val target: String, val priority: String, val signature: String)

    fun parseManifest(j: JSONObject): Manifest {
        val r = j.getJSONObject("requires")
        val m = r.getJSONObject("modules")
        val zip = j.getJSONObject("zip")
        return Manifest(
            app = j.getString("app"),
            id = j.getString("id"),
            serial = j.getInt("serial"),
            bundleSha256 = j.getString("bundleSha256"),
            requires = ZnBundles.Requires(r.getInt("registry"), r.getInt("bytecode"), r.getInt("hostApi"), m.keys().asSequence().associateWith { m.getInt(it) }),
            zipSha256 = zip.getString("sha256"),
            zipSize = zip.getLong("size"),
            url = j.optString("url", ""),
            signature = j.getJSONObject("signature").getString("value"),
        )
    }

    fun parsePointer(j: JSONObject) = Pointer(
        app = j.getString("app"),
        channel = j.getString("channel"),
        seq = j.getLong("seq"),
        target = j.getString("target"),
        priority = j.optString("priority", "normal"),
        signature = j.getJSONObject("signature").getString("value"),
    )

    fun verifyManifest(m: Manifest, publicKeys: List<String>): Boolean = ZnOtaSignature.verify(
        ZnOtaSignature.bundleText(m.app, m.id, m.serial, m.bundleSha256, m.requires, m.zipSha256, m.zipSize),
        m.signature,
        publicKeys,
    ) >= 0

    fun verifyPointer(p: Pointer, publicKeys: List<String>): Boolean =
        ZnOtaSignature.verify(ZnOtaSignature.pointerText(p.app, p.channel, p.seq, p.target), p.signature, publicKeys) >= 0

    fun sha256(file: File): String = file.inputStream().use { sha256(it) }

    private fun sha256(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return hex(md.digest())
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** The bundle's one SHA-256, as tools/bundle-info.ts makes it: over "name size sha256\n" lines sorted by name. */
    fun bundleSha256(files: Map<String, Pair<Long, String>>): String {
        val text = files.keys.sorted().joinToString("") { "$it ${files.getValue(it).first} ${files.getValue(it).second}\n" }
        return hex(MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)))
    }

    /**
     * Unzips the bundle [zip] (its SHA already checked against [m]) into the new folder [dest]. `zn-bundle.json` is
     * read first and must name the manifest's bundle; then only the files it lists are written, each stopped at its
     * listed size and checked against its listed SHA-256 (no zip bombs, no paths outside [dest]: names were checked when
     * parsing). Finally the bundle's SHA and needs must equal the signed manifest's. Throws [ZnOtaError].
     */
    fun extract(zip: File, m: Manifest, dest: File) {
        if (dest.exists()) throw ZnOtaError("install", "$dest already exists")
        ZipFile(zip).use { zf ->
            val (infoText, info) = readInfo(zf, m, "bundle")
            val listedSha = JSONObject(infoText).getJSONObject("files")
            val checked = HashMap<String, Pair<Long, String>>()
            dest.mkdirs()
            for ((name, size) in info.files) {
                val entry = zf.getEntry(name) ?: throw ZnOtaError("bundle", "the zip has no $name")
                val out = File(dest, name).also { it.parentFile!!.mkdirs() }
                val sha = zf.getInputStream(entry).use { writeChecked(it, out, name, size, listedSha.getJSONObject(name).getString("sha256"), "bundle") }
                checked[name] = size to sha
            }
            finish(checked, info, infoText, m, dest, "bundle")
        }
    }

    /**
     * Reads `zn-bundle.json` from [zf]; it must name the manifest's app, id and serial, and the same needs. Returns its
     * text and what it says. Problems throw [ZnOtaError] with [code].
     */
    private fun readInfo(zf: ZipFile, m: Manifest, code: String): Pair<String, ZnBundles.Info> {
        val infoEntry = zf.getEntry(ZnBundles.INFO_FILE) ?: throw ZnOtaError(code, "the zip has no ${ZnBundles.INFO_FILE}")
        if (infoEntry.size > 1_000_000) throw ZnOtaError(code, "${ZnBundles.INFO_FILE} is too big")
        val infoText = zf.getInputStream(infoEntry).use { readLimited(it, 1_000_000, ZnBundles.INFO_FILE, code) }.toString(Charsets.UTF_8)
        val info = try {
            ZnBundles.parseInfo(infoText)
        } catch (e: Exception) {
            throw ZnOtaError(code, "bad ${ZnBundles.INFO_FILE}: ${e.message}")
        }
        if (info.app != m.app || info.id != m.id || info.serial != m.serial) {
            throw ZnOtaError(code, "the zip holds ${info.app}/${info.id} #${info.serial}, the manifest says ${m.app}/${m.id} #${m.serial}")
        }
        val req = info.requires ?: throw ZnOtaError(code, "the zip's ${ZnBundles.INFO_FILE} has no requires")
        if (ZnOtaSignature.requiresLine(req) != ZnOtaSignature.requiresLine(m.requires)) {
            throw ZnOtaError(code, "the zip's needs differ from the signed manifest's")
        }
        return infoText to info
    }

    /**
     * Writes [input] to [out], stopped at [size] bytes; it must be exactly [size] bytes and match [listedSha].
     * Returns its SHA-256. Problems throw [ZnOtaError] with [code].
     */
    private fun writeChecked(input: InputStream, out: File, name: String, size: Long, listedSha: String, code: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        var written = 0L
        FileOutputStream(out).use { fo ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                written += n
                if (written > size) throw ZnOtaError(code, "$name is bigger than its listed $size bytes")
                md.update(buf, 0, n)
                fo.write(buf, 0, n)
            }
            fo.fd.sync()
        }
        val sha = hex(md.digest())
        if (written != size) throw ZnOtaError(code, "$name is $written bytes, listed $size")
        if (sha != listedSha) throw ZnOtaError(code, "$name doesn't match its SHA-256")
        return sha
    }

    /**
     * The last step of a build: the files made ([checked]: name → size and SHA) must give the signed bundle SHA, and so
     * must `zn-bundle.json`. Then `zn-bundle.json` is written into [dest].
     */
    private fun finish(checked: Map<String, Pair<Long, String>>, info: ZnBundles.Info, infoText: String, m: Manifest, dest: File, code: String) {
        if (bundleSha256(checked) != m.bundleSha256 || info.sha256 != m.bundleSha256) {
            throw ZnOtaError(code, "the bundle's files don't match the signed bundle SHA-256")
        }
        File(dest, ZnBundles.INFO_FILE).writeText(infoText)
    }

    /** All of [input], but never more than [limit] bytes: more throws [ZnOtaError] with [code]. */
    private fun readLimited(input: InputStream, limit: Long, name: String, code: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > limit) throw ZnOtaError(code, "$name is bigger than its limit of $limit bytes")
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    // ---- Building a bundle from a patch zip (docs/ota-patches.md §3, §6) ---------------------------------------------

    /** The patch zip's own file: what it patches, and how each new file is made. */
    const val PATCH_FILE = "zn-patch.json"
    /** A patch entry may unpack to at most 2 × the listed size of the file it makes, plus this. */
    private const val PATCH_SLACK = 1L shl 20
    /** An old file read into memory for a patch (largest today: main.hbc, 1.6 MB). Bigger: refused. */
    private const val MAX_BASE_FILE = 64L shl 20
    /** A ByteArray can't hold more than this (a little under 2 GB). */
    private const val MAX_ARRAY = Int.MAX_VALUE - 16L

    /**
     * Builds bundle [m] into the new folder [dest] from the patch zip [patchZip] (its SHA already checked against the
     * check's `patch`) and the base bundle [fromId] whose bundle SHA is [fromSha256]. [base] opens a file of the base
     * bundle by name, or gives null if it has none: a downloaded bundle's folder or the APK's assets.
     *
     * The same checks as [extract], so a patch weakens nothing: `zn-bundle.json` must name the manifest's bundle;
     * `zn-patch.json` must be from [fromId] / [fromSha256] to [m], and list exactly the files of `zn-bundle.json`; every
     * file made (copy, patch or zip) is stopped at its listed size and checked against its listed SHA-256; then the
     * bundle's SHA must equal the signed manifest's. File names go through the same rules as [ZnBundles.parseInfo], so
     * nothing is read or written outside the bundle. Throws [ZnOtaError] with code "patch" (or "install").
     */
    fun buildFromPatch(patchZip: File, m: Manifest, fromId: String, fromSha256: String, base: (String) -> InputStream?, dest: File) {
        if (dest.exists()) throw ZnOtaError("install", "$dest already exists")
        val zip = try {
            ZipFile(patchZip)
        } catch (e: java.util.zip.ZipException) {
            throw ZnOtaError("patch", "the patch zip can't be read (${e.message})")
        }
        zip.use { zf ->
            val patchEntry = zf.getEntry(PATCH_FILE) ?: throw ZnOtaError("patch", "the patch zip has no $PATCH_FILE")
            val p = try {
                JSONObject(zf.getInputStream(patchEntry).use { readLimited(it, 1_000_000, PATCH_FILE, "patch") }.toString(Charsets.UTF_8))
            } catch (e: org.json.JSONException) {
                throw ZnOtaError("patch", "bad $PATCH_FILE: ${e.message}")
            }
            val format = p.optString("format")
            if (format != ZnBsPatch.FORMAT) throw ZnOtaError("patch", "$PATCH_FILE has format \"$format\", this app reads ${ZnBsPatch.FORMAT}")
            val from = p.optJSONObject("from")
            val to = p.optJSONObject("to")
            // The base is matched by its bundle SHA only: the server makes one patch per base SHA, and two bundles
            // with the same SHA (an Android and an iOS store build of the same JS) have different ids. Same SHA = same
            // files, so the id in zn-patch.json is only for people reading it.
            if (from == null || from.optString("sha256") != fromSha256) {
                throw ZnOtaError("patch", "$PATCH_FILE is from ${from?.optString("id")} with another SHA-256 than the base $fromId")
            }
            if (to == null || to.optString("id") != m.id || to.optString("sha256") != m.bundleSha256) {
                throw ZnOtaError("patch", "$PATCH_FILE is to ${to?.optString("id")}, the manifest says ${m.id} (or its SHA-256 differs)")
            }
            val (infoText, info) = readInfo(zf, m, "patch")
            val listedSha = JSONObject(infoText).getJSONObject("files")
            val specs = p.optJSONObject("files") ?: throw ZnOtaError("patch", "$PATCH_FILE has no files")
            val names = specs.keys().asSequence().toSet()
            (names - info.files.keys).firstOrNull()?.let { throw ZnOtaError("patch", "$PATCH_FILE has $it, which ${ZnBundles.INFO_FILE} doesn't list") }
            (info.files.keys - names).firstOrNull()?.let { throw ZnOtaError("patch", "$PATCH_FILE doesn't say how to make $it") }

            val checked = HashMap<String, Pair<Long, String>>()
            dest.mkdirs()
            for ((name, size) in info.files) {
                val spec = specs.optJSONObject(name) ?: throw ZnOtaError("patch", "$PATCH_FILE: $name isn't an object")
                val how = listOf("copy", "patch", "zip").filter { spec.has(it) }
                if (how.size != 1) throw ZnOtaError("patch", "$PATCH_FILE: $name needs one of copy, patch or zip, it has ${how.ifEmpty { listOf("none") }.joinToString()}")
                val listed = listedSha.getJSONObject(name).getString("sha256")
                val out = File(dest, name).also { it.parentFile!!.mkdirs() }
                val sha = when (how[0]) {
                    "copy" -> {
                        val b = safeName(spec.optString("copy"), name)
                        (base(b) ?: throw ZnOtaError("patch", "the base $fromId has no $b (to copy as $name)"))
                            .use { writeChecked(it, out, name, size, listed, "patch") }
                    }
                    "zip" -> {
                        val entry = patchEntry(zf, spec.optString("zip"), name)
                        zf.getInputStream(entry).use { writeChecked(it, out, name, size, listed, "patch") }
                    }
                    else -> {
                        val entry = patchEntry(zf, spec.optString("patch"), name)
                        val b = safeName(spec.optString("base"), name)
                        val old = (base(b) ?: throw ZnOtaError("patch", "the base $fromId has no $b (to patch into $name)"))
                            .use { readLimited(it, MAX_BASE_FILE, "the base file $b", "patch") }
                        // §6: a patch entry may unpack to at most 2 × the file's listed size + 1 MiB.
                        val limit = if (size > (MAX_ARRAY - PATCH_SLACK) / 2) MAX_ARRAY else 2 * size + PATCH_SLACK
                        val patch = zf.getInputStream(entry).use { readLimited(it, limit, "the patch for $name", "patch") }
                        val made = try {
                            ZnBsPatch.apply(old, patch, size)
                        } catch (e: ZnOtaError) {
                            throw ZnOtaError("patch", "the patch for $name: ${e.message}")
                        }
                        writeChecked(made.inputStream(), out, name, size, listed, "patch")
                    }
                }
                checked[name] = size to sha
            }
            finish(checked, info, infoText, m, dest, "patch")
        }
    }

    /** The entry [entryName] of the patch zip (for new file [forName]); the name must pass [safeName]. */
    private fun patchEntry(zf: ZipFile, entryName: String, forName: String): java.util.zip.ZipEntry {
        val n = safeName(entryName, forName)
        return zf.getEntry(n) ?: throw ZnOtaError("patch", "the patch zip has no $n (for $forName)")
    }

    /** [n] if it is a plain relative path (the rules of [ZnBundles.parseInfo], and no backslash); else throws. */
    private fun safeName(n: String, forName: String): String {
        if (n.isEmpty() || n.startsWith("/") || '\\' in n || n.split('/').any { it == ".." || it.isEmpty() }) {
            throw ZnOtaError("patch", "$PATCH_FILE: bad path \"$n\" for $forName")
        }
        return n
    }

    /**
     * Writes a small file so readers see the old text or the new one, never half: a temp file, synced, renamed.
     * [sync] false skips the sync: the file still survives the app being killed, not a power cut (for a write on the
     * main thread that must be cheap: the launch watchdog's mark, ZnOtaHealth).
     */
    fun writeAtomic(file: File, text: String, sync: Boolean = true) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, ".${file.name}.tmp")
        FileOutputStream(tmp).use { fo ->
            fo.write(text.toByteArray(Charsets.UTF_8))
            if (sync) fo.fd.sync()
        }
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw ZnOtaError("install", "can't write $file")
        }
    }
}
