import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { KOTLIN_REGISTRY_PATH, kotlinRegistry } from "../../../tools/gen-registry"
import { Prop } from "../src/registry"

test("the Kotlin registry is generated from the TS registry (run `bun run gen:registry` if this fails)", () => {
  expect(existsSync(KOTLIN_REGISTRY_PATH)).toBe(true)
  expect(readFileSync(KOTLIN_REGISTRY_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(kotlinRegistry())
})

test("prop ids are unique", () => {
  const ids = Object.values(Prop).map((p) => p.id)
  expect(new Set(ids).size).toBe(ids.length)
})
