package dev.zeronative.sample

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.util.Log
import dev.zeronative.runtime.ZnBackground
import org.json.JSONObject

/**
 * Debug builds only (step 4.9): a start without UI, like a push message's. Asking it anything starts the process
 * (SampleApp.onCreate runs) with no Activity on screen: OTA must not check, and the watchdog must not count it as a
 * launch. See the debug AndroidManifest.xml for why this is a provider and not a broadcast receiver. The path /task
 * also runs a background task, as a push would (the core phone check).
 */
class DebugWakeProvider : ContentProvider() {
    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        Log.i("zn-sample", "background start: no Activity (DebugWakeProvider)")
        if (uri.path == "/task") {
            ZnBackground.run("lab.echo", JSONObject().put("from", "no screen"), timeoutMs = 5_000) { outcome ->
                Log.i("zn-sample", "task with no screen: $outcome")
            }
        }
        return null
    }

    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
