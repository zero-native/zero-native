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
            val infoEntry = zf.getEntry(ZnBundles.INFO_FILE) ?: throw ZnOtaError("bundle", "the zip has no ${ZnBundles.INFO_FILE}")
            if (infoEntry.size > 1_000_000) throw ZnOtaError("bundle", "${ZnBundles.INFO_FILE} is too big")
            val infoText = zf.getInputStream(infoEntry).use { it.readBytes() }.toString(Charsets.UTF_8)
            val info = try {
                ZnBundles.parseInfo(infoText)
            } catch (e: Exception) {
                throw ZnOtaError("bundle", "bad ${ZnBundles.INFO_FILE}: ${e.message}")
            }
            if (info.app != m.app || info.id != m.id || info.serial != m.serial) {
                throw ZnOtaError("bundle", "the zip holds ${info.app}/${info.id} #${info.serial}, the manifest says ${m.app}/${m.id} #${m.serial}")
            }
            val req = info.requires ?: throw ZnOtaError("bundle", "the zip's ${ZnBundles.INFO_FILE} has no requires")
            if (ZnOtaSignature.requiresLine(req) != ZnOtaSignature.requiresLine(m.requires)) {
                throw ZnOtaError("bundle", "the zip's needs differ from the signed manifest's")
            }
            val listedSha = JSONObject(infoText).getJSONObject("files")
            val checked = HashMap<String, Pair<Long, String>>()
            dest.mkdirs()
            for ((name, size) in info.files) {
                val entry = zf.getEntry(name) ?: throw ZnOtaError("bundle", "the zip has no $name")
                val out = File(dest, name).also { it.parentFile!!.mkdirs() }
                val md = MessageDigest.getInstance("SHA-256")
                var written = 0L
                zf.getInputStream(entry).use { input ->
                    FileOutputStream(out).use { fo ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            written += n
                            if (written > size) throw ZnOtaError("bundle", "$name is bigger than its listed $size bytes")
                            md.update(buf, 0, n)
                            fo.write(buf, 0, n)
                        }
                        fo.fd.sync()
                    }
                }
                val sha = hex(md.digest())
                if (written != size) throw ZnOtaError("bundle", "$name is $written bytes, listed $size")
                if (sha != listedSha.getJSONObject(name).getString("sha256")) throw ZnOtaError("bundle", "$name doesn't match its SHA-256")
                checked[name] = size to sha
            }
            if (bundleSha256(checked) != m.bundleSha256 || info.sha256 != m.bundleSha256) {
                throw ZnOtaError("bundle", "the bundle's files don't match the signed bundle SHA-256")
            }
            File(dest, ZnBundles.INFO_FILE).writeText(infoText)
        }
    }

    /** Writes a small file so readers see the old text or the new one, never half: a temp file, synced, renamed. */
    fun writeAtomic(file: File, text: String) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, ".${file.name}.tmp")
        FileOutputStream(tmp).use { fo ->
            fo.write(text.toByteArray(Charsets.UTF_8))
            fo.fd.sync()
        }
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw ZnOtaError("install", "can't write $file")
        }
    }
}
