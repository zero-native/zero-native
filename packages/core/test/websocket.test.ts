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

test("WebSocket rejects non-ws/wss URLs with SyntaxError", () => {
  expect(() => new WebSocket("http://example.com")).toThrow(SyntaxError)
  expect(() => new WebSocket("https://example.com")).toThrow(SyntaxError)
  expect(() => new WebSocket("ftp://example.com")).toThrow(SyntaxError)
  expect(() => new WebSocket("/relative")).toThrow(SyntaxError)
  expect(() => new WebSocket("not-a-url")).toThrow(SyntaxError)
})

test("WebSocket constructor subprotocol validation", () => {
  expect(() => new WebSocket("ws://echo.test", ["v1", "v1"])).toThrow(SyntaxError)
  expect(() => new WebSocket("ws://echo.test", 123 as any)).toThrow(SyntaxError)

  const ws = new WebSocket("ws://echo.test", "chat")
  const connectCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "connect")!
  expect(connectCall).toBeDefined()
  expect(connectCall.args.protocols).toEqual(["chat"])
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
  const connectCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "connect")!
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
  const sendCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "send")!
  expect(sendCall).toBeDefined()
  expect(sendCall.args).toEqual({ id, data: "hello from client" })

  // 4. Close
  ws.close(1000, "done")
  expect(ws.readyState).toBe(WebSocket.CLOSING)
  const closeCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "close")!
  expect(closeCall).toBeDefined()
  expect(closeCall.args).toEqual({ id, code: 1000, reason: "done" })

  // Calling close again while CLOSING does nothing
  ws.close(1000, "again")

  // 5. Server confirms closed
  emitWsEvent("close", { id, code: 1000, reason: "done", wasClean: true })
  expect(ws.readyState).toBe(WebSocket.CLOSED)
  expect(closeEvents.length).toBe(1)
  expect(closeEvents[0].code).toBe(1000)
  expect(closeEvents[0].reason).toBe("done")
  expect(closeEvents[0].wasClean).toBe(true)

  // Late events after close must be ignored
  emitWsEvent("message", { id, data: "ghost" })
  expect(messageEvents.length).toBe(1)
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

test("send binary throws TypeError in v1", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "connect")!
  emitWsEvent("open", { id: connectCall.args.id })

  expect(() => ws.send(new Uint8Array([1, 2, 3]))).toThrow(TypeError)
  expect(() => ws.send(new ArrayBuffer(8))).toThrow(TypeError)
  ws.close()
})

test("send message > 1 MB throws RangeError (second-opinions 161)", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "connect")!
  emitWsEvent("open", { id: connectCall.args.id })

  const bigMsg = "x".repeat(1_048_577)
  expect(() => ws.send(bigMsg)).toThrow(RangeError)
  ws.close()
})

test("invalid close code or reason length throws", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "connect")!
  emitWsEvent("open", { id: connectCall.args.id })

  expect(() => ws.close(1001)).toThrow(RangeError)
  expect(() => ws.close(2000)).toThrow(RangeError)
  expect(() => ws.close(5000)).toThrow(RangeError)

  const longReason = "r".repeat(124)
  expect(() => ws.close(1000, longReason)).toThrow(SyntaxError)

  ws.close(1000, "clean")
})

test("error event dispatches to onerror and addEventListener", () => {
  const ws = new WebSocket("ws://echo.test")
  const connectCall = host.calls.find((c) => c.module === "WebSocket" && c.method === "connect")!
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
