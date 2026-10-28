package dev.zeronative.exp4

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log

data class UpiAppInfo(
    val packageName: String,
    val appName: String,
    val iconUri: String
)

object UpiAppManager {
    private const val TAG = "zn-upi"

    private val KNOWN_UPI_PACKAGES = listOf(
        "p2pdops.android.p2pupiapp" to "P2P Mock UPI",
        "com.phonepe.app" to "PhonePe",
        "net.one97.paytm" to "Paytm",
        "com.dreamplug.androidapp" to "CRED",
        "com.google.android.apps.nbu.paisa.user" to "Google Pay",
        "in.org.npci.upiapp" to "BHIM",
        "com.canarabhim.upiapp.mobility" to "BHIM Canara",
        "com.myairtelapp" to "Airtel Thanks",
        "com.whatsapp" to "WhatsApp Pay"
    )

    fun getInstalledUpiApps(context: Context): List<UpiAppInfo> {
        val uri = Uri.parse("upi://pay")
        val intent = Intent(Intent.ACTION_VIEW, uri)
        val pm = context.packageManager
        val apps = mutableListOf<UpiAppInfo>()
        val seenPackages = HashSet<String>()

        val activities = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0)
        }

        Log.i(TAG, "[UPI_APP_DISCOVERY] Intent query returned ${activities.size} activities")

        for (resolveInfo in activities) {
            val pkg = resolveInfo.activityInfo?.packageName ?: continue
            if (!seenPackages.add(pkg)) continue

            val label = resolveInfo.loadLabel(pm)?.toString() ?: pkg
            val icon = resolveInfo.loadIcon(pm)
            val iconUri = "zn://app-icon/$pkg"

            ZnResourceRegistry.register(iconUri, icon)
            apps.add(UpiAppInfo(pkg, label, iconUri))
            Log.i(TAG, "[UPI_APP_DISCOVERY] Added via intent: $label ($pkg) -> $iconUri")
        }

        // Also check known UPI packages in case intent-filter flags in OEM ROMs hid them
        for ((pkg, defaultName) in KNOWN_UPI_PACKAGES) {
            if (seenPackages.contains(pkg)) continue
            try {
                val appInfo = pm.getApplicationInfo(pkg, 0)
                if (appInfo.enabled) {
                    val label = pm.getApplicationLabel(appInfo).toString().ifEmpty { defaultName }
                    val icon = pm.getApplicationIcon(appInfo)
                    val iconUri = "zn://app-icon/$pkg"

                    ZnResourceRegistry.register(iconUri, icon)
                    seenPackages.add(pkg)
                    apps.add(UpiAppInfo(pkg, label, iconUri))
                    Log.i(TAG, "[UPI_APP_DISCOVERY] Added via package info: $label ($pkg) -> $iconUri")
                }
            } catch (_: PackageManager.NameNotFoundException) {
                // Not installed on device, skip
            }
        }

        Log.i(TAG, "[UPI_APP_DISCOVERY] Total discovered UPI apps: ${apps.size}")
        return apps
    }

    fun getInstalledUpiAppsJson(context: Context): String {
        val apps = getInstalledUpiApps(context)
        val jsonArray = org.json.JSONArray()
        for (app in apps) {
            val obj = org.json.JSONObject().apply {
                put("packageName", app.packageName)
                put("appName", app.appName)
                put("iconUri", app.iconUri)
            }
            jsonArray.put(obj)
        }
        return jsonArray.toString()
    }
}

