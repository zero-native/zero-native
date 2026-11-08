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
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.addOutline
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.offset
import androidx.compose.ui.unit.sp

private const val NONE = -1

/** Padding or margin per edge, in dp. Equal by value, so a dynamic margin that didn't change keeps the node's chain. */
data class Edges(val start: Float, val top: Float, val end: Float, val bottom: Float) {
    val hasNegative: Boolean get() = start < 0f || top < 0f || end < 0f || bottom < 0f
    fun plus(s: Float, t: Float, e: Float, b: Float) = Edges(start + s, top + t, end + e, bottom + b)
    /**
     * Never below 0: Compose's PaddingValues throws on a negative value, and margin, padding and border widths all go
     * through here. The compiler already refuses negative values written in a style; this catches the rest (a slot's
     * padding on a Scroll or List, an old bundle), so nothing can crash (second-opinions 113). RN also treats a
     * negative padding as 0.
     */
    fun toPadding() = PaddingValues(
        start.coerceAtLeast(0f).dp, top.coerceAtLeast(0f).dp, end.coerceAtLeast(0f).dp, bottom.coerceAtLeast(0f).dp,
    )
}

/**
 * A CSS linear gradient, parsed once from the compiler's "angle|argb@position|..." (position 0–1, or -1 = spread
 * evenly). Angles follow CSS: 0deg points up, 90deg right, 180deg down (the default).
 */
class ZnGradient(private val angleDeg: Float, private val colors: List<Color>, private val stops: FloatArray) {
    /** The brush for a box of [size]: the gradient line goes through the centre, long enough to reach the corners. */
    fun brush(size: Size): Brush {
        val rad = Math.toRadians(angleDeg.toDouble())
        val dx = kotlin.math.sin(rad).toFloat()
        val dy = -kotlin.math.cos(rad).toFloat()
        val half = (kotlin.math.abs(size.width * dx) + kotlin.math.abs(size.height * dy)) / 2f
        val c = Offset(size.width / 2f, size.height / 2f)
        val start = Offset(c.x - dx * half, c.y - dy * half)
        val end = Offset(c.x + dx * half, c.y + dy * half)
        return Brush.linearGradient(colorStops = Array(colors.size) { stops[it] to colors[it] }, start = start, end = end)
    }

    companion object {
        fun parse(spec: String): ZnGradient? {
            val parts = spec.split('|')
            val angle = parts.firstOrNull()?.toFloatOrNull() ?: return null
            val raw = parts.drop(1).mapNotNull { stop ->
                val (argb, pos) = stop.split('@').takeIf { it.size == 2 } ?: return@mapNotNull null
                Color(argb.toLong().toInt()) to (pos.toFloatOrNull() ?: -1f)
            }
            if (raw.size < 2) return null
            // Missing positions are spread evenly, as in CSS.
            val stops = FloatArray(raw.size) { i -> raw[i].second.takeIf { it >= 0f } ?: (i.toFloat() / (raw.size - 1)) }
            return ZnGradient(angle, raw.map { it.first }, stops)
        }
    }
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

    /** True when the template sets [prop] (static or a slot), e.g. to tell "not set" from a default value. */
    fun has(prop: Int): Boolean = p.containsKey(prop)

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
    /** RN borderStyle (registry 16): dashed or dotted borders and top / bottom lines; solid otherwise. */
    val borderDashed = enum(Registry.Prop.BORDER_STYLE).let { it == Registry.BorderStyle.DASHED || it == Registry.BorderStyle.DOTTED }
    val borderStyle = enum(Registry.Prop.BORDER_STYLE)
    val opacity = num(Registry.Prop.OPACITY) ?: 1f
    val elevation = num(Registry.Prop.ELEVATION) ?: 0f
    val shadowColor: Color = color(Registry.Prop.SHADOW_COLOR) ?: Color.Black
    val clip = enum(Registry.Prop.OVERFLOW) == Registry.Overflow.HIDDEN
    // Per corner (registry 15), as in RN: the corner's own value, else borderRadius. Start / End beat Left / Right;
    // Left / Right are drawn as Start / End (the same left to right).
    private fun corner(left: Int, start: Int) = num(start) ?: num(left) ?: radius
    internal val topStart = corner(Registry.Prop.BORDER_TOP_LEFT_RADIUS, Registry.Prop.BORDER_TOP_START_RADIUS)
    internal val topEnd = corner(Registry.Prop.BORDER_TOP_RIGHT_RADIUS, Registry.Prop.BORDER_TOP_END_RADIUS)
    internal val bottomEnd = corner(Registry.Prop.BORDER_BOTTOM_RIGHT_RADIUS, Registry.Prop.BORDER_BOTTOM_END_RADIUS)
    internal val bottomStart = corner(Registry.Prop.BORDER_BOTTOM_LEFT_RADIUS, Registry.Prop.BORDER_BOTTOM_START_RADIUS)
    /** Any rounded corner: rounded nodes clip press feedback and images to their shape. */
    val rounded = topStart > 0f || topEnd > 0f || bottomEnd > 0f || bottomStart > 0f
    val shape: Shape = when {
        !rounded -> RectangleShape
        topStart == topEnd && topEnd == bottomEnd && bottomEnd == bottomStart -> RoundedCornerShape(topStart.dp)
        else -> RoundedCornerShape(
            topStart = topStart.coerceAtLeast(0f).dp, topEnd = topEnd.coerceAtLeast(0f).dp,
            bottomEnd = bottomEnd.coerceAtLeast(0f).dp, bottomStart = bottomStart.coerceAtLeast(0f).dp,
        )
    }

    // Transform
    val scaleX = (num(Registry.Prop.SCALE) ?: 1f) * (num(Registry.Prop.SCALE_X) ?: 1f)
    val scaleY = (num(Registry.Prop.SCALE) ?: 1f) * (num(Registry.Prop.SCALE_Y) ?: 1f)
    val translateX = num(Registry.Prop.TRANSLATE_X) ?: 0f
    val translateY = num(Registry.Prop.TRANSLATE_Y) ?: 0f
    val rotate = num(Registry.Prop.ROTATE) ?: 0f
    private val hasTransform = scaleX != 1f || scaleY != 1f || translateX != 0f || translateY != 0f || rotate != 0f
    /**
     * RN transformOrigin (registry 20): the pivot of scale and rotate, as fractions of the size ("0 0.5" = the left
     * edge's middle; the compiler writes it). Absent or unreadable: the centre, as before.
     */
    val transformOrigin: TransformOrigin = parseTransformOrigin(p[Registry.Prop.TRANSFORM_ORIGIN] as String?)
    // The parts of scaleX / scaleY above, kept apart because each can have its own slot (step 3.6).
    val scaleBase = num(Registry.Prop.SCALE) ?: 1f
    val scaleXOnly = num(Registry.Prop.SCALE_X) ?: 1f
    val scaleYOnly = num(Registry.Prop.SCALE_Y) ?: 1f

    // Animation (step 3.6, ZnAnimation.kt)
    internal val animate: ZnAnimate? = (p[Registry.Prop.ANIMATE] as String?)?.let(ZnAnimate::parse)
    internal val enter: ZnTransition? = (p[Registry.Prop.ENTER] as String?)?.let(ZnTransition::parse)
    internal val exit: ZnTransition? = (p[Registry.Prop.EXIT] as String?)?.let(ZnTransition::parse)
    /** Loops and keyframes that play by themselves (registry 13): they need the per-instance chain. */
    internal val hasMotion = animate?.selfPlaying == true
    val paused = p[Registry.Prop.PAUSED] == true

    // Content
    val text: String? = p[Registry.Prop.TEXT] as String?
    val color: Color? = color(Registry.Prop.COLOR)
    val maxLines = num(Registry.Prop.NUMBER_OF_LINES)?.toInt() ?: Int.MAX_VALUE
    val selectable = p[Registry.Prop.SELECTABLE] == true
    val selectableSlot = slotFor(raw, Registry.Prop.SELECTABLE)
    val adjustsFontSizeToFit = p[Registry.Prop.ADJUSTS_FONT_SIZE_TO_FIT] == true
    val minimumFontScale = num(Registry.Prop.MINIMUM_FONT_SCALE)
    /**
     * RN textDecorationStyle "dashed" / "dotted" (registry 16) with an underline or line-through: the line is drawn by
     * the renderer (ZnRenderer.kt drawTextDecoration), as Compose only draws solid ones. 0 = Compose draws it.
     */
    val dashedDecoration: Int = enum(Registry.Prop.TEXT_DECORATION_STYLE).let { style ->
        val line = enum(Registry.Prop.TEXT_DECORATION_LINE)
        val dashed = style == Registry.TextDecorationStyle.DASHED || style == Registry.TextDecorationStyle.DOTTED
        if (dashed && (line == Registry.TextDecorationLine.UNDERLINE || line == Registry.TextDecorationLine.LINE_THROUGH)) line else 0
    }
    val textDecorationStyle = enum(Registry.Prop.TEXT_DECORATION_STYLE)
    val textStyle = TextStyle(
        fontSize = (num(Registry.Prop.FONT_SIZE) ?: 14f).sp,
        fontWeight = num(Registry.Prop.FONT_WEIGHT)?.let { FontWeight(it.toInt().coerceIn(1, 1000)) },
        fontStyle = if (enum(Registry.Prop.FONT_STYLE) == Registry.FontStyle.ITALIC) FontStyle.Italic else null,
        textDecoration = if (dashedDecoration != 0) null else when (enum(Registry.Prop.TEXT_DECORATION_LINE)) {
            Registry.TextDecorationLine.UNDERLINE -> TextDecoration.Underline
            Registry.TextDecorationLine.LINE_THROUGH -> TextDecoration.LineThrough
            else -> null
        },
        // RN includeFontPadding (registry 16): only when written true; Compose's default leaves the padding out.
        platformStyle = if (p[Registry.Prop.INCLUDE_FONT_PADDING] == true) {
            @Suppress("DEPRECATION") androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = true)
        } else null,
        textAlign = when (enum(Registry.Prop.TEXT_ALIGN)) {
            Registry.TextAlign.CENTER -> TextAlign.Center
            Registry.TextAlign.END -> TextAlign.End
            else -> TextAlign.Start
        },
        lineHeight = num(Registry.Prop.LINE_HEIGHT)?.sp ?: TextStyle.Default.lineHeight,
        letterSpacing = num(Registry.Prop.LETTER_SPACING)?.sp ?: TextStyle.Default.letterSpacing,
    )
    /** Nested <Text> spans: one style per span; the text holds the spans' texts joined by U+001F. */
    val spans: List<SpanStyle>? = (p[Registry.Prop.SPANS] as String?)?.let(::parseSpans)
    /** Registry 16: spans that change at runtime (core text-spans.ts) come in this slot, as the same JSON. */
    val spansSlot = slotFor(raw, Registry.Prop.SPANS)
    /** Registry 16: a span with onPress was tapped; the payload is its index. */
    val onSpanPress = eventFor(raw, Registry.Event.ON_SPAN_PRESS)
    /** RN textTransform (registry 15): applied to the text as it is drawn, so text from a slot changes case too. */
    val textTransform = enum(Registry.Prop.TEXT_TRANSFORM)
    /** RN testID (registry 15): a Compose test tag; ZnNavHost shows tags to UI tests as resource ids. */
    val testID: String? = p[Registry.Prop.TEST_ID] as String?
    /** RN pointerEvents (registry 15, ZnTouch.kt): the static value, or -1 when not written. */
    val pointerEvents = enum(Registry.Prop.POINTER_EVENTS)
    val pointerEventsSlot = slotFor(raw, Registry.Prop.POINTER_EVENTS)
    /**
     * A layer drawn over its siblings: an absolute Box / Column / Row / Stack with a background or children. Without
     * pointerEvents it stops taps, as a React Native view does, so a ported "busy" overlay blocks the button under it
     * (second-opinions 74). Other elements without handlers still let taps through.
     */
    val absoluteLayer = absolute &&
        (type == Registry.Component.BOX || type == Registry.Component.COLUMN ||
            type == Registry.Component.ROW || type == Registry.Component.STACK) &&
        (background != null || slotFor(raw, Registry.Prop.BACKGROUND_COLOR) >= 0 || children.isNotEmpty())
    /** Pressable hitSlop (registry 15): start, top, end, bottom in dp, or null. */
    val hitSlop: FloatArray? = parseHitSlop(p[Registry.Prop.HIT_SLOP] as String?)
    val src: String? = p[Registry.Prop.SRC] as String?
    val contentScale = enum(Registry.Prop.CONTENT_SCALE)
    val icon: ZnIcon? = (p[Registry.Prop.ICON] as String?)?.let(ZnIcon::parse)
    // Svg and SvgPart (docs/svg.md §7). The draw data stays a string here: it is parsed on first draw (ZnSvg.kt).
    val svg: String? = p[Registry.Prop.SVG] as String?
    val autoMirror = p[Registry.Prop.AUTO_MIRROR] == true
    /** SvgPart: the index of the op it changes (G and S ops, counted from 0), or -1. */
    val part = num(Registry.Prop.PART)?.toInt() ?: NONE
    val fill: Color? = color(Registry.Prop.FILL)
    val stroke: Color? = color(Registry.Prop.STROKE)
    // <SvgPart> motion (registry 13): trims (0–1 of the line) and the point it turns around (viewBox units).
    val trimStart = num(Registry.Prop.TRIM_START) ?: 0f
    val trimEnd = num(Registry.Prop.TRIM_END) ?: 1f
    val trimOffset = num(Registry.Prop.TRIM_OFFSET) ?: 0f
    internal val hasTrimProps = p.containsKey(Registry.Prop.TRIM_START) || p.containsKey(Registry.Prop.TRIM_END) ||
        p.containsKey(Registry.Prop.TRIM_OFFSET)
    val pivotX = num(Registry.Prop.PIVOT_X) ?: 0f
    val pivotY = num(Registry.Prop.PIVOT_Y) ?: 0f
    // <SvgPart> registry 13: stroke width and dash offset (viewBox units; NaN = the shapes' own), the outline
    // scale of one shape, and morphing (keyframe paths, and where it is in them; -1 = the shape's own path).
    val strokeWidth = num(Registry.Prop.STROKE_WIDTH) ?: Float.NaN
    val dashOffset = num(Registry.Prop.DASH_OFFSET) ?: Float.NaN
    val scaleOutline = p[Registry.Prop.SCALE_OUTLINE] == true
    val morph: String? = p[Registry.Prop.MORPH] as String?
    val morphAt = num(Registry.Prop.MORPH_AT) ?: -1f
    // <SvgPart> registry 13 (set by the compiler): a path to move along and where on it (-1: not moved), skews
    // (degrees), and the space its transforms happen in ("a b c d e f"; null: viewBox units).
    val motionPath: String? = p[Registry.Prop.MOTION_PATH] as String?
    val motionAt = num(Registry.Prop.MOTION_AT) ?: -1f
    val skewX = num(Registry.Prop.SKEW_X) ?: 0f
    val skewY = num(Registry.Prop.SKEW_Y) ?: 0f
    val frame: String? = p[Registry.Prop.FRAME] as String?
    /** A trimmed piece of length 0 still draws its caps (an SVG dash of length 0, registry 13). */
    val trimCaps = p[Registry.Prop.TRIM_CAPS] == true

    // Pressable
    val disabled = p[Registry.Prop.DISABLED] == true
    val haptic = p[Registry.Prop.HAPTIC] == true
    val pressFeedback = enum(Registry.Prop.PRESS_FEEDBACK) ?: Registry.PressFeedback.RIPPLE
    val rippleColor: Color? = color(Registry.Prop.RIPPLE_COLOR)
    val pressScale = num(Registry.Prop.PRESS_SCALE) ?: 1f
    val pressOpacity = num(Registry.Prop.PRESS_OPACITY) ?: 1f
    val rippleOpacity: Float? = num(Registry.Prop.RIPPLE_OPACITY)?.coerceIn(0f, 1f)
    val rippleBorderless = p[Registry.Prop.RIPPLE_BORDERLESS] == true
    val rippleRadius: Float? = num(Registry.Prop.RIPPLE_RADIUS)
    val highlightColor: Color = color(Registry.Prop.HIGHLIGHT_COLOR) ?: Color(0x1A000000)
    // Scroll: horizontal rails; its padding becomes content padding (it scrolls with the content, as in RN's
    // contentContainerStyle), so it is left out of the modifier chain.
    // List too (2026-11-05): `paddingBottom: 100` must let the last row scroll above a floating button, not leave a
    // fixed blank strip under the list.
    val horizontal = p[Registry.Prop.HORIZONTAL] == true
    private val paddingIsContent = type == Registry.Component.SCROLL || type == Registry.Component.CAROUSEL ||
        type == Registry.Component.LIST
    val contentPadding: PaddingValues? = if (paddingIsContent) padding?.toPadding() else null
    val gradient: ZnGradient? = (p[Registry.Prop.BACKGROUND_IMAGE] as String?)?.let(ZnGradient::parse)
    // Carousel
    val autoAdvanceMs = num(Registry.Prop.AUTO_ADVANCE)?.toLong() ?: 0L
    val pauseAfterTouchMs = num(Registry.Prop.PAUSE_AFTER_TOUCH)?.toLong() ?: 3000L
    val dots = p[Registry.Prop.DOTS] == true
    val dotColor: Color = color(Registry.Prop.DOT_COLOR) ?: Color(0xFFD1D5DB)
    val activeDotColor: Color = color(Registry.Prop.ACTIVE_DOT_COLOR) ?: Color(0xFF047857)
    val itemWidth = num(Registry.Prop.ITEM_WIDTH)
    val itemWidthPercent = num(Registry.Prop.ITEM_WIDTH_PERCENT)
    // Tabs: the child to draw
    val selected = num(Registry.Prop.SELECTED)?.toInt() ?: 0
    // Pull to refresh (vertical Scroll, List; ZnPullRefresh.kt)
    val refreshing = p[Registry.Prop.REFRESHING] == true
    val refreshColor: Color = color(Registry.Prop.REFRESH_COLOR) ?: Color(0xFF374151)
    val refreshBackground: Color = color(Registry.Prop.REFRESH_BACKGROUND) ?: Color.White
    // Sheet
    val visible = p[Registry.Prop.VISIBLE] == true
    val detents: List<String> = (p[Registry.Prop.DETENTS] as String?)?.split(',')?.map { it.trim() }
        ?.filter { it == "content" || it == "half" || it == "full" }?.ifEmpty { null } ?: listOf("content")
    val dismissible = p[Registry.Prop.DISMISSIBLE] != false
    /** Sheet `animateIn={false}` (registry 21): opens already at rest. */
    val animateIn = p[Registry.Prop.ANIMATE_IN] != false
    /** `visible` written on the node (a Modal without it is shown, as in RN). */
    val hasVisibleProp = p.containsKey(Registry.Prop.VISIBLE)
    // Modal (registry 15, ZnModal.kt)
    val transparent = p[Registry.Prop.TRANSPARENT] == true
    val animationType = enum(Registry.Prop.ANIMATION_TYPE)
    val statusBarTranslucent = p[Registry.Prop.STATUS_BAR_TRANSLUCENT] == true
    val navigationBarTranslucent = p[Registry.Prop.NAVIGATION_BAR_TRANSLUCENT] == true
    val onRequestClose = eventFor(raw, Registry.Event.ON_REQUEST_CLOSE)
    // StatusBar / NavigationBar (registry 15, ZnSystemBars.kt)
    val barStyle = enum(Registry.Prop.BAR_STYLE)
    val barStyleSlot = slotFor(raw, Registry.Prop.BAR_STYLE)
    val hidden = p[Registry.Prop.HIDDEN] == true
    val hasHiddenProp = p.containsKey(Registry.Prop.HIDDEN)
    val hiddenSlot = slotFor(raw, Registry.Prop.HIDDEN)
    /** <List> RN stickyHeaderIndices (registry 15): "1,30", or a slot with that text. */
    val stickyHeaderIndices: String? = p[Registry.Prop.STICKY_HEADER_INDICES] as String?
    val stickySlot = slotFor(raw, Registry.Prop.STICKY_HEADER_INDICES)
    val scrollCommandSlot = slotFor(raw, Registry.Prop.SCROLL_COMMAND)
    val commands: String? = p[Registry.Prop.COMMANDS] as String?
    val commandsSlot = slotFor(raw, Registry.Prop.COMMANDS)
    /** <List> RN inverted (registry 19): Compose reverseLayout, row 0 at the bottom. */
    val inverted: Boolean = p[Registry.Prop.INVERTED] == true
    val onShow = eventFor(raw, Registry.Event.ON_SHOW)
    // TextField
    val rawValue: Any? = p[Registry.Prop.VALUE]
    val value: String? = rawValue as? String
    val placeholder: String? = p[Registry.Prop.PLACEHOLDER] as String?
    val placeholderColor: Color = color(Registry.Prop.PLACEHOLDER_COLOR) ?: Color(0xFF9CA3AF)
    val keyboardType = enum(Registry.Prop.KEYBOARD_TYPE)
    val secure = p[Registry.Prop.SECURE_TEXT_ENTRY] == true
    val maxLength = num(Registry.Prop.MAX_LENGTH)?.toInt()
    val multiline = p[Registry.Prop.MULTILINE] == true
    val autoFocus = p[Registry.Prop.AUTO_FOCUS] == true
    val returnKeyType = enum(Registry.Prop.RETURN_KEY_TYPE)
    val autoComplete = enum(Registry.Prop.AUTO_COMPLETE)
    // OtpInput (registry 18)
    internal val otpTheme: ZnOtpTheme by lazy { ZnOtpTheme.parse(p[Registry.Prop.OTP_THEME] as String?) }
    val otpType = enum(Registry.Prop.OTP_TYPE)
    val blurOnFilled = p[Registry.Prop.BLUR_ON_FILLED] == true
    val invalid = p[Registry.Prop.INVALID] == true
    val editable = p[Registry.Prop.EDITABLE] != false
    val autoCapitalize = enum(Registry.Prop.AUTO_CAPITALIZE)
    val autoCorrect = p[Registry.Prop.AUTO_CORRECT] != false
    val selectionColor: Color? = color(Registry.Prop.SELECTION_COLOR)
    val repeatDelayMs = (num(Registry.Prop.REPEAT_DELAY) ?: 400f).toLong()
    val repeatIntervalMs = (num(Registry.Prop.REPEAT_INTERVAL) ?: 100f).toLong().coerceAtLeast(16)

    // Small Components & Accessibility (milestone 3 steps 3.7 & 3.8)
    val trackColor: Color? = color(Registry.Prop.TRACK_COLOR)
    val activeTrackColor: Color? = color(Registry.Prop.ACTIVE_TRACK_COLOR)
    val thumbColor: Color? = color(Registry.Prop.THUMB_COLOR)
    val activeColor: Color? = color(Registry.Prop.ACTIVE_COLOR)
    val size: Float? = num(Registry.Prop.SIZE)
    val fallbackSrc: String? = p[Registry.Prop.FALLBACK_SRC] as String?
    val loading: Int = enum(Registry.Prop.LOADING).let { if (it == NONE) Registry.Loading.NONE else it }
    val baseColor: Color? = color(Registry.Prop.BASE_COLOR)
    /** Shimmer's moving highlight: `highlightColor` when set (the same prop as Pressable's), else white at 55 %. */
    val shimmerHighlight: Color = color(Registry.Prop.HIGHLIGHT_COLOR) ?: Color.White.copy(alpha = 0.55f)
    val period: Float? = num(Registry.Prop.PERIOD)
    val accessibilityLabel: String? = p[Registry.Prop.ACCESSIBILITY_LABEL] as String?
    val accessibilityLabelSlot = slotFor(raw, Registry.Prop.ACCESSIBILITY_LABEL)
    val accessibilityHint: String? = p[Registry.Prop.ACCESSIBILITY_HINT] as String?
    val accessibilityRole: Int? = enum(Registry.Prop.ACCESSIBILITY_ROLE).let { if (it == NONE) null else it }
    val accessibilityHidden = p[Registry.Prop.ACCESSIBILITY_HIDDEN] == true
    val maxFontScale = num(Registry.Prop.MAX_FONT_SCALE)

    /**
     * The scale that brings the phone's [fontScale] down to [maxFontScale] (1 when there is no cap or it isn't
     * reached). Sizes in sp already include the phone's scale, so capping multiplies them by this.
     */
    fun fontScaleCap(fontScale: Float): Float {
        val max = maxFontScale ?: return 1f
        return if (fontScale > max && fontScale > 0f) max / fontScale else 1f
    }

    fun effectiveTextStyle(
        fontScale: Float,
        fontSizeOverride: Float? = null,
        lineHeightOverride: Float? = null,
        letterSpacingOverride: Float? = null,
    ): TextStyle {
        val f = fontScaleCap(fontScale)
        var ts = textStyle
        if (fontSizeOverride != null) ts = ts.copy(fontSize = fontSizeOverride.sp)
        if (lineHeightOverride != null) ts = ts.copy(lineHeight = lineHeightOverride.sp)
        if (letterSpacingOverride != null) ts = ts.copy(letterSpacing = letterSpacingOverride.sp)
        if (f == 1f) return ts
        return ts.copy(
            fontSize = ts.fontSize.scaledSp(f),
            lineHeight = ts.lineHeight.scaledSp(f),
            letterSpacing = ts.letterSpacing.scaledSp(f),
        )
    }

    /**
     * TalkBack semantics for a node that isn't a Pressable (Pressable does its own, ZnPress.kt), or null when the
     * node sets none. [label] is the static label or the slot's current value. A labelled Image (or Svg) gets the
     * image role; one without a label stays decorative (skipped).
     */
    @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class) // hideFromAccessibility
    internal fun accessibilitySemantics(label: String?): Modifier? {
        // A labelled <Canvas> is a picture too (a chart): TalkBack reads its label as an image (2026-11-08).
        val imageRole = (type == Registry.Component.IMAGE || type == Registry.Component.SVG || type == Registry.Component.CANVAS) && label != null
        if (!accessibilityHidden && accessibilityRole == null && label == null && !imageRole) return null
        return Modifier.semantics(mergeDescendants = label != null) {
            if (accessibilityHidden) hideFromAccessibility()
            if (label != null) contentDescription = label
            when (accessibilityRole) {
                Registry.AccessibilityRole.HEADER -> heading()
                Registry.AccessibilityRole.BUTTON -> role = Role.Button
                Registry.AccessibilityRole.IMAGE -> role = Role.Image
                Registry.AccessibilityRole.SWITCH -> role = Role.Switch
                Registry.AccessibilityRole.CHECKBOX -> role = Role.Checkbox
                else -> if (imageRole) role = Role.Image
            }
        }
    }

    private val staticAccessibility: Modifier? =
        if (type != Registry.Component.PRESSABLE && type != Registry.Component.OTP_INPUT) accessibilitySemantics(accessibilityLabel) else null

    // Slots: the slot id bound to a prop, or -1 when the prop is static.
    val textSlot = slotFor(raw, Registry.Prop.TEXT)
    val colorSlot = slotFor(raw, Registry.Prop.COLOR)
    val backgroundSlot = slotFor(raw, Registry.Prop.BACKGROUND_COLOR)
    val opacitySlot = slotFor(raw, Registry.Prop.OPACITY)
    val scaleSlot = slotFor(raw, Registry.Prop.SCALE)
    val scaleXSlot = slotFor(raw, Registry.Prop.SCALE_X)
    val scaleYSlot = slotFor(raw, Registry.Prop.SCALE_Y)
    val translateXSlot = slotFor(raw, Registry.Prop.TRANSLATE_X)
    val translateYSlot = slotFor(raw, Registry.Prop.TRANSLATE_Y)
    val rotateSlot = slotFor(raw, Registry.Prop.ROTATE)
    val hasTransformSlots = scaleSlot != NONE || scaleXSlot != NONE || scaleYSlot != NONE || translateXSlot != NONE ||
        translateYSlot != NONE || rotateSlot != NONE
    val srcSlot = slotFor(raw, Registry.Prop.SRC)
    val impressionKey: String? = p[Registry.Prop.IMPRESSION_KEY] as String?
    val impressionKeySlot = slotFor(raw, Registry.Prop.IMPRESSION_KEY)
    val hasImpression = impressionKey != null || impressionKeySlot != NONE
    val disabledSlot = slotFor(raw, Registry.Prop.DISABLED)
    val valueSlot = slotFor(raw, Registry.Prop.VALUE)
    val viewName: String? = p[Registry.Prop.VIEW_NAME] as String?
    val viewProps: String? = p[Registry.Prop.VIEW_PROPS] as String?
    val viewPropsSlot = slotFor(raw, Registry.Prop.VIEW_PROPS)
    val placeholderSlot = slotFor(raw, Registry.Prop.PLACEHOLDER)
    val editableSlot = slotFor(raw, Registry.Prop.EDITABLE)
    val invalidSlot = slotFor(raw, Registry.Prop.INVALID)
    /** Sheet `animateIn={expr}` (registry 22): read when the sheet opens. */
    val animateInSlot = slotFor(raw, Registry.Prop.ANIMATE_IN)
    val fillSlot = slotFor(raw, Registry.Prop.FILL)
    val strokeSlot = slotFor(raw, Registry.Prop.STROKE)
    val pausedSlot = slotFor(raw, Registry.Prop.PAUSED)
    val replaySlot = slotFor(raw, Registry.Prop.REPLAY)
    val trimStartSlot = slotFor(raw, Registry.Prop.TRIM_START)
    val trimEndSlot = slotFor(raw, Registry.Prop.TRIM_END)
    val trimOffsetSlot = slotFor(raw, Registry.Prop.TRIM_OFFSET)
    val strokeWidthSlot = slotFor(raw, Registry.Prop.STROKE_WIDTH)
    val dashOffsetSlot = slotFor(raw, Registry.Prop.DASH_OFFSET)
    /** An SvgPart cuts its line: static trims, trims that change at runtime, or animated ones. */
    internal val hasTrim = hasTrimProps || trimStartSlot != NONE || trimEndSlot != NONE || trimOffsetSlot != NONE ||
        animate?.let {
            it.timingFor(Registry.Prop.TRIM_START) != null || it.timingFor(Registry.Prop.TRIM_END) != null ||
                it.timingFor(Registry.Prop.TRIM_OFFSET) != null
        } == true
    /** Padding edges bound to slots (start, top, end, bottom; NONE = static). Read in the layout phase. */
    val paddingSlot = slotFor(raw, Registry.Prop.PADDING)
    val paddingHorizontalSlot = slotFor(raw, Registry.Prop.PADDING_HORIZONTAL)
    val paddingVerticalSlot = slotFor(raw, Registry.Prop.PADDING_VERTICAL)
    val paddingSlots = intArrayOf(
        slotFor(raw, Registry.Prop.PADDING_START), slotFor(raw, Registry.Prop.PADDING_TOP),
        slotFor(raw, Registry.Prop.PADDING_END), slotFor(raw, Registry.Prop.PADDING_BOTTOM),
        paddingSlot, paddingHorizontalSlot, paddingVerticalSlot,
    )
    val hasDynamicPadding = paddingSlots.any { it != NONE }
    /** The props of [paddingSlots], in the same order (for [mixedEdges]). */
    val paddingProps = intArrayOf(
        Registry.Prop.PADDING_START, Registry.Prop.PADDING_TOP, Registry.Prop.PADDING_END, Registry.Prop.PADDING_BOTTOM,
        Registry.Prop.PADDING, Registry.Prop.PADDING_HORIZONTAL, Registry.Prop.PADDING_VERTICAL,
    )

    // Dynamic layout slots (registry 23, brief H1)
    val widthSlot = slotFor(raw, Registry.Prop.WIDTH)
    val heightSlot = slotFor(raw, Registry.Prop.HEIGHT)
    val minWidthSlot = slotFor(raw, Registry.Prop.MIN_WIDTH)
    val maxWidthSlot = slotFor(raw, Registry.Prop.MAX_WIDTH)
    val minHeightSlot = slotFor(raw, Registry.Prop.MIN_HEIGHT)
    val maxHeightSlot = slotFor(raw, Registry.Prop.MAX_HEIGHT)
    val flexSlot = slotFor(raw, Registry.Prop.FLEX)
    val aspectRatioSlot = slotFor(raw, Registry.Prop.ASPECT_RATIO)
    val gapSlot = slotFor(raw, Registry.Prop.GAP)
    val displaySlot = slotFor(raw, Registry.Prop.DISPLAY)

    val topSlot = slotFor(raw, Registry.Prop.TOP)
    val bottomSlot = slotFor(raw, Registry.Prop.BOTTOM)
    val startSlot = slotFor(raw, Registry.Prop.START)
    val endSlot = slotFor(raw, Registry.Prop.END)

    val marginSlot = slotFor(raw, Registry.Prop.MARGIN)
    val marginHorizontalSlot = slotFor(raw, Registry.Prop.MARGIN_HORIZONTAL)
    val marginVerticalSlot = slotFor(raw, Registry.Prop.MARGIN_VERTICAL)
    val marginTopSlot = slotFor(raw, Registry.Prop.MARGIN_TOP)
    val marginBottomSlot = slotFor(raw, Registry.Prop.MARGIN_BOTTOM)
    val marginStartSlot = slotFor(raw, Registry.Prop.MARGIN_START)
    val marginEndSlot = slotFor(raw, Registry.Prop.MARGIN_END)
    val marginSlots = intArrayOf(
        marginStartSlot, marginTopSlot, marginEndSlot, marginBottomSlot,
        marginSlot, marginHorizontalSlot, marginVerticalSlot,
    )
    val hasDynamicMargin = marginSlots.any { it != NONE }
    /** The props of [marginSlots], in the same order (for [mixedEdges]). */
    val marginProps = intArrayOf(
        Registry.Prop.MARGIN_START, Registry.Prop.MARGIN_TOP, Registry.Prop.MARGIN_END, Registry.Prop.MARGIN_BOTTOM,
        Registry.Prop.MARGIN, Registry.Prop.MARGIN_HORIZONTAL, Registry.Prop.MARGIN_VERTICAL,
    )

    val borderRadiusSlot = slotFor(raw, Registry.Prop.BORDER_RADIUS)
    val borderTopStartRadiusSlot = slotFor(raw, Registry.Prop.BORDER_TOP_START_RADIUS).takeIf { it != NONE }
        ?: slotFor(raw, Registry.Prop.BORDER_TOP_LEFT_RADIUS)
    val borderTopEndRadiusSlot = slotFor(raw, Registry.Prop.BORDER_TOP_END_RADIUS).takeIf { it != NONE }
        ?: slotFor(raw, Registry.Prop.BORDER_TOP_RIGHT_RADIUS)
    val borderBottomStartRadiusSlot = slotFor(raw, Registry.Prop.BORDER_BOTTOM_START_RADIUS).takeIf { it != NONE }
        ?: slotFor(raw, Registry.Prop.BORDER_BOTTOM_LEFT_RADIUS)
    val borderBottomEndRadiusSlot = slotFor(raw, Registry.Prop.BORDER_BOTTOM_END_RADIUS).takeIf { it != NONE }
        ?: slotFor(raw, Registry.Prop.BORDER_BOTTOM_RIGHT_RADIUS)
    val radiusSlots = intArrayOf(
        borderRadiusSlot, borderTopStartRadiusSlot, borderTopEndRadiusSlot,
        borderBottomStartRadiusSlot, borderBottomEndRadiusSlot,
    )
    val hasDynamicRadius = radiusSlots.any { it != NONE }

    val fontSizeSlot = slotFor(raw, Registry.Prop.FONT_SIZE)
    val lineHeightSlot = slotFor(raw, Registry.Prop.LINE_HEIGHT)
    val letterSpacingSlot = slotFor(raw, Registry.Prop.LETTER_SPACING)

    val hasDynamicSize = widthSlot != NONE || heightSlot != NONE || minWidthSlot != NONE ||
        maxWidthSlot != NONE || minHeightSlot != NONE || maxHeightSlot != NONE ||
        aspectRatioSlot != NONE || displaySlot != NONE

    val display = enum(Registry.Prop.DISPLAY)

    // Events: the event id JS listens to, or 0.
    val onPress = eventFor(raw, Registry.Event.ON_PRESS)
    val onRange = eventFor(raw, Registry.Event.ON_RANGE)
    val onPageChange = eventFor(raw, Registry.Event.ON_PAGE_CHANGE)
    val onDismiss = eventFor(raw, Registry.Event.ON_DISMISS)
    val onDetentChange = eventFor(raw, Registry.Event.ON_DETENT_CHANGE)
    val onChangeText = eventFor(raw, Registry.Event.ON_CHANGE_TEXT)
    val onSubmitEditing = eventFor(raw, Registry.Event.ON_SUBMIT_EDITING)
    val onFocus = eventFor(raw, Registry.Event.ON_FOCUS)
    val onBlur = eventFor(raw, Registry.Event.ON_BLUR)
    val onFilled = eventFor(raw, Registry.Event.ON_FILLED)
    /** <TextField ref>: names the field for ZnKeyboard's focus / blur / clear; focus changes go to JS on it. */
    val ref = eventFor(raw, Registry.Event.REF)
    val visibleSlot = slotFor(raw, Registry.Prop.VISIBLE)
    val selectedSlot = slotFor(raw, Registry.Prop.SELECTED)
    val refreshingSlot = slotFor(raw, Registry.Prop.REFRESHING)
    val onRefresh = eventFor(raw, Registry.Event.ON_REFRESH)
    val onEndReached = eventFor(raw, Registry.Event.ON_END_REACHED)
    val onPressIn = eventFor(raw, Registry.Event.ON_PRESS_IN)
    val onPressOut = eventFor(raw, Registry.Event.ON_PRESS_OUT)
    val onLongPress = eventFor(raw, Registry.Event.ON_LONG_PRESS)
    /** Registry 14: whether onLongPress holds a handler right now (a slot), when it isn't written in place. */
    val hasLongPressSlot = slotFor(raw, Registry.Prop.HAS_LONG_PRESS)
    val onPressRepeat = eventFor(raw, Registry.Event.ON_PRESS_REPEAT)
    val onValueChange = eventFor(raw, Registry.Event.ON_VALUE_CHANGE)
    val onNativeEvent = eventFor(raw, Registry.Event.ON_NATIVE_EVENT)

    /** Border width and colour bound to slots (registry 15; NONE = static). */
    val borderWidthSlot = slotFor(raw, Registry.Prop.BORDER_WIDTH)
    val borderColorSlot = slotFor(raw, Registry.Prop.BORDER_COLOR)
    /** RN onLayout (registry 15): sent from the modifier chain, so the node builds its chain per instance. */
    val onLayout = eventFor(raw, Registry.Event.ON_LAYOUT)
    // <Image> (registry 15): tint, and its load events (JSON payloads, see registry.ts).
    val tintColor: Color? = color(Registry.Prop.TINT_COLOR)
    val tintColorSlot = slotFor(raw, Registry.Prop.TINT_COLOR)
    val onLoad = eventFor(raw, Registry.Event.ON_LOAD)
    val onError = eventFor(raw, Registry.Event.ON_ERROR)
    val onLoadEnd = eventFor(raw, Registry.Event.ON_LOAD_END)

    /** True when the drawing chain reads a slot, so it must be built per instance instead of once here. */
    val hasDynamicChain = backgroundSlot != NONE || opacitySlot != NONE || hasDynamicPadding || hasDynamicMargin ||
        hasDynamicSize || hasDynamicRadius ||
        type == Registry.Component.PRESSABLE || hasTransformSlots || enter != null || exit != null ||
        accessibilityLabelSlot != NONE || hasMotion || borderWidthSlot != NONE || borderColorSlot != NONE ||
        onLayout != 0

    /** Pre-built chain for nodes whose chain never changes (most nodes). */
    val staticChain: Modifier = if (hasDynamicChain) Modifier else buildChain(null, null, null, null, staticAccessibility)

    /**
     * The fixed order (docs/styling-and-layout.md §4): margin → size → transform + opacity → shadow → background →
     * border → clip → press feedback → padding (+ border widths). Dynamic opacity and background are read in the
     * draw phase, so a change redraws only this node; dynamic padding ([pad], the padding edges with slot values
     * filled in) in the layout phase, so a change re-measures this node without recomposing anything (§8.3).
     */
    internal fun buildChain(
        layer: ZnLayer?,
        background: (() -> Color)?,
        press: Modifier?,
        pad: (() -> Edges)?,
        accessibility: Modifier? = null,
        border: ZnBorder? = null,
        layout: Modifier? = null,
        sizeLayout: Modifier? = null,
        dynamicShape: Shape? = null,
        dynamicMargin: Edges? = null,
    ): Modifier {
        if (display == Registry.Display.NONE) {
            return Modifier.layout { _, _ -> layout(0, 0) {} }
        }
        var m: Modifier = Modifier
        val effMargin = dynamicMargin ?: margin
        effMargin?.let {
            m = if (it.hasNegative) {
                // As Compose's padding does, but a side may be below 0: the box gets the room minus the margins (a
                // negative one gives it more room), reports a size inside the parent's limits, and sits at (start, top).
                // Before 2026-11-08 it was measured with the full room and reported a size bigger than allowed, so
                // Compose moved it by half the difference, and a stretched row with margin -16 sat 16 dp off.
                m.layout { measurable, constraints ->
                    val s = it.start.dp.roundToPx()
                    val t = it.top.dp.roundToPx()
                    val e = it.end.dp.roundToPx()
                    val b = it.bottom.dp.roundToPx()
                    val placeable = measurable.measure(constraints.offset(-(s + e), -(t + b)))
                    val w = constraints.constrainWidth((placeable.width + s + e).coerceAtLeast(0))
                    val h = constraints.constrainHeight((placeable.height + t + b).coerceAtLeast(0))
                    layout(w, h) {
                        placeable.placeRelative(s, t)
                    }
                }
            } else {
                m.padding(it.toPadding())
            }
        }
        layout?.let { m = m.then(it) } // RN onLayout: the box inside the margin, as RN reports it
        testID?.let { m = m.testTag(it) } // inside the margin: the element's own box, as RN reports it
        if (sizeLayout != null) {
            m = m.then(sizeLayout)
        } else {
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
        }
        val effShape = dynamicShape ?: shape
        if (layer != null) {
            // Values that change at runtime (slots, animations): read here, in the draw phase (step 3.6).
            val origin = transformOrigin
            m = m.graphicsLayer {
                this.alpha = layer.alpha()
                this.scaleX = layer.scaleX()
                this.scaleY = layer.scaleY()
                rotationZ = layer.rotate()
                transformOrigin = origin
                translationX = layer.translateX().dp.toPx()
                translationY = layer.translateY().dp.toPx()
            }
        } else if (opacity < 1f || hasTransform) {
            val staticAlpha = opacity
            val origin = transformOrigin
            m = m.graphicsLayer {
                this.alpha = staticAlpha
                this.scaleX = this@ZnNodeSpec.scaleX
                this.scaleY = this@ZnNodeSpec.scaleY
                rotationZ = rotate
                transformOrigin = origin
                translationX = translateX.dp.toPx()
                translationY = translateY.dp.toPx()
            }
        }
        if (elevation > 0f) m = m.shadow(elevation.dp, effShape, clip = false, ambientColor = shadowColor, spotColor = shadowColor)
        if (background != null) {
            val s = effShape
            m = m.drawBehind { drawOutline(s.createOutline(size, layoutDirection, this), background()) }
        } else {
            this.background?.let { m = m.background(it, effShape) }
        }
        // backgroundImage: a linear gradient over the background colour. The brush is built once per size.
        gradient?.let { g ->
            val s = effShape
            m = m.drawWithCache {
                val brush = g.brush(size)
                val outline = s.createOutline(size, layoutDirection, this)
                onDrawBehind { drawOutline(outline, brush) }
            }
        }
        if (borderDashed && (border != null || borderWidth > 0f)) {
            val static = borderWidth
            val staticColor = borderColor
            m = m.znDashedBorder(this, border?.width ?: { static }, border?.color ?: { staticColor })
        } else if (border != null) m = m.znBorder(this, border)
        else if (borderWidth > 0f) m = m.border(borderWidth.dp, borderColor, effShape)
        if (borderTopWidth > 0f || borderBottomWidth > 0f) {
            val c = borderColor
            val topW = borderTopWidth
            val bottomW = borderBottomWidth
            val dashed = borderDashed
            val style = borderStyle
            m = m.drawBehind {
                if (dashed) {
                    // A dashed line along the edge, its stroke centred inside the border's width (registry 16).
                    if (topW > 0f) {
                        val h = topW.dp.toPx()
                        drawLine(c, Offset(0f, h / 2), Offset(size.width, h / 2), h, pathEffect = borderDashes(style, h))
                    }
                    if (bottomW > 0f) {
                        val h = bottomW.dp.toPx()
                        val y = size.height - h / 2
                        drawLine(c, Offset(0f, y), Offset(size.width, y), h, pathEffect = borderDashes(style, h))
                    }
                    return@drawBehind
                }
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
        // A borderless ripple must draw outside the shape, so such a Pressable isn't clipped by default.
        // A radius from a slot counts too (before 2026-11-08 a rounded Image with a slot radius drew square corners).
        val isRounded = if (dynamicShape != null) dynamicShape != RectangleShape else rounded
        val clipsByDefault = isRounded && ((press != null && !rippleBorderless) || type == Registry.Component.IMAGE || type == Registry.Component.SHIMMER)
        if (clip || clipsByDefault) m = m.clip(effShape)
        press?.let { m = m.then(it) } ?: accessibility?.let { m = m.then(it) }
        // Borders take space: content sits inside them (zn flex rule 2).
        val bs = borderWidth
        val bt = borderWidth + borderTopWidth
        val bb = borderWidth + borderBottomWidth
        if (paddingIsContent) {
            if (borderWidth > 0f || borderTopWidth > 0f || borderBottomWidth > 0f) {
                m = m.padding(Edges(0f, 0f, 0f, 0f).plus(bs, bt, bs, bb).toPadding())
            }
        } else if (border != null) {
            // A border width that changes at runtime: read while measuring, so a change re-measures only this node.
            val top = borderTopWidth
            val bottom = borderBottomWidth
            m = m.layoutPadding {
                val w = border.width()
                (pad?.invoke() ?: staticPadding).plus(w, w + top, w, w + bottom)
            }
        } else if (pad != null) {
            m = m.layoutPadding { pad().plus(bs, bt, bs, bb) }
        } else if (padding != null || borderWidth > 0f || borderTopWidth > 0f || borderBottomWidth > 0f) {
            m = m.padding((padding ?: Edges(0f, 0f, 0f, 0f)).plus(bs, bt, bs, bb).toPadding())
        }
        return m
    }

    /** The static padding edges (0 where none), for [buildChain]'s dynamic padding to fill slot values into. */
    val staticPadding: Edges = padding ?: Edges(0f, 0f, 0f, 0f)

    /** This node's shape with every corner [w] dp smaller (the inside edge of a border [w] wide). */
    internal fun insetShape(w: Float): Shape = if (!rounded) RectangleShape else RoundedCornerShape(
        topStart = (topStart - w).coerceAtLeast(0f).dp, topEnd = (topEnd - w).coerceAtLeast(0f).dp,
        bottomEnd = (bottomEnd - w).coerceAtLeast(0f).dp, bottomStart = (bottomStart - w).coerceAtLeast(0f).dp,
    )

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

    /**
     * Margin or padding edges when some of them come from slots. The same RN order as [edges], for static and slot
     * values alike: a specific edge beats the axis, which beats the all-edges value. [props] and [slots] are in the
     * order start, top, end, bottom, all, horizontal, vertical; [read] gives a slot's number (null: not a number).
     * Before 2026-11-08 a slot's paddingHorizontal beat a static paddingStart (review of Gemini's H1).
     * A NaN or infinite value counts as not written, so it can't reach a layout call.
     */
    internal fun mixedEdges(props: IntArray, slots: IntArray, read: (Int) -> Float?): Edges {
        fun v(i: Int): Float? = ((if (slots[i] >= 0) read(slots[i]) else null) ?: num(props[i]))?.takeIf { it.isFinite() }
        val a = v(4) ?: 0f
        val h = v(5) ?: a
        val vv = v(6) ?: a
        return Edges(v(0) ?: h, v(1) ?: vv, v(2) ?: h, v(3) ?: vv)
    }

    private fun slotFor(raw: RawTemplate, prop: Int): Int =
        raw.slots.indexOfFirst { it.node == index && it.prop == prop }

    private fun eventFor(raw: RawTemplate, kind: Int): Int =
        raw.events.firstOrNull { it.node == index && it.kind == kind }?.eventId ?: 0
}

private fun Float?.orUnspecified(): Dp = this?.dp ?: Dp.Unspecified

/** A border whose width or colour changes at runtime (registry 15): both read as it draws or measures, in dp. */
internal class ZnBorder(val width: () -> Float, val color: () -> Color)

/**
 * The border of [spec] drawn as Compose's own border is: the shape minus the shape [width] smaller, over the content.
 * The ring is rebuilt when the size or the width changes; a colour change only redraws.
 */
private fun Modifier.znBorder(spec: ZnNodeSpec, border: ZnBorder): Modifier = drawWithCache {
    val wDp = border.width().coerceAtLeast(0f)
    val w = wDp.dp.toPx()
    val ring = if (w <= 0f || size.minDimension <= 0f) null else {
        val outer = Path().apply { addOutline(spec.shape.createOutline(size, layoutDirection, this@drawWithCache)) }
        val innerSize = Size((size.width - 2 * w).coerceAtLeast(0f), (size.height - 2 * w).coerceAtLeast(0f))
        val inner = Path().apply {
            addOutline(spec.insetShape(wDp).createOutline(innerSize, layoutDirection, this@drawWithCache))
            translate(Offset(w, w))
        }
        Path().apply { op(outer, inner, PathOperation.Difference) }
    }
    onDrawWithContent {
        drawContent()
        if (ring != null) drawPath(ring, border.color())
    }
}

/**
 * RN Android's dash pattern for a line [w] px thick (ReactViewBackgroundDrawable): "dashed" is 3 widths on and 3 off,
 * "dotted" is 1 on and 1 off (square dots). Also the textDecorationStyle lines (ZnRenderer.kt).
 */
internal fun borderDashes(style: Int, w: Float): PathEffect {
    val on = if (style == Registry.BorderStyle.DOTTED) w else 3 * w
    return PathEffect.dashPathEffect(floatArrayOf(on.coerceAtLeast(1f), on.coerceAtLeast(1f)))
}

/**
 * A dashed or dotted border (RN borderStyle, registry 16): the node's shape stroked along the middle of the border's
 * [width] (dp), over the content. Width and colour may come from slots (read as it draws).
 */
private fun Modifier.znDashedBorder(spec: ZnNodeSpec, width: () -> Float, color: () -> Color): Modifier = drawWithCache {
    val wDp = width().coerceAtLeast(0f)
    val w = wDp.dp.toPx()
    val path = if (w <= 0f || size.minDimension <= 0f) null else Path().apply {
        val inner = Size((size.width - w).coerceAtLeast(0f), (size.height - w).coerceAtLeast(0f))
        addOutline(spec.insetShape(wDp / 2).createOutline(inner, layoutDirection, this@drawWithCache))
        translate(Offset(w / 2, w / 2))
    }
    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(width = w, pathEffect = borderDashes(spec.borderStyle, w))
    onDrawWithContent {
        drawContent()
        if (path != null) drawPath(path, color(), style = stroke)
    }
}

/**
 * This size times [f] when it is in sp; unset sizes (a span that keeps its parent's size) and em sizes stay as they
 * are. Compose throws on arithmetic with an unset size, so maxFontScale must never scale one.
 */
internal fun androidx.compose.ui.unit.TextUnit.scaledSp(f: Float) = if (isSp) this * f else this

/**
 * Padding whose values are read while measuring: when a value it reads changes (a slot), only this node is measured
 * again; nothing recomposes. Start / end follow the layout direction (placeRelative mirrors in RTL).
 */
private fun Modifier.layoutPadding(edges: () -> Edges): Modifier = layout { measurable, constraints ->
    val e = edges()
    val start = e.start.coerceAtLeast(0f).dp.roundToPx()
    val top = e.top.coerceAtLeast(0f).dp.roundToPx()
    val end = e.end.coerceAtLeast(0f).dp.roundToPx()
    val bottom = e.bottom.coerceAtLeast(0f).dp.roundToPx()
    val placeable = measurable.measure(constraints.offset(-(start + end), -(top + bottom)))
    val width = constraints.constrainWidth(placeable.width + start + end)
    val height = constraints.constrainHeight(placeable.height + top + bottom)
    layout(width, height) { placeable.placeRelative(start, top) }
}

/**
 * A template prepared for drawing. Built once per template and shared by all its instances. [svgs]: the parsed SVGs,
 * one cache shared by all templates of the same file (ZnSvg.kt).
 */
@Immutable
class ZnTemplate internal constructor(val raw: RawTemplate, internal val svgs: ZnSvgCache) {
    constructor(raw: RawTemplate) : this(raw, ZnSvgCache())

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

/**
 * Span styles written by the compiler for nested <Text> (compile.ts `spanStyle`): a JSON array, one object per span,
 * with colours as ARGB numbers and enums as their numbers. Unset fields inherit the outer Text's style.
 */
/** Registry 16: which spans have onPress (`"p": 1`, core text-spans.ts), by index. */
/** "x y" fractions (registry 20 transformOrigin, written by the compiler) → Compose's pivot; else the centre. */
internal fun parseTransformOrigin(s: String?): TransformOrigin {
    val parts = s?.trim()?.split(' ')?.mapNotNull { it.toFloatOrNull() } ?: return TransformOrigin.Center
    return if (parts.size == 2) TransformOrigin(parts[0], parts[1]) else TransformOrigin.Center
}

internal fun parseSpanPresses(json: String): BooleanArray {
    val list = org.json.JSONArray(json)
    return BooleanArray(list.length()) { i -> list.optJSONObject(i)?.optInt("p", 0) == 1 }
}

internal fun parseSpans(json: String): List<SpanStyle> {
    val list = org.json.JSONArray(json)
    return List(list.length()) { i ->
        val o = list.getJSONObject(i)
        fun num(key: String) = if (o.has(key)) o.getDouble(key).toFloat() else null
        fun argb(key: String) = if (o.has(key)) Color(o.getLong(key).toInt()) else Color.Unspecified
        SpanStyle(
            color = argb("color"),
            fontSize = num("fontSize")?.sp ?: androidx.compose.ui.unit.TextUnit.Unspecified,
            fontWeight = num("fontWeight")?.let { FontWeight(it.toInt().coerceIn(1, 1000)) },
            fontStyle = when (if (o.has("fontStyle")) o.getInt("fontStyle") else -1) {
                Registry.FontStyle.ITALIC -> FontStyle.Italic
                Registry.FontStyle.NORMAL -> FontStyle.Normal
                else -> null
            },
            textDecoration = when (if (o.has("textDecorationLine")) o.getInt("textDecorationLine") else -1) {
                Registry.TextDecorationLine.UNDERLINE -> TextDecoration.Underline
                Registry.TextDecorationLine.LINE_THROUGH -> TextDecoration.LineThrough
                Registry.TextDecorationLine.NONE -> TextDecoration.None
                else -> null
            },
            letterSpacing = num("letterSpacing")?.sp ?: androidx.compose.ui.unit.TextUnit.Unspecified,
            background = argb("backgroundColor"),
        )
    }
}
