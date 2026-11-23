// tools/ios-ui-test.ts's choices that don't need a simulator: which simulator it runs on, and the per-test line it
// prints from xcodebuild's output. The UI tests themselves run only with `bun run ios:ui-test` (they need a simulator).
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pickDevice, simDevices, testLine } from "../ios-ui-test"

const root = join(import.meta.dir, "../..")

const json = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      { name: "iPhone 16", udid: "A", state: "Shutdown", isAvailable: true },
      { name: "zn g2 b", udid: "B", state: "Shutdown", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      { name: "iPad Air", udid: "C", state: "Shutdown", isAvailable: true },
      { name: "iPhone 17", udid: "D", state: "Booted", isAvailable: true },
      { name: "iPhone 16", udid: "E", state: "Shutdown", isAvailable: true },
      { name: "iPhone 15", udid: "F", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ name: "Watch", udid: "W", state: "Shutdown", isAvailable: true }],
  },
})

test("the simulator: a UDID, else a name on the newest iOS, else the newest iOS's first iPhone", () => {
  const all = simDevices(json)
  expect(all.map((d) => d.udid)).toEqual(["A", "B", "C", "D", "E", "W"])
  expect(pickDevice(all)?.udid).toBe("D")
  expect(pickDevice(all, "iPhone 16")?.udid).toBe("E")
  expect(pickDevice(all, "zn g2 b")?.udid).toBe("B")
  expect(pickDevice(all, "A")?.udid).toBe("A")
  expect(pickDevice(all, "iPhone 15")).toBeUndefined()
  expect(pickDevice(all, "Watch")).toBeUndefined()
})

test("one line per finished test", () => {
  expect(testLine("Test Case '-[ZnSampleUITests.ComponentsTests testSwitches]' passed (4.120 seconds).")).toBe(
    "passed  ComponentsTests/testSwitches  4.120 s",
  )
  expect(testLine("Test Case '-[ZnSampleUITests.A11yLabTests testFields]' failed (9.5 seconds).")).toBe(
    "failed  A11yLabTests/testFields  9.5 s",
  )
  expect(testLine("Test Case '-[ZnSampleUITests.A11yLabTests testFields]' started.")).toBeUndefined()
})

test("the shared scheme tests ZnSampleUITests without building it for a plain build", () => {
  const scheme = readFileSync(join(root, "ios/SamplePackage/ZnSamplePackage.xcodeproj/xcshareddata/xcschemes/ZnSamplePackage.xcscheme"), "utf8")
  const pbx = readFileSync(join(root, "ios/SamplePackage/ZnSamplePackage.xcodeproj/project.pbxproj"), "utf8")
  const uiTarget = /(\w{24}) \/\* ZnSampleUITests \*\/ = \{\s*isa = PBXNativeTarget;/.exec(pbx)?.[1]
  expect(uiTarget).toBeDefined()
  expect(pbx).toContain('productType = "com.apple.product-type.bundle.ui-testing";')
  const entry = new RegExp(`buildForRunning = "NO"[\\s\\S]*?BlueprintIdentifier = "${uiTarget}"`)
  expect(scheme).toMatch(entry)
  expect(scheme).toContain(`<TestableReference`)
})
