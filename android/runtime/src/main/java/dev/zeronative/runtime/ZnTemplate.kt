package dev.zeronative.runtime

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private const val NONE = -1

/** Padding or margin per edge, in dp. */
class Edges(val start: Float, val top: Float, val end: Float, val bottom: Float) {
    fun plus(s: Float, t: Float, e: Float, b: Float) = Edges(start + s, top + t, end + e, bottom + b)
    fun toPadding() = PaddingValues(start.dp, top.dp, end.dp, bottom.dp)
}

/** An icon as SVG path data, parsed once ("minX minY width height|pathData", see packages/ui Icon docs). */
class ZnIcon(val minX: Float, val minY: Float, val width: Float, val height: Float, val path: Path) {
    companion object {
        fun parse(spec: String): ZnIcon? {
            val bar = spec.indexOf('|')
            if (bar < 0) return null
            val box = spec.substring(0, bar).trim().split(Regex("[\\s,]+")).mapNotNull { it.toFloatOrNull() }
            if (box.size != 4 || box[2] <= 0f || box[3] <= 0f) return null
            val path = PathParser().parsePathString(spec.substring(bar + 1)).toPath()
            return ZnIcon(box[0], box[1], box[2], box[3], path)
        }
    }
}

/**
 * One node of a template, prepared once (ARCHITECTURE.md §9.1): typed fields instead of prop lookups, colours and
 * enums already decoded, and the modifier chain pre-built in the fixed order (docs/styling-and-layout.md §4) when
 * nothing in it changes at runtime.
 */
@Immutable
class ZnNodeSpec internal constructor(raw: RawTemplate, val index: Int, val children: IntArray) {
    val type: Int = raw.component[index]
    private val p: Map<Int, Any?> = raw.props[index]

    // Layout of this node
    val margin: Edges? = edges(Registry.Prop.MARGIN, Registry.Prop.MARGIN_HORIZONTAL, Registry.Prop.MARGIN_VERTICAL,
        Registry.Prop.MARGIN_START, Registry.Prop.MARGIN_TOP, Registry.Prop.MARGIN_END, Registry.Prop.MARGIN_BOTTOM)
    val padding: Edges? = edges(Registry.Prop.PADDING, Registry.Prop.PADDING_HORIZONTAL, Registry.Prop.PADDING_VERTICAL,
        Registry.Prop.PADDING_START, Registry.Prop.PADDING_TOP, Registry.Prop.PADDING_END, Registry.Prop.PADDING_BOTTOM)
    val width: Any? = p[Registry.Prop.WIDTH]   // Double (dp) or ZnPercent
    val height: Any? = p[Registry.Prop.HEIGHT]
    val minWidth = num(Registry.Prop.MIN_WIDTH)
    val maxWidth = num(Registry.Prop.MAX_WIDTH)
    val minHeight = num(Registry.Prop.MIN_HEIGHT)
    val maxHeight = num(Registry.Prop.MAX_HEIGHT)
    val flex = num(Registry.Prop.FLEX) ?: 0f
    val aspectRatio = num(Registry.Prop.ASPECT_RATIO)
    val alignSelf = enum(Registry.Prop.ALIGN_SELF)

    // Absolute position (only inside Stack)
    val absolute = enum(Registry.Prop.POSITION) == Registry.Position.ABSOLUTE
    val top = num(Registry.Prop.TOP)
    val bottom = num(Registry.Prop.BOTTOM)
    val start = num(Registry.Prop.START)
    val end = num(Registry.Prop.END)
    val zIndex = num(Registry.Prop.Z_INDEX)

    // Layout of children
    val gap = num(Registry.Prop.GAP) ?: 0f
    val justify = enum(Registry.Prop.JUSTIFY_CONTENT)
    val alignItems = enum(Registry.Prop.ALIGN_ITEMS)

    // Drawing
    val background: Color? = color(Registry.Prop.BACKGROUND_COLOR)
    val radius = num(Registry.Prop.BORDER_RADIUS) ?: 0f
    val borderWidth = num(Registry.Prop.BORDER_WIDTH) ?: 0f
    val borderTopWidth = num(Registry.Prop.BORDER_TOP_WIDTH) ?: 0f
    val borderBottomWidth = num(Registry.Prop.BORDER_BOTTOM_WIDTH) ?: 0f
    val borderColor: Color = color(Registry.Prop.BORDER_COLOR) ?: Color.Black
    val opacity = num(Registry.Prop.OPACITY) ?: 1f
    val elevation = num(Registry.Prop.ELEVATION) ?: 0f
    val shadowColor: Color = color(Registry.Prop.SHADOW_COLOR) ?: Color.Black
    val clip = enum(Registry.Prop.OVERFLOW) == Registry.Overflow.HIDDEN
    val shape: Shape = if (radius > 0f) RoundedCornerShape(radius.dp) else RectangleShape

    // Transform
    val scaleX = (num(Registry.Prop.SCALE) ?: 1f) * (num(Registry.Prop.SCALE_X) ?: 1f)
    val scaleY = (num(Registry.Prop.SCALE) ?: 1f) * (num(Registry.Prop.SCALE_Y) ?: 1f)
    val translateX = num(Registry.Prop.TRANSLATE_X) ?: 0f
    val translateY = num(Registry.Prop.TRANSLATE_Y) ?: 0f
    val rotate = num(Registry.Prop.ROTATE) ?: 0f
    private val hasTransform = scaleX != 1f || scaleY != 1f || translateX != 0f || translateY != 0f || rotate != 0f

    // Content
    val text: String? = p[Registry.Prop.TEXT] as String?
    val color: Color? = color(Registry.Prop.COLOR)
    val maxLines = num(Registry.Prop.NUMBER_OF_LINES)?.toInt() ?: Int.MAX_VALUE
    val textStyle = TextStyle(
        fontSize = (num(Registry.Prop.FONT_SIZE) ?: 14f).sp,
        fontWeight = num(Registry.Prop.FONT_WEIGHT)?.let { FontWeight(it.toInt().coerceIn(1, 1000)) },
        fontStyle = if (enum(Registry.Prop.FONT_STYLE) == Registry.FontStyle.ITALIC) FontStyle.Italic else null,
        textDecoration = when (enum(Registry.Prop.TEXT_DECORATION_LINE)) {
            Registry.TextDecorationLine.UNDERLINE -> TextDecoration.Underline
            Registry.TextDecorationLine.LINE_THROUGH -> TextDecoration.LineThrough
            else -> null
        },
        textAlign = when (enum(Registry.Prop.TEXT_ALIGN)) {
            Registry.TextAlign.CENTER -> TextAlign.Center
            Registry.TextAlign.END -> TextAlign.End
            else -> TextAlign.Start
        },
        lineHeight = num(Registry.Prop.LINE_HEIGHT)?.sp ?: TextStyle.Default.lineHeight,
        letterSpacing = num(Registry.Prop.LETTER_SPACING)?.sp ?: TextStyle.Default.letterSpacing,
    )
    val src: String? = p[Registry.Prop.SRC] as String?
    val contentScale = enum(Registry.Prop.CONTENT_SCALE)
    val icon: ZnIcon? = (p[Registry.Prop.ICON] as String?)?.let(ZnIcon::parse)

    // Pressable
    val disabled = p[Registry.Prop.DISABLED] == true
    val haptic = p[Registry.Prop.HAPTIC] == true
    val repeatDelayMs = (num(Registry.Prop.REPEAT_DELAY) ?: 400f).toLong()
    val repeatIntervalMs = (num(Registry.Prop.REPEAT_INTERVAL) ?: 100f).toLong().coerceAtLeast(16)

    // Slots: the slot id bound to a prop, or -1 when the prop is static.
    val textSlot = slotFor(raw, Registry.Prop.TEXT)
    val colorSlot = slotFor(raw, Registry.Prop.COLOR)
    val backgroundSlot = slotFor(raw, Registry.Prop.BACKGROUND_COLOR)
    val opacitySlot = slotFor(raw, Registry.Prop.OPACITY)
    val srcSlot = slotFor(raw, Registry.Prop.SRC)
    val disabledSlot = slotFor(raw, Registry.Prop.DISABLED)

    // Events: the event id JS listens to, or 0.
    val onPress = eventFor(raw, Registry.Event.ON_PRESS)
    val onPressIn = eventFor(raw, Registry.Event.ON_PRESS_IN)
    val onPressOut = eventFor(raw, Registry.Event.ON_PRESS_OUT)
    val onLongPress = eventFor(raw, Registry.Event.ON_LONG_PRESS)
    val onPressRepeat = eventFor(raw, Registry.Event.ON_PRESS_REPEAT)

    /** True when the drawing chain reads a slot, so it must be built per instance instead of once here. */
    val hasDynamicChain = backgroundSlot != NONE || opacitySlot != NONE || type == Registry.Component.PRESSABLE

    /** Pre-built chain for nodes whose chain never changes (most nodes). */
    val staticChain: Modifier = if (hasDynamicChain) Modifier else buildChain(null, null, null)

    /**
     * The fixed order (docs/styling-and-layout.md §4): margin → size → transform + opacity → shadow → background →
     * border → clip → press feedback → padding (+ border widths). Dynamic opacity and background are read in the
     * draw phase, so a change redraws only this node (§8.3).
     */
    fun buildChain(alpha: (() -> Float)?, background: (() -> Color)?, press: Modifier?): Modifier {
        var m: Modifier = Modifier
        margin?.let { m = m.padding(it.toPadding()) }
        when (val w = width) {
            is Double -> m = m.width(w.toFloat().dp)
            is ZnPercent -> m = m.fillMaxWidth(w.fraction.toFloat())
        }
        when (val h = height) {
            is Double -> m = m.height(h.toFloat().dp)
            is ZnPercent -> m = m.fillMaxHeight(h.fraction.toFloat())
        }
        if (minWidth != null || maxWidth != null) m = m.widthIn(minWidth.orUnspecified(), maxWidth.orUnspecified())
        if (minHeight != null || maxHeight != null) m = m.heightIn(minHeight.orUnspecified(), maxHeight.orUnspecified())
        aspectRatio?.let { m = m.aspectRatio(it) }
        if (alpha != null || opacity < 1f || hasTransform) {
            val staticAlpha = opacity
            m = m.graphicsLayer {
                this.alpha = alpha?.invoke() ?: staticAlpha
                this.scaleX = this@ZnNodeSpec.scaleX
                this.scaleY = this@ZnNodeSpec.scaleY
                rotationZ = rotate
                translationX = translateX.dp.toPx()
                translationY = translateY.dp.toPx()
            }
        }
        if (elevation > 0f) m = m.shadow(elevation.dp, shape, clip = false, ambientColor = shadowColor, spotColor = shadowColor)
        if (background != null) {
            val s = shape
            m = m.drawBehind { drawOutline(s.createOutline(size, layoutDirection, this), background()) }
        } else {
            this.background?.let { m = m.background(it, shape) }
        }
        if (borderWidth > 0f) m = m.border(borderWidth.dp, borderColor, shape)
        if (borderTopWidth > 0f || borderBottomWidth > 0f) {
            val c = borderColor
            val topW = borderTopWidth
            val bottomW = borderBottomWidth
            m = m.drawBehind {
                if (topW > 0f) drawRect(c, Offset.Zero, Size(size.width, topW.dp.toPx()))
                if (bottomW > 0f) {
                    val h = bottomW.dp.toPx()
                    drawRect(c, Offset(0f, size.height - h), Size(size.width, h))
                }
            }
        }
        // Step 7 clips for overflow: 'hidden'. Press feedback (step 8) must also stay inside a rounded shape, or the
        // pressed highlight shows square corners on a rounded button (found on the Lava, step 1.2).
        // Images clip to their rounded shape by default, as in React Native.
        val clipsByDefault = radius > 0f && (press != null || type == Registry.Component.IMAGE)
        if (clip || clipsByDefault) m = m.clip(shape)
        press?.let { m = m.then(it) }
        // Borders take space: content sits inside them (zn flex rule 2).
        val pad = padding ?: Edges(0f, 0f, 0f, 0f)
        val inner = pad.plus(borderWidth, borderWidth + borderTopWidth, borderWidth, borderWidth + borderBottomWidth)
        if (padding != null || borderWidth > 0f || borderTopWidth > 0f || borderBottomWidth > 0f) {
            m = m.padding(inner.toPadding())
        }
        return m
    }

    private fun num(prop: Int): Float? = (p[prop] as Double?)?.toFloat()
    private fun enum(prop: Int): Int = (p[prop] as ZnEnum?)?.value ?: NONE
    private fun color(prop: Int): Color? = (p[prop] as ZnColor?)?.let { Color(it.argb) }

    // RN precedence: a specific edge beats the axis (Horizontal/Vertical), which beats the all-edges value.
    private fun edges(all: Int, h: Int, v: Int, s: Int, t: Int, e: Int, b: Int): Edges? {
        if (listOf(all, h, v, s, t, e, b).none { p.containsKey(it) }) return null
        val a = num(all) ?: 0f
        val hh = num(h) ?: a
        val vv = num(v) ?: a
        return Edges(num(s) ?: hh, num(t) ?: vv, num(e) ?: hh, num(b) ?: vv)
    }

    private fun slotFor(raw: RawTemplate, prop: Int): Int =
        raw.slots.indexOfFirst { it.node == index && it.prop == prop }

    private fun eventFor(raw: RawTemplate, kind: Int): Int =
        raw.events.firstOrNull { it.node == index && it.kind == kind }?.eventId ?: 0
}

private fun Float?.orUnspecified(): Dp = this?.dp ?: Dp.Unspecified

/** A template prepared for drawing. Built once per template and shared by all its instances. */
@Immutable
class ZnTemplate(val raw: RawTemplate) {
    val nodes: Array<ZnNodeSpec>
    /** Slot defaults, in slot order (shown until JS sends a value). */
    val slotDefaults: List<Any?> = raw.slots.map { it.default }

    init {
        val n = raw.component.size
        val children = Array(n) { ArrayList<Int>() }
        for (i in 1 until n) children[raw.parent[i]].add(i)
        nodes = Array(n) { ZnNodeSpec(raw, it, children[it].toIntArray()) }
    }
}
