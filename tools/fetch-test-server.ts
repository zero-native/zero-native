// A local server for checking fetch on the phone (docs/fetch.md; sample screen /dev/fetch).
//
//   bun run tools/fetch-test-server.ts
//   adb reverse tcp:8788 tcp:8788
//   adb reverse tcp:8789 tcp:8789
//
// Port 8788: normal HTTP (Bun.serve). Port 8789: a raw TCP server for broken answers no normal server sends: a body
// cut short, and a pooled connection closed after the request arrived (OkHttp would normally send it again: this
// proves a POST is never sent twice).
//
// WebSocket (sample screen /dev/websocket): ws://localhost:8788/ws echoes text. Query flags: `proto` picks the first
// offered subprotocol, `headers` first sends the handshake's headers as JSON, `close=4001` closes at once with that
// code ("bye"), `binary` sends one binary frame, `size=N` sends N "x" (`char=é` another character), `burst=N` sends
// "0" to "N-1" first (before `close`). On port 8789, our own small WebSocket server for what a normal one won't do:
// /ws-silent does the handshake, then never answers anything (no pong, no close); /ws-noclose answers pings and echoes
// text but never answers a close; /ws-eof answers pings, and on a close frame drops the TCP connection without a close
// frame back; /ws-slowpong?ms=3000 answers each ping that late (and echoes, and answers a close); /ws-slow101?ms=20000
// sends the 101 that late; /ws-slowclose?ms=3000 answers a close that late.
//
// Uploads (the fetch lab's FormData and progress cases): /count answers only the body's length; /upload reads a
// multipart body and answers each part's headers and size, and for a file part whether byte i is i % 251, the pattern
// of the lab files. `--files <folder>` first makes those files there (zn-lab-3mb.bin, zn-lab-200mb.bin); on the iOS
// simulator any Mac folder works (--files /tmp/zn-lab, and the lab's { dir: "/tmp/zn-lab" }).
// /conn answers the client's port: two calls on one pooled connection get the same port.
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { gzipSync, type ServerWebSocket } from "bun"
import { tabsAnswer } from "./plugin-phone/tabs-server"

// Other ports for a second server next to one already running: ZN_TEST_HTTP_PORT=8798 (raw: the next port).
const HTTP_PORT = Number(process.env.ZN_TEST_HTTP_PORT ?? 8788)
const RAW_PORT = HTTP_PORT + 1

/** The lab files: byte i is i % 251 (ios/tests/net makes the same). Written in 1 MB pieces; kept when the size is right. */
const LAB_FILES: Array<[string, number]> = [["zn-lab-3mb.bin", 3 * 1024 * 1024 + 17], ["zn-lab-200mb.bin", 200_000_000]]
const filesAt = process.argv.indexOf("--files")
if (filesAt !== -1) {
  const dir = process.argv[filesAt + 1]
  if (!dir) throw new Error("--files needs a folder")
  mkdirSync(dir, { recursive: true })
  for (const [name, size] of LAB_FILES) {
    const path = join(dir, name)
    if (existsSync(path) && statSync(path).size === size) continue
    const fd = openSync(path, "w")
    const piece = Buffer.alloc(1 << 20)
    for (let at = 0; at < size; at += piece.length) {
      const n = Math.min(piece.length, size - at)
      for (let i = 0; i < n; i++) piece[i] = (at + i) % 251
      writeSync(fd, piece, 0, n)
    }
    closeSync(fd)
    console.log(`wrote ${path} (${size} bytes)`)
  }
}

/** A multipart body's parts: each one's header lines, its size, and the lab pattern check for a file part. */
function multipartParts(body: Buffer, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]?.replace(/^"|"$/g, "")
  if (!boundary) return null
  const dash = Buffer.from(`--${boundary}`)
  const parts: Array<{ headers: string[]; size: number; text?: string; pattern?: boolean }> = []
  let at = body.indexOf(dash)
  while (at !== -1) {
    const after = at + dash.length
    if (body.subarray(after, after + 2).toString() === "--") break
    const headEnd = body.indexOf("\r\n\r\n", after)
    if (headEnd === -1) break
    const headers = body.subarray(after + 2, headEnd).toString("utf8").split("\r\n")
    const next = body.indexOf(dash, headEnd + 4)
    if (next === -1) break
    const data = body.subarray(headEnd + 4, next - 2) // without the CRLF before the next boundary
    const part: (typeof parts)[number] = { headers, size: data.length }
    if (headers.some((h) => /filename=/i.test(h))) {
      let ok = true
      for (let i = 0; i < data.length && ok; i++) ok = data[i] === i % 251
      part.pattern = ok
    } else if (data.length <= 200) {
      part.text = data.toString("utf8")
    }
    parts.push(part)
    at = next
  }
  return parts
}

// A 64 x 64 blue and white checker (PNG).
const LAB_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAaElEQVR42u3XMQ0AIAxFwZpBGfIrAgzQqQuEI4wM3PTyY8w83lWc294HAAAAAEAL8MpHq/cAAAAAAD2AEgMAAADYA0oMAAAAYA8oMQAAAIA9oMQAAAAA9oASAwAAANgDSgwAAADwDWADMWSCDlyYVuEAAAAASUVORK5CYII="

// The image lab's counters (/slow-image).
let imageOpen = 0
let imageMaxOpen = 0
let imageLog: string[] = []
let imageT0 = performance.now()

// What the WebSocket server saw: each socket's close (code, reason) and pings, newest last.
interface WsData {
  query: URLSearchParams
  headers: Record<string, string>
  pings: number
}
let wsLog: string[] = []
let wsOpen = 0

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init.headers } })

Bun.serve<WsData, never>({
  port: HTTP_PORT,
  maxRequestBodySize: 1024 * 1024 * 1024, // the lab's 200 MB upload (default 128 MB)
  async fetch(req, server) {
    const url = new URL(req.url)
    const path = url.pathname
    if (path === "/ws") {
      const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()).filter(Boolean)
      const headers: Record<string, string> = {}
      if (url.searchParams.has("proto") && offered.length > 0) headers["Sec-WebSocket-Protocol"] = offered[0]!
      const data: WsData = { query: url.searchParams, headers: Object.fromEntries(req.headers), pings: 0 }
      if (server.upgrade(req, { headers, data })) return undefined
      return new Response("expected a WebSocket upgrade", { status: 400 })
    }
    if (path === "/ws-log") return json({ log: wsLog, open: wsOpen })
    if (path === "/ws-log-reset") {
      wsLog = []
      return json({ reset: true })
    }
    if (path === "/json") return json({ ok: true, hindi: "नमस्ते", emoji: "😀", amount: 1250 })
    if (path === "/echo") {
      const body = new Uint8Array(await req.arrayBuffer())
      return json({
        method: req.method,
        headers: Object.fromEntries(req.headers),
        bodyText: new TextDecoder().decode(body),
        bodyLength: body.length,
        bodyFirstBytes: [...body.slice(0, 8)],
      })
    }
    if (path === "/count") {
      let length = 0
      if (req.body) for await (const chunk of req.body) length += chunk.length
      return json({ method: req.method, contentType: req.headers.get("content-type"), length })
    }
    if (path === "/upload") {
      const body = Buffer.from(await req.arrayBuffer())
      const parts = multipartParts(body, req.headers.get("content-type") ?? "")
      console.log(`upload: ${body.length} bytes, ${parts?.length ?? "no"} parts`)
      return json({ length: body.length, contentLength: req.headers.get("content-length"), parts })
    }
    if (path === "/conn") return json({ port: server.requestIP(req)?.port ?? null })
    if (path === "/slow") {
      await Bun.sleep(Number(url.searchParams.get("ms") ?? 3000))
      return json({ slept: true })
    }
    // The image lab (/dev/image-par): a picture after `ms`, counting how many are being served at once.
    if (path === "/slow-image") {
      const t = performance.now()
      imageOpen++
      imageMaxOpen = Math.max(imageMaxOpen, imageOpen)
      const id = url.searchParams.get("id") ?? "?"
      imageLog.push(`start ${id} at ${Math.round(t - imageT0)} ms (${imageOpen} open)`)
      await Bun.sleep(Number(url.searchParams.get("ms") ?? 2000))
      imageOpen--
      imageLog.push(`end ${id} at ${Math.round(performance.now() - imageT0)} ms`)
      return new Response(Buffer.from(LAB_PNG, "base64"), { headers: { "content-type": "image/png", "cache-control": "no-store" } })
    }
    if (path === "/slow-image-reset") {
      imageOpen = 0
      imageMaxOpen = 0
      imageLog = []
      imageT0 = performance.now()
      return json({ reset: true })
    }
    if (path === "/slow-image-stats") return json({ maxOpen: imageMaxOpen, open: imageOpen, log: imageLog })
    // The tabs lab (/dev/tabs): one tab's data after a delay.
    const tabs = await tabsAnswer(url)
    if (tabs) return tabs
    if (path.startsWith("/status/")) {
      const code = Number(path.slice("/status/".length))
      return new Response(code === 204 || code === 304 ? null : `status ${code}`, { status: code })
    }
    if (path.startsWith("/redirect/")) {
      const n = Number(path.slice("/redirect/".length))
      return new Response(null, { status: 302, headers: { location: n > 1 ? `/redirect/${n - 1}` : "/json" } })
    }
    // Same port, other host name: OkHttp must drop Authorization when the host changes.
    if (path === "/redirect-other-host") {
      return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${HTTP_PORT}/auth` } })
    }
    if (path === "/auth") return json({ authorization: req.headers.get("authorization") })
    // The image viewer lab (/dev/image-viewer): a picture only with the lab's header, else 401. Logs yes or no, not the value.
    if (path === "/image-auth") {
      const ok = req.headers.get("authorization") === "Bearer zn-lab"
      console.log(`image-auth: header ${ok ? "ok" : "missing or wrong"}`)
      if (!ok) return new Response("no", { status: 401 })
      return new Response(Buffer.from(LAB_PNG, "base64"), { headers: { "content-type": "image/png", "cache-control": "no-store" } })
    }
    if (path === "/gzip") {
      const body = gzipSync(new TextEncoder().encode(JSON.stringify({ zipped: true, filler: "x".repeat(5000) })))
      return new Response(body, { headers: { "content-type": "application/json", "content-encoding": "gzip" } })
    }
    if (path === "/big") {
      const mb = Number(url.searchParams.get("mb") ?? 1)
      return new Response(new Uint8Array(Math.round(mb * 1_000_000)).fill(97), { headers: { "content-type": "text/plain" } })
    }
    if (path === "/bom") {
      return new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"bom":true}')]), {
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    if (path === "/latin1") {
      return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { headers: { "content-type": "text/plain; charset=iso-8859-1" } })
    }
    if (path === "/html") {
      return new Response("<html><body>Please log in to the Wi-Fi</body></html>", { headers: { "content-type": "text/html" } })
    }
    if (path === "/cookies") {
      const headers = new Headers()
      headers.append("set-cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/")
      headers.append("set-cookie", "b=2; Path=/")
      return new Response("ok", { headers })
    }
    return new Response("not found", { status: 404 })
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      wsOpen++
      const q = ws.data.query
      if (q.has("headers")) ws.send(JSON.stringify(ws.data.headers))
      for (let i = 0; i < Number(q.get("burst") ?? 0); i++) ws.send(String(i))
      if (q.has("close")) ws.close(Number(q.get("close")), "bye")
      if (q.has("binary")) ws.sendBinary(new Uint8Array([1, 2, 3]))
      if (q.has("size")) ws.send((q.get("char") ?? "x").repeat(Number(q.get("size"))))
    },
    message(ws: ServerWebSocket<WsData>, message) {
      if (message === "pings?") return void ws.send(String(ws.data.pings))
      ws.send(message)
    },
    ping(ws: ServerWebSocket<WsData>) {
      ws.data.pings++
    },
    close(ws: ServerWebSocket<WsData>, code, reason) {
      wsOpen--
      wsLog.push(`close ${code} ${reason}`)
      console.log(`ws: closed ${code} "${reason}" after ${ws.data.pings} pings (${wsOpen} open)`)
    },
    maxPayloadLength: 16 * 1024 * 1024,
  },
})

// ---- Raw TCP ---------------------------------------------------------------------------------------------------------

const received: Record<string, number> = {} // "POST /drop" → how many times the full request arrived

/** One WebSocket frame from the client (always masked): its opcode and payload, and how many bytes it took. */
function readFrame(buf: Buffer): { op: number; payload: Buffer; used: number } | null {
  if (buf.length < 2) return null
  let len = buf[1]! & 0x7f
  let at = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    at = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    at = 10
  }
  const masked = (buf[1]! & 0x80) !== 0
  const mask = masked ? buf.subarray(at, at + 4) : null
  if (masked) at += 4
  if (buf.length < at + len) return null
  const payload = Buffer.from(buf.subarray(at, at + len))
  if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
  return { op: buf[0]! & 0x0f, payload, used: at + len }
}

/** A frame from the server (never masked). */
function frame(op: number, payload: Buffer): Buffer {
  const n = payload.length
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : Buffer.from([0x80 | op, 126, n >> 8, n & 0xff])
  return Buffer.concat([head, payload])
}

createServer((socket) => {
  let data = Buffer.alloc(0)
  // A raw WebSocket after its handshake: "silent" ignores everything; the others read frames (see the top).
  let ws: { mode: string; ms: number } | null = null
  socket.on("data", (chunk) => {
    if (ws?.mode === "silent") return
    data = Buffer.concat([data, chunk])
    if (ws) {
      for (let f = readFrame(data); f; f = readFrame(data)) {
        data = data.subarray(f.used)
        const { op, payload } = f
        if (op === 0x9) {
          const pong = frame(0xa, payload)
          if (ws.mode === "slowpong") setTimeout(() => socket.writable && socket.write(pong), ws.ms)
          else socket.write(pong)
        } else if (op === 0x1) {
          socket.write(frame(0x1, payload))
        } else if (op === 0x8) {
          console.log(`raw ws (${ws.mode}): got a close ${payload.length >= 2 ? payload.readUInt16BE(0) : "(no code)"}`)
          const answer = frame(0x8, payload.subarray(0, 2))
          if (ws.mode === "eof") socket.destroy()
          else if (ws.mode === "slowpong") socket.end(answer)
          else if (ws.mode === "slowclose") setTimeout(() => socket.writable && socket.end(answer), ws.ms)
          // noclose: no answer, the connection stays open
        }
      }
      return
    }
    const end = data.indexOf("\r\n\r\n")
    if (end === -1) return
    const head = data.subarray(0, end).toString("latin1")
    const [method, target] = head.split(" ")
    const url = new URL(target ?? "/", "http://raw")
    const path = url.pathname
    const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0)
    if (data.length < end + 4 + length) return // wait for the whole body
    const key = `${method} ${path}`
    data = Buffer.alloc(0)
    const rawWs = /^\/ws-(silent|noclose|eof|slowpong|slowclose|slow101)$/.exec(path)?.[1]
    if (rawWs) {
      const wsKey = /sec-websocket-key: *(\S+)/i.exec(head)?.[1] ?? ""
      const accept = createHash("sha1").update(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
      const answer = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      const ms = Number(url.searchParams.get("ms") ?? (rawWs === "slow101" ? 20000 : 3000))
      if (rawWs === "slow101") setTimeout(() => socket.writable && socket.write(answer), ms)
      else socket.write(answer)
      ws = { mode: rawWs === "slow101" ? "noclose" : rawWs, ms }
    } else if (path === "/warm") {
      // A normal answer that keeps the connection open, so the client pools it and sends the next request on it.
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok")
    } else if (path === "/drop") {
      // The request arrived in full; the connection dies before any answer (server crash, network cut).
      received[key] = (received[key] ?? 0) + 1
      socket.destroy()
    } else if (path === "/cut") {
      // Promises 1000 bytes, sends 10, then closes: the client must report an error, not a short body.
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\n0123456789")
      socket.destroy()
    } else if (path === "/counts") {
      const body = JSON.stringify(received)
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    } else if (path === "/reset") {
      for (const k of Object.keys(received)) delete received[k]
      socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
    } else {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }
  })
  socket.on("error", () => {})
  socket.on("close", () => ws && console.log(`raw ws (${ws.mode}): connection closed`))
}).listen(RAW_PORT)

console.log(`fetch test server: http://localhost:${HTTP_PORT} and raw http://localhost:${RAW_PORT}`)
console.log(`on the phone: adb reverse tcp:${HTTP_PORT} tcp:${HTTP_PORT}; adb reverse tcp:${RAW_PORT} tcp:${RAW_PORT}`)
