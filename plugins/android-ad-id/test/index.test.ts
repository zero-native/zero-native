import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { AdId } from "../src/index"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const last = () => host.calls.filter((c) => c.method === "get").at(-1)!

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  host.calls.length = 0
})

test("the id and the user's choice come back as native gives them", async () => {
  const a = AdId.get()
  expect(last().module).toBe("AndroidAdId")
  reply(last().id, { id: "38400000-8cf0-11bd-b23e-10b96e40000d", limitAdTracking: true })
  expect(await a).toEqual({ id: "38400000-8cf0-11bd-b23e-10b96e40000d", limitAdTracking: true })
})

test("no id, a failure or a missing module answer id null and never reject", async () => {
  const none = AdId.get()
  reply(last().id, { id: null, limitAdTracking: true })
  expect(await none).toEqual({ id: null, limitAdTracking: true })

  const failed = AdId.get()
  refuse(last().id, "failed")
  expect(await failed).toEqual({ id: null, limitAdTracking: false })

  const old = AdId.get() // an APK without the plugin
  refuse(last().id, "unavailable")
  expect(await old).toEqual({ id: null, limitAdTracking: false })

  const odd = AdId.get()
  reply(last().id, { id: "", limitAdTracking: "yes" })
  expect(await odd).toEqual({ id: null, limitAdTracking: false })
})
