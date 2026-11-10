package dev.zeronative.runtime

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * OTA signatures on the phone (docs/ota.md §3.3): ECDSA P-256 with SHA-256, DER signatures, public keys as base64 SPKI
 * DER. The signed texts must stay byte-identical to tools/ota/signing.ts (the release CLI) and the update server; a
 * JVM test verifies a signature made by the CLI (ZnOtaSignatureTest).
 *
 * The app trusts a main key and an offline backup key: an answer signed by either is accepted, so a lost main key
 * doesn't end OTA for installed apps.
 */
internal object ZnOtaSignature {
    const val VERSION = "zn-ota-v1"
    /** The pointer target that means "run the APK's own bundle" (the kill switch). */
    const val BUILT_IN = "BUILT_IN"

    /**
     * "registry=8;bytecode=99;hostApi=2;modules=Device:1,Fetch:1;android=AdId:1" (modules sorted by name; each OS's own
     * modules after, Android then iOS, only when it has some: docs/ota-requires-per-os.md §3).
     */
    fun requiresLine(r: ZnBundles.Requires): String {
        fun list(m: Map<String, Int>) = m.keys.sorted().joinToString(",") { "$it:${m[it]}" }
        val line = StringBuilder("registry=${r.registry};bytecode=${r.bytecode};hostApi=${r.hostApi};modules=${list(r.modules)}")
        for (os in ZnBundles.Requires.OSES) {
            val m = r.os[os]
            if (!m.isNullOrEmpty()) line.append(";$os=${list(m)}")
        }
        return line.toString()
    }

    /** What a bundle's signature covers. */
    fun bundleText(
        app: String,
        id: String,
        serial: Int,
        bundleSha256: String,
        requires: ZnBundles.Requires,
        zipSha256: String,
        zipSize: Long,
    ): String = listOf(VERSION, "bundle", app, id, serial.toString(), bundleSha256, requiresLine(requires), zipSha256, zipSize.toString())
        .joinToString("\n")

    /** What a pointer's signature covers: this channel of this app chose [target] (a bundle id or BUILT_IN) at [seq]. */
    fun pointerText(app: String, channel: String, seq: Long, target: String): String =
        listOf(VERSION, "pointer", app, channel, seq.toString(), target).joinToString("\n")

    /**
     * Which of [publicKeys] (base64 SPKI DER; main first, backup second) signed [text], or -1 if none did (or the
     * signature or a key can't be read). [signature] is base64 DER.
     */
    fun verify(text: String, signature: String, publicKeys: List<String>): Int {
        val sig = try {
            decodeBase64(signature)
        } catch (_: IllegalArgumentException) {
            return -1
        }
        publicKeys.forEachIndexed { i, pk ->
            val ok = try {
                val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(decodeBase64(pk)))
                Signature.getInstance("SHA256withECDSA").run {
                    initVerify(key)
                    update(text.toByteArray(Charsets.UTF_8))
                    verify(sig)
                }
            } catch (_: Exception) {
                false
            }
            if (ok) return i
        }
        return -1
    }

    /** Standard base64 with padding (java.util.Base64 needs API 26; android.util.Base64 isn't in JVM tests). */
    internal fun decodeBase64(s: String): ByteArray {
        val clean = s.filterNot { it == '\n' || it == '\r' || it == ' ' }
        require(clean.length % 4 == 0) { "base64 length ${clean.length} is not a multiple of 4" }
        val out = java.io.ByteArrayOutputStream(clean.length / 4 * 3)
        var i = 0
        while (i < clean.length) {
            val q = IntArray(4) { k -> sixBits(clean[i + k]) }
            val n = (q[0] shl 18) or (q[1] shl 12) or (maxOf(q[2], 0) shl 6) or maxOf(q[3], 0)
            out.write(n shr 16 and 0xFF)
            if (q[2] >= 0) out.write(n shr 8 and 0xFF)
            if (q[3] >= 0) out.write(n and 0xFF)
            i += 4
        }
        return out.toByteArray()
    }

    /** 0–63, or -1 for padding. */
    private fun sixBits(c: Char): Int = when (c) {
        in 'A'..'Z' -> c - 'A'
        in 'a'..'z' -> c - 'a' + 26
        in '0'..'9' -> c - '0' + 52
        '+' -> 62
        '/' -> 63
        '=' -> -1
        else -> throw IllegalArgumentException("not base64: '$c'")
    }
}
