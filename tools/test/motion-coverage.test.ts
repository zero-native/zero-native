// The Motion module's method coverage (motion-ota-gate, 2026-11-24): iOS registers "Motion" v1 as Android does, so a
// bundle that uses motion is sent to both. If iOS lacked a function Android has, that call would answer "unavailable"
// there and nothing would move. So this test lists every function Android's Motion module registers (ZnMotion.kt, the
// gestures' addFunction, plugins' additions), every method core's motion.ts sends, and every motion driver a plugin
// registers on Android, and fails when iOS lacks one. Read from the source: no build needed.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dir, "../..")

/** Every file under [dir] (repo path) whose name ends in [ext], skipping tests and build folders. */
function files(dir: string, ext: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      if (n === "build" || n === "node_modules" || n === "test" || n === "tests" || n === "androidTest" || n.startsWith(".")) continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith(ext)) out.push(p)
    }
  }
  walk(join(ROOT, dir))
  return out
}

/** Plugin folders' [os] sources (plugins/<name>/<os>). */
function pluginFiles(os: "android" | "ios", ext: string): string[] {
  return readdirSync(join(ROOT, "plugins")).flatMap((p) => files(`plugins/${p}/${os}`, ext))
}

function names(paths: string[], pattern: RegExp): Map<string, string> {
  const found = new Map<string, string>()
  for (const p of paths) {
    for (const m of readFileSync(p, "utf8").matchAll(pattern)) if (!found.has(m[1]!)) found.set(m[1]!, relative(ROOT, p))
  }
  return found
}

const ANDROID_RT = "android/runtime/src/main/java/dev/zeronative/runtime"
const androidKt = [...files(ANDROID_RT, ".kt"), ...pluginFiles("android", ".kt")]
const iosSwift = [...files("ios/ZnRuntime/Swift", ".swift"), ...files("ios/Sample", ".swift"), ...pluginFiles("ios", ".swift")]

// Android: the module's own functions (only ZnMotion.kt's object is "Motion") and what others add through addFunction.
const androidFns = new Map([
  ...names([join(ROOT, ANDROID_RT, "ZnMotion.kt")], /\bfunction\("(\w+)"/g),
  ...names(androidKt, /\baddFunction\("(\w+)"/g),
])
// iOS: the same two ways (ZnMotionModule.swift and ZnGestures.install).
const iosFns = new Map([
  ...names([join(ROOT, "ios/ZnRuntime/Swift/ZnMotionModule.swift")], /\bfunction\("(\w+)"/g),
  ...names(iosSwift, /\baddFunction\("(\w+)"/g),
])

test("Android's Motion module and iOS's register the same functions", () => {
  // Sanity: the patterns still find the module (20 functions on 2026-11-24), so a rename can't pass by finding none.
  expect(androidFns.size).toBeGreaterThanOrEqual(20)
  expect(iosFns.size).toBeGreaterThanOrEqual(20)
  const lacking = [...androidFns].filter(([n]) => !iosFns.has(n)).map(([n, where]) => `${n} (Android: ${where})`)
  expect(lacking).toEqual([])
  // And the other way: a function only iOS has is a sign Android lost one (or iOS made one up).
  const extra = [...iosFns].filter(([n]) => !androidFns.has(n)).map(([n, where]) => `${n} (iOS: ${where})`)
  expect(extra).toEqual([])
})

test("every method core's motion.ts (and any plugin's JS) calls exists on both", () => {
  const motionTs = readFileSync(join(ROOT, "packages/core/src/motion.ts"), "utf8")
  const sent = new Set([...motionTs.matchAll(/\b(?:send|ask(?:<.*?>)?|command)\("(\w+)"/g)].map((m) => m[1]!))
  // A plugin's own JS calling the Motion module directly.
  for (const p of readdirSync(join(ROOT, "plugins"))) {
    for (const f of files(`plugins/${p}/src`, ".ts").concat(files(`plugins/${p}/src`, ".tsx"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/callNative(?:<.*?>)?\(\s*"Motion"\s*,\s*"(\w+)"/g)) sent.add(m[1]!)
    }
  }
  expect(sent.size).toBeGreaterThanOrEqual(20)
  expect([...sent].filter((n) => !androidFns.has(n)).map((n) => `${n} (Android)`)).toEqual([])
  expect([...sent].filter((n) => !iosFns.has(n)).map((n) => `${n} (iOS)`)).toEqual([])
})

test("every motion driver a plugin registers on Android is registered on iOS too", () => {
  const driver = /\bregisterDriver\("([\w.]+)"/g
  const android = names(androidKt, driver)
  const ios = names(iosSwift, driver)
  expect(android.size).toBeGreaterThanOrEqual(1) // device-test's device.wobble
  expect([...android].filter(([n]) => !ios.has(n)).map(([n, where]) => `${n} (Android: ${where})`)).toEqual([])
})
