package dev.zeronative.plugins.scanner

import android.content.Context
import android.content.pm.PackageManager
import dev.zeronative.runtime.ZnModuleBase

class ScannerModule(private val context: Context) : ZnModuleBase("Scanner", version = 1) {
    init {
        function("available") { call -> call.resolve(context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) }
    }
}
