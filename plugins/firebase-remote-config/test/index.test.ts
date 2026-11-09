import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { RemoteConfig, remoteConfig } from "../src/index"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const last = (method: string) => host.calls.filter((c) => c.method === method).at(-1)!
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const result = (values: Record<string, { value: string; source: string }>, extra: object = {}) => ({
  available: true, ok: true, reason: null, changed: true, values, lastFetchStatus: "success", fetchTimeMillis: 5, ...extra,
})

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  host.calls.length = 0
})

test("with no native answer, reads give the JS defaults, then static values", async () => {
  const p = RemoteConfig.setDefaults({ checkout_v2: true, max_cashback: 50, label: "Pay" })
  refuse(last("setDefaults").id, "unavailable")
  expect(await p).toBe(false)
  expect(RemoteConfig.getBoolean("checkout_v2")).toBe(true)
  expect(RemoteConfig.getNumber("max_cashback")).toBe(50)
  expect(RemoteConfig.getValue("label").getSource()).toBe("default")
  expect(RemoteConfig.getValue("missing").getSource()).toBe("static")
  expect(RemoteConfig.getNumber("missing")).toBe(0)
  expect(RemoteConfig.available).toBe(false)
})

test("fetchAndActivate brings every value to JS, and reads need no call", async () => {
  const p = remoteConfig().fetchAndActivate()
  reply(last("fetchAndActivate").id, result({ greeting: { value: "hello", source: "remote" }, flag: { value: "on", source: "remote" } }))
  expect(await p).toEqual({ ok: true, reason: null, changed: true })
  const calls = host.calls.length
  expect(RemoteConfig.getString("greeting")).toBe("hello")
  expect(RemoteConfig.getBoolean("flag")).toBe(true)
  expect(RemoteConfig.getValue("greeting").getSource()).toBe("remote")
  expect(RemoteConfig.lastFetchStatus).toBe("success")
  expect(RemoteConfig.available).toBe(true)
  expect(host.calls.length).toBe(calls)
})

test("a failed fetch keeps the reason and never rejects", async () => {
  const p = RemoteConfig.fetch()
  reply(last("fetch").id, result({}, { ok: false, reason: "throttled", changed: false, lastFetchStatus: "throttled" }))
  expect(await p).toEqual({ ok: false, reason: "throttled", changed: false })
  const q = RemoteConfig.activate()
  refuse(last("activate").id, "unavailable")
  expect(await q).toEqual({ ok: false, reason: "unavailable", changed: false })
})

test("onConfigUpdated starts real-time updates for the first listener and stops after the last", async () => {
  const seen: string[][] = []
  const off1 = RemoteConfig.onConfigUpdated((e) => seen.push(e.updatedKeys))
  const off2 = RemoteConfig.onConfigUpdated(() => {})
  expect(host.calls.filter((c) => c.method === "startUpdates").length).toBe(1)
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "RemoteConfig", event: "updated", payload: { updatedKeys: ["greeting"] } }))
  expect(seen).toEqual([["greeting"]])
  off1()
  off1()
  expect(host.calls.filter((c) => c.method === "stopUpdates").length).toBe(0)
  off2()
  await tick()
  expect(host.calls.filter((c) => c.method === "stopUpdates").length).toBe(1)
})

test("asNumber and asBoolean follow Firebase's rules", async () => {
  const p = RemoteConfig.ensureInitialized()
  reply(last("getAll").id, result({ n: { value: "12.5", source: "remote" }, bad: { value: "abc", source: "remote" }, no: { value: "false", source: "remote" } }))
  expect(await p).toBe(true)
  expect(RemoteConfig.getNumber("n")).toBe(12.5)
  expect(RemoteConfig.getNumber("bad")).toBe(0)
  expect(RemoteConfig.getBoolean("no")).toBe(false)
  expect(Object.keys(RemoteConfig.getAll())).toContain("n")
})
