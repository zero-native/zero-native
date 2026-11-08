// Fetch progress ids (reqId). The main progress test is in fetch.test.ts.
import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { installCalls } from "../src/calls"
import { fetch } from "../src/fetch"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

const sends = () => host.calls.filter((c) => c.module === "Fetch" && c.method === "send")

function progressEvent(id: number, loaded: number, total: number): void {
  globalThis.__zn_onEvent(
    0,
    8,
    JSON.stringify({ module: "Fetch", event: "uploadProgress", payload: { id, loaded, total } }),
  )
}

test("progress ids are new per request, fit a native Int, and a fresh JS runtime starts elsewhere", async () => {
  const seen: number[] = []
  void fetch("https://api.test/a", { method: "POST", body: "x", onUploadProgress: (p) => seen.push(p.loaded) })
  void fetch("https://api.test/b", { method: "POST", body: "y", onUploadProgress: () => {} })
  const [a, b] = sends().map((c) => c.args.reqId as number)
  expect(b).toBe(a + 1)
  expect(Number.isInteger(a) && a > 0 && b < 2 ** 31).toBe(true)

  // A second copy of the module stands in for the JS runtime after a reload: its ids don't follow on from ours.
  const fresh = (await import("../src/fetch.ts?runtime2")) as typeof import("../src/fetch")
  void fresh.fetch("https://api.test/c", { method: "POST", body: "z", onUploadProgress: () => {} })
  const c = sends().at(-1)!.args.reqId as number
  expect(c).not.toBe(b + 1)

  // Only our own id is heard
  progressEvent(b, 99, 99)
  progressEvent(a, 1, 1)
  expect(seen).toEqual([1])
})
