import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { createRoot } from "../../../packages/core/src/signals"
import { createStorage } from "../../../packages/core/src/storage"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Auth } from "../src/index"

const KEY = "auth.phone-hint"
const PHONE = "+919876543210"
const OTP = "4821"

let host: FakeHost
let drafts = 0
let draft = ""

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const module = (name: string, event: string, payload: object) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: name, event, payload }))
const launchResult = (r: object) => module("Launches", "result", { key: KEY, ...r })
const save = (r: object) => createStorage("zn.launch").set(`launch.record.${KEY}`, JSON.stringify({ key: KEY, ...r }))
const asked = () => createStorage("zn.auth")
const calls = (method: string) => host.calls.filter((c) => c.method === method)
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const otpEvent = (id: string, code: string | null, reason: string | null) => module("Auth", "otp", { id, code, reason })
const answerAcks = () => calls("ack").forEach((c) => reply(c.id, true))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  Auth.clearPhoneHint()
  Auth.stopListening()
  host.calls.length = 0
  draft = `draft-${++drafts}`
})

// ---- The hint ---------------------------------------------------------------------------------------------------------

test("a hint opens through native, and the number comes through launches and is acked", async () => {
  const p = Auth.phoneHint({ draft })
  await tick()
  const [c] = calls("phoneHint")
  expect(c).toMatchObject({ module: "Auth", args: { __v: 1 } })
  reply(c.id, { launched: true })
  await tick()
  launchResult({ id: c.args.id, status: "result", resultCode: -1, extras: { phone: PHONE } })
  expect(await p).toEqual({ phone: PHONE, reason: null })
  expect(calls("ack")[0].args).toMatchObject({ key: KEY, id: c.args.id })
})

test("the sheet closed by the user is a clean answer", async () => {
  const p = Auth.phoneHint({ draft })
  await tick()
  const [c] = calls("phoneHint")
  reply(c.id, { launched: true })
  await tick()
  launchResult({ id: c.args.id, status: "result", resultCode: 0, extras: { reason: "cancelled" } })
  expect(await p).toEqual({ phone: null, reason: "cancelled" })
})

test("a result whose extras couldn't be read means no number", async () => {
  const p = Auth.phoneHint({ draft })
  await tick()
  const [c] = calls("phoneHint")
  launchResult({ id: c.args.id, status: "result", resultCode: -1, extras: {} })
  expect(await p).toEqual({ phone: null, reason: "no_number" })
})

test("a sheet that didn't open gives its reason", async () => {
  const p = Auth.phoneHint({ draft })
  await tick()
  reply(calls("phoneHint")[0].id, { launched: false, reason: "no_activity" })
  expect(await p).toEqual({ phone: null, reason: "no_activity" })
})

test("Play services failing, or no module, never rejects", async () => {
  const p = Auth.phoneHint({ draft })
  await tick()
  refuse(calls("phoneHint")[0].id, "unavailable")
  expect(await p).toEqual({ phone: null, reason: "unavailable" })
})

test("a hint survives the screen that asked closing", async () => {
  let p!: Promise<unknown>
  createRoot((dispose) => {
    p = Auth.phoneHint({ draft })
    dispose()
  })
  await tick()
  const [c] = calls("phoneHint")
  expect(host.cancelled).toEqual([])
  reply(c.id, { launched: true })
  await tick()
  launchResult({ id: c.args.id, status: "result", resultCode: -1, extras: { phone: PHONE } })
  expect(await p).toEqual({ phone: PHONE, reason: null })
})

test("a rebuilt screen joins the open hint and opens nothing", async () => {
  const first = Auth.phoneHint({ draft })
  const second = Auth.phoneHint({ draft })
  expect(second).toBe(first)
  await tick()
  expect(calls("phoneHint")).toHaveLength(1)
})

test("a new draft answers the old one", async () => {
  const first = Auth.phoneHint({ draft })
  await tick()
  reply(calls("phoneHint")[0].id, { launched: false, reason: "replaced" })
  void Auth.phoneHint({ draft: `${draft}-new` })
  expect(await first).toEqual({ phone: null, reason: "replaced" })
})

test("a new draft while the sheet is open waits for nothing: busy", async () => {
  const first = Auth.phoneHint({ draft })
  await tick()
  const [c] = calls("phoneHint")
  save({ id: c.args.id, status: "waiting" })
  const second = await Auth.phoneHint({ draft: `${draft}-new` })
  expect(second).toEqual({ phone: null, reason: "busy" })
  expect(await first).toEqual({ phone: null, reason: "replaced" })
  expect(calls("phoneHint")).toHaveLength(1)
})

test("after a kill the saved result answers, and the sheet doesn't open again", async () => {
  asked().set("hint.asked", draft)
  save({ id: `${draft}|1`, status: "result", resultCode: -1, extras: { phone: PHONE } })
  expect(await Auth.phoneHint({ draft })).toEqual({ phone: PHONE, reason: null })
  expect(calls("phoneHint")).toHaveLength(0)
  expect(calls("ack")[0].args).toMatchObject({ key: KEY, id: `${draft}|1` })
})

test("after a kill with no answer: lost, and no new sheet", async () => {
  asked().set("hint.asked", draft)
  save({ id: `${draft}|2`, status: "lost" })
  expect(await Auth.phoneHint({ draft })).toEqual({ phone: null, reason: "lost" })
  expect(calls("phoneHint")).toHaveLength(0)
})

test("a restore after the hint was answered: already asked, and no new sheet", async () => {
  asked().set("hint.asked", draft)
  expect(await Auth.phoneHint({ draft })).toEqual({ phone: null, reason: "already_asked" })
  expect(calls("phoneHint")).toHaveLength(0)
})

test("the asked mark is on disk before the sheet opens", async () => {
  void Auth.phoneHint({ draft })
  await tick()
  expect(calls("phoneHint")).toHaveLength(1)
  expect(asked().getString("hint.asked")).toBe(draft)
})

test("a dev reload while the sheet is open: joins it through the record", async () => {
  asked().set("hint.asked", draft)
  save({ id: `${draft}|3`, status: "waiting" })
  const p = Auth.phoneHint({ draft })
  await tick()
  expect(calls("phoneHint")).toHaveLength(0)
  launchResult({ id: `${draft}|3`, status: "result", resultCode: -1, extras: { phone: PHONE } })
  expect(await p).toEqual({ phone: PHONE, reason: null })
})

test("a number from an earlier attempt is dropped, never handed to a new one", async () => {
  save({ id: "old-attempt|4", status: "result", resultCode: -1, extras: { phone: PHONE } })
  const p = Auth.phoneHint({ draft })
  await tick()
  expect(calls("ack")[0].args).toMatchObject({ id: "old-attempt|4" })
  expect(calls("phoneHint")).toHaveLength(0) // not before the ack: native would refuse it as unacked
  createStorage("zn.launch").delete(`launch.record.${KEY}`)
  answerAcks()
  await tick()
  const [c] = calls("phoneHint")
  launchResult({ id: c.args.id, status: "result", resultCode: 0, extras: { reason: "cancelled" } })
  expect(await p).toEqual({ phone: null, reason: "cancelled" })
})

test("a draft with a bar in it still finds its record", async () => {
  const odd = `${draft}|a|b`
  save({ id: `${odd}|5`, status: "result", resultCode: -1, extras: { phone: PHONE } })
  expect(await Auth.phoneHint({ draft: odd })).toEqual({ phone: PHONE, reason: null })
})

test("clearPhoneHint lets the same draft ask again, and clears a saved number", async () => {
  asked().set("hint.asked", draft)
  save({ id: "x|6", status: "result", resultCode: -1, extras: { phone: PHONE } })
  Auth.clearPhoneHint()
  expect(asked().has("hint.asked")).toBe(false)
  expect(calls("ack")[0].args).toMatchObject({ id: "x|6" })
})

test("clearPhoneHint answers an open ask", async () => {
  const p = Auth.phoneHint({ draft })
  Auth.clearPhoneHint()
  expect(await p).toEqual({ phone: null, reason: "replaced" })
})

test("a damaged record is a clean answer", async () => {
  createStorage("zn.launch").set(`launch.record.${KEY}`, "{not json")
  expect(await Auth.phoneHint({ draft })).toEqual({ phone: null, reason: "unavailable" })
})

test("a late result of a replaced hint is acked and goes nowhere", async () => {
  const first = Auth.phoneHint({ draft })
  await tick()
  const [c] = calls("phoneHint")
  reply(c.id, { launched: true })
  await tick()
  save({ id: c.args.id, status: "waiting" })
  await Auth.phoneHint({ draft: `${draft}-new` })
  await first
  launchResult({ id: c.args.id, status: "result", resultCode: -1, extras: { phone: PHONE } })
  await tick()
  expect(calls("ack").at(-1)!.args).toMatchObject({ id: c.args.id })
})

// ---- The SMS Retriever ------------------------------------------------------------------------------------------------

test("listen sends its options, and the event answers it", async () => {
  const p = Auth.listenForOtp({ pattern: "(\\d{6})", timeoutMs: 3000 })
  const [c] = calls("listenOtp")
  expect(c).toMatchObject({ module: "Auth", args: { pattern: "(\\d{6})", timeoutMs: 3000, __v: 1 } })
  reply(c.id, true)
  otpEvent(c.args.id, OTP, null)
  expect(await p).toEqual({ code: OTP, reason: null })
})

test("the ends with no code are clean answers", async () => {
  for (const reason of ["timeout", "no_code", "bad_pattern", "unavailable", "failed", "cancelled"]) {
    const p = Auth.listenForOtp()
    otpEvent(calls("listenOtp").at(-1)!.args.id, null, reason)
    expect(await p).toEqual({ code: null, reason } as never)
  }
})

test("an event with no reason is still an answer", async () => {
  const p = Auth.listenForOtp()
  otpEvent(calls("listenOtp")[0].args.id, null, null)
  expect(await p).toEqual({ code: null, reason: "failed" })
})

test("a second listen: native's answer settles the first, and only the first", async () => {
  const first = Auth.listenForOtp()
  const second = Auth.listenForOtp()
  const [a, b] = calls("listenOtp")
  expect(a.args.id).not.toBe(b.args.id)
  otpEvent(a.args.id, null, "replaced")
  expect(await first).toEqual({ code: null, reason: "replaced" })
  otpEvent(b.args.id, OTP, null)
  expect(await second).toEqual({ code: OTP, reason: null })
})

test("an event for a listen nobody waits for does nothing", () => {
  otpEvent("nobody", OTP, null)
  expect(host.logs).toEqual([])
})

test("no module: a clean answer, not a rejection", async () => {
  const p = Auth.listenForOtp()
  refuse(calls("listenOtp")[0].id, "unavailable")
  expect(await p).toEqual({ code: null, reason: "unavailable" })
})

test("a refused argument: a clean answer, not a rejection", async () => {
  const p = Auth.listenForOtp({ timeoutMs: 1.5 })
  refuse(calls("listenOtp")[0].id, "invalid_args")
  expect(await p).toEqual({ code: null, reason: "failed" })
})

test("a listen survives its screen closing", async () => {
  let p!: Promise<unknown>
  createRoot((dispose) => {
    p = Auth.listenForOtp()
    dispose()
  })
  expect(host.cancelled).toEqual([])
  otpEvent(calls("listenOtp")[0].args.id, OTP, null)
  expect(await p).toEqual({ code: OTP, reason: null })
})

test("the same key joins, also after it finished; another key starts a new one", async () => {
  const first = Auth.listenForOtp({ key: PHONE })
  expect(Auth.listenForOtp({ key: PHONE })).toBe(first)
  expect(calls("listenOtp")).toHaveLength(1)
  otpEvent(calls("listenOtp")[0].args.id, OTP, null)
  await first
  expect(Auth.listenForOtp({ key: PHONE })).toBe(first)
  expect(calls("listenOtp")).toHaveLength(1)
  void Auth.listenForOtp({ key: "+910000000000" })
  expect(calls("listenOtp")).toHaveLength(2)
})

test("stopListening tells native and ends the join", () => {
  void Auth.listenForOtp({ key: PHONE })
  Auth.stopListening()
  expect(calls("stopOtp")).toHaveLength(1)
  void Auth.listenForOtp({ key: PHONE })
  expect(calls("listenOtp")).toHaveLength(2)
})

test("the app hash is a value, and failing gives an empty one", async () => {
  const p = Auth.appHash()
  reply(calls("appHash")[0].id, "FA+9qCX9VSu")
  expect(await p).toBe("FA+9qCX9VSu")
  const q = Auth.appHash()
  refuse(calls("appHash")[1].id, "unavailable")
  expect(await q).toBe("")
})

test("nothing secret reaches a log", async () => {
  const p = Auth.phoneHint({ draft })
  await tick()
  const [c] = calls("phoneHint")
  launchResult({ id: c.args.id, status: "result", resultCode: -1, extras: { phone: PHONE } })
  await p
  const o = Auth.listenForOtp()
  otpEvent(calls("listenOtp")[0].args.id, OTP, null)
  await o
  const logged = host.logs.map(([, text]) => text).join("\n")
  expect(logged).not.toContain(PHONE)
  expect(logged).not.toContain(OTP)
})
