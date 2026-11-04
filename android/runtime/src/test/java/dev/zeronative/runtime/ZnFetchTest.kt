package dev.zeronative.runtime

import java.io.EOFException
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.ProtocolException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.UnknownServiceException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The error codes JS gets (FetchErrorCode in packages/core/src/fetch.ts). */
class ZnFetchTest {
    private fun code(e: IOException, online: Boolean = true) = ZnFetch.errorCode(e, online)

    @Test
    fun timeouts() {
        assertEquals("timeout", code(SocketTimeoutException("connect timed out")))
        assertEquals("timeout", code(InterruptedIOException("timeout"))) // OkHttp's call timeout
        // Another interruption is not a timeout.
        assertEquals("connection_lost", code(InterruptedIOException("interrupted")))
    }

    @Test
    fun offlineIsToldApartFromDnsAndConnect() {
        assertEquals("dns", code(UnknownHostException("Unable to resolve host"), online = true))
        assertEquals("offline", code(UnknownHostException("Unable to resolve host"), online = false))
        assertEquals("connect", code(ConnectException("Failed to connect"), online = true))
        assertEquals("offline", code(ConnectException("Failed to connect"), online = false))
    }

    @Test
    fun tlsCleartextRedirectsAndCutBodies() {
        assertEquals("tls", code(SSLHandshakeException("Chain validation failed")))
        assertEquals("tls", code(SSLPeerUnverifiedException("Hostname not verified")))
        assertEquals(
            "cleartext_blocked",
            code(UnknownServiceException("CLEARTEXT communication to example.com not permitted by network security policy")),
        )
        assertEquals("too_many_redirects", code(ProtocolException("Too many follow-up requests: 21")))
        assertEquals("connection_lost", code(EOFException("\\n not found: limit=0")))
        assertEquals("connection_lost", code(ProtocolException("unexpected end of stream")))
    }

    // ---- Plugin interceptors (ZnFetch.addInterceptor) ----

    /** A client whose last interceptor answers 200 with no network, counting how often the request got that far. */
    private fun clientWith(plugin: Interceptor, sent: IntArray): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(ZnFetch.PluginInterceptor(plugin) { _, _ -> })
        .addInterceptor { chain ->
            sent[0]++
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("ok".toResponseBody()).build()
        }
        .build()

    private val request = Request.Builder().url("https://example.test/pay").build()

    @Test
    fun aPluginThatWorksChangesNothing() {
        val sent = IntArray(1)
        val response = clientWith({ chain -> chain.proceed(chain.request()) }, sent).newCall(request).execute()
        assertEquals(200, response.code)
        assertEquals(1, sent[0])
    }

    @Test
    fun aPluginThatThrowsFailsTheCallInsteadOfCrashing() {
        val sent = IntArray(1)
        val before = clientWith({ throw IllegalStateException("bug before proceed") }, sent)
        val e1 = assertThrows(IOException::class.java) { before.newCall(request).execute() }
        assertEquals("connection_lost", code(e1))
        assertEquals(0, sent[0])

        // A bug after the request went out: the call fails, and the request is not sent a second time.
        val after = clientWith({ chain -> chain.proceed(chain.request()); throw NullPointerException("bug after") }, sent)
        val e2 = assertThrows(IOException::class.java) { after.newCall(request).execute() }
        assertTrue(e2.message!!.contains("a plugin's interceptor failed"))
        assertEquals(1, sent[0])
    }

    @Test
    fun aPluginsIoErrorStaysAsItIs() {
        val sent = IntArray(1)
        val client = clientWith({ throw SocketTimeoutException("plugin timeout") }, sent)
        val e = assertThrows(IOException::class.java) { client.newCall(request).execute() }
        assertEquals("timeout", code(e))
    }
}
