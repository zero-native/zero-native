package dev.zeronative.runtime

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File

/**
 * Which process this is. Android runs `Application.onCreate` in **every** process of an app, including extra ones
 * some SDKs declare (`android:process=":something"`). The JS runtime and app storage belong to the main process only:
 * storage opens MMKV in single-process mode, and two processes writing the same file can damage it.
 */
internal object ZnProcess {
    @Volatile private var cached: String? = null

    fun name(): String = cached ?: run {
        val n = if (Build.VERSION.SDK_INT >= 28) {
            Application.getProcessName()
        } else {
            File("/proc/self/cmdline").readText().substringBefore('\u0000').trim()
        }
        n.also { cached = it }
    }

    /** True in the app's main process (the one named after the package). */
    fun isMain(context: Context) = name() == context.packageName
}
