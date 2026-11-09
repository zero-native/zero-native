import { beforeEach, expect, spyOn, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Analytics, analytics, getAnalytics } from "../src/index"

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

test("logEvent sends the name and params, leaving undefined values out", async () => {
  const p = analytics().logEvent("pay_tapped", { amount: 499, method: "upi", note: undefined })
  const c = last("logEvent")
  expect(c.module).toBe("Analytics")
  expect(c.args).toMatchObject({ name: "pay_tapped", params: { amount: 499, method: "upi" } })
  expect("note" in (c.args as { params: object }).params).toBe(false)
  reply(c.id, "")
  expect(await p).toBe(true)
})

test("a refused event answers false with a console warning of the reason", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const p = Analytics.logEvent("bad-name")
  reply(last("logEvent").id, 'event name "bad-name" must start with a letter and have only letters, digits and _')
  expect(await p).toBe(false)
  expect(warn.mock.calls[0]?.[0]).toContain("bad-name")
  warn.mockRestore()
})

test("calls never reject when the plugin is missing", async () => {
  const p = Analytics.logEvent("x")
  refuse(last("logEvent").id, "unavailable")
  expect(await p).toBe(false)
  const s = Analytics.status()
  refuse(last("status").id, "unavailable")
  expect(await s).toEqual({ available: false })
  const id = Analytics.getAppInstanceId()
  refuse(last("getAppInstanceId").id, "unavailable")
  expect(await id).toBeNull()
})

test("setConsent maps RN Firebase's names and leaves out the keys not given", () => {
  void Analytics.setConsent({ analytics_storage: true, ad_storage: false })
  const args = last("setConsent").args as Record<string, unknown>
  expect(args).toMatchObject({ analyticsStorage: true, adStorage: false })
  expect("adUserData" in args).toBe(false)
})

test("recommended events and screen views use Google's names", () => {
  void getAnalytics().logPurchase({ value: 499, currency: "INR", transaction_id: "T1", items: [{ item_id: "sku1", price: 499 }] })
  expect(last("logEvent").args).toMatchObject({
    name: "purchase",
    params: { value: 499, currency: "INR", transaction_id: "T1", items: [{ item_id: "sku1", price: 499 }] },
  })
  void Analytics.logLogin({ method: "otp" })
  expect(last("logEvent").args).toMatchObject({ name: "login", params: { method: "otp" } })
  void Analytics.logScreenView({ screen_name: "checkout.sheet" })
  expect(last("logEvent").args).toMatchObject({ name: "screen_view", params: { screen_name: "checkout.sheet", screen_class: "checkout.sheet" } })
})

test("user id, properties and default params pass through, null clears", () => {
  void Analytics.setUserId(null)
  expect(last("setUserId").args).toMatchObject({ id: null })
  void Analytics.setUserProperty("plan", "free")
  expect(last("setUserProperty").args).toMatchObject({ name: "plan", value: "free" })
  void Analytics.setDefaultEventParameters(null)
  expect(last("setDefaultEventParameters").args).toMatchObject({ params: null })
})
