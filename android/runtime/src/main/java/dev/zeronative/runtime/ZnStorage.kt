package dev.zeronative.runtime

import android.content.Context
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * App storage from Kotlin (docs/storage.md): the same stores JS uses through `storage` / `createStorage(id)`, for
 * native code such as a widget, a push-notification handler or a native module.
 *
 *     val store = ZnStorage.store(context)              // the default store, "zn.default"
 *     store.set("lastStoreId", "42")
 *     val onboarded = store.getBoolean("onboarded") ?: false
 *
 * - Synchronous and safe from any thread (calls are serialized; each takes microseconds, so the main thread is fine).
 * - Main process only (a service declared with `android:process` gets an exception): docs/storage.md §7.
 * - JS and Kotlin see each other's writes at once (one MMKV instance per store per process). JS `onChange`
 *   listeners hear only writes made from JS.
 * - Values keep their type, in the format JS uses (core/include/zn/storage.h): a getter of another type throws
 *   [IllegalStateException], never returns a wrong value.
 */
object ZnStorage {
    const val DEFAULT_ID = "zn.default"
    private const val STRING: Byte = 1
    private const val NUMBER: Byte = 2
    private const val BOOLEAN: Byte = 3
    private const val BYTES: Byte = 4
    private val ID = Regex("[A-Za-z0-9._-]{1,64}")

    @Volatile private var opened = false

    /** A store by id (1–64 characters from A-Z a-z 0-9 . _ -). Works before ZnRuntime.start too. */
    fun store(context: Context, id: String = DEFAULT_ID): Store {
        require(ID.matches(id)) { "ZnStorage: id \"$id\" must be 1-64 characters from A-Z a-z 0-9 . _ -" }
        check(ZnProcess.isMain(context)) {
            "ZnStorage works only in the app's main process, not in ${ZnProcess.name()}: stores are opened in " +
                "single-process mode, and two processes writing the same file can damage it (docs/storage.md §7)"
        }
        open(context)
        return Store(id)
    }

    /** The folder the JS runtime uses too (ZnRuntime.createOnJsThread). */
    internal fun dir(context: Context) = File(context.noBackupFilesDir, "zn-storage")

    private fun open(context: Context) {
        if (opened) return
        synchronized(this) {
            if (opened) return
            val dir = dir(context.applicationContext).apply { mkdirs() }
            ZnNative.storageOpen(dir.absolutePath)
            opened = true
        }
    }

    class Store internal constructor(val id: String) {
        private val idBytes = id.toByteArray(Charsets.UTF_8)

        fun set(key: String, value: String) = put(key, byteArrayOf(STRING) + value.toByteArray(Charsets.UTF_8))
        fun set(key: String, value: Double) =
            put(key, ByteBuffer.allocate(9).order(ByteOrder.LITTLE_ENDIAN).put(NUMBER).putDouble(value).array())
        fun set(key: String, value: Int) = set(key, value.toDouble())
        fun set(key: String, value: Long) = set(key, value.toDouble()) // JS numbers: exact up to 2^53
        fun set(key: String, value: Boolean) = put(key, byteArrayOf(BOOLEAN, if (value) 1 else 0))
        fun set(key: String, value: ByteArray) = put(key, byteArrayOf(BYTES) + value)

        /** The value with its saved type (String, Double, Boolean or ByteArray), or null if the key is missing. */
        fun get(key: String): Any? {
            val blob = ZnNative.storageGet(idBytes, keyBytes(key)) ?: return null
            return when {
                blob.isNotEmpty() && blob[0] == STRING -> String(blob, 1, blob.size - 1, Charsets.UTF_8)
                blob.size == 9 && blob[0] == NUMBER -> ByteBuffer.wrap(blob, 1, 8).order(ByteOrder.LITTLE_ENDIAN).double
                blob.size == 2 && blob[0] == BOOLEAN -> blob[1] != 0.toByte()
                blob.isNotEmpty() && blob[0] == BYTES -> blob.copyOfRange(1, blob.size)
                else -> throw IllegalStateException("ZnStorage: \"$key\" in \"$id\" holds data in an unknown format")
            }
        }

        fun getString(key: String): String? = typed(key, "a string")
        fun getNumber(key: String): Double? = typed(key, "a number")
        fun getBoolean(key: String): Boolean? = typed(key, "a boolean")
        fun getBytes(key: String): ByteArray? = typed(key, "bytes")

        fun has(key: String): Boolean = ZnNative.storageHas(idBytes, keyBytes(key))
        fun delete(key: String) = ZnNative.storageRemove(idBytes, keyBytes(key))
        fun keys(): List<String> = ZnNative.storageKeys(idBytes).map { String(it, Charsets.UTF_8) }
        fun clear() = ZnNative.storageClear(idBytes)
        /** Forces the store to flash (~1 ms): survives a power cut, not just a killed app. */
        fun flush() = ZnNative.storageFlush(idBytes)

        private fun put(key: String, tagged: ByteArray) {
            check(ZnNative.storageSet(idBytes, keyBytes(key), tagged)) { "ZnStorage: could not save \"$key\" in \"$id\"" }
        }

        private inline fun <reified T> typed(key: String, what: String): T? {
            val v = get(key) ?: return null
            if (v !is T) {
                val holds = when (v) {
                    is String -> "a string"
                    is Double -> "a number"
                    is Boolean -> "a boolean"
                    else -> "bytes"
                }
                throw IllegalStateException("ZnStorage: \"$key\" in \"$id\" holds $holds, not $what")
            }
            return v
        }

        private fun keyBytes(key: String): ByteArray {
            require(key.isNotEmpty()) { "ZnStorage: a key must be a non-empty string" }
            return key.toByteArray(Charsets.UTF_8)
        }
    }
}
