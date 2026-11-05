import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import type { LaunchRecord } from "../../../packages/core/src/launches"
import { createStorage } from "../../../packages/core/src/storage"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { DocumentScanner, type ScanDocumentResponse, type ScannedPage } from "../src/index"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const event = (module: string, name: string, payload: unknown) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module, event: name, payload }))
const emit = (payload: LaunchRecord) => event("Launches", "result", payload)
const launchStore = () => createStorage("zn.launch")
const save = (r: LaunchRecord) => launchStore().set(`launch.record.${r.key}`, JSON.stringify(r))
const unsave = () => launchStore().delete("launch.record.docscanner")
const saveJob = (id: string, tag: string | null) => createStorage("zn.docscanner").set("job", JSON.stringify({ id, tag, resultCode: null, pages: [], pdf: null, pdfPages: 0 }))
const later = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const page: ScannedPage = { handle: "zn://file/docscanner-a-0.jpg", uri: "file:///x/docscanner-a-0.jpg", width: 1000, height: 1400, size: 300 }
const result = (id: string): LaunchRecord => ({ key: "docscanner", id, status: "result", resultCode: -1, data: null, extras: { pages: 1, pdf: false } })
const collected = (id: string, extra: object = {}) => ({ status: "success", id, pages: [page], pdf: null, ...extra })

/** Answers the newest call of [method], once it has come. */
async function answer(method: string, value: unknown) {
  await later()
  const c = host.calls.filter((x) => x.method === method).at(-1)
  expect(c).toBeDefined()
  reply({ id: c!.id, ok: true, value })
  await later()
  return c!
}
const names = () => host.calls.map((c) => c.method)
const count = (method: string) => names().filter((n) => n === method).length

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  unsave()
  createStorage("zn.docscanner").delete("job")
})

test("scanDocument opens, collects, then acks and forgets, and the promise gets the pages", async () => {
  const p = DocumentScanner.scanDocument({ maxNumDocuments: 5, formats: ["jpeg", "pdf"], mode: "base", galleryImport: true, tag: "order-1" })
  const open = await answer("scanDocument", { launched: true, id: "a1" })
  expect(open).toMatchObject({ module: "DocumentScanner", args: { maxNumDocuments: 5, formats: ["jpeg", "pdf"], mode: "base", galleryImport: true, tag: "order-1", __v: 1 } })
  emit(result("a1"))
  const collect = await answer("collect", collected("a1", { tag: "order-1" }))
  expect(collect.args).toMatchObject({ id: "a1" })
  const ack = await answer("ack", true)
  expect(ack).toMatchObject({ module: "Launches", args: { key: "docscanner", id: "a1" } })
  await answer("forget", true)
  expect(await p).toEqual({ status: "success", id: "a1", tag: "order-1", pages: [page], pdf: null, scannedImages: [page.handle] })
})

test("a scanner that can't open now is 'unavailable', a refused launch 'failed', and neither hears anything", async () => {
  const p = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: false, reason: "not_downloaded", unavailable: true })
  expect(await p).toEqual({ status: "unavailable", reason: "not_downloaded", scannedImages: [], pages: [], pdf: null })
  const q = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: false, reason: "busy" })
  expect(await q).toEqual({ status: "failed", reason: "busy", scannedImages: [], pages: [], pdf: null })
  expect(names()).toEqual(["scanDocument", "scanDocument"])
})

test("back from the scanner is 'cancel'; a 'lost' launch never asks native for files", async () => {
  const p = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: true, id: "b1" })
  emit({ ...result("b1"), resultCode: 0 })
  await answer("collect", { status: "cancel", id: "b1", pages: [], pdf: null })
  await answer("ack", true)
  await answer("forget", true)
  expect((await p).status).toBe("cancel")

  saveJob("b2", "order-2")
  const q = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: true, id: "b2" })
  emit({ key: "docscanner", id: "b2", status: "lost" })
  await answer("ack", true)
  await answer("forget", true)
  expect(await q).toEqual({ status: "lost", id: "b2", tag: "order-2", scannedImages: [], pages: [], pdf: null })
  expect(count("collect")).toBe(1)
})

test("a result for another id isn't this promise's", async () => {
  let settled = false
  void DocumentScanner.scanDocument().then(() => (settled = true))
  await answer("scanDocument", { launched: true, id: "c1" })
  emit(result("other"))
  await later()
  expect(settled).toBe(false)
  expect(names()).not.toContain("collect")
})

test("a collect that fails gives its code, and the launch is still cleared", async () => {
  const p = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: true, id: "d1" })
  emit(result("d1"))
  await later()
  const c = host.calls.find((x) => x.method === "collect")!
  reply({ id: c.id, ok: false, code: "unavailable", error: "x" })
  await answer("ack", true)
  await answer("forget", true)
  expect(await p).toEqual({ status: "failed", reason: "unavailable", id: "d1", scannedImages: [], pages: [], pdf: null })
})

test("after a kill the result comes to onResult with its tag, and stays until ack", async () => {
  save(result("e1")) // no promise: this is a new process
  const heard: ScanDocumentResponse[] = []
  let ack = () => {}
  DocumentScanner.onResult((r, a) => {
    heard.push(r)
    ack = a
  })
  await answer("collect", collected("e1", { tag: "order-9" }))
  expect(heard).toEqual([{ status: "success", id: "e1", tag: "order-9", pages: [page], pdf: null, scannedImages: [page.handle] }])
  expect(names()).not.toContain("ack")
  ack()
  await answer("ack", true)
  await answer("forget", true)
})

test("once: two onResult handlers in one run, only the first gets the result; after ack, a new start gets nothing", async () => {
  save(result("f1"))
  const first: string[] = []
  const second: string[] = []
  let ack = () => {}
  DocumentScanner.onResult((r, a) => {
    first.push(r.id!)
    ack = a
  })
  DocumentScanner.onResult((r) => second.push(r.id!))
  await answer("collect", collected("f1"))
  emit(result("f1")) // the same record again, as ZnLaunch sends it
  await later()
  expect(first).toEqual(["f1"])
  expect(second).toEqual([])
  expect(count("collect")).toBe(1)
  ack()
  await answer("ack", true)
  await answer("forget", true)
  unsave() // what native's ack does
  // The next start: a new handler finds nothing.
  const after: string[] = []
  DocumentScanner.onResult((r) => after.push(r.id!))
  await later()
  expect(after).toEqual([])
  expect(count("collect")).toBe(1)
})

test("a handler that goes away without ack lets a later handler in this run take the result", async () => {
  save(result("g1"))
  const off = DocumentScanner.onResult(() => {})
  await answer("collect", collected("g1"))
  off() // its screen closed before it acked
  const later2: string[] = []
  DocumentScanner.onResult((r) => later2.push(r.id!))
  await answer("collect", collected("g1"))
  expect(later2).toEqual(["g1"])
})

test("onResult leaves alone a scan a promise waits for", async () => {
  const heard: unknown[] = []
  DocumentScanner.onResult((r) => heard.push(r))
  const p = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: true, id: "h1" })
  emit(result("h1"))
  await answer("collect", collected("h1"))
  await answer("ack", true)
  await answer("forget", true)
  await p
  expect(heard).toEqual([])
  expect(count("collect")).toBe(1)
})

test("a result nobody took doesn't block a new scan; one a handler holds is left alone", async () => {
  save(result("old1"))
  const p = DocumentScanner.scanDocument()
  await answer("ack", true)
  unsave()
  const forget = await answer("forget", true)
  expect(forget.args).toMatchObject({ id: "old1" })
  await answer("scanDocument", { launched: false, reason: "no_activity" })
  await p

  save(result("old2"))
  DocumentScanner.onResult(() => {}) // holds it, no ack yet
  await answer("collect", collected("old2"))
  const q = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: false, reason: "unacked" })
  expect((await q).reason).toBe("unacked")
  expect(host.calls.filter((c) => c.method === "ack")).toHaveLength(1)
})

test("pending reads the open scan and its tag at once from disk", () => {
  expect(DocumentScanner.pending()).toBeNull()
  saveJob("p1", "order-5")
  save({ key: "docscanner", id: "p1", status: "waiting" })
  expect(DocumentScanner.pending()).toEqual({ id: "p1", status: "waiting", tag: "order-5" })
  save(result("p2")) // the job is still p1's: no tag for p2
  expect(DocumentScanner.pending()).toEqual({ id: "p2", status: "result" })
})

test("getStatus and download never reject; status events reach onStatus", async () => {
  const s = DocumentScanner.getStatus()
  await answer("getStatus", { status: "not_downloaded" })
  expect(await s).toEqual({ status: "not_downloaded" })

  const heard: unknown[] = []
  DocumentScanner.onStatus((x) => heard.push(x))
  const d = DocumentScanner.download()
  await later()
  event("DocumentScanner", "status", { status: "downloading", state: "downloading", bytes: 10, total: 100 })
  await answer("download", { status: "available" })
  expect(await d).toEqual({ status: "available" })
  expect(heard).toEqual([{ status: "downloading", state: "downloading", bytes: 10, total: 100 }])

  const bad = DocumentScanner.getStatus()
  await later()
  const c = host.calls.filter((x) => x.method === "getStatus").at(-1)!
  reply({ id: c.id, ok: false, code: "unavailable", error: "no module" }) // an APK without the plugin
  expect(await bad).toEqual({ status: "unavailable", reason: "unavailable" })
  const badDownload = DocumentScanner.download()
  await later()
  const c2 = host.calls.filter((x) => x.method === "download").at(-1)!
  reply({ id: c2.id, ok: false, code: "failed", error: "x" })
  expect(await badDownload).toEqual({ status: "failed", reason: "failed" })
})

test("nothing here takes a path: collect gets only the id", async () => {
  const p = DocumentScanner.scanDocument()
  await answer("scanDocument", { launched: true, id: "k1" })
  emit(result("k1"))
  const c = await answer("collect", collected("k1"))
  expect(Object.keys(c.args).sort()).toEqual(["__v", "id"])
  await answer("ack", true)
  await answer("forget", true)
  await p
})
