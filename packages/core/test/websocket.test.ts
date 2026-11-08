import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { installCalls } from "../src/calls"
import {
  WebSocket,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketEvent,
  WebSocketMessageEvent,
  installWebSocket,
  utf8Length,
} from "../src/websocket"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

function emitWsEvent(event: string, payload: unknown): void {
  globalThis.__zn_onEvent(
    0,
    8,
    JSON.stringify({
      module: "WebSocket",
      event,
      payload,
    }),
  )
}

/** Native's answer to a call (app event 7). */
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const wsCalls = (method: string) => host.calls.filter((c) => c.module === "WebSocket" && c.method === method)
// Bun.sleep, not setTimeout: other test files replace the global setTimeout (core timers), and in a full run it never fired.
const flush = () => Bun.sleep(0)

/** A socket plus everything it dispatched, in order ("open", "message:<data>", "error", "close:<code>"). */
function track(ws: WebSocket): string[] {
  const seen: string[] = []
  ws.onopen = () => seen.push("open")
  ws.onmessage = (e) => seen.push(`message:${e.data}`)
  ws.onerror = () => seen.push("error")
  ws.onclose = (e) => seen.push(`close:${e.code}:${e.wasClean}`)
  return seen
}

function openSocket(url = "ws://echo.test"): { ws: WebSocket; id: number; seen: string[] } {
  const ws = new WebSocket(url)
  const id = wsCalls("connect").at(-1)!.args.id
  const seen = track(ws)
  emitWsEvent("open", { id, protocol: "" })
  return { ws, id, seen }
}

test("WebSocket rejects non-ws/wss URLs with SyntaxError", () => {
  expect(() => new WebSocket("http://example.com")).toThrow(SyntaxError)
  expect(() => new WebSocket("https://example.com")).toThrow(SyntaxError)
  expect(() => new WebSocket("ftp://example.com")).toThrow(SyntaxError)
  expect(() => new WebSocket("/relative")).toThrow(SyntaxError)
  expect(() => new WebSocket("not-a-url")).toThrow(SyntaxError)
})

test("WebSocket rejects URLs with a fragment or no host, before any native call", () => {
  expect(() => new WebSocket("ws://echo.test/path#frag")).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test/#")).toThrow(SyntaxError) // an empty fragment too, like browsers
  expect(() => new WebSocket("ws://")).toThrow(SyntaxError)
  expect(() => new WebSocket("wss://:443/path")).toThrow(SyntaxError)
  expect(wsCalls("connect").length).toBe(0)
})

test("url is the full parsed URL; message origin is scheme://host[:port]", () => {
  const ws = new WebSocket("wss://Echo.Test:8443/chat?room=1")
  expect(ws.url).toBe("wss://echo.test:8443/chat?room=1")
  expect(wsCalls("connect")[0].args.url).toBe("wss://echo.test:8443/chat?room=1")
  const id = wsCalls("connect")[0].args.id
  const origins: string[] = []
  ws.onmessage = (e) => origins.push(e.origin)
  emitWsEvent("open", { id })
  emitWsEvent("message", { id, data: "hi" })
  expect(origins).toEqual(["wss://echo.test:8443"])
  expect(new WebSocket("ws://echo.test").url).toBe("ws://echo.test/")
})

test("WebSocket constructor subprotocol validation", () => {
  expect(() => new WebSocket("ws://echo.test", ["v1", "v1"])).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test", 123 as any)).toThrow(SyntaxError)
  // RFC 6455: names are HTTP tokens (no spaces, commas, quotes, empty names)
  expect(() => new WebSocket("ws://echo.test", "")).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test", "a b")).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test", ["a,b"])).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test", ['"q"'])).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test", ["ok", "naïve"])).toThrow(SyntaxError)
  expect(wsCalls("connect").length).toBe(0)

  const ws = new WebSocket("ws://echo.test", "chat")
  const connectCall = wsCalls("connect")[0]
  expect(connectCall).toBeDefined()
  expect(connectCall.args.protocols).toEqual(["chat"])
  new WebSocket("ws://echo.test", ["graphql-ws", "v1.json", "x_y~z"])
  expect(wsCalls("connect")[1].args.protocols).toEqual(["graphql-ws", "v1.json", "x_y~z"])
  ws.close()
})

test("WebSocket constants exist on class and instance", () => {
  expect(WebSocket.CONNECTING).toBe(0)
  expect(WebSocket.OPEN).toBe(1)
  expect(WebSocket.CLOSING).toBe(2)
  expect(WebSocket.CLOSED).toBe(3)

  const ws = new WebSocket("ws://echo.test")
  expect(ws.CONNECTING).toBe(0)
  expect(ws.OPEN).toBe(1)
  expect(ws.CLOSING).toBe(2)
  expect(ws.CLOSED).toBe(3)
  expect(ws.readyState).toBe(WebSocket.CONNECTING)
  ws.close()
})

test("full connection lifecycle: connect, open, message, close", () => {
  const ws = new WebSocket("wss://echo.test", ["json", "v1"])
  const connectCall = wsCalls("connect")[0]
  const id = connectCall.args.id

  const openEvents: WebSocketEvent[] = []
  const messageEvents: WebSocketMessageEvent[] = []
  const closeEvents: WebSocketCloseEvent[] = []

  ws.onopen = (e) => openEvents.push(e)
  ws.addEventListener("message", (e) => messageEvents.push(e))
  ws.onclose = (e) => closeEvents.push(e)

  // 1. Open
  emitWsEvent("open", { id, protocol: "json" })
  expect(ws.readyState).toBe(WebSocket.OPEN)
  expect(ws.protocol).toBe("json")
  expect(openEvents.length).toBe(1)
  expect(openEvents[0].type).toBe("open")

  // 2. Message
  emitWsEvent("message", { id, data: '{"status":"connected"}' })
  expect(messageEvents.length).toBe(1)
  expect(messageEvents[0].data).toBe('{"status":"connected"}')
  expect(messageEvents[0].origin).toBe("wss://echo.test")

  // 3. Send
  ws.send("hello from client")
  const sendCall = wsCalls("send")[0]
  expect(sendCall).toBeDefined()
  expect(sendCall.args).toEqual({ id, data: "hello from client" })

  // 4. Close
  ws.close(1000, "done")
  expect(ws.readyState).toBe(WebSocket.CLOSING)
  expect(wsCalls("close").length).toBe(1)
  expect(wsCalls("close")[0].args).toEqual({ id, code: 1000, reason: "done", abort: false })

  // Calling close again while CLOSING does nothing: no second native close
  ws.close(1000, "again")
  ws.close()
  expect(wsCalls("close").length).toBe(1)

  // 5. Server confirms closed
  emitWsEvent("close", { id, code: 1000, reason: "done", wasClean: true })
  expect(ws.readyState).toBe(WebSocket.CLOSED)
  expect(closeEvents.length).toBe(1)
  expect(closeEvents[0].code).toBe(1000)
  expect(closeEvents[0].reason).toBe("done")
  expect(closeEvents[0].wasClean).toBe(true)

  // Late events after close must be ignored; close in CLOSED does nothing either
  emitWsEvent("message", { id, data: "ghost" })
  expect(messageEvents.length).toBe(1)
  ws.close()
  expect(wsCalls("close").length).toBe(1)
})

test("server close: closing event moves to CLOSING, then close gives the server's code", () => {
  const { ws, id, seen } = openSocket()
  emitWsEvent("closing", { id, code: 4001, reason: "bye" })
  expect(ws.readyState).toBe(WebSocket.CLOSING)
  expect(seen).toEqual(["open"])
  // In CLOSING, send is dropped quietly (browsers don't throw either)
  ws.send("late")
  expect(wsCalls("send").length).toBe(0)
  // and close() does nothing
  ws.close()
  expect(wsCalls("close").length).toBe(0)
  emitWsEvent("close", { id, code: 4001, reason: "bye", wasClean: true })
  expect(ws.readyState).toBe(WebSocket.CLOSED)
  expect(seen).toEqual(["open", "close:4001:true"])
})

test("native failure: error event first, then close 1006", () => {
  const { ws, id, seen } = openSocket()
  emitWsEvent("error", { id, message: "Connection reset" })
  emitWsEvent("close", { id, code: 1006, reason: "Connection reset", wasClean: false })
  expect(seen).toEqual(["open", "error", "close:1006:false"])
  expect(ws.readyState).toBe(WebSocket.CLOSED)
  // A late error after close is not dispatched
  emitWsEvent("error", { id, message: "again" })
  expect(seen.length).toBe(3)
})

test("a rejected connect gives error, then close 1006 (once)", async () => {
  const ws = new WebSocket("ws://echo.test")
  const seen = track(ws)
  const c = wsCalls("connect")[0]
  reply({ id: c.id, ok: false, code: "invalid_url", error: "Invalid WebSocket URL" })
  await flush()
  expect(seen).toEqual(["error", "close:1006:false"])
  expect(ws.readyState).toBe(WebSocket.CLOSED)
  // Events for that id are no longer heard
  emitWsEvent("close", { id: c.args.id, code: 1000, reason: "", wasClean: true })
  expect(seen.length).toBe(2)
})

test("close() while CONNECTING asks native to abort; one error + one close 1006, no leak", () => {
  // Sockets of earlier tests still listen (listener counts are per event, for all sockets): note where we start.
  const before = new Map<string, number>()
  const countsNow = (into: Map<string, number>) => {
    for (const c of wsCalls("__listeners")) into.set(c.args.event, c.args.count)
    return into
  }
  const ws = new WebSocket("ws://echo.test")
  const started = countsNow(new Map())
  expect(started.get("open")).toBeGreaterThan(0)
  for (const [event, n] of started) before.set(event, n - 1)
  const seen = track(ws)
  const id = wsCalls("connect")[0].args.id
  ws.close()
  expect(ws.readyState).toBe(WebSocket.CLOSING)
  expect(wsCalls("close").map((c) => c.args)).toEqual([{ id, code: 1000, reason: "", abort: true }])
  // A late open (native opened just before the cancel) is ignored
  emitWsEvent("open", { id })
  expect(ws.readyState).toBe(WebSocket.CLOSING)
  // Native cancels the connect: onFailure → error, close 1006
  emitWsEvent("error", { id, message: "Canceled" })
  emitWsEvent("close", { id, code: 1006, reason: "Canceled", wasClean: false })
  emitWsEvent("close", { id, code: 1006, reason: "Canceled", wasClean: false })
  expect(seen).toEqual(["error", "close:1006:false"])
  expect(ws.readyState).toBe(WebSocket.CLOSED)
  // Its own native event listeners were all removed: each count is one less than while it was connecting
  expect(countsNow(new Map())).toEqual(before)
})

test("events for another id (an old JS runtime's socket) are ignored", async () => {
  const { ws, id, seen } = openSocket()
  emitWsEvent("message", { id: id + 1, data: "not mine" })
  emitWsEvent("close", { id: 1, code: 1000, reason: "", wasClean: true })
  expect(seen).toEqual(["open"])
  expect(ws.readyState).toBe(WebSocket.OPEN)

  // A second copy of the module stands in for the JS runtime after a reload: its ids start somewhere else, so an
  // old runtime's id (1, 2, ...) and the new one's don't meet.
  const fresh = (await import("../src/websocket.ts?runtime2")) as typeof import("../src/websocket")
  const ws2 = new fresh.WebSocket("ws://echo.test")
  const id2 = wsCalls("connect").at(-1)!.args.id
  expect(id2).not.toBe(id + 1)
  expect(Number.isInteger(id2) && id2 > 0 && id2 < 2 ** 31).toBe(true)
  emitWsEvent("open", { id })
  expect(ws2.readyState).toBe(WebSocket.CONNECTING)
})

test("send before open throws InvalidStateError", () => {
  const ws = new WebSocket("ws://echo.test")
  expect(() => ws.send("early")).toThrow()
  try {
    ws.send("early")
  } catch (e: any) {
    expect(e.name).toBe("InvalidStateError")
  }
  ws.close()
})

test("send in CLOSING or CLOSED is a quiet no-op", () => {
  const { ws, id } = openSocket()
  ws.close()
  expect(() => ws.send("after close")).not.toThrow()
  emitWsEvent("close", { id, code: 1000, reason: "", wasClean: true })
  expect(() => ws.send("after closed")).not.toThrow()
  expect(wsCalls("send").length).toBe(0)
})

test("a send that races a native close is not reported as an app error", async () => {
  const { ws } = openSocket()
  ws.send("a")
  ws.send("b")
  const [s1, s2] = wsCalls("send")
  reply({ id: s1.id, ok: false, code: "not_found", error: "WebSocket 1 not found or already closed" })
  reply({ id: s2.id, ok: false, code: "send_failed", error: "Failed to enqueue WebSocket message" })
  await flush()
  expect(host.logs.filter(([level]) => level === 3)).toEqual([]) // no reportError
  expect(host.logs.filter(([level, m]) => level === 2 && m.includes("WebSocket send dropped")).length).toBe(2)
  ws.close()
})

test("send binary throws TypeError in v1", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = wsCalls("connect")[0]
  emitWsEvent("open", { id: connectCall.args.id })

  expect(() => ws.send(new Uint8Array([1, 2, 3]))).toThrow(TypeError)
  expect(() => ws.send(new ArrayBuffer(8))).toThrow(TypeError)
  ws.close()
})

test("send message > 1 MB throws RangeError (second-opinions 161)", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = wsCalls("connect")[0]
  emitWsEvent("open", { id: connectCall.args.id })

  const bigMsg = "x".repeat(1_048_577)
  expect(() => ws.send(bigMsg)).toThrow(RangeError)
  // The cap is in UTF-8 bytes, like native, not .length: "é" is 1 UTF-16 unit but 2 bytes. 400k of them is 800 KB
  // (fine); 600k is only 600k units, but 1.2 MB (too big).
  expect(() => ws.send("é".repeat(400_000))).not.toThrow()
  expect(() => ws.send("é".repeat(600_000))).toThrow(RangeError)
  expect(() => ws.send("x".repeat(1_048_576))).not.toThrow()
  ws.close()
})

test("utf8Length counts like UTF-8", () => {
  for (const s of ["", "abc", "é", "₹100", "😀", "a😀b", "नमस्ते"]) {
    expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length)
  }
  expect(utf8Length("\ud800")).toBe(3) // a lone surrogate is sent as U+FFFD
  expect(utf8Length("\ud800x")).toBe(4)
})

test("invalid close code or reason length throws, even after close (arguments first)", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = wsCalls("connect")[0]
  emitWsEvent("open", { id: connectCall.args.id })

  for (const code of [1001, 2000, 5000, 999, 0]) {
    let err: any
    try {
      ws.close(code)
    } catch (e) {
      err = e
    }
    expect(err?.name).toBe("InvalidAccessError")
  }

  const longReason = "r".repeat(124)
  expect(() => ws.close(1000, longReason)).toThrow(SyntaxError)
  // 41 × "₹" is 123 bytes (fine); 42 is 126 bytes (too long), though only 42 characters
  expect(() => ws.close(1000, "₹".repeat(42))).toThrow(SyntaxError)
  expect(wsCalls("close").length).toBe(0)

  ws.close(3000.4 as number, "₹".repeat(41)) // [Clamp]: rounded to 3000
  expect(wsCalls("close")[0].args.code).toBe(3000)
  // Already CLOSING: a bad code still throws (arguments are checked before the state)
  expect(() => ws.close(1001)).toThrow()
  expect(wsCalls("close").length).toBe(1)
})

test("error event dispatches to onerror and addEventListener", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = wsCalls("connect")[0]
  const id = connectCall.args.id

  let handlerCalled = false
  let listenerCalled = false

  ws.onerror = (e) => {
    handlerCalled = true
    expect(e.type).toBe("error")
  }
  ws.addEventListener("error", (e) => {
    listenerCalled = true
    expect(e.type).toBe("error")
  })

  emitWsEvent("error", { id, message: "network connection failed" })
  expect(handlerCalled).toBe(true)
  expect(listenerCalled).toBe(true)
  ws.close()
})

test("addEventListener: once, duplicates, removal during dispatch", () => {
  const { ws, id } = openSocket()
  const calls: string[] = []
  const once = (e: WebSocketMessageEvent) => calls.push(`once:${e.data}`)
  const always = (e: WebSocketMessageEvent) => calls.push(`always:${e.data}`)
  ws.addEventListener("message", once, { once: true })
  ws.addEventListener("message", always)
  ws.addEventListener("message", always) // added once only
  emitWsEvent("message", { id, data: "1" })
  emitWsEvent("message", { id, data: "2" })
  expect(calls).toEqual(["once:1", "always:1", "always:2"])

  // A listener removed by an earlier one during the same event is not called
  const late = () => calls.push("late")
  ws.addEventListener("message", () => ws.removeEventListener("message", late))
  ws.addEventListener("message", late)
  calls.length = 0
  emitWsEvent("message", { id, data: "3" })
  expect(calls).toEqual(["always:3"])
  ws.close()
})

test("installWebSocket sets globalThis.WebSocket", () => {
  const original = (globalThis as any).WebSocket
  delete (globalThis as any).WebSocket
  try {
    installWebSocket()
    expect(globalThis.WebSocket).toBe(WebSocket)
  } finally {
    ;(globalThis as any).WebSocket = original
  }
})
