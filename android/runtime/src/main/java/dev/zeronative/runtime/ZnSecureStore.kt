package dev.zeronative.runtime

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * SecureStore (docs/storage.md): small secrets (tokens, keys) encrypted with AES-256-GCM. The key lives in the Android
 * Keystore and never leaves it (on most phones it is held by secure hardware). JS side:
 * packages/core/src/secure-store.ts. Async, because Keystore calls go to a system service (a few ms each).
 *
 * - One file per key in noBackupFilesDir/zn-secure, named by the SHA-256 of the key; written to a temp file, synced,
 *   then renamed, so a kill mid-write leaves the old value or the new one, never half.
 * - File format: [1: version][1: IV length][IV][ciphertext + GCM tag]. The key name is the GCM "associated data", so
 *   a file copied over another key's file fails to decrypt instead of returning the wrong secret.
 * - A value that can't be decrypted any more (Keystore key lost after a factory-reset restore or an OS bug, a damaged
 *   file) reads as missing (null) and is deleted. Apps must treat "no token" as "sign in again".
 * - No user authentication on the key (no fingerprint prompt): add a separate mode later if an app needs it.
 */
object ZnSecureStore : ZnModuleBase("SecureStore") {
    private const val TAG = "zn"
    private const val ALIAS = "zn.securestore.v1"
    private const val FORMAT_VERSION: Byte = 1
    private const val MAX_KEY = 256
    private const val MAX_VALUE = 64 * 1024 // characters; secrets are small
    private const val HEX = "0123456789abcdef"

    private lateinit var dir: File
    private val lock = Any() // the I/O pool has 2 threads; Keystore on some phones fails with parallel key creation

    init {
        function("get") { call -> call.resolve(get(key(call) ?: return@function)) }
        function("set") { call ->
            val key = key(call) ?: return@function
            val value = call.args.optString("value", "")
            if (!call.args.has("value") || value.length > MAX_VALUE) {
                return@function call.reject("invalid_args", "SecureStore.set: value must be a string of at most $MAX_VALUE characters")
            }
            set(key, value)
            call.resolve()
        }
        function("delete") { call ->
            val key = key(call) ?: return@function
            synchronized(lock) { fileFor(key).delete() }
            call.resolve()
        }
    }

    internal fun init(context: Context) {
        dir = File(context.noBackupFilesDir, "zn-secure")
    }

    private fun key(call: ZnCall): String? {
        val key = call.args.optString("key", "")
        if (key.isEmpty() || key.length > MAX_KEY) {
            call.reject("invalid_args", "SecureStore: key must be a non-empty string of at most $MAX_KEY characters")
            return null
        }
        return key
    }

    private fun get(key: String): String? = synchronized(lock) {
        val file = fileFor(key)
        if (!file.exists()) return null
        val data = file.readBytes()
        try {
            require(data.size > 2 && data[0] == FORMAT_VERSION) { "unknown format" }
            val ivSize = data[1].toInt()
            require(ivSize in 12..16 && data.size > 2 + ivSize) { "bad IV" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(create = false) ?: throw GeneralSecurityException("no key"),
                GCMParameterSpec(128, data, 2, ivSize))
            cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(data, 2 + ivSize, data.size - 2 - ivSize), Charsets.UTF_8)
        } catch (e: GeneralSecurityException) {
            unreadable(file, key, e)
        } catch (e: IllegalArgumentException) {
            unreadable(file, key, e)
        }
    }

    private fun unreadable(file: File, key: String, e: Exception): String? {
        Log.w(TAG, "SecureStore: \"$key\" can't be decrypted any more (${e.javaClass.simpleName}); it reads as missing", e)
        file.delete()
        return null
    }

    private fun set(key: String, value: String) = synchronized(lock) {
        val bytes = try {
            encrypt(key, value, secretKey(create = true)!!)
        } catch (e: GeneralSecurityException) {
            // A broken Keystore entry (seen after OS updates on some phones): make a new key once. Older values
            // become unreadable, which get() already handles.
            Log.w(TAG, "SecureStore: Keystore key unusable (${e.javaClass.simpleName}); creating a new one", e)
            keyStore().deleteEntry(ALIAS)
            encrypt(key, value, secretKey(create = true)!!)
        }
        dir.mkdirs()
        val file = fileFor(key)
        val tmp = File(dir, "${file.name}.tmp")
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        if (!tmp.renameTo(file)) throw IOException("could not replace ${file.name}")
    }

    private fun encrypt(key: String, value: String, secret: SecretKey): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secret) // the Keystore picks a fresh random IV
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        return byteArrayOf(FORMAT_VERSION, iv.size.toByte()) + iv + sealed
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun secretKey(create: Boolean): SecretKey? {
        (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun fileFor(key: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        val hex = StringBuilder(hash.size * 2)
        for (b in hash) {
            val v = b.toInt() and 0xff
            hex.append(HEX[v shr 4]).append(HEX[v and 0x0f])
        }
        return File(dir, hex.toString())
    }
}
