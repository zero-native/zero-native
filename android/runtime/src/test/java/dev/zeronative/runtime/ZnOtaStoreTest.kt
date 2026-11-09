package dev.zeronative.runtime

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The store part of the check's answer (ZnOtaStore.read): what the phone keeps and shows to JS. */
class ZnOtaStoreTest {
    private fun read(json: String) = ZnOtaStore.read(JSONObject(json))?.let { JSONObject(it).toString() }

    @Test
    fun nothingToDo() {
        assertEquals("""{"update":null}""", read("""{"update":null}"""))
        assertEquals("""{"update":null}""", read("""{}""")) // no update field: the same
    }

    @Test
    fun optionalAndForcedUpdates() {
        assertEquals("""{"update":{"critical":1,"version":175}}""", JSONObject(read("""{"update":{"version":175,"critical":1}}""")!!).let { sorted(it) })
        val forced = JSONObject(read("""{"update":{"version":"1.6.2","critical":2,"title":"Update","message":"New version"},"appStoreId":"123"}""")!!)
        assertEquals("1.6.2", forced.getJSONObject("update").getString("version"))
        assertEquals(2, forced.getJSONObject("update").getInt("critical"))
        assertEquals("Update", forced.getJSONObject("update").getString("title"))
        assertEquals("123", forced.getString("appStoreId"))
    }

    @Test
    fun anAnswerItCantReadIsRefused() {
        // Refused = null: the phone keeps its last good answer
        assertNull(read("""{"update":{"version":175,"critical":3}}"""))
        assertNull(read("""{"update":{"version":175,"critical":0}}"""))
        assertNull(read("""{"update":{"critical":2}}"""))
        assertNull(read("""{"update":{"version":"","critical":2}}"""))
        assertNull(read("""{"update":"soon"}"""))
        assertNull(ZnOtaStore.read("not an object"))
        assertNull(ZnOtaStore.read(null))
    }

    @Test
    fun longTextsAreCut() {
        val long = "x".repeat(1000)
        val u = JSONObject(read("""{"update":{"version":175,"critical":1,"title":"$long"}}""")!!).getJSONObject("update")
        assertEquals(300, u.getString("title").length)
    }

    @Test
    fun aKeptAnswerBecomesAStoreUpdateForTheLaunch() {
        val forced = ZnOtaStore.update(read("""{"update":{"version":175,"critical":2,"title":"New"}}"""))!!
        assertEquals("175", forced.version)
        assertEquals(2, forced.critical)
        assertEquals(true, forced.forced)
        assertEquals("New", forced.title)
        assertNull(forced.message)
        assertEquals(false, ZnOtaStore.update(read("""{"update":{"version":"2.1.0","critical":1}}"""))!!.forced)
        // The saved text has "at" too (State.storeAnswer)
        assertEquals("175", ZnOtaStore.update("""{"update":{"version":175,"critical":2},"at":1}""")!!.version)
        assertNull(ZnOtaStore.update(read("""{"update":null}""")))
        assertNull(ZnOtaStore.update(null))
        assertNull(ZnOtaStore.update("not json"))
    }

    private fun sorted(j: JSONObject): String {
        val u = j.getJSONObject("update")
        return """{"update":{"critical":${u.getInt("critical")},"version":${u.getInt("version")}}}"""
    }
}
