import { beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { compileModule } from "../../../compiler/src/compile"
import { onPdfEvent, Pdf, pdfFile, previewProps, viewerProps, type PdfFile } from "../src/api"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const later = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const file: PdfFile = { handle: "zn://file/pdf-ab.pdf", uri: "file:///x/pdf-ab.pdf", size: 900, pages: 2, width: 595, height: 842, cached: false }

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("download names the module, the version and every argument", async () => {
  const p = Pdf.download({ url: "https://r.example/a.pdf", headers: { _zcc: "t" }, key: "k1", maxBytes: 1000 })
  const [call] = host.calls
  expect(call).toMatchObject({ module: "Pdf", method: "download", args: { url: "https://r.example/a.pdf", headers: { _zcc: "t" }, key: "k1", maxBytes: 1000, __v: 1 } })
  reply({ id: call.id, ok: true, value: { status: "ok", ...file } })
  expect(await p).toEqual({ status: "ok", ...file })
})

test("pdfFile is loading, then ready with the handle", async () => {
  const f = pdfFile({ url: "https://r.example/a.pdf", key: "k1" })
  expect(f.state()).toBe("loading")
  expect(f.handle()).toBeNull()
  reply({ id: host.calls[0].id, ok: true, value: { status: "ok", ...file } })
  await later()
  expect(f.state()).toBe("ready")
  expect(f.handle()).toBe(file.handle)
  expect(f.file()).toEqual(file)
  expect(f.reason()).toBeNull()
})

test("pdfFile says why it failed, and retry asks again", async () => {
  const f = pdfFile({ url: "https://r.example/a.pdf" })
  reply({ id: host.calls[0].id, ok: true, value: { status: "failed", reason: "http", httpStatus: 404 } })
  await later()
  expect(f.state()).toBe("failed")
  expect(f.reason()).toBe("http")
  f.retry()
  expect(f.state()).toBe("loading")
  expect(f.reason()).toBeNull()
  expect(host.calls.length).toBe(2)
  reply({ id: host.calls[1].id, ok: true, value: { status: "ok", ...file, cached: true } })
  await later()
  expect(f.state()).toBe("ready")
})

test("a rejected call is a failed state, not a throw", async () => {
  const f = pdfFile({ url: "https://r.example/a.pdf" })
  reply({ id: host.calls[0].id, ok: false, code: "invalid_args", error: "bad" })
  await later()
  expect(f.state()).toBe("failed")
  expect(f.reason()).toBe("failed")
})

test("an old answer can't overwrite a retry's", async () => {
  const f = pdfFile({ url: "https://r.example/a.pdf" })
  f.retry()
  reply({ id: host.calls[1].id, ok: true, value: { status: "ok", ...file } })
  await later()
  reply({ id: host.calls[0].id, ok: true, value: { status: "failed", reason: "network" } })
  await later()
  expect(f.state()).toBe("ready")
})

test("view events reach their handlers", () => {
  const heard: unknown[][] = []
  const h = {
    source: "zn://file/pdf-ab.pdf",
    onLoad: (i: unknown) => heard.push(["load", i]),
    onPageChange: (p: number, t: number) => heard.push(["page", p, t]),
    onZoom: (s: number) => heard.push(["zoom", s]),
    onError: (e: unknown) => heard.push(["error", e]),
  }
  onPdfEvent(h, { name: "load", data: { view: "3.1", pages: 2, width: 595, height: 842 } })
  onPdfEvent(h, { name: "page", data: { page: 2, total: 2 } })
  onPdfEvent(h, { name: "zoom", data: { scale: 2.5 } })
  onPdfEvent(h, { name: "error", data: { reason: "page", page: 2 } })
  expect(heard).toEqual([
    ["load", { view: "3.1", pages: 2, width: 595, height: 842 }],
    ["page", 2, 2],
    ["zoom", 2.5],
    ["error", { reason: "page", page: 2 }],
  ])
  expect(() => onPdfEvent({ source: null }, { name: "page", data: { page: 1, total: 1 } })).not.toThrow()
})

// A change here is a change of what native reads: raise the module version (docs/plugins.md D3).
test("props snapshot: defaults, and no handler", () => {
  expect(viewerProps({ source: "zn://file/pdf-ab.pdf", onLoad: () => {} })).toEqual({ source: "zn://file/pdf-ab.pdf", maxZoom: 5, pageGap: 16, background: null, initialPage: 1 })
  expect(viewerProps({ source: undefined, maxZoom: 1, pageGap: 0, background: "#FFFFFF", initialPage: 3 })).toEqual({ source: null, maxZoom: 1, pageGap: 0, background: "#FFFFFF", initialPage: 3 })
  expect(previewProps({ source: "zn://file/pdf-ab.pdf", onError: () => {} })).toEqual({ source: "zn://file/pdf-ab.pdf", page: 1, fit: "width", background: null })
})

test("the components compile to the views the plugin registers", () => {
  const path = join(import.meta.dir, "..", "src", "PdfView.tsx")
  const views: string[] = []
  const templates: unknown[] = []
  const out = compileModule(readFileSync(path, "utf8"), path, {
    reserveTemplate: () => templates.push(null) - 1,
    defineTemplate: (id, spec) => void (templates[id] = spec),
    nativeView: (name) => void views.push(name),
  })
  expect(views).toEqual(["pdf.view", "pdf.preview"])
  expect(out.components.PdfView).toBeDefined()
  expect(out.components.PdfPreview).toBeDefined()
})
