import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { installCalls } from "../src/calls"
import { fetch, FetchError, Request, Response, setFetchDefaults } from "../src/fetch"
import { Headers } from "../src/headers"
import { FormData } from "../src/formdata"
import { decodeUtf8 } from "../src/text"
import { createRoot } from "../src/signals"
import { useAbortSignal } from "../src/abort"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

/** Answers the latest native call the way ZnModules does for resolveBytes: app event 9, one ArrayBuffer. */
function answer(head: object, body: string | Uint8Array = "", id = host.calls.at(-1)!.id): void {
  const headBytes = new TextEncoder().encode(JSON.stringify({ id, ok: true, value: head }))
  const bodyBytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  const buf = new ArrayBuffer(4 + headBytes.length + bodyBytes.length)
  new DataView(buf).setUint32(0, headBytes.length, true)
  new Uint8Array(buf, 4).set(headBytes)
  new Uint8Array(buf, 4 + headBytes.length).set(bodyBytes)
  globalThis.__zn_onEvent(0, 9, buf as any)
}

function fail(code: string, error: string, id = host.calls.at(-1)!.id): void {
  globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error }))
}

const head = (over: object = {}) => ({
  status: 200,
  statusText: "OK",
  url: "https://api.test/v1/x",
  redirected: false,
  headers: ["Content-Type", "application/json", "Set-Cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "set-cookie", "b=2"],
  ...over,
})

test("a POST with a JSON body: head as JSON, body as raw bytes, defaults filled in", async () => {
  const p = fetch("https://api.test/v1/pay?token=secret", {
    method: "post",
    headers: { "Content-Type": "application/json", "X-Name": "zero" },
    body: JSON.stringify({ amount: 1250, note: "चाय ☕" }),
  })
  const c = host.calls[0]!
  expect(c.module).toBe("Fetch")
  expect(c.method).toBe("send")
  expect(c.args).toMatchObject({
    url: "https://api.test/v1/pay?token=secret",
    method: "POST",
    timeout: 30_000,
    maxBodySize: 10_000_000,
    redirect: "follow",
    headers: ["content-type", "application/json", "x-name", "zero"],
  })
  expect(new TextDecoder().decode(c.bytes)).toBe('{"amount":1250,"note":"चाय ☕"}')

  answer(head(), '{"ok":true,"id":"ztc_1"}')
  const res = await p
  expect([res.status, res.ok, res.statusText, res.url, res.redirected]).toEqual([200, true, "OK", "https://api.test/v1/x", false])
  expect(res.headers.get("content-type")).toBe("application/json")
  expect(res.headers.getSetCookie()).toEqual(["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "b=2"])
  expect(await res.json()).toEqual({ ok: true, id: "ztc_1" })
  expect(res.bodyUsed).toBe(true)
  await expect(res.text()).rejects.toThrow("already read")
})

test("a fetch is not tied to the screen: it settles after the screen closes", async () => {
  let p!: Promise<Response>
  const dispose = createRoot((d) => {
    p = fetch("https://api.test/a")
    return d
  })
  dispose()
  expect(host.cancelled).toEqual([]) // native was not told to stop
  answer(head())
  expect((await p).status).toBe(200)
})

test("useAbortSignal aborts the request when the screen closes", async () => {
  let p!: Promise<Response>
  const dispose = createRoot((d) => {
    p = fetch("https://api.test/a", { signal: useAbortSignal() })
    return d
  })
  const id = host.calls[0]!.id
  dispose()
  expect(host.cancelled).toEqual([id])
  const err = (await p.catch((e) => e)) as Error
  expect(err.name).toBe("AbortError")
})

test("abort rejects with the signal's reason and cancels native; a late answer is ignored", async () => {
  const ac = new AbortController()
  const p = fetch("https://api.test/slow", { signal: ac.signal })
  const id = host.calls[0]!.id
  const reason = new Error("user left")
  ac.abort(reason)
  expect(await p.catch((e) => e)).toBe(reason)
  expect(host.cancelled).toEqual([id])
  answer(head(), "late", id) // must not throw or resolve anything

  const before = host.calls.length
  const pre = new AbortController()
  pre.abort()
  await expect(fetch("https://api.test/x", { signal: pre.signal })).rejects.toBe(pre.signal.reason)
  expect(host.calls.length).toBe(before) // already aborted: never sent
})

test("network failures become FetchError (a TypeError) with a code; timeouts are TimeoutError", async () => {
  const p = fetch("https://api.test/a")
  fail("offline", "Network request failed (offline): GET https://api.test/a: Unable to resolve host")
  const err = (await p.catch((e) => e)) as FetchError
  expect(err).toBeInstanceOf(FetchError)
  expect(err).toBeInstanceOf(TypeError)
  expect([err.code, err.name]).toEqual(["offline", "TypeError"])

  const t = fetch("https://api.test/b", { timeout: 5000 })
  expect(host.calls.at(-1)!.args.timeout).toBe(5000)
  fail("timeout", "no complete answer within 5000 ms")
  const terr = (await t.catch((e) => e)) as FetchError
  expect([terr.code, terr.name]).toEqual(["timeout", "TimeoutError"])
})

test("HTTP errors are not exceptions", async () => {
  const p = fetch("https://api.test/missing")
  answer(head({ status: 404, statusText: "Not Found" }), "nope")
  const res = await p
  expect([res.ok, res.status]).toEqual([false, 404])
  expect(await res.text()).toBe("nope")
})

test("bad requests fail fast in JS with a clear TypeError", async () => {
  await expect(fetch("/relative")).rejects.toThrow("not a full http(s) URL")
  await expect(fetch("ftp://x.test/f")).rejects.toThrow("not a full http(s) URL")
  await expect(fetch("https://x.test", { body: "x" })).rejects.toThrow("GET request can't have a body")
  await expect(fetch("https://x.test", { method: "TRACE" })).rejects.toThrow("not allowed")
  await expect(fetch("https://x.test", { method: "POST", body: { a: 1 } as any })).rejects.toThrow("JSON.stringify")
  await expect(fetch("https://x.test", { headers: { "X-Name": "पवन" } })).rejects.toThrow("encodeURIComponent")
  await expect(fetch("https://x.test", { headers: { "X-Bad": "a\r\nInjected: 1" } })).rejects.toThrow(TypeError)
  await expect(fetch("https://x.test", { timeout: -1 })).rejects.toThrow("timeout")
  expect(host.calls.length).toBe(0)
})

test("string bodies default to text/plain; transport headers are dropped; patch is upper-cased", () => {
  fetch("https://x.test", { method: "patch", body: "hi", headers: { "Accept-Encoding": "gzip", Host: "evil.test" } })
  const c = host.calls[0]!
  expect(c.args.method).toBe("PATCH")
  expect(c.args.headers).toEqual(["content-type", "text/plain;charset=UTF-8"])
  expect(host.logs.some(([lvl, m]) => lvl === 2 && m.includes("accept-encoding"))).toBe(true)
})

test("binary bodies go as raw bytes, also from a view into a bigger buffer", () => {
  const big = new Uint8Array([9, 9, 1, 2, 3, 9])
  fetch("https://x.test/up", { method: "PUT", body: big.subarray(2, 5) })
  expect([...host.calls[0]!.bytes!]).toEqual([1, 2, 3])
  expect(host.calls[0]!.args.headers).toEqual([]) // no default type for bytes
})

test("FormData: text and file parts, and a hand-written Content-Type is replaced", () => {
  const form = new FormData()
  form.append("storeId", "42")
  form.append("receipt", { uri: "content://media/external/images/7", type: "image/jpeg" })
  form.append("doc", { uri: "file:///data/user/0/app/files/r%201.pdf", name: "r1.pdf" })
  fetch("https://x.test/up", { method: "POST", body: form, headers: { "Content-Type": "multipart/form-data" } })
  const c = host.calls[0]!
  expect(c.bytes).toBeUndefined()
  expect(c.args.headers).toEqual([])
  expect(c.args.form).toEqual([
    ["storeId", "42"],
    ["receipt", "content://media/external/images/7", "7", "image/jpeg"],
    ["doc", "file:///data/user/0/app/files/r%201.pdf", "r1.pdf", "application/octet-stream"],
  ])
  expect(() => form.append("x", { uri: "https://x.test/a.jpg" })).toThrow("content:// or file://")
})

test("json() errors explain empty bodies and HTML pages; the query string never shows", async () => {
  const p = fetch("https://api.test/v1/items?token=secret", { method: "DELETE" })
  answer(head({ status: 204, url: "https://api.test/v1/items?token=secret", headers: [] }))
  const e204 = (await (await p).json().catch((e: Error) => e)) as Error
  expect(e204).toBeInstanceOf(SyntaxError)
  expect(e204.message).toContain("status 204")
  expect(e204.message).toContain("check res.status")
  expect(e204.message).not.toContain("secret")

  const q = fetch("https://api.test/v1/items")
  answer(head({ status: 200, headers: ["Content-Type", "text/html"] }), "<html><body>Wi-Fi login</body></html>")
  const eHtml = (await (await q).json().catch((e: Error) => e)) as Error
  expect(eHtml.message).toContain("text/html")
  expect(eHtml.message).toContain("<html><body>Wi-Fi login")
})

test("text() strips a UTF-8 BOM and turns bad bytes into U+FFFD; arrayBuffer() and clone() work", async () => {
  const p = fetch("https://api.test/bom")
  answer(head(), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))
  const res = await p
  const copy = res.clone()
  expect(await res.json()).toEqual({})
  expect(new Uint8Array(await copy.arrayBuffer())).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))
  expect(decodeUtf8(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a�b")
  expect(() => decodeUtf8(new Uint8Array([0xff]), true)).toThrow("not valid UTF-8")
})

test("Headers: case-insensitive, combined get, web iteration order", () => {
  const h = new Headers([
    ["X-B", "2"],
    ["x-a", "1"],
    ["X-B", "3"],
  ])
  expect(h.get("x-b")).toBe("2, 3")
  h.set("X-B", "4")
  expect([...h]).toEqual([
    ["x-a", "1"],
    ["x-b", "4"],
  ])
  expect(new Headers({ "X-T": "  padded \t" }).get("x-t")).toBe("padded")
  expect(() => new Headers({ "bad name": "y" })).toThrow("not a valid header name")
})

test("Response made in JS (for mocks) and Request reuse", async () => {
  const r = Response.json({ a: 1 }, { status: 201 })
  expect([r.status, r.headers.get("content-type")]).toEqual([201, "application/json"])
  expect(await r.json()).toEqual({ a: 1 })
  expect(() => new Response("x", { status: 99 })).toThrow(RangeError)

  const base = new Request("https://api.test/a", { method: "POST", body: "x", timeout: 1000 })
  fetch(base.clone(), { headers: { "X-Retry": "1" } })
  expect(host.calls[0]!.args).toMatchObject({ method: "POST", timeout: 1000, headers: ["x-retry", "1", "content-type", "text/plain;charset=UTF-8"] })
})

test("app-wide defaults apply to later requests; a request's own value still wins", () => {
  setFetchDefaults({ timeout: 20_000, maxBodySize: 2_000_000 })
  try {
    fetch("https://x.test/a")
    fetch("https://x.test/b", { timeout: 5000 })
    expect(host.calls[0]!.args).toMatchObject({ timeout: 20_000, maxBodySize: 2_000_000 })
    expect(host.calls[1]!.args).toMatchObject({ timeout: 5000, maxBodySize: 2_000_000 })
    expect(() => setFetchDefaults({ maxBodySize: 0 })).toThrow("maxBodySize")
  } finally {
    setFetchDefaults({ timeout: 30_000, maxBodySize: 10_000_000 })
  }
})
