package dev.zeronative.runtime

import android.content.res.AssetManager

/**
 * JNI entry points (android/runtime/src/main/cpp/jni_bridge.cpp).
 * Call the `external` functions only on the JS thread, except [takeBatch] (main thread).
 */
internal object ZnNative {
    init {
        System.loadLibrary("zn")
    }

    /** [flowDir], [storageDir]: existing app-private folders for FlowStore and app storage, excluded from backups. */
    @JvmStatic external fun createRuntime(flowDir: String, storageDir: String): Long

    @JvmStatic external fun destroyRuntime(runtime: Long)

    /** Returns "ok:<value>" or "error:<message>". */
    @JvmStatic external fun evalAsset(runtime: Long, assets: AssetManager, name: String): String

    /** Like [evalAsset], for a bytecode file (a downloaded OTA bundle, [ZnBundles]). The file is memory-mapped. */
    @JvmStatic external fun evalFile(runtime: Long, path: String, name: String): String

    /** Like [evalAsset], for bytecode in memory (debug builds: a new build from `zn dev`). */
    @JvmStatic external fun evalBytes(runtime: Long, bytes: ByteArray, name: String): String

    /** payloadKind: 0 null, 1 boolean (number != 0), 2 number, 3 string. */
    @JvmStatic external fun dispatchEvent(
        runtime: Long, instance: Int, eventId: Int, payloadKind: Int, number: Double, text: String?
    )

    /** A binary answer: JS gets one ArrayBuffer, [u32 LE head size][head][body] (jni_bridge.cpp). */
    @JvmStatic external fun dispatchBytes(runtime: Long, instance: Int, eventId: Int, head: ByteArray, body: ByteArray?)

    @JvmStatic external fun fireTimer(runtime: Long, handle: Int)

    /** Main thread. The pending batch (format in core/include/zn/batch.h), or null if nothing changed. */
    @JvmStatic external fun takeBatch(runtime: Long): ByteArray?

    // ---- App storage for Kotlin (ZnStorage.kt): any thread; strings as UTF-8 bytes, values as tagged bytes ----

    @JvmStatic external fun storageOpen(dir: String)
    @JvmStatic external fun storageSet(id: ByteArray, key: ByteArray, tagged: ByteArray): Boolean
    @JvmStatic external fun storageGet(id: ByteArray, key: ByteArray): ByteArray?
    @JvmStatic external fun storageHas(id: ByteArray, key: ByteArray): Boolean
    @JvmStatic external fun storageRemove(id: ByteArray, key: ByteArray)
    @JvmStatic external fun storageKeys(id: ByteArray): Array<ByteArray>
    @JvmStatic external fun storageClear(id: ByteArray)
    @JvmStatic external fun storageFlush(id: ByteArray)

    // ---- Called from C++ on the JS thread ------------------------------------------------------------------------

    @JvmStatic fun onScheduleTimer(handle: Int, delayMs: Double) = ZnRuntime.scheduleTimer(handle, delayMs)

    @JvmStatic fun onRequestApply() = ZnRuntime.requestApply()

    /** [bytes]: binary input from JS (an ArrayBuffer, e.g. a fetch body), or null when JS passed none. */
    @JvmStatic fun onCallNative(module: String, method: String, args: ByteArray, bytes: ByteArray?, callbackId: Int) =
        ZnModules.call(module, method, String(args, Charsets.UTF_8), bytes, callbackId)

    @JvmStatic fun onCancelNative(callbackId: Int) = ZnModules.cancel(callbackId)

    /** JS threw and nothing caught it. "where\nmessage and JS stack", as UTF-8. Already in logcat. */
    @JvmStatic fun onJsError(text: ByteArray) = ZnRuntime.jsError(String(text, Charsets.UTF_8))
}
