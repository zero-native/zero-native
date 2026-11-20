import { expect, test } from "bun:test"
import { hermesPins, releaseProblems, type HermesPins } from "../check-release"

const pins: HermesPins = {
  fetchScript: "260318099.0.5",
  rootCompiler: "260318099.0.5",
  cliCompiler: "260318099.0.5",
  android: "260318099.0.5",
  packageSwift: "260318099.0.5",
  packageSwiftChecksum: "a".repeat(64),
}
const pkgs = [
  { name: "@zeronative/core", version: "0.1.0", dir: "packages/core" },
  { name: "@zeronative/cli", version: "0.1.0", dir: "tools" },
]

test("ready when every package has the version and Hermes is one release everywhere", () => {
  expect(releaseProblems("0.1.0", pkgs, pins)).toEqual([])
})

test("a package at another version, a Hermes mismatch, zeros for the checksum and a bad version are each named", () => {
  expect(releaseProblems("0.2.0", pkgs, pins)).toEqual([
    "@zeronative/core (packages/core/package.json) is 0.1.0, not 0.2.0",
    "@zeronative/cli (tools/package.json) is 0.1.0, not 0.2.0",
  ])
  expect(releaseProblems("0.1.0", pkgs, { ...pins, android: "260318099.0.8" })[0]).toMatch(/^Hermes differs: .*hermes-android = 260318099\.0\.8/)
  expect(releaseProblems("0.1.0", pkgs, { ...pins, packageSwiftChecksum: "0".repeat(64) })).toEqual([
    "Package.swift has no real Hermes checksum: run the Hermes release first (docs/releasing.md)",
  ])
  expect(releaseProblems("v0.1", pkgs, pins)[0]).toMatch(/like 0\.1\.0/)
})

test("the repo's own Hermes pins agree today", () => {
  const p = hermesPins()
  expect(new Set([p.fetchScript, p.rootCompiler, p.cliCompiler, p.android, p.packageSwift]).size).toBe(1)
  expect(p.packageSwiftChecksum).toMatch(/^[0-9a-f]{64}$/)
})
