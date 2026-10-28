package dev.zeronative.exp4

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log

data class UpiAppInfo(
    val packageName: String,
    val appName: String
)

object UpiAppManager {
    private const val TAG = "zn-upi"

    fun getInstalledUpiApps(context: Context): List<UpiAppInfo> {
        val uri = Uri.parse("upi://pay")
        val intent = Intent(Intent.ACTION_VIEW, uri)
        val pm = context.packageManager

        val activities = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        val apps = mutableListOf<UpiAppInfo>()

        for (resolveInfo in activities) {
            val pkg = resolveInfo.activityInfo.packageName
            val label = resolveInfo.loadLabel(pm).toString()
            apps.add(UpiAppInfo(pkg, label))
            Log.i(TAG, "[UPI_APP_DISCOVERY] Found installed UPI app: $label ($pkg)")
        }

        return apps
    }
}

