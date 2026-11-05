import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { AppEvent, nav, resetNavForTests, startApp } from "../../../packages/core/src/nav"
import { defineRoutes } from "../../../packages/core/src/routes"
import { createStorage } from "../../../packages/core/src/storage"
import { installTimers } from "../../../packages/core/src/timers"
import { view } from "../../../packages/core/src/view"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { HELD_DATA, ImageViewer, resetImageViewerForTests, viewerParams, viewerParts } from "../src/index"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const later = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const PNG = "data:image/png;base64,iVBORw0KGgo="
const PUSH = 1
const Home = () => view(0, () => {})
const routes = defineRoutes({
  home: { path: "/", screen: Home },
  imageViewer: { path: "/image-viewer", native: "imageviewer.full", safeArea: "none", transition: "fade" },
  photos: { path: "/photos", native: "imageviewer.full", safeArea: "none" },
})

const send = (event: number, payload: string | number | null) => globalThis.__zn_onEvent(0, event, payload)
const navOps = () => host.ops.filter((o) => o[0] === "nav").map((o) => o.slice(1))
const pushes = () => navOps().filter((o) => o[0] === PUSH)

/** What native does when the viewer closes: the answer on disk first, then the event (as in core's nav-native test). */
function answer(entry: number, id: string, value: unknown, route = "imageViewer") {
  const record = { key: `nav.${route}`, id, status: "result", resultCode: -1, data: null, extras: { value: JSON.stringify(value) } }
  createStorage("zn.launch").set(`launch.record.nav.${route}`, JSON.stringify(record))
  send(AppEvent.NavResult, JSON.stringify({ entry, route, id }))
}

beforeEach(() => {
  resetNavForTests()
  resetImageViewerForTests()
  host = installFakeHost()
  installEvents()
  installCalls()
  installTimers({ replaceGlobals: false })
  startApp(routes)
  send(AppEvent.Start, JSON.stringify([{ entry: 0x80000001, route: 0, params: {} }]))
  host.ops.length = 0
})

test("params: strings, { uri } and { url } all become { uri }, alt is kept", () => {
  const p = viewerParams({ images: ["https://a/1.jpg", { uri: "asset:img/2.png", alt: "Shop front" }, { url: "zn://file/p.jpg" }] })
  expect(p).toEqual({
    images: [{ uri: "https://a/1.jpg" }, { uri: "asset:img/2.png", alt: "Shop front" }, { uri: "zn://file/p.jpg" }],
    index: 0,
  })
})

test("params: the start index comes from imageIndex, else index, and stays inside the list", () => {
  const images = ["a", "b", "c"]
  expect(viewerParams({ images, imageIndex: 2 }).index).toBe(2)
  expect(viewerParams({ images, index: 1 }).index).toBe(1)
  expect(viewerParams({ images, imageIndex: 0, index: 2 }).index).toBe(0)
  expect(viewerParams({ images, imageIndex: 9 }).index).toBe(2)
  expect(viewerParams({ images, imageIndex: -3 }).index).toBe(0)
  expect(viewerParams({ images, imageIndex: 1.7 }).index).toBe(1)
  expect(viewerParams({ images, imageIndex: NaN }).index).toBe(0)
})

test("params: switches go only when off, words and the colour only when given", () => {
  const p = viewerParams({ images: ["a"], swipeToCloseEnabled: false, doubleTapToZoomEnabled: true, backgroundColor: "#111111", closeLabel: "Band karo" })
  expect(p).toEqual({ images: [{ uri: "a" }], index: 0, swipeToClose: false, backgroundColor: "#111111", closeLabel: "Band karo" })
})

test("params: no pictures, or a picture with no link, is a bug in the app", () => {
  expect(() => viewerParams({ images: [] })).toThrow("at least one picture")
  expect(() => viewerParams({ images: ["a", { uri: "" }] })).toThrow("images[1] has no uri")
  expect(() => viewerParams({ images: [{} as never] })).toThrow("images[0] has no uri")
})

test("open pushes the viewer route with the params, and gives the index it closed on", async () => {
  const p = ImageViewer.open({ images: ["https://a/1.jpg", "https://a/2.jpg"], imageIndex: 1 })
  const [push] = pushes()
  expect(push).toEqual([PUSH, push![1], 1, '{"images":[{"uri":"https://a/1.jpg"},{"uri":"https://a/2.jpg"}],"index":1}'])
  answer(push![1] as number, "v1", { index: 0 })
  expect(await p).toEqual({ index: 0 })
  expect(nav.depth()).toBe(1)
})

test("a second open while the viewer is on screen gets the same viewer: a double tap opens one screen", async () => {
  const a = ImageViewer.open({ images: ["a"] })
  const b = ImageViewer.open({ images: ["b"] })
  expect(b).toBe(a)
  expect(pushes().length).toBe(1)
  nav.back()
  expect(await a).toBeNull()
  void ImageViewer.open({ images: ["c"] }) // closed: the next open pushes again
  expect(pushes().length).toBe(2)
})

test("Back from JS (nav.back) gives null", async () => {
  const p = ImageViewer.open({ images: ["a"] })
  nav.back()
  expect(await p).toBeNull()
})

test("open can use another route that shows the same screen", async () => {
  const p = ImageViewer.open({ images: ["a"], route: "photos" })
  expect(pushes()[0]![2]).toBe(2)
  answer(pushes()[0]![1] as number, "v2", { index: 0 }, "photos")
  expect(await p).toEqual({ index: 0 })
})

test("a missing route rejects with the line to add, and pushes nothing", async () => {
  await expect(ImageViewer.open({ images: ["a"], route: "gallery" })).rejects.toThrow('gallery: { path: "/image-viewer", native: "imageviewer.full"')
  await expect(ImageViewer.open({ images: ["a"], route: "home" })).rejects.toThrow("not a native screen")
  expect(pushes()).toEqual([])
})

test("bad options reject; they don't throw at the caller", async () => {
  await expect(ImageViewer.open({ images: [] })).rejects.toThrow("at least one picture")
  expect(pushes()).toEqual([])
})

test("parts: a data: link goes to held, the params only say held:data", () => {
  const { params, held } = viewerParts({ images: ["https://a/1.jpg", { uri: PNG, alt: "Bill" }] })
  expect(params.images).toEqual([{ uri: "https://a/1.jpg" }, { uri: HELD_DATA, alt: "Bill" }])
  expect(held).toEqual([{ i: 1, data: PNG }])
  expect(JSON.stringify(params)).not.toContain("base64")
})

test("parts: headers go to held, never to the params; only text values are kept", () => {
  const { params, held } = viewerParts({
    images: [{ uri: "https://a/1.jpg", headers: { Authorization: "Bearer secret", "X-N": 5 as never } }, { url: "https://a/2.jpg", headers: {} }],
  })
  expect(params.images).toEqual([{ uri: "https://a/1.jpg" }, { uri: "https://a/2.jpg" }])
  expect(held).toEqual([{ i: 0, headers: { Authorization: "Bearer secret" } }])
  expect(JSON.stringify(params)).not.toContain("secret")
})

test("parts: a data: link with headers is one held item", () => {
  expect(viewerParts({ images: [{ uri: PNG, headers: { A: "b" } }] }).held).toEqual([{ i: 0, data: PNG, headers: { A: "b" } }])
})

test("open with a data: link or headers holds them natively first, then pushes with the key", async () => {
  const p = ImageViewer.open({ images: [{ uri: "https://a/1.jpg", headers: { Authorization: "Bearer t" } }, PNG], imageIndex: 1 })
  expect(pushes()).toEqual([]) // not before native has them
  const hold = host.calls.find((c) => c.method === "hold")!
  expect(hold.module).toBe("ImageViewer")
  expect(hold.args.__v).toBe(2)
  expect(hold.args.items).toEqual([{ i: 0, headers: { Authorization: "Bearer t" } }, { i: 1, data: PNG }])
  expect(String(hold.args.key)).toMatch(/^iv-/)
  reply({ id: hold.id, ok: true, value: true })
  await later()
  const [push] = pushes()
  const params = JSON.parse(push![3] as string)
  expect(params).toEqual({ images: [{ uri: "https://a/1.jpg" }, { uri: HELD_DATA }], index: 1, held: hold.args.key })
  expect(push![3]).not.toContain("Bearer")
  answer(push![1] as number, "v3", { index: 1 })
  expect(await p).toEqual({ index: 1 })
})

test("a second open while hold is still running gets the same viewer", async () => {
  const a = ImageViewer.open({ images: [PNG] })
  expect(ImageViewer.open({ images: [PNG] })).toBe(a)
  expect(host.calls.filter((c) => c.method === "hold").length).toBe(1)
})

test("a failed hold rejects and pushes nothing; the next open tries again", async () => {
  const p = ImageViewer.open({ images: [PNG] })
  const hold = host.calls.find((c) => c.method === "hold")!
  reply({ id: hold.id, ok: false, error: { code: "unavailable", message: "old app" } })
  await expect(p).rejects.toThrow()
  expect(pushes()).toEqual([])
  void ImageViewer.open({ images: [PNG] })
  expect(host.calls.filter((c) => c.method === "hold").length).toBe(2)
})

test("a missing route after hold still rejects with the line to add", async () => {
  const p = ImageViewer.open({ images: [PNG], route: "gallery" })
  const hold = host.calls.find((c) => c.method === "hold")!
  reply({ id: hold.id, ok: true, value: true })
  await expect(p).rejects.toThrow('gallery: { path: "/image-viewer"')
})
