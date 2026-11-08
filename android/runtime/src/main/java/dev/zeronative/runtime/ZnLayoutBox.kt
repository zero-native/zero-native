package dev.zeronative.runtime

import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.modifier.ModifierLocalModifierNode
import androidx.compose.ui.modifier.modifierLocalMapOf
import androidx.compose.ui.modifier.modifierLocalOf
import androidx.compose.ui.node.GlobalPositionAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.requireLayoutCoordinates
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.Dp

/*
 * A11 (2026-11-08, found by the iOS session's layout conformance lab, examples/sample/src/LayoutLab.tsx):
 *
 * - A11-2: RN onLayout gives x / y from the parent's top-left corner, its padding and border included. Compose's
 *   positionInParent() starts inside the parent's padding and border, so a child of `padding: 10` reported x = 0.
 *   Each container now carries a [ZnBoxNode] at the point of its own box (after its margin and size, before its
 *   padding and border), and a child's onLayout measures from there.
 * - A11-3: a maxWidth / maxHeight beats a stretch or a % size from the parent, as in RN. Compose's widthIn can't go
 *   below the parent's minimum, so a stretched child with maxWidth 80 stayed 200 wide.
 */

/** The box of the nearest zn container above, for a child's onLayout. */
private val LocalZnBox = modifierLocalOf<ZnBoxNode?> { null }

/** Marks a container's own box (see the note at the top). Has no layout or drawing of its own. */
internal class ZnBoxNode : Modifier.Node(), ModifierLocalModifierNode {
    override val providedValues = modifierLocalMapOf(LocalZnBox to this)

    fun coordinatesOrNull(): LayoutCoordinates? = if (isAttached) requireLayoutCoordinates().takeIf { it.isAttached } else null
}

internal data object ZnBoxElement : ModifierNodeElement<ZnBoxNode>() {
    override fun create() = ZnBoxNode()
    override fun update(node: ZnBoxNode) = Unit
}

/**
 * RN onLayout (registry 15): sends { layout: { x, y, width, height } } in dp when the box gets a new size or a new
 * place in its parent. x / y come from the parent's top-left corner, its padding and border included (A11-2). Compose
 * calls this on every move on screen (a scroll); only a real change in the four numbers builds and sends an event, so
 * a scroll costs a compare.
 */
internal class ZnOnLayoutNode(var instId: Int, var eventId: Int, var density: Float) :
    Modifier.Node(), GlobalPositionAwareModifierNode, ModifierLocalModifierNode {
    private val last = FloatArray(4) { Float.NaN }

    override fun onGloballyPositioned(coordinates: LayoutCoordinates) {
        val p = positionInParentBox(LocalZnBox.current?.coordinatesOrNull(), coordinates)
        val now = floatArrayOf(p.x, p.y, coordinates.size.width.toFloat(), coordinates.size.height.toFloat())
        if (now.contentEquals(last)) return
        now.copyInto(last)
        fun dp(px: Float) = Math.round(px / density * 100f) / 100.0
        val layout = org.json.JSONObject().put("x", dp(now[0])).put("y", dp(now[1]))
            .put("width", dp(now[2])).put("height", dp(now[3]))
        ZnRuntime.dispatchEvent(instId, eventId, org.json.JSONObject().put("layout", layout).toString())
    }
}

/**
 * Where [child] sits in its parent's box. [box] is the nearest container mark above it; it is used only when it is in
 * the child's own parent layout. Rows of a List, a Sheet's body or a rail's items have a Compose layout of their own
 * in between: they keep positionInParent(), as before (inside a lazy list it never moves with the scroll).
 */
private fun positionInParentBox(box: LayoutCoordinates?, child: LayoutCoordinates): Offset {
    if (box != null) {
        // Every layer of one Compose layout has the same parentLayoutCoordinates (its own parent's innermost layer).
        val parentInner = child.parentLayoutCoordinates
        if (parentInner != null && box.parentLayoutCoordinates === parentInner.parentLayoutCoordinates) {
            return box.localPositionOf(child, Offset.Zero)
        }
    }
    return child.positionInParent()
}

internal data class ZnOnLayoutElement(val instId: Int, val eventId: Int, val density: Float) : ModifierNodeElement<ZnOnLayoutNode>() {
    override fun create() = ZnOnLayoutNode(instId, eventId, density)
    override fun update(node: ZnOnLayoutNode) {
        node.instId = instId
        node.eventId = eventId
        node.density = density
    }
}

/**
 * A fixed size between its min and max, as RN does: the max first, then the min, so a min beats the max (c29a,
 * 2026-11-08: `width: 50, minWidth: 80, maxWidth: 60` is 80 wide). Before, a fixed width or height ignored its min / max.
 */
internal fun znClampSize(size: Float, min: Float?, max: Float?): Float {
    var r = size
    if (max != null) r = minOf(r, max)
    if (min != null) r = maxOf(r, min)
    return r
}

/** [znClampSize] in px, for sizes read from slots. */
internal fun znClampSize(size: Int, min: Int?, max: Int?): Int {
    var r = size
    if (max != null) r = minOf(r, max)
    if (min != null) r = maxOf(r, min)
    return r
}

/**
 * The room a box with min / max sizes (px, null = not set) gets. A max beats the parent's minimum (a stretch, a %
 * size, a flex share) as in RN; a min beats the max, as in RN, but stays inside the parent's room as widthIn does.
 */
internal fun znSizeInConstraints(c: Constraints, minW: Int?, maxW: Int?, minH: Int?, maxH: Int?): Constraints {
    var hiW = if (maxW != null) minOf(c.maxWidth, maxOf(maxW, 0)) else c.maxWidth
    var loW = minOf(c.minWidth, hiW)
    if (minW != null) {
        loW = maxOf(loW, minW.coerceIn(0, c.maxWidth))
        hiW = maxOf(hiW, loW)
    }
    var hiH = if (maxH != null) minOf(c.maxHeight, maxOf(maxH, 0)) else c.maxHeight
    var loH = minOf(c.minHeight, hiH)
    if (minH != null) {
        loH = maxOf(loH, minH.coerceIn(0, c.maxHeight))
        hiH = maxOf(hiH, loH)
    }
    return Constraints.fitPrioritizingWidth(loW, hiW, loH, hiH)
}

/**
 * minWidth / maxWidth / minHeight / maxHeight ([znSizeInConstraints]). The box keeps the room the parent gave it, so
 * the parent never centres it, and sits at its start and top inside that room, as RN places a clamped stretch.
 */
internal fun Modifier.znSizeIn(minW: Dp?, maxW: Dp?, minH: Dp?, maxH: Dp?): Modifier = layout { measurable, c ->
    val inner = znSizeInConstraints(c, minW?.roundToPx(), maxW?.roundToPx(), minH?.roundToPx(), maxH?.roundToPx())
    val p = measurable.measure(inner)
    layout(c.constrainWidth(p.width), c.constrainHeight(p.height)) { p.placeRelative(0, 0) }
}
