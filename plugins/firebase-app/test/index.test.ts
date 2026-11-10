import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Firebase, firebase, Installations, installations } from "../src/index"

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

test("app() answers the native info, and off when the plugin is missing", async () => {
  const info = { available: true, name: "[DEFAULT]", projectId: "p", appId: "1:2:android:3", dataCollectionDefault: true }
  const p = firebase.app()
  expect(last("app").module).toBe("FirebaseApp")
  reply(last("app").id, info)
  expect(await p).toEqual(info)

  const q = Firebase.app()
  refuse(last("app").id, "unavailable")
  expect(await q).toEqual({ available: false })
})

test("setDataCollectionDefault sends the switch", () => {
  void Firebase.setDataCollectionDefault(false)
  expect(last("setDataCollectionDefault").args).toMatchObject({ on: false })
})

test("Installations calls never reject", async () => {
  const id = installations().getId()
  expect(last("getId").module).toBe("FirebaseInstallations")
  refuse(last("getId").id, "unavailable")
  expect(await id).toBeNull()

  const t = Installations.getToken(true)
  expect(last("getToken").args).toMatchObject({ forceRefresh: true })
  refuse(last("getToken").id, "unavailable")
  expect(await t).toBeNull()

  const d = Installations.delete()
  refuse(last("delete").id, "unavailable")
  expect(await d).toBe(false)
})
