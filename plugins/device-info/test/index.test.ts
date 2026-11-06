import { afterEach, beforeEach, expect, test } from "bun:test"
import { installCalls, nativeConstants, resetNativeConstantsForTests } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import DeviceInfo, * as Named from "../src/index"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const last = (method: string) => host.calls.filter((c) => c.method === method).at(-1)!

const LAVA = {
  bundleId: "com.example.app.dev",
  applicationName: "Example Dev",
  version: "4.2.0-DEBUG",
  buildNumber: "168",
  readableVersion: "4.2.0-DEBUG.168",
  firstInstallTime: 1762300000000,
  lastUpdateTime: 1762400000000,
  installerPackageName: "unknown",
  uniqueId: "9774d56d682e549c",
  androidId: "9774d56d682e549c",
  deviceId: "LXX505",
  model: "LXX505",
  brand: "LAVA",
  manufacturer: "LAVA",
  systemName: "Android",
  systemVersion: "14",
  apiLevel: 34,
  deviceType: "Handset",
  isTablet: false,
  hasNotch: true,
  isEmulator: false,
  supportedAbis: ["arm64-v8a", "armeabi-v7a", "armeabi"],
  totalMemory: 5_900_000_000,
  deviceName: "My 😀 phone",
}

function withConstants(c: unknown) {
  globalThis.__zn_constants = c === undefined ? undefined : JSON.stringify({ DeviceInfo: c, Other: { x: 1 } })
  resetNativeConstantsForTests()
  Named.resetDeviceInfoForTests()
}

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  host.calls.length = 0
  withConstants(LAVA)
})

afterEach(() => withConstants(undefined))

test("fixed values answer at once, with react-native-device-info's names, and make no native call", () => {
  expect(DeviceInfo.getBundleId()).toBe("com.example.app.dev")
  expect(DeviceInfo.getVersion()).toBe("4.2.0-DEBUG")
  expect(DeviceInfo.getBuildNumber()).toBe("168")
  expect(DeviceInfo.getUniqueIdSync()).toBe("9774d56d682e549c")
  expect(DeviceInfo.getManufacturerSync()).toBe("LAVA")
  expect(DeviceInfo.getLastUpdateTimeSync()).toBe(1762400000000)
  expect(DeviceInfo.getDeviceId()).toBe("LXX505")
  expect(DeviceInfo.getSystemVersion()).toBe("14")
  expect(DeviceInfo.getDeviceType()).toBe("Handset")
  expect(DeviceInfo.hasNotch()).toBe(true)
  expect(DeviceInfo.getDeviceNameSync()).toBe("My 😀 phone")
  expect(Named.getModel()).toBe("LXX505") // named imports work too
  expect(host.calls.length).toBe(0)
})

test("the Promise forms of fixed values give the same value", async () => {
  expect(await DeviceInfo.getUniqueId()).toBe("9774d56d682e549c")
  expect(await DeviceInfo.getApiLevel()).toBe(34)
  expect(await DeviceInfo.supportedAbis()).toEqual(["arm64-v8a", "armeabi-v7a", "armeabi"])
  expect(await DeviceInfo.syncUniqueId()).toBe("9774d56d682e549c")
})

test("a list a caller changes doesn't change the next answer", () => {
  DeviceInfo.supportedAbisSync().push("x86")
  expect(DeviceInfo.supportedAbisSync()).toEqual(["arm64-v8a", "armeabi-v7a", "armeabi"])
})

test("an older app (no constants) answers react-native-device-info's 'don't know' values, never throws", () => {
  withConstants(undefined)
  expect(DeviceInfo.getBundleId()).toBe("unknown")
  expect(DeviceInfo.getApiLevelSync()).toBe(-1)
  expect(DeviceInfo.isTablet()).toBe(false)
  expect(DeviceInfo.supportedAbisSync()).toEqual([])
  expect(DeviceInfo.getSystemName()).toBe("Android")
  expect(nativeConstants("DeviceInfo")).toBeUndefined()
})

test("bad constants JSON reads as none", () => {
  globalThis.__zn_constants = "{not json"
  resetNativeConstantsForTests()
  Named.resetDeviceInfoForTests()
  expect(DeviceInfo.getVersion()).toBe("unknown")
})

test("nativeConstants gives each module its own object", () => {
  expect(nativeConstants<{ x: number }>("Other")).toEqual({ x: 1 })
})

test("changing values are calls; a failure or null answers the fallback", async () => {
  const level = DeviceInfo.getBatteryLevel()
  reply(last("batteryLevel").id, 0.42)
  expect(await level).toBe(0.42)

  const charging = DeviceInfo.isBatteryCharging()
  refuse(last("isBatteryCharging").id, "failed")
  expect(await charging).toBe(false)

  const disk = DeviceInfo.getFreeDiskStorage()
  reply(last("freeDiskStorage").id, null)
  expect(await disk).toBe(-1)

  const feature = DeviceInfo.hasSystemFeature("android.hardware.camera")
  expect(last("hasSystemFeature").args).toMatchObject({ feature: "android.hardware.camera" })
  reply(last("hasSystemFeature").id, true)
  expect(await feature).toBe(true)
})

test("values Android keeps from apps answer like react-native-device-info", async () => {
  expect(DeviceInfo.getMacAddressSync()).toBe("02:00:00:00:00:00")
  expect(await DeviceInfo.getSerialNumber()).toBe("unknown")
  expect(await DeviceInfo.getBrightness()).toBe(-1)
  expect(DeviceInfo.hasDynamicIsland()).toBe(false)
})
