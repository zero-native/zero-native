import { expect, test } from "bun:test"
import { capabilityList, requiresList } from "./util"

test("needs list one-OS modules after the others, marked with the OS (docs/ota-requires-per-os.md)", () => {
  const r = { registry: 22, bytecode: 99, hostApi: 9, modules: { Fetch: 1 }, os: { ios: { Haptics: 1 }, android: { AdId: 1 } } }
  expect(requiresList(r)).toEqual(["Registry v22", "Bytecode 99", "Host API v9", "Fetch v1", "AdId v1 (Android only)", "Haptics v1 (iOS only)"])
  expect(requiresList({ ...r, os: undefined })).toEqual(["Registry v22", "Bytecode 99", "Host API v9", "Fetch v1"])
  const c = { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1 } }
  expect(capabilityList({ ...c, os: "ios" })).toEqual(["Registry v24", "Bytecode 99", "Host API v1 to v9", "iOS", "Fetch v1"])
  expect(capabilityList(c)).toEqual(["Registry v24", "Bytecode 99", "Host API v1 to v9", "Fetch v1"])
})
