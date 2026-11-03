import { beforeEach, expect, mock, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { handleScannerEvent, Scanner } from "../src/module"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("a call names the module and the version the plugin needs", async () => {
  const p = Scanner.available()
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Scanner", method: "available", args: { __v: 1 } })
  reply({ id: c.id, ok: true, value: true })
  expect(await p).toBe(true)
})

test("each view event reaches its prop", () => {
  const props = { onScan: mock(), onPermission: mock(), onError: mock(), onTorchOff: mock() }
  handleScannerEvent(props, { name: "scanned", data: { value: "abc", format: "qr" } })
  handleScannerEvent(props, { name: "permission", data: { state: "blocked" } })
  handleScannerEvent(props, { name: "error", data: { code: "camera_failed", message: "no" } })
  handleScannerEvent(props, { name: "torch", data: { on: false } })
  expect(props.onScan).toHaveBeenCalledWith({ value: "abc", format: "qr" })
  expect(props.onPermission).toHaveBeenCalledWith("blocked")
  expect(props.onError).toHaveBeenCalledWith({ code: "camera_failed", message: "no" })
  expect(props.onTorchOff).toHaveBeenCalledTimes(1)
})

test("optional props may be left out, and a new event from a newer app is ignored", () => {
  const onScan = mock()
  handleScannerEvent({ onScan }, { name: "permission", data: { state: "granted" } })
  handleScannerEvent({ onScan }, { name: "torch", data: { on: false } })
  handleScannerEvent({ onScan }, { name: "something-new", data: null })
  expect(onScan).not.toHaveBeenCalled()
})
