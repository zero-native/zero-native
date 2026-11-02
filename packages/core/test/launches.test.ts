import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { launches, type LaunchRecord } from "../src/launches"
import { createStorage } from "../src/storage"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const emit = (payload: LaunchRecord) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Launches", event: "result", payload }))
const save = (r: LaunchRecord) => createStorage("zn.launch").set(`launch.record.${r.key}`, JSON.stringify(r))
const later = () => Promise.resolve().then(() => {}) // other tests replace the global timers

const waiting: LaunchRecord = { key: "upi", id: "t1", status: "waiting" }
const result: LaunchRecord = { key: "upi", id: "t1", status: "result", resultCode: -1, data: null, extras: { Status: "SUCCESS" } }

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("pending is a sync read of what native saved, and clears nothing", () => {
  expect(launches.pending("upi")).toBeNull()
  save(result)
  expect(launches.pending("upi")).toEqual(result)
  expect(launches.pending("upi")).toEqual(result)
})

test("a live result reaches the listener of its key only", () => {
  const seen: LaunchRecord[] = []
  launches.onResult("upi", (r) => seen.push(r))
  emit({ ...result, key: "hint" })
  expect(seen).toEqual([])
  emit(result)
  expect(seen).toEqual([result])
})

test("a result saved before the app listens comes too, after the caller has finished", async () => {
  save(result)
  const seen: LaunchRecord[] = []
  launches.onResult("upi", (r) => seen.push(r))
  expect(seen).toEqual([])
  await later()
  expect(seen).toEqual([result])
})

test("waiting is not a result", async () => {
  save(waiting)
  const seen: LaunchRecord[] = []
  launches.onResult("upi", (r) => seen.push(r))
  await later()
  emit(waiting)
  expect(seen).toEqual([])
})

test("one listener sees a record once; a new listener sees it again", async () => {
  save(result)
  const first: LaunchRecord[] = []
  const second: LaunchRecord[] = []
  launches.onResult("upi", (r) => first.push(r))
  await later()
  emit(result)
  expect(first).toHaveLength(1)
  launches.onResult("upi", (r) => second.push(r))
  await later()
  expect(second).toHaveLength(1)
})

test("a late result after lost still comes", async () => {
  const seen: string[] = []
  launches.onResult("upi", (r) => seen.push(r.status))
  emit({ ...waiting, status: "lost" })
  emit(result)
  expect(seen).toEqual(["lost", "result"])
})

test("ack sends the key and id; native says if it matched", async () => {
  const p = launches.ack("upi", "t1")
  const c = host.calls.at(-1)!
  expect(c).toMatchObject({ module: "Launches", method: "ack", args: { key: "upi", id: "t1", __v: 1 } })
  reply({ id: c.id, ok: true, value: false })
  expect(await p).toBe(false)
})
