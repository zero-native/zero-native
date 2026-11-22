import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import type { UpdateStatus } from "../../../packages/core/src/updates"
import { AppUpdates, appStoreUpdates, checkAfterUpdateChecks, playUpdates, storeAnswer, type AppUpdateEngine, type AppUpdateState } from "../src/index"

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

  const none = AppUpdates.isUpdateAvailable() // no answer from the store (iOS: the lookup failed)
  reply(last("isUpdateAvailable").id, { available: false })
  expect(await none).toEqual({ available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false })
  expect(last("isUpdateAvailable").args.appStoreId).toBeUndefined()

  // iOS: the App Store's lookup, with its version and id
  const ios = AppUpdates.isUpdateAvailable({ appStoreId: "6784262215" })
  expect(last("isUpdateAvailable").args.appStoreId).toBe("6784262215")
  const found = { available: true, versionCode: 0, immediateAllowed: true, flexibleAllowed: true, stalenessDays: 3, storeVersion: "1.6.2", appStoreId: "6784262215" }
  reply(last("isUpdateAvailable").id, found)
  expect(await ios).toEqual(found)
  const upToDate = AppUpdates.isUpdateAvailable()
  reply(last("isUpdateAvailable").id, { available: false, versionCode: 0, storeVersion: "1.6.2", appStoreId: "6784262215" })
  expect(await upToDate).toEqual({ available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false, storeVersion: "1.6.2", appStoreId: "6784262215" })
  const odd = AppUpdates.isUpdateAvailable() // an id that isn't one is dropped
  reply(last("isUpdateAvailable").id, { available: false, storeVersion: "", appStoreId: "12/../x" })
  expect(await odd).toEqual({ available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false })

  const old = AppUpdates.isUpdateAvailable() // an APK without the plugin
  refuse(last("isUpdateAvailable").id, "unavailable")
  expect(await old).toEqual({ available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false })
})

test("start, complete, setBusy and openStore send their args and never reject", async () => {
  const s = AppUpdates.start({ flexible: true })
  expect(last("start").args.flexible).toBe(true)
  reply(last("start").id, { ok: true })
  expect(await s).toEqual({ ok: true })

  const old = AppUpdates.start({ flexible: false }) // an older iOS build answered `unavailable`
  expect(last("start").args).toEqual({ __v: 1, flexible: false })
  reply(last("start").id, { unavailable: true })
  expect(await old).toEqual({ ok: false, unavailable: true })

  const sheet = AppUpdates.start({ flexible: true, appStoreId: "6784262215" }) // iOS: the App Store sheet for that app
  expect(last("start").args).toEqual({ __v: 1, flexible: true, appStoreId: "6784262215" })
  reply(last("start").id, { ok: true })
  expect(await sheet).toEqual({ ok: true })

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

test("appStoreUpdates asks the lookup for the server's App Store id", async () => {
  const a = appStoreUpdates.isAvailable({ appStoreId: "123" })
  expect(last("isUpdateAvailable").args.appStoreId).toBe("123")
  reply(last("isUpdateAvailable").id, { available: true, storeVersion: "2.0", appStoreId: "123" })
  expect((await a).available).toBe(true)
  const b = appStoreUpdates.isAvailable({})
  expect(last("isUpdateAvailable").args.appStoreId).toBeUndefined()
  refuse(last("isUpdateAvailable").id, "unavailable")
  expect((await b).available).toBe(false)
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

// ---- The store answer (from native's update check) --------------------------------------------------------------

const status = (store: unknown, lastCheckAt: number | null = 1) => ({ enabled: true, phase: "idle", progress: 0, lastCheckAt, store }) as UpdateStatus

test("storeAnswer reads the answer that came with the update check", async () => {
  expect(await storeAnswer(status({ update: { version: 170, critical: 2, title: "New", message: "Please update" }, at: 5 }))).toEqual({
    update: { version: 170, critical: 2, title: "New", message: "Please update" },
    store: {},
  })
  expect(await storeAnswer(status({ update: null, at: 5 }))).toEqual({ update: null, store: {} })
  expect(await storeAnswer(status({ update: { version: "1.7.0", critical: 1 }, appStoreId: "123", at: 5 }))).toEqual({
    update: { version: "1.7.0", critical: 1 },
    store: { appStoreId: "123" },
  })
})

test("storeAnswer: null before the first answer, and for an answer it can't read", async () => {
  expect(await storeAnswer(status(null))).toBeNull()
  expect(await storeAnswer(status(undefined))).toBeNull()
  expect(await storeAnswer(status({ update: { version: 2, critical: 3 }, at: 5 }))).toBeNull()
  expect(await storeAnswer(status({ update: { critical: 1 }, at: 5 }))).toBeNull()
})

test("storeAnswer asks native when no status is given, and never rejects", async () => {
  const a = storeAnswer()
  expect(last("status").module).toBe("Updates")
  reply(last("status").id, status({ update: null, at: 5 }))
  expect(await a).toEqual({ update: null, store: {} })

  const b = storeAnswer()
  refuse(last("status").id, "E_FAILED")
  expect(await b).toBeNull()
})

test("checkAfterUpdateChecks: one engine check per native update check, none for other status changes", async () => {
  let checks = 0
  const engine = { check: async () => void checks++ } as unknown as AppUpdateEngine
  const stop = checkAfterUpdateChecks(engine)
  // Native checked before JS was up: one check now
  reply(last("status").id, status({ update: null, at: 5 }, 100))
  await Promise.resolve()
  await Promise.resolve()
  expect(checks).toBe(1)
  const send = (s: UpdateStatus) => globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Updates", event: "status", payload: s }))
  send(status({ update: null, at: 5 }, 100)) // the same check (a phase change): nothing
  send({ ...status({ update: null, at: 5 }, 100), phase: "downloading", progress: 0.5 })
  expect(checks).toBe(1)
  send(status({ update: { version: 175, critical: 2 }, at: 9 }, 200)) // a new check
  expect(checks).toBe(2)
  send(status(null, null)) // no check yet: nothing
  expect(checks).toBe(2)
  stop()
  send(status({ update: null, at: 10 }, 300))
  expect(checks).toBe(2)
})
