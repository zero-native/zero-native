package dev.zeronative.plugins.deviceinfo

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.location.LocationManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.telephony.TelephonyManager
import android.util.Log
import android.view.Display
import android.webkit.WebSettings
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.string
import java.net.Inet4Address
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

private const val TAG = "zn-device-info"
private const val UNKNOWN = "unknown"
/** How long a JS start waits for the constants at most. They take ~10 ms; this is only a guard against a stuck call. */
private const val CONSTANTS_WAIT_S = 3L

/** Add it with `ZnPlugins.register(this, DeviceInfoPlugin())`. */
class DeviceInfoPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(DeviceInfoModule(r.context.applicationContext))
    }
}

/**
 * react-native-device-info on Android. Values that don't change while the app runs are constants: JS reads them
 * synchronously (`getVersion()`, `getUniqueIdSync()`), also at module level. Values that change (battery, disk, network)
 * are calls.
 */
internal class DeviceInfoModule(private val app: Context) : ZnModuleBase("DeviceInfo", version = 1) {
    /**
     * Once per process: every value here is fixed until the app is updated or restarted. Read on its own thread from
     * the plugin's registration (Application.onCreate), in parallel with the JS runtime's creation: about 10 ms of
     * system calls on the Lava, which would otherwise come before the app's JS on every start.
     */
    private val fixed = FutureTask { readConstants() }.also { Thread(it, "zn-device-info").start() }

    override fun constants(): JSONObject? {
        val t0 = SystemClock.uptimeMillis()
        return try {
            fixed.get(CONSTANTS_WAIT_S, TimeUnit.SECONDS).also {
                Log.d(TAG, "constants: the JS start waited ${SystemClock.uptimeMillis() - t0} ms")
            }
        } catch (e: Exception) {
            // Never seen; the app still starts, and JS answers "unknown" for these values.
            Log.e(TAG, "constants not read in $CONSTANTS_WAIT_S s: $e")
            null
        }
    }

    init {
        dynamic("batteryLevel") { battery().let { DeviceInfoRules.batteryLevel(it.first, it.second) } }
        dynamic("powerState") {
            val (level, scale, status) = battery()
            JSONObject()
                .put("batteryLevel", DeviceInfoRules.batteryLevel(level, scale))
                .put("batteryState", DeviceInfoRules.batteryState(status))
                .put("lowPowerMode", (app.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode)
        }
        dynamic("isBatteryCharging") { battery().third == BatteryManager.BATTERY_STATUS_CHARGING }
        dynamic("freeDiskStorage") { StatFs(Environment.getDataDirectory().path).availableBytes.toDouble() }
        dynamic("totalDiskCapacity") { StatFs(Environment.getDataDirectory().path).totalBytes.toDouble() }
        dynamic("usedMemory") { Runtime.getRuntime().let { (it.totalMemory() - it.freeMemory()).toDouble() } }
        dynamic("isAirplaneMode") { Settings.Global.getInt(app.contentResolver, Settings.Global.AIRPLANE_MODE_ON, 0) != 0 }
        dynamic("isLocationEnabled") { locationEnabled() }
        dynamic("isHeadphonesConnected") { headphones() }
        dynamic("isPinOrFingerprintSet") { (app.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardSecure }
        dynamic("fontScale") { app.resources.configuration.fontScale.toDouble() }
        dynamic("isLandscape") { app.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE }
        dynamic("carrier") {
            (app.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager)?.networkOperatorName?.takeIf { it.isNotEmpty() } ?: UNKNOWN
        }
        dynamic("ipAddress") { ipAddress() }
        dynamic("isCameraPresent") { app.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
        dynamic("systemAvailableFeatures") {
            JSONArray().apply { app.packageManager.systemAvailableFeatures.forEach { f -> f.name?.let(::put) } }
        }
        dynamic("hasGms") { installedAndEnabled("com.google.android.gms") }
        dynamic("hasHms") { installedAndEnabled("com.huawei.hwid") }
        dynamic("userAgent") {
            try {
                WebSettings.getDefaultUserAgent(app)
            } catch (t: Throwable) {
                System.getProperty("http.agent") ?: UNKNOWN
            }
        }
        function("hasSystemFeature") { call ->
            val feature = call.string("feature")
            call.resolve(feature.isNotEmpty() && app.packageManager.hasSystemFeature(feature))
        }
    }

    /** A call with no arguments that answers [read]'s value. Any failure answers RN's "don't know" value instead. */
    private fun dynamic(name: String, read: () -> Any) {
        function(name) { call: ZnCall ->
            val value = try {
                read()
            } catch (t: Throwable) {
                Log.w(TAG, "$name failed: $t")
                null
            }
            call.resolve(value ?: JSONObject.NULL)
        }
    }

    @SuppressLint("HardwareIds") // ANDROID_ID is what react-native-device-info's getUniqueId gives on Android.
    private fun readConstants(): JSONObject {
        val t0 = SystemClock.uptimeMillis()
        val pm = app.packageManager
        val pkg = pm.getPackageInfo(app.packageName, 0)
        @Suppress("DEPRECATION")
        val build = if (Build.VERSION.SDK_INT >= 28) pkg.longVersionCode else pkg.versionCode.toLong()
        val version = pkg.versionName ?: UNKNOWN
        val androidId = safe { Settings.Secure.getString(app.contentResolver, Settings.Secure.ANDROID_ID) } ?: UNKNOWN
        val config = app.resources.configuration
        val isTv = safe {
            (app.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
        } == true
        val deviceType = DeviceInfoRules.deviceType(isTv, config.smallestScreenWidthDp)
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val fields = DeviceInfoRules.BuildFields(
            Build.FINGERPRINT, Build.MODEL, Build.MANUFACTURER, Build.HARDWARE, Build.PRODUCT, Build.BOARD,
            Build.BOOTLOADER, Build.BRAND, Build.DEVICE,
        )
        val json = JSONObject()
            .put("bundleId", app.packageName)
            .put("applicationName", safe { app.applicationInfo.loadLabel(pm).toString() } ?: UNKNOWN)
            .put("version", version)
            .put("buildNumber", build.toString())
            .put("readableVersion", DeviceInfoRules.readableVersion(version, build.toString()))
            .put("firstInstallTime", pkg.firstInstallTime.toDouble())
            .put("lastUpdateTime", pkg.lastUpdateTime.toDouble())
            .put("installerPackageName", safe { installer(pm) } ?: UNKNOWN)
            .put("uniqueId", androidId)
            .put("androidId", androidId)
            .put("deviceId", Build.BOARD)
            .put("model", Build.MODEL)
            .put("brand", Build.BRAND)
            .put("manufacturer", Build.MANUFACTURER)
            .put("systemName", "Android")
            .put("systemVersion", Build.VERSION.RELEASE)
            .put("apiLevel", Build.VERSION.SDK_INT)
            .put("baseOs", Build.VERSION.BASE_OS ?: "")
            .put("bootloader", Build.BOOTLOADER)
            .put("buildId", Build.ID)
            .put("codename", Build.VERSION.CODENAME)
            .put("device", Build.DEVICE)
            .put("display", Build.DISPLAY)
            .put("fingerprint", Build.FINGERPRINT)
            .put("hardware", Build.HARDWARE)
            .put("host", Build.HOST)
            .put("incremental", Build.VERSION.INCREMENTAL)
            .put("product", Build.PRODUCT)
            .put("tags", Build.TAGS)
            .put("type", Build.TYPE)
            .put("previewSdkInt", Build.VERSION.PREVIEW_SDK_INT)
            .put("securityPatch", Build.VERSION.SECURITY_PATCH ?: "")
            .put("deviceType", deviceType)
            .put("isTablet", deviceType == "Tablet")
            .put("hasNotch", safe { hasCutout() } == true)
            .put("isEmulator", DeviceInfoRules.isEmulator(fields))
            .put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS.toList()))
            .put("supported32BitAbis", JSONArray(Build.SUPPORTED_32_BIT_ABIS.toList()))
            .put("supported64BitAbis", JSONArray(Build.SUPPORTED_64_BIT_ABIS.toList()))
            .put("maxMemory", Runtime.getRuntime().maxMemory().toDouble())
            .put("totalMemory", memory.totalMem.toDouble())
            .put("isLowRamDevice", am.isLowRamDevice)
            .put("deviceName", safe { deviceName() } ?: UNKNOWN)
        Log.d(TAG, "constants read in ${SystemClock.uptimeMillis() - t0} ms")
        return json
    }

    private fun <T> safe(read: () -> T?): T? = try {
        read()
    } catch (t: Throwable) {
        Log.w(TAG, "a value couldn't be read: $t")
        null
    }

    private fun installer(pm: PackageManager): String? =
        if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(app.packageName).installingPackageName
        else @Suppress("DEPRECATION") pm.getInstallerPackageName(app.packageName)

    /** react-native-device-info's order: the Bluetooth name (Android 12 and older), then the phone's name in settings. */
    private fun deviceName(): String? {
        if (Build.VERSION.SDK_INT <= 31) Settings.Secure.getString(app.contentResolver, "bluetooth_name")?.let { return it }
        if (Build.VERSION.SDK_INT >= 25) Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME)?.let { return it }
        return null
    }

    /** The screen has a cut-out (a notch or a camera hole). Android 10+; older phones answer false. */
    private fun hasCutout(): Boolean {
        if (Build.VERSION.SDK_INT < 29) return false
        val display = (app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
        return display?.cutout != null
    }

    /** level, scale, status from the sticky battery broadcast (no receiver is kept). */
    private fun battery(): Triple<Int, Int, Int> {
        val i: Intent? = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return Triple(
            i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1,
            i?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1,
            i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1,
        )
    }

    private fun locationEnabled(): Boolean {
        val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled
        else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    @SuppressLint("InlinedApi") // TYPE_USB_HEADSET is a plain number: on Android 7 no device has it, so it never matches
    private fun headphones(): Boolean {
        val audio = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val kinds = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_USB_HEADSET,
        )
        return audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in kinds }
    }

    /** The active network's first IPv4 address, or "0.0.0.0" (react-native-device-info's "none"). */
    private fun ipAddress(): String {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val props = cm.getLinkProperties(cm.activeNetwork) ?: return "0.0.0.0"
        return props.linkAddresses.map { it.address }.firstOrNull { it is Inet4Address }?.hostAddress ?: "0.0.0.0"
    }

    private fun installedAndEnabled(pkg: String): Boolean = try {
        app.packageManager.getApplicationInfo(pkg, 0).enabled
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }
}
