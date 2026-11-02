package dev.zeronative.runtime

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a plugin may add (ZnPlugins.collect, docs/plugins.md §8). ZnPlugins.register commits the result only if this returns. */
class ZnPluginsTest {
    private class Plugin(val body: (ZnPluginRegistry) -> Unit) : ZnPlugin {
        override fun register(r: ZnPluginRegistry) = body(r)
    }

    private class Module(name: String) : ZnModuleBase(name)

    private val noContext: () -> Context = { error("this test has no Context") }

    private fun collect(taken: Set<String> = emptySet(), hostApi: Int = 5, body: (ZnPluginRegistry) -> Unit) =
        ZnPlugins.collect(Plugin(body), noContext, hostApi) { it in taken }.modules

    @Test fun aPluginAddsItsModules() {
        val modules = collect {
            it.requireHostApi(5)
            it.module(Module("Scanner"))
            it.module(Module("Camera"))
        }
        assertEquals(listOf("Scanner", "Camera"), modules.map { it.name })
    }

    @Test fun aPluginAddsItsActivityEvents() {
        val events = object : ZnActivityEvents {}
        val added = ZnPlugins.collect(Plugin { it.activityEvents(events) }, noContext, 5) { false }
        assertEquals(listOf(events), added.events)
    }

    @Test fun aPluginThatThrowsReturnsNothingToCommit() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            collect {
                it.module(Module("Scanner"))
                throw IllegalArgumentException("no")
            }
        }
        assertEquals("no", error.message)
    }

    @Test fun aHostApiTooNewFails() {
        val error = assertThrows(IllegalStateException::class.java) { collect(hostApi = 5) { it.requireHostApi(6) } }
        assertTrue(error.message!!.contains("host API v6"))
    }

    @Test fun aTakenNameFails() {
        val error = assertThrows(IllegalStateException::class.java) { collect(taken = setOf("Fetch")) { it.module(Module("Fetch")) } }
        assertTrue(error.message!!.contains("\"Fetch\""))
    }

    @Test fun oneNameTwiceInAPluginFails() {
        assertThrows(IllegalStateException::class.java) {
            collect {
                it.module(Module("Scanner"))
                it.module(Module("Scanner"))
            }
        }
    }
}
