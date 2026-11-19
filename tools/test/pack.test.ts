import { expect, test } from "bun:test"
import { packProblems, publishable } from "../pack"

test("the packages we publish: all under @zeronative, one version, dependencies before what uses them", () => {
  const list = publishable()
  const names = list.map((p) => p.name)
  expect(names.length).toBe(25)
  expect(names.every((n) => n.startsWith("@zeronative/"))).toBe(true)
  expect(new Set(list.map((p) => p.version)).size).toBe(1)
  for (const kept of ["@zeronative/device-test", "@zeronative/updates-server", "@zeronative/example-sample"]) expect(names).not.toContain(kept)
  const at = (n: string) => names.indexOf(n)
  expect(at("@zeronative/core")).toBeLessThan(at("@zeronative/template"))
  expect(at("@zeronative/template")).toBeLessThan(at("@zeronative/compiler"))
  expect(at("@zeronative/notifications")).toBeLessThan(at("@zeronative/firebase-messaging"))
  expect(at("@zeronative/compiler")).toBeLessThan(at("@zeronative/cli"))
})

test("a packed package.json with a workspace range, a test file or a missing main is refused", () => {
  const ok = { main: "src/index.ts", dependencies: { "@zeronative/core": "0.1.0" } }
  const files = ["package.json", "LICENSE", "NOTICE", "src/index.ts"]
  expect(packProblems(ok, files)).toEqual([])
  expect(packProblems({ ...ok, peerDependencies: { "@zeronative/ui": "workspace:*" } }, files)).toEqual(['peerDependencies @zeronative/ui: "workspace:*"'])
  expect(packProblems(ok, [...files, "src/a.test.ts"])).toEqual(["a test file: src/a.test.ts"])
  expect(packProblems({ bin: { zn: "zn.ts" } }, files)).toEqual(["zn.ts is not in the package"])
  expect(packProblems(ok, ["package.json", "src/index.ts"])).toEqual(["no LICENSE", "no NOTICE"])
})
