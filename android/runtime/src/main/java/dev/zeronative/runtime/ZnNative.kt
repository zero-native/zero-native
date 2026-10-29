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

    @JvmStatic external fun createRuntime(): Long

    @JvmStatic external fun destroyRuntime(runtime: Long)

    /** Returns "ok:<value>" or "error:<message>". */
    @JvmStatic external fun evalAsset(runtime: Long, assets: AssetManager, name: String): String

    /** payloadKind: 0 null, 1 boolean (number != 0), 2 number, 3 string. */
    @JvmStatic external fun dispatchEvent(
        runtime: Long, instance: Int, eventId: Int, payloadKind: Int, number: Double, text: String?
    )

    @JvmStatic external fun fireTimer(runtime: Long, handle: Int)

    /** Main thread. The pending batch (format in core/include/zn/batch.h), or null if nothing changed. */
    @JvmStatic external fun takeBatch(runtime: Long): ByteArray?

    // ---- Called from C++ on the JS thread ------------------------------------------------------------------------

    @JvmStatic fun onScheduleTimer(handle: Int, delayMs: Double) = ZnRuntime.scheduleTimer(handle, delayMs)

    @JvmStatic fun onRequestApply() = ZnRuntime.requestApply()

    @JvmStatic fun onCallNative(module: String, method: String, args: ByteArray, callbackId: Int) =
        ZnModules.call(module, method, String(args, Charsets.UTF_8), callbackId)
}
