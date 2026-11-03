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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
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
    val chain = if (s.hasDynamicChain) dynamicChain(s, inst, root = n == 0) else s.staticChain
    val mod = if (s.hasImpression) outer.then(impression(s, inst)).then(chain) else outer.then(chain)
    when (s.type) {
        // A Fragment inside a parent is expanded by the parent (childRefs); alone (a screen, a list row) it is a Column.
        Registry.Component.COLUMN, Registry.Component.BOX, Registry.Component.PRESSABLE, Registry.Component.FRAGMENT ->
            ZnColumn(f, t, inst, s, mod, definiteWidth)
        Registry.Component.TEXT_FIELD -> ZnTextField(s, inst, n, mod)
        Registry.Component.NATIVE_VIEW -> ZnNativeView(s, inst, n, mod)
        Registry.Component.SHEET -> ZnSheet(f, t, s, inst) // drawn in its own window, takes no space here
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
                // In a Row, a child's width is definite when it is set or shared out by flex.
                ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = child.width != null || child.flex > 0f)
            }
        }
        Registry.Component.STACK -> Box(modifier = mod, contentAlignment = stackAlignment(s)) {
            for (ref in childRefs(f, t, inst, s)) key(ref.key) {
                val child = ref.template.nodes[ref.node]
                var m: Modifier = Modifier
                if (child.absolute) {
                    // position: 'absolute' with top/bottom/start/end, relative to the Stack's content box.
                    val h = if (child.start != null) -1f else if (child.end != null) 1f else stackBias(s).first
                    val v = if (child.top != null) -1f else if (child.bottom != null) 1f else stackBias(s).second
                    m = m.align(BiasAlignment(h, v)).offset(
                        x = (child.start ?: child.end?.let { -it } ?: 0f).dp,
                        y = (child.top ?: child.bottom?.let { -it } ?: 0f).dp,
                    )
                }
                child.zIndex?.let { m = m.zIndex(it) }
                ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = child.width != null)
            }
        }
        Registry.Component.ANCHOR -> Unit // expanded by the parent (childRefs)
        Registry.Component.LIST -> ZnLazyList(f, s, inst, n, mod)
        Registry.Component.CAROUSEL -> ZnCarousel(f, t, s, inst, mod)
        Registry.Component.SCROLL -> if (s.horizontal) {
            // A rail: only the visible children are composed; scrolling it never involves JS.
            val refs = childRefs(f, t, inst, s)
            LazyRow(
                modifier = mod,
                contentPadding = s.contentPadding ?: PaddingValues(0.dp),
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
                modifier = mod.verticalScroll(rememberScrollState()).padding(s.contentPadding ?: PaddingValues(0.dp)),
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
                    ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null)
                }
            }
        }
        Registry.Component.TEXT -> {
            val text = if (s.textSlot >= 0) display(inst.slot(s.textSlot).value) else s.text.orEmpty()
            // Read in the draw phase: a colour change redraws, nothing more.
            val color: () -> Color = if (s.colorSlot >= 0) ({ toColor(inst.slot(s.colorSlot).value) ?: Color.Black })
            else ({ s.color ?: Color.Black })
            val fontScale = androidx.compose.ui.platform.LocalDensity.current.fontScale
            val textStyle = s.effectiveTextStyle(fontScale)
            val spans = s.spans
            if (spans == null) {
                BasicText(text = text, modifier = mod, style = textStyle, maxLines = s.maxLines,
                    overflow = TextOverflow.Ellipsis, color = color)
            } else {
                val cap = s.fontScaleCap(fontScale)
                val styled = remember(text, spans, cap) { spannedText(text, spans, cap) }
                BasicText(text = styled, modifier = mod, style = textStyle, maxLines = s.maxLines,
                    overflow = TextOverflow.Ellipsis, color = color)
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

            AsyncImage(
                model = activeModel,
                // The label (and the image role) come from the node's accessibility step in the chain, so TalkBack
                // reads it once; without a label the image is decorative and skipped.
                contentDescription = null,
                modifier = imageModifier,
                onLoading = { isLoading = true },
                onSuccess = { isLoading = false },
                onError = {
                    if (stage == IMAGE_NONE) return@AsyncImage // no model: nothing was requested
                    val which = if (stage == IMAGE_SRC) src else "fallback $fallback"
                    android.util.Log.w("zn", "image failed: $which — ${it.result.throwable}")
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
            ZnNode(f, ref.template, ref.instance, ref.node, m, definiteWidth = stretched || child.width != null)
        }
    }
}

/** A node's modifier chain (built once, or per instance when it reads slots). */
@Composable
internal fun nodeChain(s: ZnNodeSpec, inst: ZnInstance): Modifier =
    if (s.hasDynamicChain) dynamicChain(s, inst, root = false) else s.staticChain

/** The screen entry a node belongs to (provided per screen by ZnNavHost), for impressions. 0 = none. */
internal val LocalZnEntry = staticCompositionLocalOf { 0 }

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
 * A <Carousel> (feeds proposal, step 2.4c): a native pager. Pages are its children (anchors expanded, usually a
 * `.map`). Paging, snapping, auto-advance and dots are all native: no JS timer, no re-render per page. Auto-advance
 * runs only while the carousel is composed (on screen, its screen on top) and the app is resumed, and waits
 * `pauseAfterTouch` after the user touched it. `onPageChange` reaches JS only if it is bound.
 */
@Composable
private fun ZnCarousel(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    val refs = childRefs(f, t, inst, s)
    val pager = rememberPagerState { refs.size }
    Column(mod) {
        HorizontalPager(
            state = pager,
            modifier = Modifier.fillMaxWidth(),
            contentPadding = s.contentPadding ?: PaddingValues(0.dp),
            pageSize = s.itemWidth?.let { PageSize.Fixed(it.dp) } ?: PageSize.Fill,
            pageSpacing = s.gap.dp,
            verticalAlignment = Alignment.Top,
            key = { refs.getOrNull(it)?.key ?: it },
        ) { page ->
            val ref = refs.getOrNull(page) ?: return@HorizontalPager
            ZnNode(f, ref.template, ref.instance, ref.node, Modifier, definiteWidth = true)
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
    LazyColumn(
        modifier = mod,
        state = state,
        verticalArrangement = if (s.gap > 0f) Arrangement.spacedBy(s.gap.dp) else Arrangement.Top,
    ) {
        items(count = rows.size, key = { rows[it].key }, contentType = { rows[it].type }) { i ->
            val row = rows.getOrNull(i) ?: return@items
            val mounted = list.bound[row.key]?.let(ZnStore::find)
            val t = f.getOrNull(mounted?.templateId ?: row.type) ?: return@items
            val ri = mounted ?: ZnStore.placeholder(row.type, t)
            ZnNode(f, t, ri, 0, Modifier.fillMaxWidth(), definiteWidth = true)
        }
    }
    if (s.onRange != 0 || s.onEndReached != 0) {
        LaunchedEffect(state, inst.id, node) {
            var endSentAt = -1
            snapshotFlow {
                val visible = state.layoutInfo.visibleItemsInfo
                (visible.firstOrNull()?.index ?: 0) to (visible.lastOrNull()?.index ?: 0)
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
private fun dynamicChain(s: ZnNodeSpec, inst: ZnInstance, root: Boolean): Modifier {
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
    return remember(s, inst, disabled, indication, layer, background, aLabel) {
        val press = if (s.type == Registry.Component.PRESSABLE) {
            Modifier.znPress(s, inst, enabled = !disabled, view, interactions, indication)
        } else null
        val pad = if (s.hasDynamicPadding) {
            val base = s.staticPadding
            val cells = s.paddingSlots.map { if (it >= 0) inst.slot(it) else null }
            fun edge(i: Int, static: Float) = (cells[i]?.value as? Double)?.toFloat() ?: static
            ({ Edges(edge(0, base.start), edge(1, base.top), edge(2, base.end), edge(3, base.bottom)) })
        } else null
        val accessibility = if (s.type != Registry.Component.PRESSABLE) s.accessibilitySemantics(aLabel ?: s.accessibilityLabel) else null
        s.buildChain(layer, background, press, pad, accessibility)
    }
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

private fun verticalArrangement(s: ZnNodeSpec): Arrangement.Vertical =
    if (s.gap > 0f && s.justify in listOf(-1, Registry.JustifyContent.FLEX_START)) Arrangement.spacedBy(s.gap.dp())
    else when (s.justify) {
        Registry.JustifyContent.CENTER -> Arrangement.Center
        Registry.JustifyContent.FLEX_END -> Arrangement.Bottom
        Registry.JustifyContent.SPACE_BETWEEN -> Arrangement.SpaceBetween
        Registry.JustifyContent.SPACE_AROUND -> Arrangement.SpaceAround
        Registry.JustifyContent.SPACE_EVENLY -> Arrangement.SpaceEvenly
        else -> Arrangement.Top
    }

private fun horizontalArrangement(s: ZnNodeSpec): Arrangement.Horizontal =
    if (s.gap > 0f && s.justify in listOf(-1, Registry.JustifyContent.FLEX_START)) Arrangement.spacedBy(s.gap.dp())
    else when (s.justify) {
        Registry.JustifyContent.CENTER -> Arrangement.Center
        Registry.JustifyContent.FLEX_END -> Arrangement.End
        Registry.JustifyContent.SPACE_BETWEEN -> Arrangement.SpaceBetween
        Registry.JustifyContent.SPACE_AROUND -> Arrangement.SpaceAround
        Registry.JustifyContent.SPACE_EVENLY -> Arrangement.SpaceEvenly
        else -> Arrangement.Start
    }

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

private fun Float.dp() = androidx.compose.ui.unit.Dp(this)

/**
 * Nested <Text> spans: the text holds one piece per span, joined by U+001F (compile.ts `textChildren`). [cap] is the
 * parent's maxFontScale cap ([ZnNodeSpec.fontScaleCap]); a span's own sizes are capped too. A span without its own
 * size keeps the parent's (already capped) size.
 */
private fun spannedText(
    text: String,
    spans: List<androidx.compose.ui.text.SpanStyle>,
    cap: Float = 1f,
) = androidx.compose.ui.text.buildAnnotatedString {
    text.split('\u001f').forEachIndexed { i, piece ->
        val style = spans.getOrNull(i)
        if (style == null) {
            append(piece)
        } else {
            val capped = if (cap == 1f) style
            else style.copy(fontSize = style.fontSize.scaledSp(cap), letterSpacing = style.letterSpacing.scaledSp(cap))
            withStyle(capped) { append(piece) }
        }
    }
}
