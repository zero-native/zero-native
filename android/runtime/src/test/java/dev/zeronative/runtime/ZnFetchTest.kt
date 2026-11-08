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
import okhttp3.RequestBody.Companion.toRequestBody
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

    // ---- Upload and Download Progress (ZnFetch.CountingRequestBody, ProgressThrottler) ----

    @Test
    fun countingBodyCountsBytesAndMatchesLength() {
        val payload = "Hello, zero-native upload progress!".toByteArray()
        val inner = payload.toRequestBody(null)
        val progressReports = mutableListOf<Pair<Long, Long>>()
        var doneCalled = false

        val counting = ZnFetch.CountingRequestBody(
            inner = inner,
            onProgress = { loaded, total -> progressReports += (loaded to total) },
            onDone = { _, _ -> doneCalled = true },
        )

        assertEquals(payload.size.toLong(), counting.contentLength())
        val sink = okio.Buffer()
        counting.writeTo(sink)

        assertTrue(doneCalled)
        assertEquals(payload.size.toLong(), sink.size)
        assertTrue(progressReports.isNotEmpty())
        assertEquals(payload.size.toLong(), progressReports.last().first)
        assertEquals(payload.size.toLong(), progressReports.last().second)
    }

    @Test
    fun countingBodyPreservesOneShot() {
        val oneShotInner = object : okhttp3.RequestBody() {
            override fun contentType() = null
            override fun contentLength() = 10L
            override fun isOneShot() = true
            override fun writeTo(sink: okio.BufferedSink) {
                sink.write(ByteArray(10))
            }
        }
        val counting = ZnFetch.CountingRequestBody(oneShotInner, onProgress = { _, _ -> })
        assertTrue("counting body must preserve oneShot", counting.isOneShot())
    }

    @Test
    fun progressThrottlerThrottlesAndEmitsFinal() {
        var clockTime = 1000L
        val emitted = mutableListOf<Pair<Long, Long>>()
        val throttler = ZnFetch.ProgressThrottler(
            minIntervalMs = 100L,
            clock = { clockTime },
            onEmit = { loaded, total -> emitted += (loaded to total) },
        )

        // First event at t=1000 -> emitted
        throttler.update(10L, 100L)
        assertEquals(1, emitted.size)
        assertEquals(10L to 100L, emitted[0])

        // Event at t=1050 (< 100ms interval) -> throttled
        clockTime = 1050L
        throttler.update(30L, 100L)
        assertEquals(1, emitted.size)

        // Event at t=1110 (>= 100ms interval) -> emitted
        clockTime = 1110L
        throttler.update(60L, 100L)
        assertEquals(2, emitted.size)
        assertEquals(60L to 100L, emitted[1])

        // Finish call -> always emits the final state if changed
        throttler.finish(100L, 100L)
        assertEquals(3, emitted.size)
        assertEquals(100L to 100L, emitted[2])

        // Calling finish again with same loaded does not duplicate
        throttler.finish(100L, 100L)
        assertEquals(3, emitted.size)
    }

    /** A body that doesn't know its size (like a content:// file whose length can't be read), written in 3 pieces. */
    private class UnknownLengthBody(private val pieces: List<ByteArray>) : okhttp3.RequestBody() {
        override fun contentType() = null
        override fun contentLength() = -1L
        override fun writeTo(sink: okio.BufferedSink) {
            for (p in pieces) {
                sink.write(p)
                sink.emit() // hand each piece on, like a streamed file
            }
        }
    }

    @Test
    fun uploadProgressWithUnknownLengthEndsWithTheRealByteCount() {
        val pieces = listOf(ByteArray(8192) { 1 }, ByteArray(8192) { 2 }, ByteArray(100) { 3 })
        val emitted = mutableListOf<Pair<Long, Long>>()
        val throttler = ZnFetch.ProgressThrottler(minIntervalMs = 100L, clock = { 1000L }) { loaded, total ->
            emitted += (loaded to total)
        }
        // The real path: a POST body is a one-shot Guarded body, then wrapped for progress (ZnFetch.requestBody).
        val body = ZnFetch.uploadProgressBody(ZnFetch.Guarded(UnknownLengthBody(pieces), oneShot = true), throttler)
        assertTrue("progress must keep the one-shot guard (no silent POST retry)", body.isOneShot())
        assertEquals(-1L, body.contentLength())

        val sink = okio.Buffer()
        body.writeTo(sink)

        assertEquals(16484L, sink.size)
        assertTrue(emitted.isNotEmpty())
        // Before the fix the last event was (-1, -1).
        assertEquals(16484L to -1L, emitted.last())
        assertTrue(emitted.all { it.second == -1L })
    }

    @Test
    fun uploadProgressWithKnownLengthEndsWithLoadedEqualToTotal() {
        val payload = ByteArray(20_000) { 7 }
        val emitted = mutableListOf<Pair<Long, Long>>()
        val throttler = ZnFetch.ProgressThrottler(minIntervalMs = 100L, clock = { 1000L }) { loaded, total ->
            emitted += (loaded to total)
        }
        val body = ZnFetch.uploadProgressBody(ZnFetch.Guarded(payload.toRequestBody(null), oneShot = false), throttler)
        body.writeTo(okio.Buffer())
        assertEquals(20_000L to 20_000L, emitted.last())
    }
}
