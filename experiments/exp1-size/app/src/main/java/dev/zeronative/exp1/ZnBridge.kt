package dev.zeronative.exp1

object ZnBridge {
    init {
        if (BuildConfig.ZN_VARIANT != "D") {
            try {
                System.loadLibrary("jsi")
                System.loadLibrary("zn")
            } catch (e: Throwable) {
                android.util.Log.e("ZnBridge", "Failed to load native libraries", e)
            }
        }
    }

    external fun evalSmokeBytecode(bytecode: ByteArray): String
}
