import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { nativeModuleUses } from "../src/modules"
import { buildApp } from "../src/build-app"
import { HOST_API_VERSION } from "@zero-native/core/src/host-api"

describe("native modules a bundle needs (docs/ota.md §3.2)", () => {
  test("nativeModule and callNative with literal names and versions", () => {
    const uses = nativeModuleUses(
      `export const Device = nativeModule<DeviceModule>("Device", { version: 3 })
       export const Pay = nativeModule("Pay")
       callNative<T>("SecureStore", "get", { key, __v: 2 }, { owned: false })
       callNative("Fetch", "send", args)`,
      "app.ts",
    )
    expect(uses).toEqual([
      { name: "Device", version: 3 },
      { name: "Pay", version: 1 },
      { name: "SecureStore", version: 2 },
      { name: "Fetch", version: 1 },
    ])
  })

  test("a module name in a variable is a build error (the build couldn't list it)", () => {
    expect(() => nativeModuleUses(`const n = "Device"; nativeModule(n)`, "app.ts")).toThrow("must be a string literal")
    expect(() => nativeModuleUses(`callNative(name, "x", {})`, "screen.tsx")).toThrow("must be a string literal")
  })

  test("a version that isn't a number literal is a build error", () => {
    expect(() => nativeModuleUses(`nativeModule("Device", { version: V })`, "app.ts")).toThrow("number literal")
  })

  test("core's own calls.ts may use a variable (it implements nativeModule)", () => {
    expect(nativeModuleUses(`callNative(name, prop, { ...args, __v: version })`, "/x/packages/core/src/calls.ts")).toEqual([])
  })

  test("buildApp lists what the bundle needs", async () => {
    const app = await buildApp(join(import.meta.dir, "fixtures/order/main.ts"))
    expect(app.requires.registry).toBe(8)
    expect(app.requires.hostApi).toBe(HOST_API_VERSION)
    // The fixture pulls in @zero-native/core's storage and keyboard code (via the compiler's runtime import).
    expect(app.requires.modules.Keyboard).toBe(2) // v2: focus / blur / clear of a TextField ref
    // B4 (2026-11-08): core's own WebSocket and Splash calls are soft, so an older APK still takes this bundle.
    expect(app.requires.modules.WebSocket).toBeUndefined()
    expect(app.requires.modules.Splash).toBeUndefined()
  })

  test("soft core modules count only when the app calls them itself (B4)", () => {
    const call = `callNative("WebSocket", "connect", { id, url })`
    expect(nativeModuleUses(call, "C:\\work\\zero-native\\packages\\core\\src\\websocket.ts")).toEqual([])
    expect(nativeModuleUses(call, "/app/node_modules/@zero-native/core/src/websocket.ts")).toEqual([])
    expect(nativeModuleUses(call, "/app/src/chat.ts")).toEqual([{ name: "WebSocket", version: 1 }])
    // Any other core module still counts.
    expect(nativeModuleUses(`callNative("Toast", "show", {})`, "/x/packages/core/src/toast.ts")).toEqual([{ name: "Toast", version: 1 }])
  })
})
