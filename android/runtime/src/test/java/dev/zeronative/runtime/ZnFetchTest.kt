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
import org.junit.Assert.assertEquals
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
}
