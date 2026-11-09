import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { AppUpdates, checkStore, playUpdates, type AppUpdateState, type StoreFetchResponse } from "../src/index"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const last = (method: string) => host.calls.filter((c) => c.method === method).at(-1)!

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  host.calls.length = 0
})

test("isUpdateAvailable gives Play's answer and never rejects", async () => {
  const a = AppUpdates.isUpdateAvailable()
  expect(last("isUpdateAvailable").module).toBe("AppUpdates")
  reply(last("isUpdateAvailable").id, { available: true, versionCode: 170, immediateAllowed: true, flexibleAllowed: false, stalenessDays: 3 })
  expect(await a).toEqual({ available: true, versionCode: 170, immediateAllowed: true, flexibleAllowed: false, stalenessDays: 3 })

  const ios = AppUpdates.isUpdateAvailable() // iOS answers only { available: false }
  reply(last("isUpdateAvailable").id, { available: false })
  expect(await ios).toEqual({ available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false })

  const old = AppUpdates.isUpdateAvailable() // an APK without the plugin
  refuse(last("isUpdateAvailable").id, "unavailable")
  expect(await old).toEqual({ available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false })
})

test("start, complete, setBusy and openStore send their args and never reject", async () => {
  const s = AppUpdates.start({ flexible: true })
  expect(last("start").args.flexible).toBe(true)
  reply(last("start").id, { ok: true })
  expect(await s).toEqual({ ok: true })

  const ios = AppUpdates.start({ flexible: false })
  expect(last("start").args.flexible).toBe(false)
  reply(last("start").id, { unavailable: true })
  expect(await ios).toEqual({ ok: false, unavailable: true })

  const c = AppUpdates.complete()
  refuse(last("complete").id, "failed")
  expect(await c).toEqual({ ok: false })

  const b = AppUpdates.setBusy(true)
  expect(last("setBusy").args.busy).toBe(true)
  refuse(last("setBusy").id, "unavailable")
  expect(await b).toBeNull()

  const o = AppUpdates.openStore({ appStoreId: "123456789" })
  expect(last("openStore").args.appStoreId).toBe("123456789")
  reply(last("openStore").id, { opened: true })
  expect(await o).toBe(true)

  const none = AppUpdates.openStore()
  expect(last("openStore").args.appStoreId).toBeUndefined()
  refuse(last("openStore").id, "failed")
  expect(await none).toBe(false)
})

test("playUpdates is the module in the engine's shape", async () => {
  const a = playUpdates.isAvailable()
  reply(last("isUpdateAvailable").id, { available: true, versionCode: 9 })
  expect((await a).available).toBe(true)
})

test("state events reach the handler until it stops", () => {
  const seen: AppUpdateState[] = []
  const stop = AppUpdates.onState((s) => seen.push(s))
  const send = (payload: AppUpdateState) => globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "AppUpdates", event: "state", payload }))
  send({ status: "downloading", bytesDownloaded: 5, totalBytes: 10, errorCode: 0 })
  stop()
  send({ status: "downloaded", bytesDownloaded: 0, totalBytes: 0, errorCode: 0 })
  expect(seen).toEqual([{ status: "downloading", bytesDownloaded: 5, totalBytes: 10, errorCode: 0 }])
})

// ---- checkStore -------------------------------------------------------------------------------------------------------

function fakeFetch(status: number, body: unknown, seen: string[] = [], timeouts: number[] = []) {
  return async (url: string, init: { method: string; timeout: number }): Promise<StoreFetchResponse> => {
    seen.push(url)
    timeouts.push(init.timeout)
    return { status, json: async () => (body instanceof Error ? Promise.reject(body) : body) }
  }
}

test("checkStore builds the URL and reads an update", async () => {
  const seen: string[] = []
  const timeouts: number[] = []
  const answer = await checkStore({
    server: "http://127.0.0.1:8790/",
    app: "sample",
    os: "android",
    version: 168,
    fetch: fakeFetch(200, { update: { version: 170, critical: 2, title: "New", message: "Please update" }, store: {} }, seen, timeouts),
  })
  expect(seen).toEqual(["http://127.0.0.1:8790/v1/store?app=sample&os=android&version=168"])
  expect(timeouts).toEqual([8000])
  expect(answer).toEqual({ update: { version: 170, critical: 2, title: "New", message: "Please update" }, store: {} })
})

test("checkStore: nothing to do, and the App Store id on iOS", async () => {
  expect(await checkStore({ server: "s", app: "a", os: "android", version: "1", fetch: fakeFetch(200, { update: null }) })).toEqual({
    update: null,
    store: {},
  })
  const ios = await checkStore({
    server: "https://u.example.com",
    app: "a b",
    os: "ios",
    version: "1.6.2",
    fetch: fakeFetch(200, { update: { version: "1.7.0", critical: 1 }, store: { appStoreId: "123" } }),
  })
  expect(ios).toEqual({ update: { version: "1.7.0", critical: 1 }, store: { appStoreId: "123" } })
})

test("checkStore answers null on any problem", async () => {
  const base = { server: "s", app: "a", os: "android" as const, version: 1 }
  expect(await checkStore({ ...base, fetch: fakeFetch(500, { error: "x" }) })).toBeNull()
  expect(await checkStore({ ...base, fetch: fakeFetch(400, { error: "x" }) })).toBeNull()
  expect(await checkStore({ ...base, fetch: fakeFetch(200, new Error("bad json")) })).toBeNull()
  expect(await checkStore({ ...base, fetch: fakeFetch(200, "text") })).toBeNull()
  expect(await checkStore({ ...base, fetch: fakeFetch(200, { update: { version: 2, critical: 3 } }) })).toBeNull()
  expect(await checkStore({ ...base, fetch: fakeFetch(200, { update: { critical: 1 } }) })).toBeNull()
  expect(
    await checkStore({
      ...base,
      fetch: async () => {
        throw new Error("offline")
      },
    }),
  ).toBeNull()
})
