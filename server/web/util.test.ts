import { expect, test } from "bun:test"
import { canRunShort, capabilityList, requiresGroups, requiresList } from "./util"

test("needs list one-OS modules after the others, marked with the OS (docs/ota-requires-per-os.md)", () => {
  const r = { registry: 22, bytecode: 99, hostApi: 9, modules: { Fetch: 1 }, os: { ios: { Haptics: 1 }, android: { AdId: 1 } } }
  expect(requiresList(r)).toEqual(["Registry v22", "Bytecode 99", "Host API v9", "Fetch v1", "AdId v1 (Android only)", "Haptics v1 (iOS only)"])
  expect(requiresList({ ...r, os: undefined })).toEqual(["Registry v22", "Bytecode 99", "Host API v9", "Fetch v1"])
  const c = { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1 } }
  expect(capabilityList({ ...c, os: "ios" })).toEqual(["Registry v24", "Bytecode 99", "Host API v1 to v9", "iOS", "Fetch v1"])
  expect(capabilityList(c)).toEqual(["Registry v24", "Bytecode 99", "Host API v1 to v9", "Fetch v1"])
  expect(canRunShort(c)).toBe("Registry v24 · Host API v1–v9 · 1 module")
  expect(canRunShort({ ...c, modules: { Fetch: 1, Upi: 1 } })).toBe("Registry v24 · Host API v1–v9 · 2 modules")
})

test("needs in groups: framework, core, zero-native plugins, the app's own (moduleFrom); one row without it", () => {
  const r = { registry: 22, bytecode: 99, hostApi: 9, modules: { Fetch: 1, FirebaseMessaging: 1, Upi: 1 }, os: { android: { AndroidAdId: 1 } } }
  const from = { Fetch: "@zero-native/core", FirebaseMessaging: "@zero-native/firebase-messaging", Upi: "@acme/upi", AndroidAdId: "@zero-native/android-ad-id" }
  expect(requiresGroups(r, from)).toEqual([
    { title: "Framework", items: [{ label: "Registry v22" }, { label: "Bytecode 99" }, { label: "Host API v9" }] },
    { title: "Core", items: [{ label: "Fetch v1", from: "@zero-native/core" }] },
    { title: "zero-native plugins", items: [
      { label: "AndroidAdId v1 (Android only)", from: "@zero-native/android-ad-id" },
      { label: "FirebaseMessaging v1", from: "@zero-native/firebase-messaging" },
    ] },
    { title: "App's own", items: [{ label: "Upi v1", from: "@acme/upi" }] },
  ])
  // A bundle from before moduleFrom: the modules in one row, the OS marks kept
  expect(requiresGroups(r).map((g) => g.title)).toEqual(["Framework", "Modules"])
  expect(requiresGroups(r)[1]!.items.map((x) => x.label)).toEqual(["AndroidAdId v1 (Android only)", "Fetch v1", "FirebaseMessaging v1", "Upi v1"])
})
