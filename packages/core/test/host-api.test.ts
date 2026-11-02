import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { HOST_API_VERSION } from "../src/host-api"

test("the JS host API version is the native one (core/include/zn/engine.h kHostApiVersion)", () => {
  const header = readFileSync(join(import.meta.dir, "../../../core/include/zn/engine.h"), "utf8")
  const native = header.match(/kHostApiVersion = (\d+);/)
  expect(native).not.toBeNull()
  expect(HOST_API_VERSION).toBe(Number(native![1]))
})

test("the Kotlin host API version is the native one (ZnPlugins.HOST_API, for requireHostApi)", () => {
  const kotlin = readFileSync(join(import.meta.dir, "../../../android/runtime/src/main/java/dev/zeronative/runtime/ZnPlugins.kt"), "utf8")
  const version = kotlin.match(/const val HOST_API = (\d+)/)
  expect(version).not.toBeNull()
  expect(Number(version![1])).toBe(HOST_API_VERSION)
})
