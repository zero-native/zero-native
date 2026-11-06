package dev.zeronative.runtime

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.annotation.RequiresApi
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.KeyStore
import java.security.MessageDigest
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
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
 * - A value that can never be decrypted again (the Keystore key is gone or broken, the data no longer matches it, a
 *   damaged file) reads as missing (null) and is deleted. Apps must treat "no token" as "sign in again".
 * - Anything else is not a loss (2026-11-06, old-phone audit): a busy or not-ready Keystore, a ProviderException
 *   ("Keystore operation failed", seen on some Android 7-9 phones), a file that can't be read now. The call is tried
 *   again a few times, then rejects with code "temporarily_unavailable" and **nothing is deleted**, so the app can try
 *   again instead of signing the user out. Before, any Keystore error deleted the value: an app that logs out on "no
 *   token" signed the user out and wiped their data, and even the next start couldn't recover. [Rules] decides.
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

    /** The code a call rejects with when the Keystore or the file can't be used now; the value is kept. */
    internal const val TEMPORARY = "temporarily_unavailable"
    /** Waits before the 2nd and 3rd try of a failed Keystore or file step (a busy Keystore often answers soon). */
    private val RETRY_MS = longArrayOf(50, 200)

    /** Failed even after the tries, and the value is kept: JS gets [TEMPORARY]. */
    private class NotNow(cause: Throwable) : Exception(cause)

    /** Our own checks of a file found it damaged (it can never be decrypted). */
    internal class Damaged(message: String) : Exception(message)

    /** The Keystore has no key for SecureStore: values made with the old key can never be decrypted. */
    internal class NoKey : Exception("no Keystore key")

    /**
     * What an error means for a stored value (ZnSecureStoreTest). Only [lostForGood] errors delete anything; when in
     * doubt the value is kept. Wrongly keeping a broken value costs a "try again" the app can offer with "log in
     * again"; wrongly deleting a good one signs the user out for nothing.
     */
    object Rules {
        /** The value (or the key) can never be used again. */
        fun lostForGood(e: Throwable): Boolean {
            if (Build.VERSION.SDK_INT >= 33) keystoreError(e)?.let { ks ->
                val code = ks.numericErrorCode
                if (code == android.security.KeyStoreException.ERROR_KEY_DOES_NOT_EXIST ||
                    code == android.security.KeyStoreException.ERROR_KEY_CORRUPTED) return true
                if (ks.isTransientFailure) return false
            }
            return when (e) {
                is AEADBadTagException -> true // the data doesn't match the key: the key changed, or the file is damaged
                is KeyPermanentlyInvalidatedException -> true
                is UnrecoverableKeyException -> true // the key entry is there but can't be loaded (seen after OS updates)
                is Damaged, is NoKey -> true
                else -> false
            }
        }

        /**
         * A Keystore failure that is known to pass (never a reason to make a new key): ProviderException, the
         * Keystore's own "transient" flag on Android 13+, or a file read or write.
         */
        fun passes(e: Throwable): Boolean {
            if (Build.VERSION.SDK_INT >= 33) keystoreError(e)?.let { if (it.isTransientFailure) return true }
            return e is ProviderException || e is IOException
        }

        /** The Keystore's own error in [e]'s causes (Android 13+ gives a code and a "transient" flag). */
        @RequiresApi(33)
        private fun keystoreError(e: Throwable): android.security.KeyStoreException? {
            var c: Throwable? = e
            var depth = 0
            while (c != null && depth++ < 8) {
                if (c is android.security.KeyStoreException) return c
                c = c.cause
            }
            return null
        }
    }

    init {
        function("get") { call ->
            val key = key(call) ?: return@function
            try {
                call.resolve(get(key))
            } catch (e: NotNow) {
                call.reject(TEMPORARY, "SecureStore.get: can't read \"$key\" now (${e.cause?.javaClass?.simpleName}); it is kept, try again")
            }
        }
        function("set") { call ->
            val key = key(call) ?: return@function
            val value = call.args.optString("value", "")
            if (!call.args.has("value") || value.length > MAX_VALUE) {
                return@function call.reject("invalid_args", "SecureStore.set: value must be a string of at most $MAX_VALUE characters")
            }
            try {
                set(key, value)
            } catch (e: NotNow) {
                return@function call.reject(TEMPORARY, "SecureStore.set: can't save \"$key\" now (${e.cause?.javaClass?.simpleName}); the old value is kept, try again")
            }
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

    /**
     * Runs [step] up to 3 times (waits [RETRY_MS] between), returning its value or the last error. Every error is
     * tried again, also one that looks final: a busy Keystore has been seen to answer oddly once.
     */
    private fun <T> tries(what: String, step: () -> T): Result<T> {
        var last: Throwable? = null
        for (attempt in 0..RETRY_MS.size) {
            try {
                return Result.success(step())
            } catch (e: Exception) {
                last = e
                if (attempt < RETRY_MS.size) {
                    Log.w(TAG, "SecureStore: $what failed (${e.javaClass.simpleName}: ${e.message}); trying again")
                    Thread.sleep(RETRY_MS[attempt])
                }
            }
        }
        return Result.failure(last!!)
    }

    private fun get(key: String): String? = synchronized(lock) {
        val file = fileFor(key)
        if (!file.exists()) return null
        val read = tries("reading \"$key\"") { decrypt(key, file.readBytes()) }
        read.getOrNull()?.let { return it }
        val e = read.exceptionOrNull()!!
        if (!file.exists()) return null // deleted meanwhile
        if (!Rules.lostForGood(e)) {
            Log.w(TAG, "SecureStore: \"$key\" can't be read now (${e.javaClass.simpleName}); kept, the app can try again", e)
            throw NotNow(e)
        }
        Log.w(TAG, "SecureStore: \"$key\" can't be decrypted any more (${e.javaClass.simpleName}); it reads as missing", e)
        file.delete()
        null
    }

    private fun decrypt(key: String, data: ByteArray): String {
        if (data.size <= 2 || data[0] != FORMAT_VERSION) throw Damaged("unknown format")
        val ivSize = data[1].toInt()
        if (ivSize !in 12..16 || data.size <= 2 + ivSize) throw Damaged("bad IV")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(create = false) ?: throw NoKey(), GCMParameterSpec(128, data, 2, ivSize))
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(data, 2 + ivSize, data.size - 2 - ivSize), Charsets.UTF_8)
    }

    private fun set(key: String, value: String) = synchronized(lock) {
        val first = tries("saving \"$key\"") { encrypt(key, value, secretKey(create = true)!!) }
        val bytes = first.getOrElse { e ->
            // A Keystore failure known to pass: keep the key (a new key would make every other value unreadable).
            if (Rules.passes(e)) throw NotNow(e)
            // A broken Keystore entry (seen after OS updates on some phones): make a new key once. Older values
            // become unreadable, which get() then reads as missing (AEADBadTagException).
            Log.w(TAG, "SecureStore: Keystore key unusable (${e.javaClass.simpleName}); creating a new one", e)
            tries("making a new key") {
                keyStore().deleteEntry(ALIAS)
                encrypt(key, value, secretKey(create = true)!!)
            }.getOrElse { throw NotNow(it) }
        }
        dir.mkdirs()
        val file = fileFor(key)
        val tmp = File(dir, "${file.name}.tmp")
        // The old value stays until the rename, so a failed write (storage full) keeps it
        tries("writing \"$key\"") {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) throw IOException("could not replace ${file.name}")
        }.getOrElse { throw NotNow(it) }
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
