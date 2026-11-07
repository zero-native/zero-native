package dev.zeronative.runtime

import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import okhttp3.Protocol
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * ZeroBill PAY-5 (2026-11-07): an HTTP/2 connection that silently stops answering must be dropped, so the next call
 * gets a new connection. A fake server accepts HTTP/2 (prior knowledge, no TLS), sends its SETTINGS, then reads and
 * never writes again: like a connection whose packets go nowhere.
 */
class ZnFetchPingTest {
    private lateinit var server: ServerSocket
    private val accepted = AtomicInteger()
    private val sockets = CopyOnWriteArrayList<Socket>()

    @Before
    fun start() {
        server = ServerSocket(0)
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (e: IOException) { break }
                accepted.incrementAndGet()
                sockets += s
                // Server preface: an empty SETTINGS frame (length 0, type 4, flags 0, stream 0). Then silence.
                s.getOutputStream().apply { write(byteArrayOf(0, 0, 0, 4, 0, 0, 0, 0, 0)); flush() }
                thread(isDaemon = true) { try { s.getInputStream().readBytes() } catch (_: IOException) {} }
            }
        }
    }

    @After
    fun stop() {
        server.close()
        sockets.forEach { runCatching { it.close() } }
    }

    private fun client(pingMs: Long) = ZnFetch.baseBuilder(pingMs).protocols(listOf(Protocol.H2_PRIOR_KNOWLEDGE)).build()

    private fun request() = Request.Builder().url("http://127.0.0.1:${server.localPort}/verify").build()

    @Test
    fun `the shared client checks its connections every 10 s`() {
        assertEquals(10_000, ZnFetch.baseBuilder().build().pingIntervalMillis)
    }

    @Test
    fun `a silent connection fails its call soon, and the next call opens a new connection`() {
        val c = client(pingMs = 300)
        val first = c.newCall(request()).apply { timeout().timeout(20, TimeUnit.SECONDS) }
        val t0 = System.nanoTime()
        try {
            first.execute().close()
            fail("a server that never answers gave an answer")
        } catch (e: IOException) {
            val ms = (System.nanoTime() - t0) / 1_000_000
            // Two missed pings (~600 ms each try; OkHttp may retry a GET once on a new connection), far below the 20 s
            // call timeout that kept PAY-5 waiting.
            assertTrue("failed after $ms ms: ${e.message}", ms < 5_000)
        }
        val before = accepted.get()
        val second = c.newCall(request()).apply { timeout().timeout(20, TimeUnit.SECONDS) }
        runCatching { second.execute().close() }
        assertTrue("the next call reused the dead connection (accepted ${accepted.get()}, before $before)", accepted.get() > before)
    }

    @Test
    fun `without the ping, the same call waits for its whole timeout (what PAY-5 did)`() {
        val c = client(pingMs = 0)
        val call = c.newCall(request()).apply { timeout().timeout(1500, TimeUnit.MILLISECONDS) }
        val t0 = System.nanoTime()
        runCatching { call.execute().close() }
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("failed after only $ms ms", ms >= 1_400)
        // The dead connection is still in the pool for the next call.
        assertEquals(1, c.connectionPool.connectionCount())
    }
}
