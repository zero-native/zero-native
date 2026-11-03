package dev.zeronative.runtime

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.ContextWrapper
import android.content.DialogInterface
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import org.json.JSONObject

/**
 * The built-in Alert module: React Native's `Alert.alert` (packages/core/src/alert.ts). The platform AlertDialog, so it
 * takes the app's theme, as in RN.
 *
 * Alerts wait in a queue and show one at a time. [Host] (once, in [ZnNavHost]) shows the first one in the Activity that
 * is alive now: when the Activity is made again (rotation), the dialog is closed without an answer and the new
 * Activity shows it again. A button or a cancel answers `{ index }` (-1: closed by back or a tap outside) and the next
 * alert shows. Main thread only.
 */
internal object ZnAlert : ZnModuleBase("Alert", version = 1) {
    /** Android has 3 button places: neutral, negative, positive. */
    const val MAX_BUTTONS = 3

    private class Pending(val title: String, val message: String?, val buttons: List<String>, val cancelable: Boolean, val call: ZnCall)

    private val main by lazy { Handler(Looper.getMainLooper()) } // lazy: the JVM tests have no Looper
    private val queue = ArrayDeque<Pending>()
    /** The alert to show now: the first in [queue]. Compose state, so [Host] draws again when it changes. */
    private var head by mutableStateOf<Pending?>(null)

    /**
     * Where each button goes, by its index in the list, as in React Native on Android: 1 button → positive;
     * 2 → negative, positive; 3 → neutral, negative, positive. Android draws them left to right in that order.
     */
    fun places(count: Int): List<Int> = when (count) {
        1 -> listOf(DialogInterface.BUTTON_POSITIVE)
        2 -> listOf(DialogInterface.BUTTON_NEGATIVE, DialogInterface.BUTTON_POSITIVE)
        3 -> listOf(DialogInterface.BUTTON_NEUTRAL, DialogInterface.BUTTON_NEGATIVE, DialogInterface.BUTTON_POSITIVE)
        else -> throw IllegalArgumentException("an alert has 1 to $MAX_BUTTONS buttons, not $count")
    }

    init {
        function("show", onMain = true) { call ->
            val title = call.stringOrNull("title") ?: ""
            val message = call.stringOrNull("message")
            val cancelable = call.booleanOrNull("cancelable") ?: false
            val list = call.args.optJSONArray("buttons")
            val buttons = (0 until (list?.length() ?: 0)).map { list!!.optString(it, "") }
            if (buttons.isEmpty() || buttons.size > MAX_BUTTONS) throw ZnInvalidArgs("\"buttons\" must have 1 to $MAX_BUTTONS texts")
            // A start with no screens (a push, a background task): nowhere to show it, as in RN.
            if (ZnActivity.current == null) return@function call.reject("no_activity", "no Activity to show the alert in")
            val pending = Pending(title, message, buttons, cancelable, call)
            // The JS runtime was replaced (dev reload, an update applied): its alerts go without an answer.
            call.onCancel { main.post { drop(pending) } }
            if (call.isCancelled) return@function
            queue.addLast(pending)
            if (head == null) head = pending
        }
    }

    /** Shows the first alert in the queue. Call it once, inside [ZnNavHost]. */
    @Composable
    fun Host() {
        val activity = LocalContext.current.findActivity() ?: return
        val shown = head ?: return
        DisposableEffect(activity, shown) {
            val dialog = if (activity.isFinishing || activity.isDestroyed) null else build(activity, shown)
            dialog?.show()
            // The Activity is going (or the alert was dropped): close it without an answer.
            onDispose { dialog?.dismiss() }
        }
    }

    private fun build(activity: Activity, p: Pending): AlertDialog {
        val builder = AlertDialog.Builder(activity).setTitle(p.title).setCancelable(p.cancelable)
        if (!p.message.isNullOrEmpty()) builder.setMessage(p.message)
        places(p.buttons.size).forEachIndexed { index, place ->
            val onClick = DialogInterface.OnClickListener { _, _ -> answer(p, index) }
            when (place) {
                DialogInterface.BUTTON_POSITIVE -> builder.setPositiveButton(p.buttons[index], onClick)
                DialogInterface.BUTTON_NEGATIVE -> builder.setNegativeButton(p.buttons[index], onClick)
                else -> builder.setNeutralButton(p.buttons[index], onClick)
            }
        }
        // Only back and a tap outside cancel: a dismiss() from Host (Activity gone) is not an answer.
        builder.setOnCancelListener { answer(p, -1) }
        return builder.create().apply { setCanceledOnTouchOutside(p.cancelable) }
    }

    private fun answer(p: Pending, index: Int) {
        if (head !== p) return // already answered or dropped
        drop(p)
        p.call.resolve(JSONObject().put("index", index))
    }

    private fun drop(p: Pending) {
        queue.remove(p)
        if (head === p) head = queue.firstOrNull()
    }

    private tailrec fun Context.findActivity(): Activity? = when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }
}
