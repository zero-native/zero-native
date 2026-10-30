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
