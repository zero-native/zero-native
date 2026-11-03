import { beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { compileModule } from "../../../compiler/src/compile"
import { onWebViewEvent, viewProps, webViewController, detachController, WebViewNative, type WebViewHandlers } from "../src/api"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

const ready = (c: ReturnType<typeof webViewController>, h: WebViewHandlers = {}) =>
  onWebViewEvent(c, h, { name: "ready", data: { view: "7.2", bridge: true, refused: [] } })

test("a command needs a view that is ready, and asks nothing of native before", async () => {
  const c = webViewController()
  expect(await c.back()).toBe(false)
  expect(await c.reload()).toBe(false)
  expect(await c.postMessage("hi")).toEqual({ sent: false, reason: "no_view" })
  expect(await c.openLink("tel:1")).toEqual({ opened: false, reason: "no_view" })
  expect(host.calls.length).toBe(0)
})

test("a command names the module, the version and the view", async () => {
  const c = webViewController()
  ready(c)
  expect(c.view()).toBe("7.2")
  const p = c.postMessage("hello")
  const [call] = host.calls
  expect(call).toMatchObject({ module: "WebView", method: "postMessage", args: { view: "7.2", text: "hello", __v: 1 } })
  reply({ id: call.id, ok: true, value: { sent: true } })
  expect(await p).toEqual({ sent: true })
})

test("the view leaving turns commands off again", async () => {
  const c = webViewController()
  ready(c)
  detachController(c)
  expect(c.view()).toBe(null)
  expect(await c.back()).toBe(false)
  expect(host.calls.length).toBe(0)
})

test("a link leaves only if the app's handler says true", async () => {
  const c = webViewController()
  ready(c)
  const link = { url: "tel:123", scheme: "tel", gesture: true }
  onWebViewEvent(c, {}, { name: "linkOutside", data: link })
  onWebViewEvent(c, { onLinkOutside: () => false }, { name: "linkOutside", data: link })
  onWebViewEvent(c, { onLinkOutside: (() => "yes") as never }, { name: "linkOutside", data: link })
  expect(host.calls.length).toBe(0)
  onWebViewEvent(c, { onLinkOutside: () => true }, { name: "linkOutside", data: link })
  expect(host.calls[0]).toMatchObject({ method: "openLink", args: { view: "7.2", url: "tel:123" } })
})

test("each event reaches its handler", () => {
  const heard: unknown[] = []
  const say = (name: string) => (v?: unknown) => void heard.push([name, v])
  const h: WebViewHandlers = {
    onReady: say("ready"),
    onLoadStart: say("start"),
    onLoadFinish: say("finish"),
    onLoadError: say("error"),
    onProgress: say("progress"),
    onTitle: say("title"),
    onNavigate: say("nav"),
    onMessage: say("message"),
    onLinkRefused: say("refused"),
    onUpload: say("upload"),
    onRenderGone: say("gone"),
    onPause: say("paused"),
    onResume: say("resumed"),
  }
  const c = webViewController()
  const send = (name: string, data: unknown = null) => onWebViewEvent(c, h, { name, data })
  send("ready", { view: "1.1", bridge: false, refused: ["*"] })
  send("loadStart", { url: "https://a.example/" })
  send("loadFinish", { url: "u", ok: true, status: null, title: "t", canGoBack: false })
  send("loadError", { kind: "http", status: 500, url: "u", description: "x" })
  send("progress", 40)
  send("title", "Hi")
  send("nav", { url: "u", canGoBack: true })
  send("message", { text: "m", origin: "https://a.example", mainFrame: true })
  send("linkRefused", { url: "u", reason: "host" })
  send("upload", { count: 0 })
  send("renderGone", { crashed: true })
  send("paused")
  send("resumed")
  send("no such event")
  expect(heard.map((x) => (x as unknown[])[0])).toEqual(["ready", "start", "finish", "error", "progress", "title", "nav", "message", "refused", "upload", "gone", "paused", "resumed"])
  expect(heard[0]).toEqual(["ready", { view: "1.1", bridge: false, refused: ["*"] }])
  expect(heard[1]).toEqual(["start", "https://a.example/"])
  expect(heard[4]).toEqual(["progress", 40])
  expect(heard[9]).toEqual(["upload", 0])
})

test("an event with no handler does nothing", () => {
  const c = webViewController()
  expect(() => onWebViewEvent(c, {}, { name: "message", data: { text: "x" } })).not.toThrow()
})

test("props carry the rules, and no handler or controller", () => {
  const p = viewProps({ url: "https://a.example/", allowedHosts: ["a.example"], leaveSchemes: ["tel"], headers: { a: "b" } })
  expect(JSON.parse(JSON.stringify(p))).toEqual({ url: "https://a.example/", allowedHosts: ["a.example"], leaveSchemes: ["tel"], headers: { a: "b" } })
  const q = viewProps({ allowedHosts: [], onMessage: () => {}, controller: webViewController() } as never)
  expect(JSON.stringify(q)).toBe('{"allowedHosts":[]}')
})

test("there is no way to run script in a page", () => {
  expect(Object.keys(webViewController()).filter((k) => /eval|script|inject/i.test(k))).toEqual([])
  expect("evaluate" in WebViewNative).toBe(false)
})

test("the component compiles to the view the plugin registers", () => {
  const file = join(import.meta.dir, "..", "src", "WebView.tsx")
  const views: string[] = []
  const templates: unknown[] = []
  const out = compileModule(readFileSync(file, "utf8"), file, {
    reserveTemplate: () => templates.push(null) - 1,
    defineTemplate: (id, spec) => void (templates[id] = spec),
    nativeView: (name) => void views.push(name),
  })
  expect(views).toEqual(["webview.page"])
  expect(out.components.WebView).toBeDefined()
})
