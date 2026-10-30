package dev.zeronative.runtime

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Native Toast module (ARCHITECTURE §15.1, milestone 3 step 3.7).
 * Called from JS: `toast(message, { duration })`.
 */
object ZnToast : ZnModuleBase("Toast", version = 1) {
    private var currentToast by mutableStateOf<ToastState?>(null)

    private data class ToastState(val id: Long, val message: String, val durationMs: Long)

    private var nextId = 1L
    /** The last toast shown: still drawn while it fades out, after [currentToast] is cleared. Main thread. */
    private var lastShown: ToastState? = null
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /**
     * Windows that can draw the toast, newest last: 0 is the screens' window ([ZnNavHost]); each open <Sheet> adds
     * its own (a sheet is a separate window on top, so a toast drawn under it can't be seen). Only the newest draws.
     */
    private val windows = mutableStateListOf(0)
    private var nextWindow = 1

    init {
        function("show", onMain = true) { call ->
            val message = call.args.optString("message", "")
            val duration = call.args.optString("duration", "short")
            val ms = if (duration == "long") 3500L else 2000L
            if (message.isNotEmpty()) {
                val toast = ToastState(nextId++, message, ms).also { lastShown = it }
                currentToast = toast
                // Timed here, not in a composable: the toast keeps its time when it moves to another window.
                main.postDelayed({ if (currentToast?.id == toast.id) currentToast = null }, ms)
            }
            call.resolve()
        }
    }

    /** A sheet's window opened ([ZnSheet]); returns its id for [Host] and [closeWindow]. Main thread. */
    internal fun openWindow(): Int = nextWindow++.also { windows += it }

    internal fun closeWindow(id: Int) {
        windows.remove(id)
    }

    /** Draws the toast in [window] when it is the newest window ([windows]). */
    @Composable
    fun Host(window: Int = 0) {
        if (windows.lastOrNull() != window) return
        val state = currentToast

        val insets = WindowInsets.navigationBars.union(WindowInsets.ime).asPaddingValues()

        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .padding(bottom = 16.dp, start = 24.dp, end = 24.dp),
            contentAlignment = Alignment.BottomCenter
        ) {
            AnimatedVisibility(
                visible = state != null,
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                val shown = state ?: lastShown
                if (shown != null) {
                    Box(
                        modifier = Modifier
                            .shadow(4.dp, RoundedCornerShape(20.dp))
                            .background(Color(0xE61F2937), RoundedCornerShape(20.dp))
                            .padding(horizontal = 16.dp, vertical = 10.dp)
                            .semantics { liveRegion = LiveRegionMode.Polite },
                        contentAlignment = Alignment.Center
                    ) {
                        BasicText(
                            text = shown.message,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            style = TextStyle(
                                color = Color.White,
                                fontSize = 14.sp,
                                textAlign = TextAlign.Center
                            )
                        )
                    }
                }
            }
        }
    }
}

