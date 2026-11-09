package dev.zeronative.runtime

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.roundToInt

/*
 * RN flexWrap: "wrap" on a Row (registry 24): chips and tags, laid out as Yoga does.
 *
 * Why not Compose's FlowRow: it rounds every child and the gap to whole pixels before it decides the line breaks (the
 * gap rounded up), so children that fit a line exactly in dp did not fit in pixels: three 60 dp boxes with 10 dp gaps
 * in a 200 dp Row went on two lines on a 2.625x screen, and two `width: "50%"` children (a common RN two-column
 * pattern) can go on two lines, depending on the screen's width. Yoga decides in dp (floats). Here a line accepts a
 * child when it fits within half a pixel per child and gap (the most rounding can add), so these cases stay on one
 * line; a line can then hang out by a pixel at most.
 *
 * Rules, as RN:
 * - A child with flex > 0 counts as 0 wide when lines are made (RN's flex: n is flexBasis 0); then the flex children of
 *   a line share what the line has left, by their flex.
 * - justifyContent places the children of each line (the same arrangements as a Row, gap included); alignItems /
 *   alignSelf place each child in its line, which is as tall as its tallest child. Only an explicit "stretch" stretches
 *   a child without a height to its line's height (zn's Row rule 4; unset is flex-start, platform-differences.md).
 * - alignContent places the lines when the Row has a height (justifyContent's arrangements, with the row gap).
 * - The Row is as wide as its longest line (at least its minimum, as when a Column stretches it), and as tall as its
 *   lines and row gaps.
 * A stretched child's width comes from its max intrinsic width (Compose's FlowRow does the same for fillMaxRowHeight):
 * a child that can't answer (a lazy list inside) is not stretched.
 */

/** What a child of a wrapped Row tells the layout (its layoutId). */
internal class ZnWrapItem(val flex: Float, val alignSelf: Int, val stretch: Boolean)

@Composable
internal fun ZnWrapLayout(
    modifier: Modifier,
    justify: Int,
    gap: Float,
    alignItems: Int,
    alignContent: Int,
    crossGap: Float,
    content: @Composable () -> Unit,
) {
    Layout(content, modifier) { measurables, c ->
        val maxW = c.maxWidth
        val gapPx = if (gap > 0f && gap.isFinite()) gap.dp.toPx() else 0f
        val crossGapPx = if (crossGap > 0f && crossGap.isFinite()) crossGap.dp.toPx() else 0f
        val n = measurables.size
        val items = Array(n) { measurables[it].layoutId as? ZnWrapItem ?: PLAIN }
        val placeables = arrayOfNulls<Placeable>(n)
        val loose = Constraints(0, maxW, 0, c.maxHeight)
        // 1. The size each child has for line breaking.
        val main = IntArray(n)
        val stretchOk = BooleanArray(n)
        for (i in 0 until n) {
            val item = items[i]
            if (item.stretch) {
                // Measured once its line's height is known (step 3); its width now from intrinsics.
                val w = intrinsicWidth(measurables[i], c.maxHeight)
                if (w != null) {
                    stretchOk[i] = true
                    main[i] = if (item.flex > 0f) 0 else minOf(w, maxW)
                    continue
                }
            }
            if (item.flex > 0f) continue // flexBasis 0: measured with its share (step 3)
            val p = measurables[i].measure(loose)
            placeables[i] = p
            main[i] = p.width
        }
        // 2. Lines: [start, end) ranges.
        val starts = ArrayList<Int>()
        var lineLen = 0f
        var inLine = 0
        for (i in 0 until n) {
            val add = if (inLine == 0) main[i].toFloat() else gapPx + main[i]
            // Rounding adds at most half a pixel per child and per gap.
            val slack = (2 * inLine + 1) * 0.5f
            if (inLine > 0 && maxW != Constraints.Infinity && lineLen + add > maxW + slack) {
                starts += i
                lineLen = main[i].toFloat()
                inLine = 1
            } else {
                if (inLine == 0) starts += i
                lineLen += add
                inLine++
            }
        }
        val lines = starts.size
        val lineHeights = IntArray(lines)
        val lineWidths = IntArray(lines)
        // 3. Per line: flex shares, the line's height, stretched children.
        for (l in 0 until lines) {
            val from = starts[l]
            val to = if (l + 1 < lines) starts[l + 1] else n
            var fixed = 0f
            var flexSum = 0f
            for (i in from until to) {
                if (items[i].flex > 0f) flexSum += items[i].flex else fixed += main[i]
            }
            val gaps = gapPx * (to - from - 1)
            if (flexSum > 0f) {
                val free = if (maxW == Constraints.Infinity) 0f else (maxW - fixed - gaps).coerceAtLeast(0f)
                // Shares rounded on running totals, so they add up to `free` exactly.
                var done = 0f
                var placed = 0
                for (i in from until to) {
                    if (items[i].flex <= 0f) continue
                    done += free * items[i].flex / flexSum
                    val w = done.roundToInt() - placed
                    placed += w
                    main[i] = w
                    if (!(items[i].stretch && stretchOk[i])) {
                        placeables[i] = measurables[i].measure(Constraints(w, w, 0, c.maxHeight))
                    }
                }
            }
            var h = 0
            for (i in from until to) {
                val p = placeables[i]
                h = if (p != null) max(h, p.height) else max(h, intrinsicHeight(measurables[i], main[i]))
            }
            lineHeights[l] = h
            var w = 0
            for (i in from until to) {
                if (placeables[i] == null) {
                    val width = main[i].coerceIn(0, if (maxW == Constraints.Infinity) Int.MAX_VALUE else maxW)
                    placeables[i] = measurables[i].measure(Constraints(width, width, h, h))
                }
                w += placeables[i]!!.width
            }
            lineWidths[l] = w + (gaps).roundToInt()
        }
        // 4. The Row's size and the lines' places.
        val contentW = lineWidths.maxOrNull() ?: 0
        val width = if (maxW == Constraints.Infinity) max(contentW, c.minWidth) else contentW.coerceIn(c.minWidth, maxW)
        val contentH = lineHeights.sum() + (crossGapPx * (lines - 1).coerceAtLeast(0)).roundToInt()
        val height = contentH.coerceIn(c.minHeight, if (c.hasBoundedHeight) c.maxHeight else Int.MAX_VALUE)
        val lineTops = IntArray(lines)
        with(znVerticalArrangement(alignContent, crossGap)) { arrange(height, lineHeights, lineTops) }
        // xs come mirrored for right-to-left from the arrangement: placed with place, not placeRelative.
        val rowArrangement = znHorizontalArrangement(justify, gap)
        val xs = Array(lines) { l ->
            val from = starts[l]
            val to = if (l + 1 < lines) starts[l + 1] else n
            val sizes = IntArray(to - from) { placeables[from + it]!!.width }
            IntArray(sizes.size).also { out -> with(rowArrangement) { arrange(width, sizes, layoutDirection, out) } }
        }
        layout(width, height) {
            for (l in 0 until lines) {
                val from = starts[l]
                for (k in xs[l].indices) {
                    val i = from + k
                    val p = placeables[i]!!
                    val align = if (items[i].alignSelf != -1) items[i].alignSelf else alignItems
                    val dy = when (align) {
                        Registry.AlignItems.CENTER -> (lineHeights[l] - p.height) / 2
                        Registry.AlignItems.FLEX_END -> lineHeights[l] - p.height
                        else -> 0
                    }
                    p.place(xs[l][k], lineTops[l] + dy)
                }
            }
        }
    }
}

private val PLAIN = ZnWrapItem(0f, -1, false)

/** A child's max intrinsic width, or null when it can't give one (lazy layouts throw). */
private fun intrinsicWidth(m: Measurable, height: Int): Int? = try {
    m.maxIntrinsicWidth(if (height == Constraints.Infinity) Constraints.Infinity else height)
} catch (_: IllegalStateException) {
    null
}

/** A child's min intrinsic height at [width], or 0 when it can't give one. */
private fun intrinsicHeight(m: Measurable, width: Int): Int = try {
    m.minIntrinsicHeight(width)
} catch (_: IllegalStateException) {
    0
}
