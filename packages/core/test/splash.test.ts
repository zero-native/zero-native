import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { Splash } from "../src/splash"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
// Lets Promise callbacks run (microtasks only: other test files replace setTimeout).
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

// The release waits one JS turn (setTimeout 0): here a timer runs as a microtask, as other test files replace timers.
const realSetTimeout = globalThis.setTimeout

beforeEach(() => {
  globalThis.setTimeout = ((fn: () => void) => {
    queueMicrotask(fn)
    return 0
  }) as unknown as typeof setTimeout
  host = installFakeHost()
  installEvents()
  installCalls()
})

// Answers what a test left open: pending calls are shared by every test file (calls.test.ts counts them).
afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  for (const c of host.calls) if (c.id !== 0) reply({ id: c.id, ok: true, value: null })
})

const splashCalls = () => host.calls.filter((c) => c.module === "Splash")

test("holdUntil asks native to hold, and releases the same id when the work resolves", async () => {
  let done!: () => void
  Splash.holdUntil(new Promise<void>((r) => (done = r)), { maxMs: 400 })
  await tick()
  const [hold] = splashCalls()
  expect(hold).toMatchObject({ method: "hold", args: { maxMs: 400, __v: 1 } })
  expect(splashCalls()).toHaveLength(1)
  done()
  await tick()
  const release = splashCalls()[1]
  expect(release).toMatchObject({ method: "release", args: { id: hold.args.id, __v: 1 } })
})

test("a failed piece of work releases the splash too", async () => {
  let fail!: (e: Error) => void
  Splash.holdUntil(new Promise<void>((_, rej) => (fail = rej)), { maxMs: 400 })
  await tick()
  fail(new Error("init failed"))
  await tick()
  expect(splashCalls().map((c) => c.method)).toEqual(["hold", "release"])
})

test("each hold has its own id", async () => {
  Splash.holdUntil(Promise.resolve(), { maxMs: 100 })
  Splash.holdUntil(Promise.resolve(), { maxMs: 100 })
  await tick()
  const holds = splashCalls().filter((c) => c.method === "hold")
  expect(holds[0].args.id).not.toBe(holds[1].args.id)
})

test("maxMs must be a number, 0 or more", () => {
  expect(() => Splash.holdUntil(Promise.resolve(), { maxMs: -1 })).toThrow("maxMs must be a number")
  expect(() => Splash.holdUntil(Promise.resolve(), { maxMs: Number.NaN })).toThrow("maxMs must be a number")
  expect(() => Splash.holdUntil(Promise.resolve(), {} as { maxMs: number })).toThrow("maxMs must be a number")
})
