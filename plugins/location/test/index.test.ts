import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { createRoot } from "../../../packages/core/src/signals"
import { createStorage } from "../../../packages/core/src/storage"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Geolocation, Location, type GeoError, type Position } from "../src/index"

const FINE = "android.permission.ACCESS_FINE_LOCATION"
const COARSE = "android.permission.ACCESS_COARSE_LOCATION"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const watchEvent = (payload: object) => globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Location", event: "watch", payload }))
const calls = (method: string) => host.calls.filter((c) => c.method === method)
const last = (method: string) => calls(method).at(-1)!
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const fix = {
  latitude: 12.9,
  longitude: 77.6,
  accuracy: 18,
  altitude: null,
  altitudeAccuracy: null,
  heading: null,
  speed: null,
  timestamp: 1_700_000_000_000,
  ageMs: 40,
  provider: "network",
  mocked: false,
}
const providers = { enabled: true, gps: true, network: true, hasGps: true, hasNetwork: true, fine: false, coarse: false }

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  Geolocation.stopObserving()
  Geolocation.setRNConfiguration({})
  host.calls.length = 0
  host.cancelled.length = 0
})

// ---- One fix ----------------------------------------------------------------------------------------------------------

test("a fix comes back in RN's shape, with no dialog and not tied to a screen", async () => {
  const p = Location.getCurrentPosition({ accuracy: "high", timeoutMs: 8000 })
  const c = last("current")
  expect(c).toMatchObject({ module: "Location", args: { accuracy: "high", timeoutMs: 8000, __v: 2 } })
  reply(c.id, { position: fix, reason: null, lastKnown: null })
  const r = await p
  expect(r.reason).toBeNull()
  expect(r.position?.coords).toEqual({ latitude: 12.9, longitude: 77.6, accuracy: 18, altitude: null, altitudeAccuracy: null, heading: null, speed: null })
  expect(r.position).toMatchObject({ timestamp: fix.timestamp, ageMs: 40, provider: "network", mocked: false })
  expect(calls("request")).toHaveLength(0)
})

test("no fix gives the reason and the last known fix", async () => {
  const p = Location.getCurrentPosition()
  reply(last("current").id, { position: null, reason: "timeout", lastKnown: { ...fix, ageMs: 600_000 } })
  const r = await p
  expect(r.reason).toBe("timeout")
  expect(r.lastKnown?.ageMs).toBe(600_000)
})

test("denied becomes blocked when Android won't ask again", async () => {
  const p = Location.getCurrentPosition()
  reply(last("current").id, { position: null, reason: "denied", lastKnown: null })
  await tick()
  const s = last("status")
  expect(s).toMatchObject({ module: "Permissions", args: { names: [FINE, COARSE] } })
  reply(s.id, { [FINE]: "blocked", [COARSE]: "denied" })
  expect((await p).reason).toBe("blocked")
})

test("denied stays denied when the permission state can't be read", async () => {
  const p = Location.getCurrentPosition()
  reply(last("current").id, { position: null, reason: "denied", lastKnown: null })
  await tick()
  refuse(last("status").id, "no_activity")
  expect((await p).reason).toBe("denied")
})

test("a missing plugin or a failure never rejects", async () => {
  const p = Location.getCurrentPosition()
  refuse(last("current").id, "unavailable")
  expect(await p).toEqual({ position: null, reason: "failed", lastKnown: null })
})

test("an aborted call answers cancelled and native is told", async () => {
  const controller = new AbortController()
  const p = Location.getCurrentPosition({ signal: controller.signal })
  const c = last("current")
  controller.abort()
  expect((await p).reason).toBe("cancelled")
  expect(host.cancelled).toContain(c.id)
})

test("a one-shot started in a screen still answers after the screen closes", async () => {
  let p!: Promise<unknown>
  createRoot((dispose) => {
    p = Location.getCurrentPosition()
    dispose()
  })
  reply(last("current").id, { position: fix, reason: null, lastKnown: null })
  expect(await p).toMatchObject({ reason: null })
})

// ---- Watch ------------------------------------------------------------------------------------------------------------

test("a watch gets only its own positions, and stop cancels the native call", async () => {
  const got: Position[] = []
  const stop = Location.watchPosition((p) => got.push(p), { intervalMs: 2000, distanceFilterM: 5 })
  const w = last("watch")
  expect(w.args).toMatchObject({ intervalMs: 2000, distanceFilterM: 5 })
  watchEvent({ id: w.args.id, position: fix, reason: null })
  watchEvent({ id: "other", position: fix, reason: null })
  expect(got).toHaveLength(1)
  stop()
  expect(host.cancelled).toContain(w.id)
  watchEvent({ id: w.args.id, position: fix, reason: null })
  expect(got).toHaveLength(1)
})

test("location off reaches onError, and positions go on after", async () => {
  const got: Position[] = []
  const errors: string[] = []
  Location.watchPosition((p) => got.push(p), {}, (r) => errors.push(r))
  const id = last("watch").args.id
  watchEvent({ id, position: null, reason: "off" })
  watchEvent({ id, position: fix, reason: null })
  expect(errors).toEqual(["off"])
  expect(got).toHaveLength(1)
})

test("a watch that can't run ends with its reason, refined to blocked", async () => {
  const errors: string[] = []
  Location.watchPosition(() => {}, {}, (r) => errors.push(r))
  reply(last("watch").id, { reason: "denied" })
  await tick()
  reply(last("status").id, { [FINE]: "denied", [COARSE]: "blocked" })
  await tick()
  expect(errors).toEqual(["blocked"])
})

test("a watch started in a screen stops when the screen closes", () => {
  createRoot((dispose) => {
    Location.watchPosition(() => {})
    dispose()
  })
  expect(host.cancelled).toContain(last("watch").id)
})

// ---- Permission and status --------------------------------------------------------------------------------------------

test("status: approximate only is granted, not precise", async () => {
  const p = Location.status()
  reply(last("providers").id, { ...providers, coarse: true })
  expect(await p).toEqual({ permission: "granted", precise: false, enabled: true, gps: true, network: true })
  expect(calls("status")).toHaveLength(0)
})

test("status: not granted asks the core for blocked", async () => {
  const p = Location.status()
  reply(last("providers").id, providers)
  await tick()
  reply(last("status").id, { [FINE]: "blocked", [COARSE]: "blocked" })
  expect((await p).permission).toBe("blocked")
})

test("requestPermission asks both, or only the rough one", async () => {
  const p = Location.requestPermission()
  const c = last("request")
  expect(c.args.names).toEqual([FINE, COARSE])
  reply(c.id, { [FINE]: "granted", [COARSE]: "granted" })
  expect(await p).toEqual({ permission: "granted", precise: true })

  const q = Location.requestPermission({ precise: false })
  expect(last("request").args.names).toEqual([COARSE])
  reply(last("request").id, { [COARSE]: "granted" })
  await tick()
  reply(last("providers").id, { ...providers, coarse: true })
  expect(await q).toEqual({ permission: "granted", precise: false })
})

test("requestPermission: the user picked approximate", async () => {
  const p = Location.requestPermission()
  reply(last("request").id, { [FINE]: "denied", [COARSE]: "granted" })
  await tick()
  reply(last("providers").id, { ...providers, coarse: true })
  expect(await p).toEqual({ permission: "granted", precise: false })
})

// ---- Settings and geocoding -------------------------------------------------------------------------------------------

test("openSettings and the geocoder never reject", async () => {
  const s = Location.openSettings()
  refuse(last("openSettings").id, "failed")
  expect(await s).toBe(false)

  const r = Location.reverseGeocode(12.9, 77.6, { max: 3 })
  expect(last("reverseGeocode").args).toMatchObject({ latitude: 12.9, longitude: 77.6, max: 3 })
  refuse(last("reverseGeocode").id, "failed")
  expect(await r).toEqual({ addresses: [], reason: "failed" })

  const g = Location.geocode("Koramangala, Bengaluru")
  const address = { name: "Koramangala", postalCode: "560034" }
  reply(last("geocode").id, { addresses: [address], reason: null })
  expect(await g).toEqual({ addresses: [address] as never, reason: null })
})

// ---- Turning location on ----------------------------------------------------------------------------------------------

const TURN_ON_KEY = "location.turn-on"
const launchResult = (r: object) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Launches", event: "result", payload: { key: TURN_ON_KEY, ...r } }))

test("turnOn: already on shows nothing", async () => {
  const p = Location.turnOn()
  await tick()
  reply(last("turnOn").id, { on: true })
  expect(await p).toEqual({ on: true, reason: null })
})

test("turnOn: Google's dialog, the user taps Turn on, and the record is acked", async () => {
  const p = Location.turnOn()
  await tick()
  const c = last("turnOn")
  reply(c.id, { on: false, launched: true })
  await tick()
  launchResult({ id: c.args.id, status: "result", resultCode: -1, extras: {} })
  expect(await p).toEqual({ on: true, reason: null })
  expect(last("ack").args).toMatchObject({ key: TURN_ON_KEY, id: c.args.id })
})

test("turnOn: No thanks is declined, and a lost dialog is lost", async () => {
  const p = Location.turnOn()
  await tick()
  const c = last("turnOn")
  reply(c.id, { on: false, launched: true })
  await tick()
  launchResult({ id: c.args.id, status: "result", resultCode: 0, extras: {} })
  expect(await p).toEqual({ on: false, reason: "declined" })

  const q = Location.turnOn()
  await tick()
  const d = last("turnOn")
  reply(d.id, { on: false, launched: true })
  await tick()
  launchResult({ id: d.args.id, status: "lost" })
  expect(await q).toEqual({ on: false, reason: "lost" })
})

test("turnOn: no dialog possible, or a failure, never rejects", async () => {
  const p = Location.turnOn()
  await tick()
  reply(last("turnOn").id, { on: false, reason: "unavailable" })
  expect(await p).toEqual({ on: false, reason: "unavailable" })

  const q = Location.turnOn()
  await tick()
  refuse(last("turnOn").id, "unavailable")
  expect(await q).toEqual({ on: false, reason: "failed" })
})

test("turnOn: a second tap while the dialog is open joins it", async () => {
  const p = Location.turnOn()
  const q = Location.turnOn()
  expect(q).toBe(p)
  await tick()
  expect(calls("turnOn")).toHaveLength(1)
  reply(last("turnOn").id, { on: true })
  await p
})

test("turnOn: another launch waiting is busy; an old answer is cleared first", async () => {
  const store = createStorage("zn.launch")
  store.set(`launch.record.${TURN_ON_KEY}`, JSON.stringify({ key: TURN_ON_KEY, id: "x", status: "waiting" }))
  expect(await Location.turnOn()).toEqual({ on: false, reason: "busy" })
  expect(calls("turnOn")).toHaveLength(0)

  store.set(`launch.record.${TURN_ON_KEY}`, JSON.stringify({ key: TURN_ON_KEY, id: "old", status: "result", resultCode: -1 }))
  const p = Location.turnOn()
  await tick()
  const ack = calls("ack").find((a) => a.args.id === "old")!
  expect(ack).toBeDefined()
  reply(ack.id, true)
  await tick()
  reply(last("turnOn").id, { on: true })
  expect(await p).toEqual({ on: true, reason: null })
})

// ---- The RN shim ------------------------------------------------------------------------------------------------------

test("RN getCurrentPosition: asks the permission first, then maps RN's options", async () => {
  let got: Position | null = null
  Geolocation.getCurrentPosition((p) => (got = p), undefined, { enableHighAccuracy: true, timeout: 5000 })
  await tick()
  reply(last("providers").id, providers)
  await tick()
  reply(last("status").id, { [FINE]: "denied", [COARSE]: "denied" })
  await tick()
  reply(last("request").id, { [FINE]: "granted", [COARSE]: "granted" })
  await tick()
  const c = last("current")
  expect(c.args).toMatchObject({ accuracy: "high", timeoutMs: 5000, maxAgeMs: Number.MAX_SAFE_INTEGER })
  reply(c.id, { position: fix, reason: null, lastKnown: null })
  await tick()
  expect(got).not.toBeNull()
})

test("RN errors use RN's codes", async () => {
  Geolocation.setRNConfiguration({ skipPermissionRequests: true })
  const errors: GeoError[] = []
  Geolocation.getCurrentPosition(() => {}, (e) => errors.push(e))
  await tick()
  reply(last("current").id, { position: null, reason: "timeout", lastKnown: null })
  await tick()
  expect(errors[0]).toMatchObject({ code: 3, TIMEOUT: 3 })
})

test("RN watch ids clear their watch", () => {
  const id = Geolocation.watchPosition(() => {})
  const w = last("watch")
  Geolocation.clearWatch(id)
  expect(host.cancelled).toContain(w.id)
})
