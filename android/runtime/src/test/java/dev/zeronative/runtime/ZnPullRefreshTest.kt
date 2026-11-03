package dev.zeronative.runtime

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.Velocity
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.CoroutineContext

class ZnPullRefreshTest {
    private val math = ZnPullMath(line = 200f, rest = 140f)

    @Test
    fun theDiscFollowsHalfTheFingerThenSlowsPastTheLine() {
        assertEquals(50f, math.position(math.distance(100f)), 0.01f)
        assertEquals(200f, math.position(200f), 0.01f)
        assertEquals(250f, math.position(300f), 0.01f) // past the line: half speed
        assertEquals(300f, math.position(10_000f), 0.01f) // never past 1.5 × the line
        assertEquals(0f, math.position(-5f), 0.01f)
        assertFalse(math.refreshes(199f))
        assertTrue(math.refreshes(200f))
        assertEquals(0.5f, math.progress(100f), 0.01f)
    }

    // Launched jobs (animations, the wait for JS) are queued and never run: these tests check the decisions only.
    private class Parked : CoroutineDispatcher() {
        override fun dispatch(context: CoroutineContext, block: Runnable) = Unit
    }

    private fun state(canPull: Boolean = true, onRefresh: () -> Unit) =
        ZnPullState(CoroutineScope(Job() + Parked()), math, canPull, onRefresh).also { it.setRefreshing(false) }

    private fun ZnPullState.drag(dy: Float): Offset {
        // A list at its top consumes nothing, so all of the finger move is left over for the parent.
        val pre = connection.onPreScroll(Offset(0f, dy), NestedScrollSource.UserInput)
        val left = Offset(0f, dy - pre.y)
        return pre + connection.onPostScroll(Offset.Zero, left, NestedScrollSource.UserInput)
    }

    private fun ZnPullState.letGo(): Velocity = runBlocking { connection.onPreFling(Velocity(0f, 1000f)) }

    @Test
    fun aLongPullRefreshesOnceAndShowsTheSpinnerAtOnce() {
        var calls = 0
        val s = state { calls++ }
        assertEquals(Offset(0f, 500f), s.drag(500f)) // the pull takes the whole move: no overscroll stretch
        assertEquals(math.position(250f), s.offset, 0.01f)
        assertEquals(0, calls) // nothing until the finger is up
        assertEquals(Velocity(0f, 1000f), s.letGo()) // the fling that ends a pull is eaten
        assertEquals(1, calls)
        assertTrue(s.shown)
        // While the spinner shows, a new pull does nothing and the content scrolls as usual.
        assertEquals(Offset.Zero, s.drag(500f))
        assertEquals(1, calls)
    }

    @Test
    fun aShortPullDoesNotRefresh() {
        var calls = 0
        val s = state { calls++ }
        s.drag(300f) // disc at 150, the line is 200
        s.letGo()
        assertEquals(0, calls)
        assertFalse(s.shown)
    }

    @Test
    fun goingBackUpMovesTheDiscFirst() {
        var calls = 0
        val s = state { calls++ }
        s.drag(500f)
        // Up by 300: the disc takes it all (it comes up to 100), the content does not scroll.
        assertEquals(Offset(0f, -300f), s.connection.onPreScroll(Offset(0f, -300f), NestedScrollSource.UserInput))
        assertEquals(100f, s.offset, 0.01f)
        // Up by 400 more: the disc only needs 200 of it, the rest scrolls the content.
        assertEquals(Offset(0f, -200f), s.connection.onPreScroll(Offset(0f, -400f), NestedScrollSource.UserInput))
        assertEquals(0f, s.offset, 0.01f)
        s.letGo()
        assertEquals(0, calls)
    }

    @Test
    fun withoutOnRefreshThereIsNoPullButRefreshingShows() {
        val s = state(canPull = false) { error("no onRefresh") }
        assertEquals(Offset.Zero, s.drag(500f))
        assertEquals(Velocity.Zero, s.letGo())
        s.setRefreshing(true)
        assertTrue(s.shown)
        s.setRefreshing(false)
        assertFalse(s.shown)
    }

    @Test
    fun theSpinnerFollowsJsAfterTheRelease() {
        val s = state { }
        s.drag(500f)
        s.letGo()
        assertTrue(s.shown) // waiting for JS
        s.setRefreshing(true)
        assertTrue(s.shown)
        s.setRefreshing(false) // loaded
        assertFalse(s.shown)
    }

    @Test
    fun aFlingThatIsNotAPullIsLeftAlone() {
        val s = state { }
        assertEquals(Velocity.Zero, s.letGo())
        // A fling's scroll (not the finger) never pulls.
        assertEquals(Offset.Zero, s.connection.onPostScroll(Offset.Zero, Offset(0f, 400f), NestedScrollSource.SideEffect))
    }
}
