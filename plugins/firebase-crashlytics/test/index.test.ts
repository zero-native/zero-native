import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Crashlytics, crashlytics, getCrashlytics } from "../src/index"

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

test("recordError sends the name, message, Hermes stack and tag", async () => {
  const e = new TypeError("amount is undefined")
  const p = Crashlytics.recordError(e, "Checkout.verify")
  const c = last("recordError")
  expect(c.module).toBe("FirebaseCrashlytics")
  expect(c.args).toMatchObject({ name: "TypeError", message: "amount is undefined", tag: "Checkout.verify" })
  expect(typeof (c.args as { stack: string }).stack).toBe("string")
  reply(c.id, true)
  expect(await p).toBe(true)
})

test("recordError takes a string or a plain value too, and leaves the tag out when there is none", () => {
  void Crashlytics.recordError("plain text")
  expect(last("recordError").args).toMatchObject({ message: "plain text" })
  expect("tag" in last("recordError").args).toBe(false)
  void Crashlytics.recordError({ code: 42 })
  expect(last("recordError").args).toMatchObject({ message: '{"code":42}' })
})

test("calls never reject: a missing plugin answers false, status answers off", async () => {
  const p = Crashlytics.log("hello")
  refuse(last("log").id, "unavailable")
  expect(await p).toBe(false)

  const s = Crashlytics.status()
  refuse(last("status").id, "unavailable")
  expect(await s).toEqual({ available: false, enabled: false })
})

test("isCrashlyticsCollectionEnabled follows the last status, like RN Firebase's property", async () => {
  expect(Crashlytics.isCrashlyticsCollectionEnabled).toBe(false)
  const s = Crashlytics.status()
  reply(last("status").id, { available: true, enabled: true })
  await s
  expect(Crashlytics.isCrashlyticsCollectionEnabled).toBe(true)

  const off = Crashlytics.setCrashlyticsCollectionEnabled(false)
  expect(last("setCollectionEnabled").args).toMatchObject({ on: false })
  reply(last("setCollectionEnabled").id, { available: true, enabled: false })
  expect(await off).toEqual({ available: true, enabled: false })
  expect(Crashlytics.isCrashlyticsCollectionEnabled).toBe(false)
})

test("attributes keep their type; crash defaults to a Kotlin crash", () => {
  void Crashlytics.setAttribute("cart_items", 3)
  expect(last("setAttribute").args).toMatchObject({ key: "cart_items", value: 3 })
  void Crashlytics.setAttributes({ plan: "free", beta: true })
  expect(last("setAttributes").args).toMatchObject({ values: { plan: "free", beta: true } })
  void Crashlytics.crash()
  expect(last("crash").args).toMatchObject({ kind: "kotlin" })
})

test("RN Firebase's names give the same object", () => {
  expect(crashlytics()).toBe(Crashlytics)
  expect(getCrashlytics()).toBe(Crashlytics)
})
