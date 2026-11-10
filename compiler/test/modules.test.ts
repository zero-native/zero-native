import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { nativeModuleUses, platformsOf } from "../src/modules"
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

describe("per-OS needs (docs/ota-requires-per-os.md)", () => {
  test("buildApp puts a one-OS plugin's modules under requires.os", async () => {
    const app = await buildApp(join(import.meta.dir, "fixtures/per-os/main.ts"))
    expect(app.requires.modules.Pay).toBe(1) // the app's own call: both OSes
    expect(app.requires.modules.Share).toBe(2) // a plugin for both
    expect(app.requires.modules.AdId).toBeUndefined()
    expect(app.requires.os).toEqual({ android: { AdId: 2 }, ios: { Haptics: 2 } })
  })

  test("buildApp says which package each needed module comes from (moduleFrom, for the dashboard)", async () => {
    const app = await buildApp(join(import.meta.dir, "fixtures/per-os/main.ts"))
    expect(app.moduleFrom.AdId).toBe("per-os-droid")
    expect(app.moduleFrom.Haptics).toBe("per-os-apple")
    expect(app.moduleFrom.Share).toBe("per-os-both")
    expect(app.moduleFrom.Pay).toBe("@zero-native/compiler") // the app's own call: the nearest package.json (here the compiler's)
    // Core's own modules say core; every needed module has an entry
    const needed = [...Object.keys(app.requires.modules), ...Object.values(app.requires.os ?? {}).flatMap((m) => Object.keys(m))]
    expect(Object.keys(app.moduleFrom).sort()).toEqual(needed.sort())
    expect(Object.entries(app.moduleFrom).filter(([, p]) => p === "@zero-native/core").length).toBeGreaterThan(0)
  })

  test("a plugin's platforms: zeroNative.platforms, else its folders; anything else is both", () => {
    const root = mkdtempSync(join(tmpdir(), "zn-platforms-"))
    try {
      const pkg = (name: string, zeroNative?: object, folders: string[] = []) => {
        const dir = join(root, name)
        mkdirSync(join(dir, "src"), { recursive: true })
        for (const f of folders) mkdirSync(join(dir, f))
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...(zeroNative ? { zeroNative } : {}) }))
        return join(dir, "src", "index.ts")
      }
      const sorted = (s: ReadonlySet<string>) => [...s].sort()
      expect(sorted(platformsOf(pkg("droid", { android: { plugin: "x" } })))).toEqual(["android"])
      expect(sorted(platformsOf(pkg("folders", {}, ["android", "ios"])))).toEqual(["android", "ios"])
      expect(sorted(platformsOf(pkg("apple", {}, ["ios"])))).toEqual(["ios"])
      // Written platforms win over folders (a plugin meant for both, not built on iOS yet)
      expect(sorted(platformsOf(pkg("planned", { platforms: ["android", "ios"] }, ["android"])))).toEqual(["android", "ios"])
      expect(sorted(platformsOf(pkg("lib")))).toEqual(["android", "ios"]) // not a plugin
      expect(sorted(platformsOf(pkg("bare", {})))).toEqual(["android", "ios"]) // a plugin with no native side yet
      expect(() => platformsOf(pkg("bad", { platforms: ["web"] }))).toThrow("zeroNative.platforms")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
