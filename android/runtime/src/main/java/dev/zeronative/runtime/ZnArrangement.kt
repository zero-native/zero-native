package dev.zeronative.runtime

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import kotlin.math.roundToInt

/*
 * justifyContent together with gap, the way React Native (Yoga) lays them out (second-opinions 112).
 * - No gap: the plain Compose arrangements, as before.
 * - flex-start / center / flex-end: the items sit together with `gap` between them, and the group is placed at the
 *   start, in the middle or at the end.
 * - space-between / around / evenly: `gap` is the smallest space between two items. The free space left after the
 *   items and the gaps is shared out as RN shares it, on top of the gap.
 * Before 2026-11-05 the gap was dropped for every justifyContent except flex-start.
 * Each result is equal (==) to the one from the last recomposition, so Row / Column keep their measure policy. This is
 * why center / flex-end don't use Compose's `spacedBy(gap, alignment)`: it makes a new, unequal object on every call,
 * which would remeasure the row on every recomposition (caught by ZnArrangementTest).
 */

internal fun znVerticalArrangement(justify: Int, gap: Float): Arrangement.Vertical {
    if (!(gap > 0f && gap.isFinite())) return when (justify) { // NaN or Infinity from a slot: no gap
        Registry.JustifyContent.CENTER -> Arrangement.Center
        Registry.JustifyContent.FLEX_END -> Arrangement.Bottom
        Registry.JustifyContent.SPACE_BETWEEN -> Arrangement.SpaceBetween
        Registry.JustifyContent.SPACE_AROUND -> Arrangement.SpaceAround
        Registry.JustifyContent.SPACE_EVENLY -> Arrangement.SpaceEvenly
        else -> Arrangement.Top
    }
    val space = Dp(gap)
    return when (justify) {
        Registry.JustifyContent.CENTER,
        Registry.JustifyContent.FLEX_END,
        Registry.JustifyContent.SPACE_BETWEEN,
        Registry.JustifyContent.SPACE_AROUND,
        Registry.JustifyContent.SPACE_EVENLY -> ZnJustifyWithGap(justify, space)
        else -> Arrangement.spacedBy(space)
    }
}

internal fun znHorizontalArrangement(justify: Int, gap: Float): Arrangement.Horizontal {
    if (!(gap > 0f && gap.isFinite())) return when (justify) { // NaN or Infinity from a slot: no gap
        Registry.JustifyContent.CENTER -> Arrangement.Center
        Registry.JustifyContent.FLEX_END -> Arrangement.End
        Registry.JustifyContent.SPACE_BETWEEN -> Arrangement.SpaceBetween
        Registry.JustifyContent.SPACE_AROUND -> Arrangement.SpaceAround
        Registry.JustifyContent.SPACE_EVENLY -> Arrangement.SpaceEvenly
        else -> Arrangement.Start
    }
    val space = Dp(gap)
    return when (justify) {
        Registry.JustifyContent.CENTER,
        Registry.JustifyContent.FLEX_END,
        Registry.JustifyContent.SPACE_BETWEEN,
        Registry.JustifyContent.SPACE_AROUND,
        Registry.JustifyContent.SPACE_EVENLY -> ZnJustifyWithGap(justify, space)
        else -> Arrangement.spacedBy(space)
    }
}

/**
 * center / flex-end / space-* with a gap, as in Yoga. With n items: group = items + gap × (n - 1), free = size - group.
 * - center: the group starts at free / 2; flex-end: at free. (Too little room: it hangs over both ends or the start,
 *   as with RN and Compose's own Center / End.)
 * - space-*: free is never below 0 (Yoga falls back to flex-start). Between two items: gap + free / (n - 1)
 *   (between), gap + free / n (around), gap + free / (n + 1) (evenly). Before the first item: 0, free / 2n,
 *   free / (n + 1). One item with space-between sits at the start, as in RN.
 * The gap is rounded to whole pixels, as Row / Column round `spacing` when they reserve room for it; so a Row that
 * wraps its content has exactly the room for its gaps.
 */
internal data class ZnJustifyWithGap(val justify: Int, val gap: Dp) : Arrangement.HorizontalOrVertical {
    override val spacing: Dp get() = gap

    override fun Density.arrange(totalSize: Int, sizes: IntArray, layoutDirection: LayoutDirection, outPositions: IntArray) {
        place(totalSize, sizes, gap.roundToPx(), outPositions)
        // Right to left: the first item goes at the right edge, so mirror every position.
        if (layoutDirection == LayoutDirection.Rtl) {
            for (i in sizes.indices) outPositions[i] = totalSize - outPositions[i] - sizes[i]
        }
    }

    override fun Density.arrange(totalSize: Int, sizes: IntArray, outPositions: IntArray) {
        place(totalSize, sizes, gap.roundToPx(), outPositions)
    }

    private fun place(totalSize: Int, sizes: IntArray, gapPx: Int, outPositions: IntArray) {
        val n = sizes.size
        if (n == 0) return
        var used = 0
        for (s in sizes) used += s
        val left = (totalSize - used - gapPx * (n - 1)).toFloat()
        val free = left.coerceAtLeast(0f)
        val lead: Float
        val between: Float
        when (justify) {
            Registry.JustifyContent.CENTER -> { lead = left / 2f; between = gapPx.toFloat() }
            Registry.JustifyContent.FLEX_END -> { lead = left; between = gapPx.toFloat() }
            Registry.JustifyContent.SPACE_AROUND -> { lead = free / n / 2f; between = gapPx + free / n }
            Registry.JustifyContent.SPACE_EVENLY -> { lead = free / (n + 1); between = gapPx + free / (n + 1) }
            else -> { lead = 0f; between = if (n > 1) gapPx + free / (n - 1) else 0f } // space-between
        }
        var current = lead
        for (i in 0 until n) {
            outPositions[i] = current.roundToInt()
            current += sizes[i] + between
        }
    }

    override fun toString() = "ZnJustifyWithGap($justify, $gap)"
}
