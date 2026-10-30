package dev.zeronative.runtime

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phone accepts what the release CLI signs (tools/ota/signing.ts): the fixture holds texts and signatures made by
 * the CLI with a throwaway key (tools/ota/make-signature-fixture.ts). Kotlin builds each text from its fields and must
 * get the same bytes, then verify the CLI's signature.
 */
class ZnOtaSignatureTest {
    private val f = JSONObject(javaClass.classLoader!!.getResource("ota-signature-fixture.json")!!.readText())
    private val main = f.getString("publicKey")
    private val other = f.getString("otherPublicKey")

    private fun requires(o: JSONObject): ZnBundles.Requires {
        val r = o.getJSONObject("requires")
        val m = r.getJSONObject("modules")
        return ZnBundles.Requires(r.getInt("registry"), r.getInt("bytecode"), r.getInt("hostApi"), m.keys().asSequence().associateWith { m.getInt(it) })
    }

    @Test
    fun bundleTextAndSignatureMatchTheCli() {
        val b = f.getJSONObject("bundle")
        assertEquals(f.getString("requiresLine"), ZnOtaSignature.requiresLine(requires(b)))
        val text = ZnOtaSignature.bundleText(
            b.getString("app"), b.getString("id"), b.getInt("serial"), b.getString("bundleSha256"), requires(b),
            b.getString("zipSha256"), b.getLong("zipSize"),
        )
        assertEquals(b.getString("text"), text)
        assertEquals(0, ZnOtaSignature.verify(text, b.getString("signature"), listOf(main)))
        assertEquals("the signing key in the second (backup) place is found too", 1, ZnOtaSignature.verify(text, b.getString("signature"), listOf(other, main)))
    }

    @Test
    fun pointerAndKillSwitchMatchTheCli() {
        for (name in listOf("pointer", "kill")) {
            val p = f.getJSONObject(name)
            val text = ZnOtaSignature.pointerText(p.getString("app"), p.getString("channel"), p.getLong("seq"), p.getString("target"))
            assertEquals(p.getString("text"), text)
            assertEquals(name, 0, ZnOtaSignature.verify(text, p.getString("signature"), listOf(main)))
        }
        assertEquals(ZnOtaSignature.BUILT_IN, f.getJSONObject("kill").getString("target"))
    }

    @Test
    fun anythingChangedOrSignedByAnotherKeyIsRefused() {
        val p = f.getJSONObject("pointer")
        val sig = p.getString("signature")
        val text = p.getString("text")
        assertEquals(-1, ZnOtaSignature.verify(text, sig, listOf(other)))
        assertEquals(-1, ZnOtaSignature.verify(text.replace("\n7\n", "\n6\n"), sig, listOf(main))) // an older seq
        assertEquals(-1, ZnOtaSignature.verify(text.replace("production", "staging"), sig, listOf(main)))
        assertEquals(-1, ZnOtaSignature.verify(text, "not base64!", listOf(main)))
        assertEquals(-1, ZnOtaSignature.verify(text, sig, listOf("AAAA")))
    }

    @Test
    fun base64DecodesLikeTheStandard() {
        assertArrayEquals("hi?".toByteArray(), ZnOtaSignature.decodeBase64("aGk/"))
        assertArrayEquals("hi".toByteArray(), ZnOtaSignature.decodeBase64("aGk="))
        assertArrayEquals("h".toByteArray(), ZnOtaSignature.decodeBase64("aA=="))
        assertArrayEquals(ByteArray(0), ZnOtaSignature.decodeBase64(""))
    }
}
