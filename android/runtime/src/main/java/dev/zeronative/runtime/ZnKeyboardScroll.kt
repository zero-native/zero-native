package dev.zeronative.runtime

import android.os.Build
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.Velocity

/**
 * RN's `keyboardDismissMode` on <Scroll> and <List> (registry 24). Put it on the scrolling element's modifier before
 * its scroll, so it is the parent in the nested scroll chain and hears the drag first.
 *
 * - "on-drag": the first drag while the keyboard is open closes it and clears focus, as zn's `Keyboard.dismiss()` and
 *   RN do. A drag with no keyboard open changes nothing (it doesn't take focus from a button).
 * - "interactive" (vertical only, Android 11+): Compose's imeNestedScroll. The keyboard follows the finger: a drag
 *   down pushes it away first, then the content scrolls; at the end the content can't scroll past, a drag up pulls
 *   it back. The field keeps focus, so the keyboard can come back (with no focused field it can only go away, as on
 *   iOS). Older Android and horizontal scrolling work like "on-drag".
 *
 * Needs the window drawn edge to edge (the keyboard as an inset), which ZnNavHost already needs.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Modifier.znKeyboardDismiss(mode: String?, vertical: Boolean): Modifier {
    if (mode != "on-drag" && mode != "interactive") return this
    if (mode == "interactive" && vertical && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return this.imeNestedScroll()
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val ime = WindowInsets.ime
    val density = LocalDensity.current
    val onDrag = remember(keyboard, focus, ime, density) {
        object : NestedScrollConnection {
            /** Once per drag: the fling (always sent when the finger lifts, maybe with 0 speed) starts the next one. */
            var done = false

            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (!done && source == NestedScrollSource.UserInput && available != Offset.Zero) {
                    done = true
                    // Read outside composition: no recomposition when the keyboard moves.
                    if (ime.getBottom(density) > 0) {
                        focus.clearFocus(force = true)
                        keyboard?.hide()
                    }
                }
                return Offset.Zero
            }

            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
                done = false
                return Velocity.Zero
            }
        }
    }
    return this.nestedScroll(onDrag)
}
