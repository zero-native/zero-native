package dev.zeronative.runtime

import android.content.Context
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.ui.semantics.Role
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
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.foundation.lazy.LazyItemScope
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
import androidx.compose.ui.graphics.RectangleShape
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
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
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
    val own = if (s.hasImpression) impression(s, inst).then(chain) else chain
    val mod = blocked.then(own)
    val kidsOff = touchOff || pe == Registry.PointerEvents.NONE || pe == Registry.PointerEvents.BOX_ONLY
    val slop = s.hitSlop
    if (slop != null && selfTouch && s.type == Registry.Component.PRESSABLE) {
        WithHitSlop(slop, s.margin) { measure ->
            // Measured after the parent's modifiers: an absolute child in a Stack is laid out in a box the Stack's size
            // and placed inside it (absoluteChild), so measuring outside that box gave the Stack's size, and a tap
            // 100 dp away still pressed a 24 dp icon (found 2026-11-07; broken since R29, 2026-11-05).
            ZnNodeChildren(f, t, inst, n, s, blocked.then(measure).then(own), definiteWidth, touchOff, kidsOff)
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
        Registry.Component.ROW -> {
            val gap = if (s.gapSlot >= 0) inst.finiteNum(s.gapSlot) ?: s.gap else s.gap
            Row(
                modifier = mod,
                // B1 (2026-11-08): justifyContent is kept with a gap, as in RN; spacedBy alone dropped it.
                horizontalArrangement = znHorizontalArrangement(s.justify, gap),
                verticalAlignment = verticalAlignment(s.alignItems),
            ) {
                // zn flex rule 4: a Row stretches children only when it has a fixed height, and then only with
                // alignItems or alignSelf "stretch" (an unset alignItems doesn't, a zn rule: platform-differences.md).
                // An absolute Row pinned top and bottom has a set height too, as in RN (like R44's width; 2026-11-09:
                // swipe-row buttons behind a row were a thin strip at its top).
                val pinnedH = s.absolute && (s.top != null || s.topSlot >= 0) && (s.bottom != null || s.bottomSlot >= 0)
                val definiteHeight = s.height is Double || s.heightSlot >= 0 || pinnedH
                for (ref in shownRefs(f, t, inst, s)) key(ref.key) {
                    val child = ref.template.nodes[ref.node]
                    var m: Modifier = Modifier
                    val childFlex = if (child.flexSlot >= 0) inst.finiteNum(child.flexSlot) ?: child.flex else child.flex
                    if (childFlex > 0f) m = m.weight(childFlex) // finiteNum: never NaN or Infinity
                    // A11-1 (2026-11-08): alignSelf "stretch" stretches too, whatever alignItems says, as in RN.
                    val stretchChild = child.alignSelf == Registry.AlignSelf.STRETCH ||
                        (child.alignSelf == -1 && s.alignItems == Registry.AlignItems.STRETCH)
                    if (definiteHeight && stretchChild && child.height == null && child.heightSlot < 0) m = m.fillMaxHeight()
                    if (child.alignSelf != -1) m = m.align(verticalAlignment(child.alignSelf))
                    child.zIndex?.let { m = m.zIndex(it) } // RN zIndex on any child (registry 16)
                    // In a Row, a child's width is definite when it is set or shared out by flex.
                    ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = child.width != null || child.widthSlot >= 0 || childFlex > 0f)
                }
            }
        }
        Registry.Component.STACK -> Box(modifier = mod, contentAlignment = stackAlignment(s)) {
            // A normal (not absolute) child stretches to the Stack's width like a Column's (zn flex rule 4, RN's
            // default alignItems: 'stretch'), so a styled row inside a Stack is full width (2026-11-05).
            for (ref in childRefs(f, t, inst, s)) key(ref.key) {
                val child = ref.template.nodes[ref.node]
                var m: Modifier = Modifier
                var stretched = false
                if (!child.absolute) {
                    stretched = definiteWidth && child.width == null && child.widthSlot < 0 && child.type != Registry.Component.SPACER &&
                        stretchesInColumn(s, child)
                    if (stretched) m = m.fillMaxWidth()
                }
                if (child.absolute) {
                    // position: 'absolute' with top/bottom/start/end, relative to the Stack's content box. Both sides
                    // of a pair (start + end, top + bottom) stretch it between them, as in RN (registry 15).
                    val fillW = (child.start != null || child.startSlot >= 0) && (child.end != null || child.endSlot >= 0)
                    val fillH = (child.top != null || child.topSlot >= 0) && (child.bottom != null || child.bottomSlot >= 0)
                    if (fillW && fillH) {
                        // The Stack's own size, after its other children (StyleSheet.absoluteFill).
                        m = m.matchParentSize().absoluteInsets(child, ref.instance)
                    } else {
                        // R29 (2026-11-05): it takes no room, as in RN. In matchParentSize the Box sizes itself
                        // from its normal children only, then measures this child at that size (absoluteChild).
                        // Before, the Box grew to fit it (a 220 dp header shape made a 90 dp Stack 220 tall).
                        m = m.matchParentSize().absoluteChild(child, ref.instance, stackBias(s))
                    }
                }
                child.zIndex?.let { m = m.zIndex(it) }
                // R44 (2026-11-07): an absolute child pinned on both sides (start + end) has a set width, as in RN, so
                // its own children stretch to it. Before, a centred spinner inside one sat at the left.
                val pinnedW = child.absolute && (child.start != null || child.startSlot >= 0) && (child.end != null || child.endSlot >= 0)
                ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null || child.widthSlot >= 0 || pinnedW)
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
                modifier = mod.znKeyboardDismiss(s.keyboardDismissMode, vertical = false),
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
            val scrollState = rememberScrollState()
            // Registry 24: scrollY for useElementMotion (a collapsing header follows it with no JS).
            znElementOf(s, inst)?.let { e ->
                val d = LocalDensity.current.density
                ZnProvide(e, "scrollY") { scrollState.value / d }
                ZnFollow(e) { scrollState.scrollTo((it * d).roundToInt().coerceAtLeast(0)) }
            }
            Column(
                // A11-2: the box children's onLayout x / y start from: the scrolling content, so y doesn't move
                // with the scroll; its contentContainerStyle padding counts, as in RN.
                modifier = mod.then(znPullRefresh(s, inst)).znKeyboardDismiss(s.keyboardDismissMode, vertical = true).verticalScroll(scrollState)
                    .then(ZnBoxElement).padding(contentPaddingOf(s, inst)),
                verticalArrangement = verticalArrangement(s),
                horizontalAlignment = horizontalAlignment(s.alignItems),
            ) {
                // Stretches children like a Column (zn flex rule 4, as RN's ScrollView). No flex: the height is open.
                for (ref in shownRefs(f, t, inst, s)) key(ref.key) {
                    val child = ref.template.nodes[ref.node]
                    // A width from a slot isn't stretched over (as in a Column; before 2026-11-08 the stretch won).
                    val stretched = definiteWidth && child.width == null && child.widthSlot < 0 && child.type != Registry.Component.SPACER &&
                        stretchesInColumn(s, child)
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
            val fs = if (s.fontSizeSlot >= 0) inst.finiteNum(s.fontSizeSlot) else null
            val lh = if (s.lineHeightSlot >= 0) inst.finiteNum(s.lineHeightSlot) else null
            val ls = if (s.letterSpacingSlot >= 0) inst.finiteNum(s.letterSpacingSlot) else null
            val textStyle = s.effectiveTextStyle(fontScale, fs, lh, ls)
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
            val hasPress = s.onPress != 0
            val hasLongPress = s.onLongPress != 0
            val finalMod = if ((hasPress || hasLongPress) && !LocalTouchOff.current) {
                if (hasLongPress) {
                    @OptIn(ExperimentalFoundationApi::class)
                    textMod.combinedClickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onLongClick = { ZnRuntime.dispatchEvent(inst.id, s.onLongPress) },
                        onClick = { if (hasPress) ZnRuntime.dispatchEvent(inst.id, s.onPress) },
                    )
                } else {
                    textMod.clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        role = Role.Button,
                        onClick = { ZnRuntime.dispatchEvent(inst.id, s.onPress) },
                    )
                }
            } else textMod
            val isSelectable = if (s.selectableSlot >= 0) inst.slot(s.selectableSlot).value == true else s.selectable
            val renderText = @Composable {
                if (s.adjustsFontSizeToFit && s.maxLines != Int.MAX_VALUE) {
                    // RN adjustsFontSizeToFit (registry 23): Compose's own step search (TextAutoSize), done while
                    // measuring, in the text's own box, so textAlign works. Gemini's loop measured the text up to ~100
                    // times per composition in a box around it, and lost textAlign (M11, 2026-11-08 review).
                    val base = if (textStyle.fontSize.isSp) textStyle.fontSize.value else 14f
                    val minScale = (s.minimumFontScale ?: 0.5f).coerceIn(0.01f, 1f)
                    val autoSize = remember(base, minScale) {
                        TextAutoSize.StepBased(minFontSize = (base * minScale).sp, maxFontSize = base.sp, stepSize = 0.5.sp)
                    }
                    if (spans == null) {
                        BasicText(text = text, modifier = finalMod, style = textStyle, maxLines = s.maxLines,
                            overflow = TextOverflow.Ellipsis, color = color, onTextLayout = onLayout, autoSize = autoSize)
                    } else {
                        val cap = s.fontScaleCap(fontScale)
                        val press: ((Int) -> Unit)? = if (presses == null) null else { i -> ZnRuntime.dispatchEvent(inst.id, s.onSpanPress, i) }
                        val styled = remember(text, spans, cap, presses, press) { spannedText(text, spans, cap, presses, press) }
                        BasicText(text = styled, modifier = finalMod, style = textStyle, maxLines = s.maxLines,
                            overflow = TextOverflow.Ellipsis, color = color, onTextLayout = onLayout, autoSize = autoSize)
                    }
                } else {
                    if (spans == null) {
                        BasicText(text = text, modifier = finalMod, style = textStyle, maxLines = s.maxLines,
                            overflow = TextOverflow.Ellipsis, color = color, onTextLayout = onLayout)
                    } else {
                        val cap = s.fontScaleCap(fontScale)
                        val press: ((Int) -> Unit)? = if (presses == null) null else { i -> ZnRuntime.dispatchEvent(inst.id, s.onSpanPress, i) }
                        val styled = remember(text, spans, cap, presses, press) { spannedText(text, spans, cap, presses, press) }
                        BasicText(text = styled, modifier = finalMod, style = textStyle, maxLines = s.maxLines,
                            overflow = TextOverflow.Ellipsis, color = color, onTextLayout = onLayout)
                    }
                }
            }
            if (isSelectable) {
                SelectionContainer { renderText() }
            } else {
                renderText()
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
        Registry.Component.CANVAS -> ZnCanvas(s, inst, mod)
        else -> Box(modifier = mod)
    }
}

/**
 * display: 'none', written or from a slot. Row and Column leave such a child out, so the gap around it goes too, as in
 * RN. Before 2026-11-08 it was drawn 0 x 0 and still took a gap on both sides (review of Gemini's H1). A slot's change
 * recomposes the parent: display changes are rare, and the 0 x 0 layout in dynamicSize stays for other parents.
 */
private fun ZnNodeSpec.displayNone(inst: ZnInstance): Boolean {
    if (displaySlot < 0) return display == Registry.Display.NONE
    val d = inst.slot(displaySlot).value
    return d == "none" || (d as? Number)?.toInt() == Registry.Display.NONE
}

/** [childRefs] without the children that have display: 'none' ([displayNone]), for Row and Column. */
@Composable
private fun shownRefs(f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, s: ZnNodeSpec): List<ChildRef> {
    val refs = childRefs(f, t, inst, s)
    if (refs is ArrayList) refs.removeAll { it.template.nodes[it.node].displayNone(it.instance) }
    return refs
}

/**
 * Does [child] stretch across a Column-like parent [s] (Column, Stack, vertical Scroll)? Its alignSelf decides when it
 * has one: "stretch" stretches whatever the parent's alignItems is, as in RN (A11-1, 2026-11-08; before, an alignItems
 * of center or flex-start won). Else the parent's alignItems: unset or "stretch".
 */
internal fun stretchesInColumn(s: ZnNodeSpec, child: ZnNodeSpec): Boolean =
    if (child.alignSelf != -1) child.alignSelf == Registry.AlignSelf.STRETCH
    else s.alignItems == -1 || s.alignItems == Registry.AlignItems.STRETCH

/** A Column-like node's children, with the zn flex rules (also the body of a <Sheet>). */
@Composable
internal fun ZnColumn(f: List<ZnTemplate>, t: ZnTemplate, inst: ZnInstance, s: ZnNodeSpec, mod: Modifier, definiteWidth: Boolean) {
    val gap = if (s.gapSlot >= 0) inst.finiteNum(s.gapSlot) ?: s.gap else s.gap
    Column(
        modifier = mod,
        // B1 (2026-11-08): justifyContent is kept with a gap, as in RN; spacedBy alone dropped it.
        verticalArrangement = znVerticalArrangement(s.justify, gap),
        horizontalAlignment = horizontalAlignment(s.alignItems),
    ) {
        for (ref in shownRefs(f, t, inst, s)) key(ref.key) {
            val child = ref.template.nodes[ref.node]
            var m: Modifier = Modifier
            val childFlex = if (child.flexSlot >= 0) inst.finiteNum(child.flexSlot) ?: child.flex else child.flex
            if (childFlex > 0f) m = m.weight(childFlex)
            // zn flex rule 4: Column stretches children without a width (docs/styling-and-layout.md §5).
            val stretched = definiteWidth && child.width == null && child.widthSlot < 0 && child.type != Registry.Component.SPACER &&
                stretchesInColumn(s, child)
            if (stretched) m = m.fillMaxWidth()
            if (child.alignSelf != -1) m = m.align(horizontalAlignment(child.alignSelf))
            // RN zIndex on any child (registry 16, R23): draws it over its later siblings (a row holding a tooltip).
            child.zIndex?.let { m = m.zIndex(it) }
            ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null || child.widthSlot >= 0 || childFlex > 0f)
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

// RN onLayout (registry 15): ZnOnLayoutNode in ZnLayoutBox.kt (x / y from the parent's box since A11-2, 2026-11-08).

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
    // Registry 24: the page as a number (2.5 = half way from page 2 to 3), for parallax and dots that stretch.
    znElementOf(s, inst)?.let { e ->
        ZnProvide(e, "page") { pager.currentPage + pager.currentPageOffsetFraction }
        // m.follow(v): v is a page as a number (a tab indicator's value drives the pages, or the other way round).
        ZnFollow(e) { v ->
            if (refs.isEmpty()) return@ZnFollow
            val p = kotlin.math.round(v).toInt().coerceIn(0, refs.size - 1)
            pager.scrollToPage(p, (v - p).coerceIn(-0.5f, 0.5f))
        }
    }
    // Made once per carousel: a new object each recomposition made the pager measure again (2026-11-08 review).
    // A percent is of the pager's width inside its padding, gap not taken off (as CSS width: 80%).
    val pageSize = remember(s.itemWidthPercent, s.itemWidth) {
        when {
            s.itemWidthPercent != null -> object : PageSize {
                override fun androidx.compose.ui.unit.Density.calculateMainAxisPageSize(availableSpace: Int, pageSpacing: Int): Int =
                    (availableSpace * (s.itemWidthPercent / 100f)).roundToInt().coerceAtLeast(1)
            }
            s.itemWidth != null -> PageSize.Fixed(s.itemWidth.dp)
            else -> PageSize.Fill
        }
    }
    // `fill`: the pager takes the height left after the dots, and each page gets all of it. False: as tall as the
    // tallest page, the dots 10 dp under it (the layout of a carousel with no height, unchanged since 2.4c).
    val body: @Composable (Modifier, Boolean) -> Unit = { colMod, fill -> Column(colMod) {
        HorizontalPager(
            state = pager,
            modifier = if (fill) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth(),
            contentPadding = contentPaddingOf(s, inst),
            pageSize = pageSize,
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
    // Header / footer / empty (registry 23) have their own states in ZnList: reading them here doesn't recompose the
    // whole list on each row bind, as reading list.bound did (M9, 2026-11-08 review).
    val headerInst = drawnExtra(f, list.header.value)
    val footerInst = drawnExtra(f, list.footer.value)
    val emptyInst = drawnExtra(f, list.empty.value)
    val hasHeader = headerInst != null
    val hasFooter = footerInst != null
    val hasEmpty = emptyInst != null

    val state = rememberLazyListState() // saveable: the scroll position survives back navigation and recreation
    // Registry 24: the first visible item and how far it is scrolled (dp), and scrollY: exact while the first item is
    // visible, estimated from the visible items' sizes after (enough for a collapsing header).
    znElementOf(s, inst)?.let { e ->
        val d = LocalDensity.current.density
        ZnProvide(e, "index") { state.firstVisibleItemIndex.toFloat() }
        ZnProvide(e, "offset") { state.firstVisibleItemScrollOffset / d }
        ZnProvide(e, if (s.horizontal) "scrollX" else "scrollY") { estimatedScrollPx(state) / d }
        // m.follow(v): v is an item index; 3.5 is half way through item 3 (when item 3 is laid out).
        ZnFollow(e) { v ->
            val i = kotlin.math.floor(v).toInt().coerceAtLeast(0)
            val size = state.layoutInfo.visibleItemsInfo.firstOrNull { it.index == i }?.size ?: 0
            state.scrollToItem(i, ((v - i) * size).roundToInt())
        }
    }
    val scrollCmd = if (s.scrollCommandSlot >= 0) inst.slot(s.scrollCommandSlot).value as? String else null
    val density = LocalDensity.current
    LaunchedEffect(scrollCmd) {
        // "action:param:animated:viewOffset:seq" from core's bindListController. Numbers are dp, as in RN.
        val parts = scrollCmd?.split(":") ?: return@LaunchedEffect
        val seq = parts.getOrNull(4)?.toIntOrNull() ?: return@LaunchedEffect
        if (seq <= list.lastScrollSeq) return@LaunchedEffect
        list.lastScrollSeq = seq
        fun number(i: Int): Float = parts.getOrNull(i)?.toFloatOrNull()?.takeIf { it.isFinite() } ?: 0f
        val anim = parts.getOrNull(2) != "0"
        // The item order is the same in every list: header, empty (no rows only), rows, footer (M10).
        val head = if (list.header.value != null && hasHeader) 1 else 0
        val count = head + rows.size + (if (hasFooter) 1 else 0) + (if (rows.isEmpty() && hasEmpty) 1 else 0)
        when (parts.getOrNull(0)) {
            "index" -> {
                // RN's viewOffset: the row ends up that many dp further from the start (Compose's offset goes the
                // other way, and is in px). Before 2026-11-08 it was px with the wrong sign, and 2.5 became 0 (M7).
                val target = (number(1).toInt().coerceIn(0, (rows.size - 1).coerceAtLeast(0)) + head)
                    .coerceIn(0, (count - 1).coerceAtLeast(0))
                val offset = -with(density) { number(3).dp.toPx() }.roundToInt()
                if (anim) state.animateScrollToItem(target, offset) else state.scrollToItem(target, offset)
            }
            "end" -> {
                val last = (count - 1).coerceAtLeast(0) // the footer, or the empty item, when there is one
                if (anim) state.animateScrollToItem(last) else state.scrollToItem(last)
            }
            "offset" -> {
                // RN's scrollToOffset is absolute, in dp. A lazy list knows only the rows near the screen, so: exact
                // without animation (top, then down by the offset); animated, exact for 0 and close for other values
                // (from the visible rows' average size). Before 2026-11-08 it scrolled BY px, so 0 did nothing (M7).
                val px = with(density) { number(1).coerceAtLeast(0f).dp.toPx() }
                when {
                    !anim -> { state.scrollToItem(0); if (px > 0f) state.scrollBy(px) }
                    px == 0f -> state.animateScrollToItem(0)
                    else -> state.animateScrollBy(px - estimatedScrollPx(state))
                }
            }
        }
    }
    // RN stickyHeaderIndices (registry 15): rows drawn pinned (Compose stickyHeader), in order, inside the list.
    val stickyText = if (s.stickySlot >= 0) inst.slot(s.stickySlot).value as? String else s.stickyHeaderIndices
    val sticky = remember(stickyText) { parseSticky(stickyText) }
    // Registry 24: drag to reorder (ZnReorder.kt). Not with pinned rows (they can't move).
    val view = LocalView.current
    val reorderScope = rememberCoroutineScope()
    val reorder = if (s.reorderable && sticky.isEmpty()) {
        remember(state, s, inst) {
            ZnReorder(
                state, reorderScope, view, s.horizontal,
                head = { if (list.header.value != null) 1 else 0 },
                rowCount = { rows.size },
                keyOfRow = { rows.getOrNull(it)?.key },
                onDrop = { from, to -> if (s.onReorder != 0) ZnRuntime.dispatchEvent(inst.id, s.onReorder, "$from,$to") },
            )
        }
    } else null
    if (reorder != null) {
        LaunchedEffect(reorder) {
            var first = true
            snapshotFlow { rows.toList() }.collect { if (first) first = false else reorder.rowsChanged() }
        }
    }
    // The shown position [p] → its row and modifier (with reorder: the local order, and the picked row on top).
    val shownRow: (Int) -> Int = { p -> reorder?.rowAt(p) ?: p }
    val itemModAt: @Composable LazyItemScope.(Int) -> Modifier = { r ->
        val key = rows.getOrNull(r)?.key
        if (reorder == null || key == null) znItemAnimation(s.itemAnimation)
        else if (reorder.dragged == key) reorder.rowModifier(key)
        else znItemAnimation(s.itemAnimation ?: "move")
    }
    val rowAt: @Composable (Int, Modifier) -> Unit = { i, itemMod ->
        val row = rows.getOrNull(i)
        if (row != null) {
            val mounted = list.bound[row.key]?.let(ZnStore::find)
            val t = f.getOrNull(mounted?.templateId ?: row.type)
            if (t != null) {
                if (s.horizontal) {
                    val rootNode = t.nodes.firstOrNull()
                    ZnNode(f, t, mounted ?: ZnStore.placeholder(row.type, t), 0, itemMod, definiteWidth = rootNode?.width != null)
                } else {
                    ZnNode(f, t, mounted ?: ZnStore.placeholder(row.type, t), 0, itemMod.fillMaxWidth(), definiteWidth = true)
                }
            }
        }
    }
    // A header, footer or empty item: its own template, full width in a column, its own width in a row.
    val extraAt: @Composable (ZnInstance) -> Unit = { e ->
        val et = f[e.templateId]
        if (s.horizontal) ZnNode(f, et, e, 0, Modifier, definiteWidth = et.nodes.firstOrNull()?.width != null)
        else ZnNode(f, et, e, 0, Modifier.fillMaxWidth(), definiteWidth = true)
    }
    if (s.inverted) FollowNewestRow(state, rows.firstOrNull()?.key)
    if (s.horizontal) {
        LazyRow(
            modifier = mod.then(reorder?.modifier() ?: Modifier).znKeyboardDismiss(s.keyboardDismissMode, vertical = false),
            state = state,
            contentPadding = contentPaddingOf(s, inst),
            horizontalArrangement = if (s.gap > 0f) Arrangement.spacedBy(s.gap.dp) else Arrangement.Start,
            verticalAlignment = verticalAlignment(s.alignItems),
        ) {
            if (headerInst != null) item(key = "__zn_header", contentType = "__zn_header") { extraAt(headerInst) }
            if (rows.isEmpty() && emptyInst != null) item(key = "__zn_empty", contentType = "__zn_empty") { extraAt(emptyInst) }
            items(count = rows.size, key = { rows[shownRow(it)].key }, contentType = { rows[shownRow(it)].type }) {
                val r = shownRow(it)
                rowAt(r, itemModAt(r))
            }
            if (footerInst != null) item(key = "__zn_footer", contentType = "__zn_footer") { extraAt(footerInst) }
        }
    } else {
        LazyColumn(
            modifier = mod.then(znPullRefresh(s, inst)) // pull to refresh, when it has onRefresh / refreshing
                .then(reorder?.modifier() ?: Modifier)
                .znKeyboardDismiss(s.keyboardDismissMode, vertical = true), // RN keyboardDismissMode (registry 24)
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
            // Same order in an inverted list, as RN flips the whole list: the header sits next to row 0 (at the
            // bottom), the footer past the last row (at the top). Before 2026-11-08 they were swapped (M10).
            if (headerInst != null) item(key = "__zn_header", contentType = "__zn_header") { extraAt(headerInst) }
            if (rows.isEmpty() && emptyInst != null) item(key = "__zn_empty", contentType = "__zn_empty") { extraAt(emptyInst) }
            // Runs of plain rows between the pinned ones: one `items` per run, so a long list stays a few blocks.
            var start = 0
            for (h in sticky) {
                if (h >= rows.size) break
                val from = start
                if (h > from) items(count = h - from, key = { rows[from + it].key }, contentType = { rows[from + it].type }) { rowAt(from + it, znItemAnimation(s.itemAnimation)) }
                stickyHeader(key = rows[h].key, contentType = rows[h].type) { rowAt(h, Modifier) }
                start = h + 1
            }
            val from = start
            if (rows.size > from) {
                // With reorder there are no pinned rows, so from is 0 and the shown order applies.
                items(count = rows.size - from, key = { rows[shownRow(from + it)].key }, contentType = { rows[shownRow(from + it)].type }) {
                    val r = shownRow(from + it)
                    rowAt(r, itemModAt(r))
                }
            }
            if (footerInst != null) item(key = "__zn_footer", contentType = "__zn_footer") { extraAt(footerInst) }
        }
    }
    if (s.onRange != 0 || s.onEndReached != 0) {
        LaunchedEffect(state, inst.id, node) {
            var endSentAt = -1
            snapshotFlow {
                // Lazy index → row index by arithmetic (the order above). Before 2026-11-08 each visible item did an
                // indexOfFirst over all rows on every scroll frame, and the pinned filter mixed the two kinds of index
                // (M9, M10).
                val head = if (drawnExtra(f, list.header.value) != null) 1 else 0
                val n = rows.size
                // A pinned row shows above rows far below it: leave it out, or JS would mount every row in between.
                val pinned = parseSticky(if (s.stickySlot >= 0) inst.slot(s.stickySlot).value as? String else s.stickyHeaderIndices)
                var lo = Int.MAX_VALUE
                var hi = -1
                var pinnedLo = Int.MAX_VALUE
                var pinnedHi = -1
                var pastRows = false
                for (item in state.layoutInfo.visibleItemsInfo) {
                    val r = item.index - head
                    if (r >= n) pastRows = true
                    if (r < 0 || r >= n) continue
                    if (r in pinned) { pinnedLo = minOf(pinnedLo, r); pinnedHi = maxOf(pinnedHi, r) }
                    else { lo = minOf(lo, r); hi = maxOf(hi, r) }
                }
                when {
                    hi >= 0 -> lo to hi
                    pinnedHi >= 0 -> pinnedLo to pinnedHi // only pinned rows on screen: those (as before batch 2)
                    n > 0 && pastRows -> (n - 1) to (n - 1) // only the footer: keep the last rows, and say "end"
                    else -> 0 to 0 // no rows, or only the header
                }
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

/** A List extra's instance (header / footer / empty), when it is mounted and its template is in this file. */
private fun drawnExtra(f: List<ZnTemplate>, id: Int?): ZnInstance? =
    id?.let(ZnStore::find)?.takeIf { f.getOrNull(it.templateId) != null }

/** How far the list is scrolled from its start, in px, estimated from the visible rows' sizes (for scrollToOffset). */
private fun estimatedScrollPx(state: LazyListState): Float {
    val info = state.layoutInfo
    val items = info.visibleItemsInfo
    if (items.isEmpty()) return 0f
    val each = items.sumOf { it.size }.toFloat() / items.size + info.mainAxisItemSpacing
    return state.firstVisibleItemIndex * each + state.firstVisibleItemScrollOffset
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

    // Dynamic margin (registry 23, brief H1): resolved on composition of this node
    // RN's order for static and slot values alike (ZnNodeSpec.mixedEdges); a NaN counts as not written.
    val dynamicMargin = if (s.hasDynamicMargin) {
        s.mixedEdges(s.marginProps, s.marginSlots) { inst.finiteNum(it) }
    } else null

    // Dynamic border radii (registry 23, brief H1): resolved on composition of this node.
    // A corner written for itself beats borderRadius, static or from a slot, as in RN (before 2026-11-08 a slot's
    // borderRadius beat a static corner). NaN or a negative value counts as 0.
    val dynamicShape = if (s.hasDynamicRadius) znMotionShape(s, inst) ?: run {
        fun slotNum(slot: Int): Float? = if (slot >= 0) inst.finiteNum(slot) else null
        val all = slotNum(s.borderRadiusSlot)
        fun corner(slot: Int, own: Int, own2: Int, static: Float): Float =
            (slotNum(slot) ?: (if (s.has(own) || s.has(own2)) static else null) ?: all ?: static).coerceAtLeast(0f)
        val ts = corner(s.borderTopStartRadiusSlot, Registry.Prop.BORDER_TOP_START_RADIUS, Registry.Prop.BORDER_TOP_LEFT_RADIUS, s.topStart)
        val te = corner(s.borderTopEndRadiusSlot, Registry.Prop.BORDER_TOP_END_RADIUS, Registry.Prop.BORDER_TOP_RIGHT_RADIUS, s.topEnd)
        val be = corner(s.borderBottomEndRadiusSlot, Registry.Prop.BORDER_BOTTOM_END_RADIUS, Registry.Prop.BORDER_BOTTOM_RIGHT_RADIUS, s.bottomEnd)
        val bs = corner(s.borderBottomStartRadiusSlot, Registry.Prop.BORDER_BOTTOM_START_RADIUS, Registry.Prop.BORDER_BOTTOM_LEFT_RADIUS, s.bottomStart)
        if (ts == 0f && te == 0f && be == 0f && bs == 0f) RectangleShape
        else RoundedCornerShape(ts.dp, te.dp, be.dp, bs.dp)
    } else null

    // Registry 24: useElementMotion() values from this element (its box; a Pressable's press).
    val element = if (s.motionSlot >= 0) (inst.slot(s.motionSlot).value as? Double)?.toInt()?.let { ZnMotion.element(it) } else null
    if (element != null && s.type == Registry.Component.PRESSABLE) ZnPressMotion(element, interactions)

    // Dynamic sizes & offsets (registry 23, brief H1): read inside layout pass (no recomposition!)
    val sizeLayout = if (s.hasDynamicSize) dynamicSize(s, inst, density) else null

    // Registry 24: the gesture JS gave this node (core motion.ts), and its size for `self` in bound formulas.
    val gestureId = if (s.gestureSlot >= 0) (inst.slot(s.gestureSlot).value as? Double)?.toInt() else null
    val gesture = gestureId?.let { ZnGestures.find(it) }
    // A layer slot that follows a motion formula reading `self` / `parent` needs the node's size.
    val needsSite = s.hasTransformSlots || s.opacitySlot >= 0
    // Registry 24: a shared element between two screens (`sharedTag`), outermost so the whole element moves.
    val shared = znSharedModifier(s, inst)
    val siteUsed = needsSite && intArrayOf(s.opacitySlot, s.scaleSlot, s.scaleXSlot, s.scaleYSlot, s.rotateSlot, s.translateXSlot,
        s.translateYSlot, s.rotateXSlot, s.rotateYSlot, s.blurRadiusSlot).any { it >= 0 && ZnMotion.ref(inst.slot(it).value)?.usesSite == true }

    return remember(s, inst, disabled, indication, layer, background, aLabel, longPressSet, touchable, density, dynamicMargin, dynamicShape, sizeLayout, gesture, siteUsed, element, shared) {
        val press = if (s.type == Registry.Component.PRESSABLE) {
            Modifier.znPress(s, inst, enabled = !disabled, view, interactions, indication, touchable)
        } else null
        val pad = if (s.hasDynamicPadding) {
            // Read while measuring (layoutPadding), in RN's order (ZnNodeSpec.mixedEdges).
            ({ s.mixedEdges(s.paddingProps, s.paddingSlots) { inst.finiteNum(it) } })
        } else null
        val accessibility = if (s.type != Registry.Component.PRESSABLE && s.type != Registry.Component.OTP_INPUT) s.accessibilitySemantics(aLabel ?: s.accessibilityLabel) else null
        // Registry 15: a border width / colour from a slot, read while measuring / drawing (no recomposition).
        val border = if (s.borderWidthSlot >= 0 || s.borderColorSlot >= 0) {
            val wCell = if (s.borderWidthSlot >= 0) inst.slot(s.borderWidthSlot) else null
            val cCell = if (s.borderColorSlot >= 0) inst.slot(s.borderColorSlot) else null
            ZnBorder(
                width = { (wCell?.value as? Double)?.toFloat()?.takeIf { it.isFinite() && it >= 0f } ?: s.borderWidth }, // NaN: M1
                color = { cCell?.let { toColor(it.value) } ?: s.borderColor },
            )
        } else null
        val layout = if (s.onLayout != 0) ZnOnLayoutElement(inst.id, s.onLayout, density) else null
        val site = layer?.site?.takeIf { siteUsed }
        var gestureMod: Modifier? = when {
            gesture != null -> Modifier.znGesture(gesture, view, layer).then(if (site != null) Modifier.znSite(site, view) else Modifier)
            site != null -> Modifier.znSite(site, view)
            else -> null
        }
        if (element != null) gestureMod = (gestureMod ?: Modifier).znElementBox(element, view)
        val layoutAnim = s.animateLayout
        if (layoutAnim != null) gestureMod = (gestureMod ?: Modifier).znAnimateLayout(layoutAnim)
        val chain = s.buildChain(layer, background, press, pad, accessibility, border, layout, sizeLayout, dynamicShape, dynamicMargin, gestureMod)
        if (shared != null) shared.then(chain) else chain
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

/**
 * A slot's number, or null when it isn't one or isn't finite. NaN and Infinity come from JS easily (a division by 0)
 * and crash Compose's layout and text code, so every number a layout reads goes through here (review M1, 2026-11-08).
 */
internal fun ZnInstance.finiteNum(slot: Int): Float? = when (val v = slot(slot).value) {
    is Number -> v.toFloat().takeIf { it.isFinite() }
    // A motion value bound to a layout prop (registry 24): read where this is read (layout phase for sizes and padding),
    // so a moving value re-measures this node each frame. Allowed with a lint warning (plan D4).
    is String -> ZnMotion.ref(v)?.read(null)
    else -> null
}

/** Slot values arrive as null, Boolean, Double or String. Whole numbers show without ".0". */
private fun display(v: Any?): String = when (v) {
    null -> ""
    is Double -> if (v % 1.0 == 0.0 && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
    // A motion value as text (`v.format(...)`, registry 24): formatted natively from its value now.
    is String -> ZnMotion.text(v) ?: v
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
    return s.mixedEdges(s.paddingProps, s.paddingSlots) { inst.finiteNum(it) }.toPadding()
}

/**
 * An absolute Stack child without a full fill (R29), inside matchParentSize, so the incoming size is the Stack's own.
 * Each axis: both sides (start + end, top + bottom) = the Stack's size minus the two; else its own size: a set dp size
 * is kept even when bigger than the Stack, a % is of the Stack, no width is at most the Stack's width, no height is the
 * content's height. Placed at its inset (end / bottom from the far side), or by the Stack's alignment
 * ([bias]) when it has none. Reports the Stack's size, so it never makes the Stack bigger. Draws outside when bigger.
 */
private fun Modifier.absoluteChild(child: ZnNodeSpec, inst: ZnInstance, bias: Pair<Float, Float>): Modifier =
    layout { measurable, constraints ->
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        val s = (if (child.startSlot >= 0) inst.finiteNum(child.startSlot) else child.start)?.dp?.roundToPx()
        val e = (if (child.endSlot >= 0) inst.finiteNum(child.endSlot) else child.end)?.dp?.roundToPx()
        val t = (if (child.topSlot >= 0) inst.finiteNum(child.topSlot) else child.top)?.dp?.roundToPx()
        val b = (if (child.bottomSlot >= 0) inst.finiteNum(child.bottomSlot) else child.bottom)?.dp?.roundToPx()
        val fillW = s != null && e != null
        val fillH = t != null && b != null
        val fullW = (w - (s ?: 0) - (e ?: 0)).coerceAtLeast(0)
        val fullH = (h - (t ?: 0) - (b ?: 0)).coerceAtLeast(0)
        val inner = Constraints(
            minWidth = if (fillW) fullW else 0,
            maxWidth = when {
                fillW -> fullW
                child.width is Double || child.widthSlot >= 0 -> Constraints.Infinity
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
private fun Modifier.absoluteInsets(child: ZnNodeSpec, inst: ZnInstance): Modifier =
    layout { measurable, constraints ->
        val s = (if (child.startSlot >= 0) inst.finiteNum(child.startSlot) else child.start)?.dp?.roundToPx() ?: 0
        val e = (if (child.endSlot >= 0) inst.finiteNum(child.endSlot) else child.end)?.dp?.roundToPx() ?: 0
        val t = (if (child.topSlot >= 0) inst.finiteNum(child.topSlot) else child.top)?.dp?.roundToPx() ?: 0
        val b = (if (child.bottomSlot >= 0) inst.finiteNum(child.bottomSlot) else child.bottom)?.dp?.roundToPx() ?: 0
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        val stretchW = (child.start != null || child.startSlot >= 0) && (child.end != null || child.endSlot >= 0) && constraints.hasBoundedWidth
        val stretchH = (child.top != null || child.topSlot >= 0) && (child.bottom != null || child.bottomSlot >= 0) && constraints.hasBoundedHeight
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

private val loggedDevWarnings = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

/**
 * Dynamic size modifier (registry 23, brief H1): reads size and min/max slots inside the layout phase.
 * A size change re-measures and needs NO recomposition (making Animated width/height work at 60fps).
 */
internal fun dynamicSize(s: ZnNodeSpec, inst: ZnInstance, density: Float): Modifier {
    val wCell = if (s.widthSlot >= 0) inst.slot(s.widthSlot) else null
    val hCell = if (s.heightSlot >= 0) inst.slot(s.heightSlot) else null
    val minWCell = if (s.minWidthSlot >= 0) inst.slot(s.minWidthSlot) else null
    val maxWCell = if (s.maxWidthSlot >= 0) inst.slot(s.maxWidthSlot) else null
    val minHCell = if (s.minHeightSlot >= 0) inst.slot(s.minHeightSlot) else null
    val maxHCell = if (s.maxHeightSlot >= 0) inst.slot(s.maxHeightSlot) else null
    val ratioCell = if (s.aspectRatioSlot >= 0) inst.slot(s.aspectRatioSlot) else null
    val dispCell = if (s.displaySlot >= 0) inst.slot(s.displaySlot) else null

    return Modifier.layout { measurable, constraints ->
        // 1. display check: "none" takes 0x0 and places nothing
        val d = dispCell?.value ?: s.display
        if (d == "none" || d == Registry.Display.NONE || d == 1) {
            return@layout layout(0, 0) {}
        }

        // 2. Resolve width
        val wRaw = wCell?.value ?: s.width
        val wPx = resolveSizePx(wRaw, constraints.maxWidth, constraints.hasBoundedWidth, density, s, "width")

        // 3. Resolve height
        val hRaw = hCell?.value ?: s.height
        val hPx = resolveSizePx(hRaw, constraints.maxHeight, constraints.hasBoundedHeight, density, s, "height")

        // 4. Resolve min/max constraints
        val minWRaw = minWCell?.value ?: s.minWidth
        val maxWRaw = maxWCell?.value ?: s.maxWidth
        val minHRaw = minHCell?.value ?: s.minHeight
        val maxHRaw = maxHCell?.value ?: s.maxHeight

        val minWPx = resolveDpPx(minWRaw, density)
        val maxWPx = resolveDpPx(maxWRaw, density)
        val minHPx = resolveDpPx(minHRaw, density)
        val maxHPx = resolveDpPx(maxHRaw, density)

        var minW = constraints.minWidth
        var maxW = constraints.maxWidth
        var minH = constraints.minHeight
        var maxH = constraints.maxHeight

        // A set width or height takes its own min / max first, as RN does (c29a), then the parent's room.
        if (wPx != null) {
            val clampedW = znClampSize(wPx, minWPx, maxWPx).coerceIn(minW, maxW)
            minW = clampedW
            maxW = clampedW
        } else {
            // A11-3 (2026-11-08): a max beats the parent's minimum (a stretch); a min beats the max (as in RN).
            if (maxWPx != null) { maxW = minOf(maxW, maxOf(maxWPx, 0)); minW = minOf(minW, maxW) }
            if (minWPx != null) { minW = maxOf(minW, minWPx.coerceIn(0, constraints.maxWidth)); maxW = maxOf(maxW, minW) }
        }

        if (hPx != null) {
            val clampedH = znClampSize(hPx, minHPx, maxHPx).coerceIn(minH, maxH)
            minH = clampedH
            maxH = clampedH
        } else {
            if (maxHPx != null) { maxH = minOf(maxH, maxOf(maxHPx, 0)); minH = minOf(minH, maxH) }
            if (minHPx != null) { minH = maxOf(minH, minHPx.coerceIn(0, constraints.maxHeight)); maxH = maxOf(maxH, minH) }
        }

        // 5. aspectRatio (only a finite number above 0). The width sets the height when it is known: set, or the
        //    bounded room the parent gives, as the static Modifier.aspectRatio does. Else the height sets the width.
        //    Before 2026-11-08 a slot's ratio with no width or height did nothing (review of Gemini's H1).
        val ratioVal = ((ratioCell?.value as? Number)?.toFloat() ?: s.aspectRatio)?.takeIf { it.isFinite() && it > 0f }
        if (ratioVal != null) {
            if (hPx == null && maxW != Constraints.Infinity) {
                val derivedH = (maxW / ratioVal).roundToInt().coerceIn(minH, maxH)
                minW = maxW
                minH = derivedH
                maxH = derivedH
            } else if (wPx == null && maxH != Constraints.Infinity) {
                val derivedW = (maxH * ratioVal).roundToInt().coerceIn(minW, maxW)
                minH = maxH
                minW = derivedW
                maxW = derivedW
            }
        }

        // Not Constraints(...): a large width and a large height together can't be stored in one Constraints and
        // throw. This keeps the width and gives up height detail first (a 1e6 dp height from JS no longer crashes).
        val childConstraints = Constraints.fitPrioritizingWidth(minW, maxW, minH, maxH)
        val placeable = measurable.measure(childConstraints)
        // Keeps the room the parent gave (a box smaller than it, from a max, isn't centred by Compose) and sits at the
        // start and top of it, as RN places a clamped stretch (A11-3).
        layout(constraints.constrainWidth(placeable.width), constraints.constrainHeight(placeable.height)) {
            placeable.placeRelative(0, 0)
        }
    }
}

internal fun resolveSizePx(
    value: Any?,
    parentBoundPx: Int,
    hasBound: Boolean,
    density: Float,
    spec: ZnNodeSpec,
    propName: String,
): Int? {
    if (value == null || value == "auto") return null
    if (value is Number) return dpToLayoutPx(value.toFloat(), density, spec, propName)
    if (value is ZnPercent) {
        if (!hasBound) {
            val key = "${spec.type}:$propName:unbounded"
            layoutWarn(key, "Dynamic layout: % on unbounded axis ignored for $propName on node ${spec.type}")
            return null
        }
        return (value.fraction * parentBoundPx).roundToInt()
    }
    if (value is String) {
        val str = value.trim()
        if (str == "auto") return null
        if (str.endsWith("%")) {
            val num = str.dropLast(1).trim().toFloatOrNull()
            if (num != null) {
                if (!hasBound) {
                    val key = "${spec.type}:$propName:unbounded"
                    layoutWarn(key, "Dynamic layout: % on unbounded axis ignored for $propName on node ${spec.type}")
                    return null
                }
                if (num.isFinite()) return ((num / 100f) * parentBoundPx).roundToInt().coerceIn(0, MAX_LAYOUT_PX)
            }
        }
        val key = "${spec.type}:$propName:invalid" // once per prop, not per value (an animated bad string)
        layoutWarn(key, "Dynamic layout: invalid $propName value '$str' on node ${spec.type}; treated as not written")
        return null
    }
    return null
}

internal fun resolveDpPx(value: Any?, density: Float): Int? {
    if (value == null || value == "auto") return null
    if (value is Number) return dpToLayoutPx(value.toFloat(), density, null, "min/max size")
    return null
}

/** One warning per [key] for a bad layout value from JS. (Log is a stub in JVM unit tests, so a throw there is ignored.) */
private fun layoutWarn(key: String, message: String) {
    if (!loggedDevWarnings.add(key)) return
    try { android.util.Log.w("zero-native", message) } catch (_: RuntimeException) {}
}

/** The largest size in px a slot can set: more than any screen, and small enough for Compose's Constraints. */
private const val MAX_LAYOUT_PX = (1 shl 18) - 1

/**
 * A slot's dp size in px. NaN or Infinity (a division by 0 in JS) counts as not written, with one warning: before
 * 2026-11-08 it crashed the app in roundToInt (review M1). Below 0 is 0; a huge value is capped at [MAX_LAYOUT_PX].
 */
private fun dpToLayoutPx(dp: Float, density: Float, spec: ZnNodeSpec?, propName: String): Int? {
    if (!dp.isFinite()) {
        layoutWarn("${spec?.type}:$propName:nan", "Dynamic layout: $propName is $dp on node ${spec?.type}; treated as not written")
        return null
    }
    return (dp * density).coerceIn(0f, MAX_LAYOUT_PX.toFloat()).roundToInt()
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
