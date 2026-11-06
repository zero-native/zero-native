package dev.zeronative.runtime

import android.content.Context
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PageSize
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.clip
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import kotlin.math.roundToInt
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.semantics
import coil3.compose.AsyncImage

/**
 * Draws template instances with Compose (ARCHITECTURE.md §9). Anchor nodes draw the child instances mounted there
 * (components, `&&` branches, `.map` rows) as if they were direct children of the anchor's parent. Images load with
 * Coil (http(s) URLs and `asset:` paths); icons are SVG path data drawn natively.
 *
 * [templates] is the whole .zn.ui file: a child instance may use any template in it.
 */
@Composable
fun ZnScreen(templates: List<ZnTemplate>, instance: ZnInstance, modifier: Modifier = Modifier) {
    val t = templates.getOrNull(instance.templateId) ?: return
    ZnNode(templates, t, instance, 0, modifier, definiteWidth = true) // a screen fills its host
}

/** What to draw at one child position: a node of the same template, or the root of a mounted instance. */
private class ChildRef(val template: ZnTemplate, val instance: ZnInstance, val node: Int, val key: Any)

/**
 * The children of node [s] in order, with anchors expanded into the instances mounted there (observable). An
 * instance whose root is a Fragment (`<>...</>`, a component's children) adds its root's children instead of itself.
 */
@Composable
private fun childRefs(f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, s: ZnNodeSpec): List<ChildRef> {
    val out = ArrayList<ChildRef>(s.children.size)
    addChildRefs(out, f, t, inst, s.children)
    return out
}

private fun addChildRefs(out: ArrayList<ChildRef>, f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, children: IntArray) {
    for (c in children) {
        if (t.nodes[c].type == Registry.Component.ANCHOR) {
            for (id in inst.children(c)) {
                val ci = ZnStore.find(id) ?: continue
                val ct = f.getOrNull(ci.templateId) ?: continue
                if (ct.nodes[0].type == Registry.Component.FRAGMENT) addChildRefs(out, f, ct, ci, ct.nodes[0].children)
                else out += ChildRef(ct, ci, 0, "i$id")
            }
        } else {
            // Keyed by instance too: a fragment's nodes sit next to its parent's nodes.
            out += ChildRef(t, inst, c, inst.id.toLong() shl 32 or c.toLong())
        }
    }
}

/**
 * [definiteWidth]: this node's width is fixed by something other than its content (a width prop, or its parent
 * stretches it). zn flex rule 4: a Column only stretches its children when its own width is definite; otherwise it
 * wraps its content, as in React Native (a stretch must never push a shrink-wrapped parent wider).
 */
@Composable
private fun ZnNode(f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, n: Int, outer: Modifier, definiteWidth: Boolean) {
    val s = t.nodes[n]
    if (ZnDebug.countRecompositions) SideEffect { ZnDebug.hit("${ZnDebug.componentName(s.type)}#${inst.id}.$n") }
    // pointerEvents (registry 15, ZnTouch.kt): does this node take taps, and do its children?
    val touchOff = LocalTouchOff.current
    val pe = if (s.pointerEvents == POINTER_EVENTS_UNSET && s.pointerEventsSlot < 0) POINTER_EVENTS_UNSET else pointerEventsOf(s, inst)
    val selfTouch = !touchOff && pe != Registry.PointerEvents.NONE && pe != Registry.PointerEvents.BOX_NONE
    val chain = if (s.hasDynamicChain) dynamicChain(s, inst, root = n == 0, touchable = selfTouch) else s.staticChain
    // Written "auto" or "box-only": taps stop here, as on a React Native view. Not written: they go through, except
    // on an absolute layer (ZnNodeSpec.absoluteLayer), which stops them as RN does.
    val stops = pe == Registry.PointerEvents.AUTO || pe == Registry.PointerEvents.BOX_ONLY ||
        (pe == POINTER_EVENTS_UNSET && s.absoluteLayer)
    val blocked = if (selfTouch && stops) outer.znBlockTouches() else outer
    val mod = if (s.hasImpression) blocked.then(impression(s, inst)).then(chain) else blocked.then(chain)
    val kidsOff = touchOff || pe == Registry.PointerEvents.NONE || pe == Registry.PointerEvents.BOX_ONLY
    val slop = s.hitSlop
    if (slop != null && selfTouch && s.type == Registry.Component.PRESSABLE) {
        WithHitSlop(slop, s.margin) { measure ->
            ZnNodeChildren(f, t, inst, n, s, measure.then(mod), definiteWidth, touchOff, kidsOff)
        }
    } else {
        ZnNodeChildren(f, t, inst, n, s, mod, definiteWidth, touchOff, kidsOff)
    }
}

/** [ZnNodeContent], with [LocalTouchOff] set for the children when pointerEvents changes it. */
@Composable
private fun ZnNodeChildren(
    f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, n: Int, s: ZnNodeSpec, mod: Modifier, definiteWidth: Boolean,
    touchOff: Boolean, kidsOff: Boolean,
) {
    if (kidsOff != touchOff) {
        CompositionLocalProvider(LocalTouchOff provides kidsOff) { ZnNodeContent(f, t, inst, n, s, mod, definiteWidth) }
    } else {
        ZnNodeContent(f, t, inst, n, s, mod, definiteWidth)
    }
}

/** What node [n] draws, with its modifier chain [mod] already built ([ZnNode]). */
@Composable
private fun ZnNodeContent(f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, n: Int, s: ZnNodeSpec, mod: Modifier, definiteWidth: Boolean) {
    when (s.type) {
        // A Fragment inside a parent is expanded by the parent (childRefs); alone (a screen, a list row) it is a Column.
        Registry.Component.COLUMN, Registry.Component.BOX, Registry.Component.PRESSABLE, Registry.Component.FRAGMENT ->
            ZnColumn(f, t, inst, s, mod, definiteWidth)
        Registry.Component.TEXT_FIELD -> ZnTextField(s, inst, n, mod)
        Registry.Component.OTP_INPUT -> ZnOtpInput(s, inst, n, mod)
        Registry.Component.NATIVE_VIEW -> ZnNativeView(s, inst, n, mod)
        Registry.Component.SHEET -> ZnSheet(f, t, s, inst) // drawn in its own window, takes no space here
        Registry.Component.MODAL -> ZnModal(f, t, s, inst) // the same
        Registry.Component.STATUS_BAR -> ZnBarElement(s, inst, navigation = false) // takes no space
        Registry.Component.NAVIGATION_BAR -> ZnBarElement(s, inst, navigation = true)
        Registry.Component.ROW -> Row(
            modifier = mod,
            horizontalArrangement = horizontalArrangement(s),
            verticalAlignment = verticalAlignment(s.alignItems),
        ) {
            // zn flex rule 4: a Row stretches children only when it has a fixed height.
            val stretch = s.alignItems == Registry.AlignItems.STRETCH && s.height is Double
            for (ref in childRefs(f, t, inst, s)) key(ref.key) {
                val child = ref.template.nodes[ref.node]
                var m: Modifier = Modifier
                if (child.flex > 0f) m = m.weight(child.flex)
                if (stretch && child.height == null) m = m.fillMaxHeight()
                if (child.alignSelf != -1) m = m.align(verticalAlignment(child.alignSelf))
                child.zIndex?.let { m = m.zIndex(it) } // RN zIndex on any child (registry 16)
                // In a Row, a child's width is definite when it is set or shared out by flex.
                ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = child.width != null || child.flex > 0f)
            }
        }
        Registry.Component.STACK -> Box(modifier = mod, contentAlignment = stackAlignment(s)) {
            // A normal (not absolute) child stretches to the Stack's width like a Column's (zn flex rule 4, RN's
            // default alignItems: 'stretch'), so a styled row inside a Stack is full width (2026-11-05).
            val stretch = definiteWidth && (s.alignItems == -1 || s.alignItems == Registry.AlignItems.STRETCH)
            for (ref in childRefs(f, t, inst, s)) key(ref.key) {
                val child = ref.template.nodes[ref.node]
                var m: Modifier = Modifier
                var stretched = false
                if (!child.absolute) {
                    stretched = stretch && child.width == null && child.type != Registry.Component.SPACER &&
                        (child.alignSelf == -1 || child.alignSelf == Registry.AlignSelf.STRETCH)
                    if (stretched) m = m.fillMaxWidth()
                }
                if (child.absolute) {
                    // position: 'absolute' with top/bottom/start/end, relative to the Stack's content box. Both sides
                    // of a pair (start + end, top + bottom) stretch it between them, as in RN (registry 15).
                    val fillW = child.start != null && child.end != null
                    val fillH = child.top != null && child.bottom != null
                    if (fillW && fillH) {
                        // The Stack's own size, after its other children (StyleSheet.absoluteFill).
                        m = m.matchParentSize().absoluteInsets(child.start, child.top, child.end, child.bottom)
                    } else {
                        // R29 (2026-11-05): it takes no room, as in RN. In matchParentSize the Box sizes itself
                        // from its normal children only, then measures this child at that size (absoluteChild).
                        // Before, the Box grew to fit it (a 220 dp header shape made a 90 dp Stack 220 tall).
                        m = m.matchParentSize().absoluteChild(child, stackBias(s))
                    }
                }
                child.zIndex?.let { m = m.zIndex(it) }
                ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null)
            }
        }
        Registry.Component.ANCHOR -> Unit // expanded by the parent (childRefs)
        Registry.Component.LIST -> ZnLazyList(f, s, inst, n, mod)
        Registry.Component.CAROUSEL -> ZnCarousel(f, t, s, inst, mod)
        Registry.Component.TABS -> ZnTabs(f, t, s, inst, mod)
        Registry.Component.SCROLL -> if (s.horizontal) {
            // A rail: only the visible children are composed; scrolling it never involves JS.
            val refs = childRefs(f, t, inst, s)
            LazyRow(
                modifier = mod,
                contentPadding = contentPaddingOf(s, inst),
                horizontalArrangement = if (s.gap > 0f) Arrangement.spacedBy(s.gap.dp) else Arrangement.Start,
                verticalAlignment = verticalAlignment(s.alignItems),
            ) {
                items(count = refs.size, key = { refs[it].key }) { i ->
                    val ref = refs[i]
                    val child = ref.template.nodes[ref.node]
                    ZnNode(f, ref.template, ref.instance, ref.node, Modifier, definiteWidth = child.width != null)
                }
            }
        } else {
            Column(
                modifier = mod.then(znPullRefresh(s, inst)).verticalScroll(rememberScrollState())
                    .padding(contentPaddingOf(s, inst)),
                verticalArrangement = verticalArrangement(s),
                horizontalAlignment = horizontalAlignment(s.alignItems),
            ) {
                // Stretches children like a Column (zn flex rule 4, as RN's ScrollView). No flex: the height is open.
                val stretch = definiteWidth && (s.alignItems == -1 || s.alignItems == Registry.AlignItems.STRETCH)
                for (ref in childRefs(f, t, inst, s)) key(ref.key) {
                    val child = ref.template.nodes[ref.node]
                    val stretched = stretch && child.width == null && child.type != Registry.Component.SPACER &&
                        (child.alignSelf == -1 || child.alignSelf == Registry.AlignSelf.STRETCH)
                    var m: Modifier = if (stretched) Modifier.fillMaxWidth() else Modifier
                    if (child.alignSelf != -1) m = m.align(horizontalAlignment(child.alignSelf))
                    child.zIndex?.let { m = m.zIndex(it) } // RN zIndex on any child (registry 16)
                    ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null)
                }
            }
        }
        Registry.Component.TEXT -> {
            val raw = if (s.textSlot >= 0) display(inst.slot(s.textSlot).value) else s.text.orEmpty()
            val text = if (s.textTransform > 0) remember(raw) { transformText(raw, s.textTransform) } else raw
            // Read in the draw phase: a colour change redraws, nothing more.
            val color: () -> Color = if (s.colorSlot >= 0) ({ toColor(inst.slot(s.colorSlot).value) ?: Color.Black })
            else ({ s.color ?: Color.Black })
            val fontScale = androidx.compose.ui.platform.LocalDensity.current.fontScale
            val textStyle = s.effectiveTextStyle(fontScale)
            // Registry 16: spans that change at runtime come as JSON in a slot (core text-spans.ts); else the template's.
            val spansJson = if (s.spansSlot >= 0) inst.slot(s.spansSlot).value as? String else null
            val spans = if (s.spansSlot >= 0) remember(spansJson) { spansJson?.let(::parseSpans) } else s.spans
            val presses = if (s.spansSlot >= 0 && s.onSpanPress != 0) remember(spansJson) { spansJson?.let(::parseSpanPresses) } else null
            // textDecorationStyle dashed / dotted (registry 16): drawn here from the laid-out lines.
            val layout = if (s.dashedDecoration != 0) remember { mutableStateOf<TextLayoutResult?>(null) } else null
            val textMod = if (layout == null) mod else mod.drawWithContent {
                drawContent()
                layout.value?.let { drawTextDecoration(it, s.dashedDecoration, s.textDecorationStyle, textStyle, color()) }
            }
            val onLayout: (TextLayoutResult) -> Unit = { r -> layout?.value = r }
            if (spans == null) {
                BasicText(text = text, modifier = textMod, style = textStyle, maxLines = s.maxLines,
                    overflow = TextOverflow.Ellipsis, color = color, onTextLayout = onLayout)
            } else {
                val cap = s.fontScaleCap(fontScale)
                val press: ((Int) -> Unit)? = if (presses == null) null else { i -> ZnRuntime.dispatchEvent(inst.id, s.onSpanPress, i) }
                val styled = remember(text, spans, cap, presses) { spannedText(text, spans, cap, presses, press) }
                BasicText(text = styled, modifier = textMod, style = textStyle, maxLines = s.maxLines,
                    overflow = TextOverflow.Ellipsis, color = color, onTextLayout = onLayout)
            }
        }
        Registry.Component.SPACER -> Spacer(modifier = mod)
        Registry.Component.IMAGE -> {
            val src = if (s.srcSlot >= 0) inst.slot(s.srcSlot).value as? String else s.src
            val fallback = s.fallbackSrc
            // Per src, one way only: src → fallback (if any) → give up (empty box). Never back to src: a loaded
            // fallback must not retry the broken src, or the two swap forever (one request per frame, seen on
            // the Lava). A new src starts again (a reused list row, rule 24).
            var stage by remember(src) {
                mutableStateOf(if (src != null) IMAGE_SRC else if (fallback != null) IMAGE_FALLBACK else IMAGE_NONE)
            }
            var isLoading by remember(src) { mutableStateOf(stage != IMAGE_NONE) }
            val context = LocalContext.current
            val activeModel = when (stage) {
                IMAGE_SRC -> imageModel(src, context)
                IMAGE_FALLBACK -> imageModel(fallback, context)
                else -> null
            }

            val imageModifier = if (s.loading == Registry.Loading.SHIMMER && isLoading) {
                mod.shimmerEffect()
            } else {
                mod
            }

            val tint = if (s.tintColorSlot >= 0) toColor(inst.slot(s.tintColorSlot).value) else s.tintColor
            AsyncImage(
                model = activeModel,
                // The label (and the image role) come from the node's accessibility step in the chain, so TalkBack
                // reads it once; without a label the image is decorative and skipped.
                contentDescription = null,
                modifier = imageModifier,
                onLoading = { isLoading = true },
                onSuccess = {
                    isLoading = false
                    // RN onLoad / onLoadEnd (registry 15): for src only, as RN's defaultSource sends none.
                    if (stage == IMAGE_SRC && (s.onLoad != 0 || s.onLoadEnd != 0)) {
                        val img = it.result.image
                        val source = org.json.JSONObject().put("width", img.width).put("height", img.height).put("uri", src)
                        if (s.onLoad != 0) ZnRuntime.dispatchEvent(inst.id, s.onLoad, org.json.JSONObject().put("source", source).toString())
                        if (s.onLoadEnd != 0) ZnRuntime.dispatchEvent(inst.id, s.onLoadEnd)
                    }
                },
                onError = {
                    if (stage == IMAGE_NONE) return@AsyncImage // no model: nothing was requested
                    val which = if (stage == IMAGE_SRC) src else "fallback $fallback"
                    android.util.Log.w("zn", "image failed: $which — ${it.result.throwable}")
                    if (stage == IMAGE_SRC) {
                        val error = it.result.throwable.message ?: it.result.throwable.javaClass.simpleName
                        if (s.onError != 0) ZnRuntime.dispatchEvent(inst.id, s.onError, org.json.JSONObject().put("error", error).toString())
                        if (s.onLoadEnd != 0) ZnRuntime.dispatchEvent(inst.id, s.onLoadEnd)
                    }
                    if (stage == IMAGE_SRC && fallback != null) {
                        stage = IMAGE_FALLBACK // stays loading: the fallback is requested next
                    } else {
                        stage = IMAGE_NONE
                        isLoading = false
                    }
                },
                contentScale = when (s.contentScale) {
                    Registry.ContentScale.CONTAIN -> ContentScale.Fit
                    Registry.ContentScale.FILL -> ContentScale.FillBounds
                    else -> ContentScale.Crop
                },
                // RN tintColor: the picture's shape in one colour (SrcIn keeps its transparency).
                colorFilter = tint?.let { androidx.compose.ui.graphics.ColorFilter.tint(it, androidx.compose.ui.graphics.BlendMode.SrcIn) },
            )
        }
        Registry.Component.SWITCH -> ZnSwitch(s, inst, mod)
        Registry.Component.CHECKBOX -> ZnCheckbox(s, inst, mod)
        Registry.Component.SPINNER -> ZnSpinner(s, inst, mod)
        Registry.Component.PROGRESS -> ZnProgress(s, inst, mod)
        Registry.Component.SHIMMER -> ZnShimmer(s, inst, mod)
        Registry.Component.ICON -> {
            val icon = s.icon
            val tint: () -> Color = if (s.colorSlot >= 0) ({ toColor(inst.slot(s.colorSlot).value) ?: Color.Black })
            else ({ s.color ?: Color.Black })
            val sized = if (s.width == null && s.height == null) mod.size(24.dp) else mod
            Spacer(
                sized.drawBehind {
                    if (icon != null) {
                        withTransform({
                            scale(size.width / icon.width, size.height / icon.height, pivot = Offset.Zero)
                            translate(-icon.minX, -icon.minY)
                        }) { drawPath(icon.path, tint()) }
                    }
                },
            )
        }
        Registry.Component.SVG -> ZnSvg(t, s, inst, mod)
        Registry.Component.SVG_PART -> Unit // read by its <Svg> (ZnSvg.kt), never drawn on its own
        else -> Box(modifier = mod)
    }
}

/** A Column-like node's children, with the zn flex rules (also the body of a <Sheet>). */
@Composable
internal fun ZnColumn(f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, s: ZnNodeSpec, mod: Modifier, definiteWidth: Boolean) {
    Column(
        modifier = mod,
        verticalArrangement = verticalArrangement(s),
        horizontalAlignment = horizontalAlignment(s.alignItems),
    ) {
        val stretch = definiteWidth && (s.alignItems == -1 || s.alignItems == Registry.AlignItems.STRETCH)
        for (ref in childRefs(f, t, inst, s)) key(ref.key) {
            val child = ref.template.nodes[ref.node]
            var m: Modifier = Modifier
            if (child.flex > 0f) m = m.weight(child.flex)
            // zn flex rule 4: Column stretches children without a width (docs/styling-and-layout.md §5).
            val stretched = stretch && child.width == null && child.type != Registry.Component.SPACER &&
                (child.alignSelf == -1 || child.alignSelf == Registry.AlignSelf.STRETCH)
            if (stretched) m = m.fillMaxWidth()
            if (child.alignSelf != -1) m = m.align(horizontalAlignment(child.alignSelf))
            // RN zIndex on any child (registry 16, R23): draws it over its later siblings (a row holding a tooltip).
            child.zIndex?.let { m = m.zIndex(it) }
            ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null)
        }
    }
}

/** A node's modifier chain (built once, or per instance when it reads slots). */
@Composable
internal fun nodeChain(s: ZnNodeSpec, inst: ZnInstance): Modifier =
    if (s.hasDynamicChain) dynamicChain(s, inst, root = false, touchable = !LocalTouchOff.current) else s.staticChain

/**
 * RN testID (registry 15): UI tests (uiautomator, Espresso) see test tags as resource ids. Set on the root of each
 * window that draws templates (the screens, a Sheet, a Modal).
 */
internal fun Modifier.znTestTags(): Modifier = semantics { testTagsAsResourceId = true }

/**
 * RN onLayout (registry 15): sends { layout: { x, y, width, height } } in dp when the box inside the margin gets a new
 * size or a new place in its parent. Compose calls this on every move on screen (a scroll); only a real change in
 * the four numbers builds and sends an event, so a scroll costs a compare.
 */
private fun znOnLayout(instId: Int, eventId: Int, density: Float): Modifier {
    val last = FloatArray(4) { Float.NaN }
    return Modifier.onGloballyPositioned { c ->
        val p = c.positionInParent()
        val now = floatArrayOf(p.x, p.y, c.size.width.toFloat(), c.size.height.toFloat())
        if (now.contentEquals(last)) return@onGloballyPositioned
        now.copyInto(last)
        fun dp(px: Float) = Math.round(px / density * 100f) / 100.0
        val layout = org.json.JSONObject().put("x", dp(now[0])).put("y", dp(now[1]))
            .put("width", dp(now[2])).put("height", dp(now[3]))
        ZnRuntime.dispatchEvent(instId, eventId, org.json.JSONObject().put("layout", layout).toString())
    }
}

/** The screen entry a node belongs to (provided per screen by ZnNavHost), for impressions. 0 = none. */
internal val LocalZnEntry = staticCompositionLocalOf { 0 }

/** Has the screen's enter transition ended (provided per screen by ZnNavHost)? Outside a screen: always true. */
internal val LocalZnScreenSettled = staticCompositionLocalOf<androidx.compose.runtime.State<Boolean>> { mutableStateOf(true) }

/**
 * A node with an `impressionKey`: reports how much of it is visible (from its layout position, clipped by the lists
 * and rails around it) whenever it moves, and 0 when it leaves the screen. Only on screens that track impressions.
 */
@Composable
private fun impression(s: ZnNodeSpec, inst: ZnInstance): Modifier {
    val entry = LocalZnEntry.current
    val key = (if (s.impressionKeySlot >= 0) inst.slot(s.impressionKeySlot).value else s.impressionKey)?.toString()
    if (entry == 0 || key.isNullOrEmpty() || !ZnImpressions.tracking(entry)) return Modifier
    DisposableEffect(entry, key) { onDispose { ZnImpressions.report(entry, key, 0f) } }
    return Modifier.onGloballyPositioned { c ->
        if (ZnImpressions.done(entry, key)) return@onGloballyPositioned // counted: no more work while scrolling
        val area = c.size.width.toFloat() * c.size.height.toFloat()
        val b = c.boundsInWindow()
        ZnImpressions.report(entry, key, if (area > 0f) (b.width * b.height / area).coerceIn(0f, 1f) else 0f)
    }
}

/**
 * <Tabs> (useTabs, docs/guide-notes.md §40): draws only the child at `selected`, filling the container. A child it
 * stops drawing leaves composition, so data arriving for a hidden tab costs no frames; its instances stay (JS keeps its
 * state), and its Compose saved state (scroll positions) is kept by a SaveableStateHolder until it is shown again. Like
 * React Navigation's `freezeOnBlur`. A NativeView in a hidden tab is made again when the tab comes back.
 */
@Composable
private fun ZnTabs(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    val refs = childRefs(f, t, inst, s)
    val selected = if (s.selectedSlot >= 0) (inst.slot(s.selectedSlot).value as? Number)?.toInt() ?: 0 else s.selected
    val holder = rememberSaveableStateHolder()
    Box(mod) {
        val ref = refs.getOrNull(selected) ?: return@Box
        // The key is the child's own key (a String or Long): what a saved state needs.
        key(ref.key) {
            holder.SaveableStateProvider(ref.key) {
                ZnNode(f, ref.template, ref.instance, ref.node, Modifier.fillMaxSize(), definiteWidth = true)
            }
        }
    }
}

/**
 * A <Carousel> (feeds proposal, step 2.4c): a native pager. Pages are its children (anchors expanded, usually a
 * `.map`). Paging, snapping, auto-advance and dots are all native: no JS timer, no re-render per page. Auto-advance
 * runs only while the carousel is composed (on screen, its screen on top) and the app is resumed, and waits
 * `pauseAfterTouch` after the user touched it. `onPageChange` reaches JS only if it is bound.
 */
@Composable
private fun ZnCarousel(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    val refs = childRefs(f, t, inst, s)
    val pager = rememberPagerState { refs.size }
    // `fill`: the pager takes the height left after the dots, and each page gets all of it. False: as tall as the
    // tallest page, the dots 10 dp under it (the layout of a carousel with no height, unchanged since 2.4c).
    val body: @Composable (Modifier, Boolean) -> Unit = { colMod, fill -> Column(colMod) {
        HorizontalPager(
            state = pager,
            modifier = if (fill) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth(),
            contentPadding = contentPaddingOf(s, inst),
            pageSize = s.itemWidth?.let { PageSize.Fixed(it.dp) } ?: PageSize.Fill,
            pageSpacing = s.gap.dp,
            verticalAlignment = Alignment.Top,
            key = { refs.getOrNull(it)?.key ?: it },
        ) { page ->
            val ref = refs.getOrNull(page) ?: return@HorizontalPager
            ZnNode(f, ref.template, ref.instance, ref.node, if (fill) Modifier.fillMaxHeight() else Modifier, definiteWidth = true)
        }
        if (s.dots && refs.size > 1) {
            Row(
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                repeat(refs.size) { i ->
                    val active = pager.currentPage == i
                    Box(
                        Modifier.height(6.dp).width(if (active) 20.dp else 6.dp)
                            .clip(RoundedCornerShape(3.dp)).background(if (active) s.activeDotColor else s.dotColor),
                    )
                }
            }
        }
    } }
    if (s.height == null && s.flex <= 0f) {
        body(mod, false)
    } else {
        // A carousel with a height (set, or flex) shares it out as RN's flex-1 list does: pages get the full height, so
        // a page's flex and justifyContent work, and the dots sit at the bottom (prototype ask R35). With no bounded
        // height to share (flex inside a scroll) it lays out as one with no height.
        BoxWithConstraints(mod) {
            val fill = constraints.hasBoundedHeight
            body(if (fill) Modifier.fillMaxSize() else Modifier.fillMaxWidth(), fill)
        }
    }
    if (s.autoAdvanceMs > 0 && refs.size > 1) {
        val dragged by pager.interactionSource.collectIsDraggedAsState()
        var lastTouch by remember { mutableLongStateOf(0L) }
        LaunchedEffect(dragged) { lastTouch = SystemClock.uptimeMillis() } // on touch down and on release
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(pager, s.autoAdvanceMs) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (true) {
                    delay(s.autoAdvanceMs)
                    if (pager.isScrollInProgress || SystemClock.uptimeMillis() - lastTouch < s.pauseAfterTouchMs) continue
                    if (pager.pageCount > 1) pager.animateScrollToPage((pager.currentPage + 1) % pager.pageCount)
                }
            }
        }
    }
    if (s.onPageChange != 0) {
        LaunchedEffect(pager, inst.id) {
            snapshotFlow { pager.settledPage }.drop(1).collect { ZnRuntime.dispatchEvent(inst.id, s.onPageChange, it) }
        }
    }
}

/** How close to the end (in rows) a <List> sends onEndReached. */
private const val END_REACHED_ROWS = 5

/**
 * A <List> (docs/lists.md): a LazyColumn over the row keys JS sent. A row draws its mounted instance, or a placeholder
 * of its type while JS hasn't mounted it (the UI thread never waits for JS). Rows of the same type share Compose's
 * reuse pool (`contentType`). The visible range goes to JS (onRange) so it mounts rows ahead of the scroll.
 */
@Composable
private fun ZnLazyList(f: List<ZnTemplate>, s: ZnNodeSpec, inst: ZnInstance, node: Int, mod: Modifier) {
    val list = inst.list(node)
    val rows = list.rows
    val state = rememberLazyListState() // saveable: the scroll position survives back navigation and recreation
    // RN stickyHeaderIndices (registry 15): rows drawn pinned (Compose stickyHeader), in order, inside the list.
    val stickyText = if (s.stickySlot >= 0) inst.slot(s.stickySlot).value as? String else s.stickyHeaderIndices
    val sticky = remember(stickyText) { parseSticky(stickyText) }
    val rowAt: @Composable (Int) -> Unit = { i ->
        val row = rows.getOrNull(i)
        if (row != null) {
            val mounted = list.bound[row.key]?.let(ZnStore::find)
            val t = f.getOrNull(mounted?.templateId ?: row.type)
            if (t != null) ZnNode(f, t, mounted ?: ZnStore.placeholder(row.type, t), 0, Modifier.fillMaxWidth(), definiteWidth = true)
        }
    }
    if (s.inverted) FollowNewestRow(state, rows.firstOrNull()?.key)
    LazyColumn(
        modifier = mod.then(znPullRefresh(s, inst)), // pull to refresh, when it has onRefresh / refreshing
        state = state,
        // Its padding scrolls with the rows (RN's contentContainerStyle), so the last row can scroll above a floating
        // button. The fixed space around the list is margin.
        contentPadding = contentPaddingOf(s, inst),
        // RN inverted (registry 19): row 0 at the bottom, growing upwards; a short list sits at the bottom.
        reverseLayout = s.inverted,
        verticalArrangement = when {
            s.gap > 0f -> Arrangement.spacedBy(s.gap.dp, if (s.inverted) Alignment.Bottom else Alignment.Top)
            s.inverted -> Arrangement.Bottom
            else -> Arrangement.Top
        },
    ) {
        // Runs of plain rows between the pinned ones: one `items` per run, so a long list stays a few blocks.
        var start = 0
        for (h in sticky) {
            if (h >= rows.size) break
            val from = start
            if (h > from) items(count = h - from, key = { rows[from + it].key }, contentType = { rows[from + it].type }) { rowAt(from + it) }
            stickyHeader(key = rows[h].key, contentType = rows[h].type) { rowAt(h) }
            start = h + 1
        }
        val from = start
        if (rows.size > from) {
            items(count = rows.size - from, key = { rows[from + it].key }, contentType = { rows[from + it].type }) { rowAt(from + it) }
        }
    }
    if (s.onRange != 0 || s.onEndReached != 0) {
        LaunchedEffect(state, inst.id, node) {
            var endSentAt = -1
            snapshotFlow {
                // A pinned row shows above rows far below it: leave it out, or JS would mount every row in between.
                val pinned = parseSticky(if (s.stickySlot >= 0) inst.slot(s.stickySlot).value as? String else s.stickyHeaderIndices)
                val visible = state.layoutInfo.visibleItemsInfo.filter { it.index !in pinned }.ifEmpty { state.layoutInfo.visibleItemsInfo }
                (visible.minOfOrNull { it.index } ?: 0) to (visible.maxOfOrNull { it.index } ?: 0)
            }.distinctUntilChanged().collect { (a, b) ->
                if (s.onRange != 0) ZnRuntime.dispatchEvent(inst.id, s.onRange, "$a,$b")
                val count = rows.size
                if (s.onEndReached != 0 && count > 0 && b >= count - END_REACHED_ROWS && endSentAt != count) {
                    endSentAt = count
                    ZnRuntime.dispatchEvent(inst.id, s.onEndReached)
                }
            }
        }
    }
}

/**
 * <List inverted>: a new row 0 (a new chat message) stays in view when the user was at the newest row. Compose keeps
 * the old first row where it was (by key), which would leave the new one hidden below it. Read before the new rows
 * are laid out: "were we at the newest row" is the old layout's answer. Scrolled up to read: nothing moves.
 */
@Composable
private fun FollowNewestRow(state: LazyListState, firstKey: String?) {
    val slop = with(LocalDensity.current) { FOLLOW_SLOP.roundToPx() }
    val atNewest by remember(state) { derivedStateOf { state.firstVisibleItemIndex == 0 && state.firstVisibleItemScrollOffset <= slop } }
    val follow = remember(firstKey) { atNewest }
    LaunchedEffect(firstKey) { if (follow && firstKey != null) state.scrollToItem(0) }
}

/** How far from the newest row (scrolled up) still counts as "at the newest row" for [FollowNewestRow]. */
private val FOLLOW_SLOP = 24.dp

/** "1,30" → the sorted, distinct row indices (bad entries dropped). */
internal fun parseSticky(text: String?): IntArray =
    text?.split(',')?.mapNotNull { it.trim().toIntOrNull()?.takeIf { i -> i >= 0 } }?.distinct()?.sorted()?.toIntArray() ?: IntArray(0)

// Which image an <Image> shows (its `stage`): its src, its fallbackSrc, or nothing (an empty box).
private const val IMAGE_SRC = 0
private const val IMAGE_FALLBACK = 1
private const val IMAGE_NONE = 2

/**
 * `asset:path` (or `asset://path`) → the running bundle's image (a downloaded OTA bundle's copy, else the APK's
 * assets, [ZnBundles.assetModel]); `zn://` handles load natively ([ZnHandles]); http(s) URLs as they are.
 */
private fun imageModel(src: String?, context: Context): Any? = when {
    src == null -> null
    src.startsWith("zn://") -> ZnHandles.request(context, src)
    src.startsWith("asset://") -> ZnBundles.assetModel(src.removePrefix("asset://"))
    src.startsWith("asset:") -> ZnBundles.assetModel(src.removePrefix("asset:"))
    else -> src
}

@Composable
private fun dynamicChain(s: ZnNodeSpec, inst: ZnInstance, root: Boolean, touchable: Boolean): Modifier {
    val disabled = if (s.disabledSlot >= 0) inst.slot(s.disabledSlot).value == true else s.disabled
    val view = LocalView.current
    val indication = when (s.pressFeedback) {
        Registry.PressFeedback.NONE -> null
        Registry.PressFeedback.HIGHLIGHT -> remember(s) { ZnHighlight(s.highlightColor) }
        else -> remember(s) { ZnRipple(s.rippleColor, s.rippleOpacity, !s.rippleBorderless, s.rippleRadius) }
    }
    val interactions = remember { MutableInteractionSource() }
    val pressed = if (s.type == Registry.Component.PRESSABLE) znPressed(s, interactions) else null
    // Opacity, transforms and background: slot reads or animations, all read in the draw phase (ZnAnimation.kt).
    val layer = znLayer(s, inst, root, pressed)
    val background = znBackground(s, inst)
    val aLabel = if (s.accessibilityLabelSlot >= 0) {
        inst.slot(s.accessibilityLabelSlot).value as? String
    } else null
    // Registry 14: read here so TalkBack's long-press action follows it (the touch path reads it at finger-down).
    val longPressSet = if (s.hasLongPressSlot >= 0) inst.slot(s.hasLongPressSlot).value else null
    val density = LocalDensity.current.density
    return remember(s, inst, disabled, indication, layer, background, aLabel, longPressSet, touchable, density) {
        val press = if (s.type == Registry.Component.PRESSABLE) {
            Modifier.znPress(s, inst, enabled = !disabled, view, interactions, indication, touchable)
        } else null
        val pad = if (s.hasDynamicPadding) {
            val base = s.staticPadding
            val cells = s.paddingSlots.map { if (it >= 0) inst.slot(it) else null }
            fun edge(i: Int, static: Float) = (cells[i]?.value as? Double)?.toFloat() ?: static
            ({ Edges(edge(0, base.start), edge(1, base.top), edge(2, base.end), edge(3, base.bottom)) })
        } else null
        val accessibility = if (s.type != Registry.Component.PRESSABLE && s.type != Registry.Component.OTP_INPUT) s.accessibilitySemantics(aLabel ?: s.accessibilityLabel) else null
        // Registry 15: a border width / colour from a slot, read while measuring / drawing (no recomposition).
        val border = if (s.borderWidthSlot >= 0 || s.borderColorSlot >= 0) {
            val wCell = if (s.borderWidthSlot >= 0) inst.slot(s.borderWidthSlot) else null
            val cCell = if (s.borderColorSlot >= 0) inst.slot(s.borderColorSlot) else null
            ZnBorder(
                width = { (wCell?.value as? Double)?.toFloat() ?: s.borderWidth },
                color = { cCell?.let { toColor(it.value) } ?: s.borderColor },
            )
        } else null
        val layout = if (s.onLayout != 0) znOnLayout(inst.id, s.onLayout, density) else null
        s.buildChain(layer, background, press, pad, accessibility, border, layout)
    }
}

/**
 * RN textTransform (registry 15). Like JavaScript's toUpperCase / toLowerCase (no phone locale, so "i" never becomes
 * the Turkish "İ"). capitalize works as React Native's Android code does: for each word (java.text.BreakIterator, so
 * "don't" is one word), the first letter upper case and the rest lower case. Span breaks (U+001F) end a word.
 */
internal fun transformText(text: String, transform: Int): String = when (transform) {
    Registry.TextTransform.UPPERCASE -> text.uppercase(java.util.Locale.ROOT)
    Registry.TextTransform.LOWERCASE -> text.lowercase(java.util.Locale.ROOT)
    Registry.TextTransform.CAPITALIZE -> buildString(text.length) {
        val words = java.text.BreakIterator.getWordInstance(java.util.Locale.ROOT)
        words.setText(text)
        var start = words.first()
        var end = words.next()
        while (end != java.text.BreakIterator.DONE) {
            val word = text.substring(start, end)
            if (word[0].isLetterOrDigit()) {
                append(word.substring(0, 1).uppercase(java.util.Locale.ROOT))
                append(word.substring(1).lowercase(java.util.Locale.ROOT))
            } else {
                append(word)
            }
            start = end
            end = words.next()
        }
    }
    else -> text
}

/** Slot values arrive as null, Boolean, Double or String. Whole numbers show without ".0". */
private fun display(v: Any?): String = when (v) {
    null -> ""
    is Double -> if (v % 1.0 == 0.0 && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
    else -> v.toString()
}

/** Colours come from templates as ZnColor and from JS as an ARGB number. */
internal fun toColor(v: Any?): Color? = when (v) {
    is ZnColor -> Color(v.argb)
    is Double -> Color(v.toLong().toInt())
    else -> null
}

// gap is kept with every justifyContent, as in RN (ZnArrangement.kt, second-opinions 112).
private fun verticalArrangement(s: ZnNodeSpec): Arrangement.Vertical = znVerticalArrangement(s.justify, s.gap)

private fun horizontalArrangement(s: ZnNodeSpec): Arrangement.Horizontal = znHorizontalArrangement(s.justify, s.gap)

private fun horizontalAlignment(align: Int): Alignment.Horizontal = when (align) {
    Registry.AlignItems.CENTER -> Alignment.CenterHorizontally
    Registry.AlignItems.FLEX_END -> Alignment.End
    else -> Alignment.Start
}

private fun verticalAlignment(align: Int): Alignment.Vertical = when (align) {
    Registry.AlignItems.CENTER -> Alignment.CenterVertically
    Registry.AlignItems.FLEX_END -> Alignment.Bottom
    else -> Alignment.Top
}

/** A Stack's default child position as (horizontal, vertical) bias: alignItems and justifyContent. */
private fun stackBias(s: ZnNodeSpec): Pair<Float, Float> {
    val h = when (s.alignItems) {
        Registry.AlignItems.CENTER -> 0f
        Registry.AlignItems.FLEX_END -> 1f
        else -> -1f
    }
    val v = when (s.justify) {
        Registry.JustifyContent.CENTER -> 0f
        Registry.JustifyContent.FLEX_END -> 1f
        else -> -1f
    }
    return h to v
}

private fun stackAlignment(s: ZnNodeSpec): Alignment = stackBias(s).let { (h, v) -> BiasAlignment(h, v) }

/**
 * The content padding of a Scroll, Carousel or List (it scrolls with the content). Padding from a slot is read here,
 * so a change recomposes only this node. Before 2026-11-05 a slot's padding on a Scroll was dropped: the modifier
 * chain leaves content padding out, and only the static value reached the content.
 */
private fun contentPaddingOf(s: ZnNodeSpec, inst: ZnInstance): PaddingValues {
    if (!s.hasDynamicPadding) return s.contentPadding ?: PaddingValues(0.dp)
    val b = s.staticPadding
    fun edge(i: Int, static: Float): Float {
        val slot = s.paddingSlots[i]
        return if (slot >= 0) (inst.slot(slot).value as? Double)?.toFloat() ?: static else static
    }
    return Edges(edge(0, b.start), edge(1, b.top), edge(2, b.end), edge(3, b.bottom)).toPadding()
}

/**
 * An absolute Stack child without a full fill (R29), inside matchParentSize, so the incoming size is the Stack's own.
 * Each axis: both sides (start + end, top + bottom) = the Stack's size minus the two; else its own size: a set dp size
 * is kept even when bigger than the Stack, a % is of the Stack, no width is at most the Stack's width, no height is the
 * content's height. Placed at its inset (end / bottom from the far side), or by the Stack's alignment
 * ([bias]) when it has none. Reports the Stack's size, so it never makes the Stack bigger. Draws outside when bigger.
 */
private fun Modifier.absoluteChild(child: ZnNodeSpec, bias: Pair<Float, Float>): Modifier =
    layout { measurable, constraints ->
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        val s = child.start?.dp?.roundToPx()
        val e = child.end?.dp?.roundToPx()
        val t = child.top?.dp?.roundToPx()
        val b = child.bottom?.dp?.roundToPx()
        val fillW = s != null && e != null
        val fillH = t != null && b != null
        val fullW = (w - (s ?: 0) - (e ?: 0)).coerceAtLeast(0)
        val fullH = (h - (t ?: 0) - (b ?: 0)).coerceAtLeast(0)
        val inner = Constraints(
            minWidth = if (fillW) fullW else 0,
            maxWidth = when {
                fillW -> fullW
                child.width is Double -> Constraints.Infinity
                else -> w // a % of the Stack; no width: at most the Stack's width (Yoga's rule, and zn's before)
            },
            minHeight = if (fillH) fullH else 0,
            maxHeight = when {
                fillH -> fullH
                child.height is ZnPercent -> h
                else -> Constraints.Infinity
            },
        )
        val p = measurable.measure(inner)
        val x = s ?: e?.let { w - p.width - it } ?: ((1f + bias.first) / 2f * (w - p.width)).roundToInt()
        val y = t ?: b?.let { h - p.height - it } ?: ((1f + bias.second) / 2f * (h - p.height)).roundToInt()
        layout(w, h) { p.placeRelative(x, y) }
    }

/**
 * Insets an absolute child that fills its axis (after matchParentSize / fillMaxWidth / fillMaxHeight): on each axis
 * that has both sides, it is the full size minus the two insets, placed at the start / top inset. Negative insets make
 * it bigger than the Stack (it draws outside, as in RN). A null pair leaves that axis as measured.
 */
private fun Modifier.absoluteInsets(start: Float?, top: Float?, end: Float?, bottom: Float?): Modifier =
    layout { measurable, constraints ->
        val s = start?.dp?.roundToPx() ?: 0
        val e = end?.dp?.roundToPx() ?: 0
        val t = top?.dp?.roundToPx() ?: 0
        val b = bottom?.dp?.roundToPx() ?: 0
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        val stretchW = start != null && end != null && constraints.hasBoundedWidth
        val stretchH = top != null && bottom != null && constraints.hasBoundedHeight
        val inner = Constraints(
            minWidth = if (stretchW) (w - s - e).coerceAtLeast(0) else constraints.minWidth,
            maxWidth = if (stretchW) (w - s - e).coerceAtLeast(0) else constraints.maxWidth,
            minHeight = if (stretchH) (h - t - b).coerceAtLeast(0) else constraints.minHeight,
            maxHeight = if (stretchH) (h - t - b).coerceAtLeast(0) else constraints.maxHeight,
        )
        val p = measurable.measure(inner)
        val outW = if (stretchW) w else p.width
        val outH = if (stretchH) h else p.height
        layout(outW, outH) { p.placeRelative(if (stretchW) s else 0, if (stretchH) t else 0) }
    }

/**
 * Nested <Text> spans: the text holds one piece per span, joined by U+001F (compile.ts `textChildren`). [cap] is the
 * parent's maxFontScale cap ([ZnNodeSpec.fontScaleCap]); a span's own sizes are capped too. A span without its own
 * size keeps the parent's (already capped) size.
 */
private fun spannedText(
    text: String,
    spans: List<androidx.compose.ui.text.SpanStyle>,
    cap: Float = 1f,
    presses: BooleanArray? = null,
    press: ((Int) -> Unit)? = null,
) = androidx.compose.ui.text.buildAnnotatedString {
    text.split('\u001f').forEachIndexed { i, piece ->
        val style = spans.getOrNull(i)
        // Registry 16: a span with onPress is a link (Compose handles the tap and TalkBack's link action).
        val link = if (press != null && presses?.getOrNull(i) == true) {
            androidx.compose.ui.text.LinkAnnotation.Clickable("zn-span-$i") { press(i) }
        } else null
        val appendPiece: androidx.compose.ui.text.AnnotatedString.Builder.() -> Unit = {
            if (style == null) {
                append(piece)
            } else {
                val capped = if (cap == 1f) style
                else style.copy(fontSize = style.fontSize.scaledSp(cap), letterSpacing = style.letterSpacing.scaledSp(cap))
                withStyle(capped) { append(piece) }
            }
        }
        if (link != null) withLink(link) { appendPiece() } else appendPiece()
    }
}

/**
 * textDecorationStyle "dashed" / "dotted" (registry 16): an underline ([line] UNDERLINE) or line-through under or
 * across each laid-out line, with RN Android's dash pattern. Thickness and place follow the font size, close to the
 * lines Android draws itself (about 1/18 of the size thick, a tenth of the size below the baseline).
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawTextDecoration(
    r: TextLayoutResult, line: Int, style: Int, textStyle: androidx.compose.ui.text.TextStyle, color: Color,
) {
    val size = if (textStyle.fontSize.isSp) textStyle.fontSize.toPx() else 14.sp.toPx()
    val thick = (size / 18f).coerceAtLeast(1f)
    val effect = borderDashes(style, thick)
    for (i in 0 until r.lineCount) {
        val left = r.getLineLeft(i)
        val right = r.getLineRight(i)
        if (right <= left) continue
        val base = r.getLineBaseline(i)
        val y = if (line == Registry.TextDecorationLine.LINE_THROUGH) base - size * 0.27f else base + size * 0.11f
        drawLine(color, Offset(left, y), Offset(right, y), thick, pathEffect = effect)
    }
}
