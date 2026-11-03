import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls, NativeError } from "../src/calls"
import { installEvents } from "../src/events"
import { Permissions } from "../src/permissions"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("request names the permissions and gives each one's state", async () => {
  const p = Permissions.request(["camera", "contacts"])
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Permissions", method: "request", args: { names: ["camera", "contacts"], __v: 1 } })
  reply({ id: c.id, ok: true, value: { camera: "granted", contacts: "blocked" } })
  expect(await p).toEqual({ camera: "granted", contacts: "blocked" })
})

test("location is granted with approximate only, and says precise apart", async () => {
  const p = Permissions.request(["location"])
  const [c] = host.calls
  reply({ id: c.id, ok: true, value: { location: "granted", "location.precise": "denied" } })
  const r = await p
  expect(r.location).toBe("granted")
  expect(r["location.precise"]).toBe("denied")
})

test("a request while one is open fails with busy", async () => {
  const p = Permissions.status(["camera"])
  const [c] = host.calls
  reply({ id: c.id, ok: false, code: "busy", error: "a permission request is open" })
  const err = (await p.catch((e) => e)) as NativeError
  expect(err.code).toBe("busy")
})
