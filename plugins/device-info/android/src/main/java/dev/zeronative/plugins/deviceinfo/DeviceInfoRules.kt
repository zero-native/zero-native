package dev.zeronative.plugins.deviceinfo

/** The decisions, apart from Android (DeviceInfoRulesTest). Each follows react-native-device-info's Android code. */
internal object DeviceInfoRules {
    /** The `Build` fields [isEmulator] looks at. */
    class BuildFields(
        val fingerprint: String,
        val model: String,
        val manufacturer: String,
        val hardware: String,
        val product: String,
        val board: String,
        val bootloader: String,
        val brand: String,
        val device: String,
    )

    /** react-native-device-info's `isEmulator` checks, the same list. */
    fun isEmulator(b: BuildFields): Boolean =
        b.fingerprint.startsWith("generic") ||
            b.fingerprint.startsWith("unknown") ||
            b.model.contains("google_sdk") ||
            b.model.lowercase().contains("droid4x") ||
            b.model.contains("Emulator") ||
            b.model.contains("Android SDK built for x86") ||
            b.manufacturer.contains("Genymotion") ||
            b.hardware.contains("goldfish") ||
            b.hardware.contains("ranchu") ||
            b.hardware.contains("vbox86") ||
            b.product.contains("sdk") ||
            b.product.contains("google_sdk") ||
            b.product.contains("sdk_google") ||
            b.product.contains("sdk_x86") ||
            b.product.contains("vbox86p") ||
            b.product.contains("emulator") ||
            b.product.contains("simulator") ||
            b.board.lowercase().contains("nox") ||
            b.bootloader.lowercase().contains("nox") ||
            b.hardware.lowercase().contains("nox") ||
            b.product.lowercase().contains("nox") ||
            (b.brand.startsWith("generic") && b.device.startsWith("generic"))

    /** "Tv", "Tablet" or "Handset" (react-native-device-info's `getDeviceType` names). */
    fun deviceType(isTv: Boolean, smallestWidthDp: Int): String = when {
        isTv -> "Tv"
        smallestWidthDp >= 600 -> "Tablet"
        else -> "Handset"
    }

    /** `BatteryManager.EXTRA_STATUS` → react-native-device-info's `batteryState`. */
    fun batteryState(status: Int): String = when (status) {
        2 -> "charging" // BATTERY_STATUS_CHARGING
        5 -> "full" // BATTERY_STATUS_FULL
        3, 4 -> "unplugged" // DISCHARGING, NOT_CHARGING
        else -> "unknown"
    }

    /** level / scale, or -1 when the phone gives none. */
    fun batteryLevel(level: Int, scale: Int): Double = if (level < 0 || scale <= 0) -1.0 else level.toDouble() / scale

    /** `getReadableVersion`: "1.2.3.168". */
    fun readableVersion(version: String, buildNumber: String): String = "$version.$buildNumber"
}
