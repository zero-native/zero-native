import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HOST_API_VERSION, NATIVE_ONLY_HOST_API } from "../src/host-api"

test("the JS host API version is the native one less its native-only steps (core/include/zn/engine.h kHostApiVersion)", () => {
  const header = readFileSync(join(import.meta.dir, "../../../core/include/zn/engine.h"), "utf8")
  const native = header.match(/kHostApiVersion = (\d+);/)
  expect(native).not.toBeNull()
  let js = Number(native![1])
  while (NATIVE_ONLY_HOST_API.includes(js)) js--
  expect(HOST_API_VERSION).toBe(js)
  // Never a number a bundle asks for.
  expect(NATIVE_ONLY_HOST_API).not.toContain(HOST_API_VERSION)
})

test("the Swift host API version for plugins is the JS one (ZnPlugins.hostApi, for requireHostApi)", () => {
  const swift = readFileSync(join(import.meta.dir, "../../../ios/ZnRuntime/Swift/ZnPlugins.swift"), "utf8")
  const version = swift.match(/public static let hostApi = (\d+)/)
  expect(version).not.toBeNull()
  expect(Number(version![1])).toBe(HOST_API_VERSION)
})

test("the Kotlin host API version for plugins is the JS one (ZnPlugins.HOST_API, for requireHostApi)", () => {
  const kotlin = readFileSync(join(import.meta.dir, "../../../android/runtime/src/main/java/dev/zeronative/runtime/ZnPlugins.kt"), "utf8")
  const version = kotlin.match(/const val HOST_API = (\d+)/)
  expect(version).not.toBeNull()
  expect(Number(version![1])).toBe(HOST_API_VERSION)
})
