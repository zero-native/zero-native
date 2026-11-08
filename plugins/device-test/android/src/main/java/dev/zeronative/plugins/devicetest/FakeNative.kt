package dev.zeronative.plugins.devicetest

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.lifecycle.LifecycleEventObserver
import dev.zeronative.runtime.ZnScreenScope
import dev.zeronative.runtime.ZnViewScope
import org.json.JSONObject

private const val TAG = "zn-sample"

/** A native screen and a native view for the core phone check (docs/ota-test-matrix.md). The real ones are in the other plugins. */
@Composable
internal fun FakeScreen(scope: ZnScreenScope) {
    Column(Modifier.fillMaxSize().background(Color.White).padding(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        BasicText("fake screen: ${scope.params.optString("title", "no title")}")
        BasicText("Finish", Modifier.clickable { scope.finish(JSONObject().put("code", "abc")) })
        BasicText("Finish twice", Modifier.clickable {
            scope.finish(JSONObject().put("code", "first"))
            scope.finish(JSONObject().put("code", "second"))
        })
        BasicText("Cancel", Modifier.clickable { scope.cancel() })
    }
}

@Composable
internal fun FakeView(scope: ZnViewScope) {
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> Log.i(TAG, "fake view: $event") }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            Log.i(TAG, "fake view: gone")
        }
    }
    val label = scope.props.optString("label", "none")
    // Registry 24 (lab 9): `level` may be a motion value; the bar reads it while drawing, so the view isn't composed again.
    val level = scope.motion("level")
    Box(Modifier.background(Color(0xFFDDEEFF)).clickable { scope.emit("tapped", JSONObject().put("label", label)) }.padding(12.dp)) {
        BasicText("view says $label")
        if (level != null) {
            Box(
                Modifier.padding(top = 24.dp).fillMaxWidth().height(6.dp).drawBehind {
                    val f = level().coerceIn(0f, 1f)
                    drawRect(Color(0xFF5B5BD6), size = size.copy(width = size.width * f))
                },
            )
        }
    }
}
