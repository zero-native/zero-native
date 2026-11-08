package dev.zeronative.runtime

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import org.json.JSONException
import org.json.JSONObject

/** A plugin's view inside a screen: a composable that follows the screen (docs/plugins.md §5). */
typealias ZnViewContent = @Composable (ZnViewScope) -> Unit

/**
 * What a view gets. A plugin adds a view with `r.view(name) { scope -> ... }`. For a covered or closed screen, use Compose's
 * own `LocalLifecycleOwner`: the view stops with the screen it is on.
 */
class ZnViewScope internal constructor(val id: String, props: State<JSONObject>, private val send: (String) -> Unit) {
    /** The `props` JS gave, as Compose state: reading it here redraws the view when they change. */
    val props: JSONObject by props

    /**
     * Prop [name] when JS gave a motion value (registry 24): a function to read each frame in a draw or layout block
     * (a video's position, a level meter), so the view isn't composed again. Null when it isn't a motion value.
     */
    fun motion(name: String): (() -> Float)? = ZnMotionApi.reader(props.opt(name))

    /** Sends JS `{ name, data }`: `<NativeView onEvent>` hears it. Any thread. [data]: a JSONObject, JSONArray, text, number or boolean. */
    fun emit(name: String, data: Any? = null) {
        send(JSONObject().put("name", name).put("data", data ?: JSONObject.NULL).toString())
    }
}

internal object ZnNativeViews {
    private val views = HashMap<String, ZnViewContent>()

    fun has(name: String) = name in views
    fun get(name: String): ZnViewContent? = views[name]
    fun add(name: String, content: ZnViewContent) {
        views[name] = content
    }
}

@Composable
internal fun ZnNativeView(s: ZnNodeSpec, inst: ZnInstance, n: Int, mod: Modifier) {
    val name = s.viewName.orEmpty()
    val content = ZnNativeViews.get(name)
    if (content == null) {
        // The build checks a view's plugin (D3), so this is a bundle on an app without it: the OTA check refuses those too.
        LaunchedEffect(name) { Log.e("zn", "no native view \"$name\": is its plugin registered?") }
        Box(mod)
        return
    }
    val raw = if (s.viewPropsSlot >= 0) inst.slot(s.viewPropsSlot).value as String? else s.viewProps
    val props = rememberUpdatedState(remember(raw) { viewProps(name, raw) })
    val scope = remember(inst.id, n) {
        ZnViewScope("${inst.id}.$n", props) { payload -> ZnRuntime.dispatchEvent(inst.id, s.onNativeEvent, payload) }
    }
    Box(mod, propagateMinConstraints = true) { content(scope) }
}

private fun viewProps(name: String, raw: String?): JSONObject = try {
    if (raw == null) JSONObject() else JSONObject(raw)
} catch (e: JSONException) { // props that aren't an object, as `props={list}`: the types refuse it, a cast doesn't
    Log.e("zn", "native view \"$name\": props must be an object", e)
    JSONObject()
}
