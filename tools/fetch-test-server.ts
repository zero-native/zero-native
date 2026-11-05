// A local server for checking fetch on the phone (docs/fetch.md; sample screen /dev/fetch).
//
//   bun run tools/fetch-test-server.ts
//   adb reverse tcp:8788 tcp:8788
//   adb reverse tcp:8789 tcp:8789
//
// Port 8788: normal HTTP (Bun.serve). Port 8789: a raw TCP server for broken answers no normal server sends: a body
// cut short, and a pooled connection closed after the request arrived (OkHttp would normally send it again: this
// proves a POST is never sent twice).
import { createServer } from "node:net"
import { gzipSync } from "bun"
import { tabsAnswer } from "./plugin-phone/tabs-server"

const HTTP_PORT = 8788
const RAW_PORT = 8789

// A 64 x 64 blue and white checker (PNG).
const LAB_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAaElEQVR42u3XMQ0AIAxFwZpBGfIrAgzQqQuEI4wM3PTyY8w83lWc294HAAAAAEAL8MpHq/cAAAAAAD2AEgMAAADYA0oMAAAAYA8oMQAAAIA9oMQAAAAA9oASAwAAANgDSgwAAADwDWADMWSCDlyYVuEAAAAASUVORK5CYII="

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init.headers } })

Bun.serve({
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
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
    if (path === "/slow") {
      await Bun.sleep(Number(url.searchParams.get("ms") ?? 3000))
      return json({ slept: true })
    }
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
})

// ---- Raw TCP ---------------------------------------------------------------------------------------------------------

const received: Record<string, number> = {} // "POST /drop" → how many times the full request arrived

createServer((socket) => {
  let data = Buffer.alloc(0)
  socket.on("data", (chunk) => {
    data = Buffer.concat([data, chunk])
    const end = data.indexOf("\r\n\r\n")
    if (end === -1) return
    const head = data.subarray(0, end).toString("latin1")
    const [method, path] = head.split(" ")
    const length = Number(/content-length: *(\d+)/i.exec(head)?.[1] ?? 0)
    if (data.length < end + 4 + length) return // wait for the whole body
    const key = `${method} ${path}`
    data = Buffer.alloc(0)
    if (path === "/warm") {
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
}).listen(RAW_PORT)

console.log(`fetch test server: http://localhost:${HTTP_PORT} and raw http://localhost:${RAW_PORT}`)
console.log(`on the phone: adb reverse tcp:${HTTP_PORT} tcp:${HTTP_PORT}; adb reverse tcp:${RAW_PORT} tcp:${RAW_PORT}`)
