// The dashboard's "can run" view (familiesView): the Motion row for iOS apps below host API 10 (docs/ota.md §3.2).
import { expect, test } from "bun:test"
import { familiesView } from "../src/model"

type Builds = Parameters<typeof familiesView>[0]
type Bundles = Parameters<typeof familiesView>[1]

const motion = { registry: 24, bytecode: 99, hostApi: 9, modules: { Fetch: 1, Motion: 1 } }
const bundles = [{ id: "shop_11", manifest: { requires: motion } }] as unknown as Bundles
const caps = { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1, Motion: 1 } }
const build = (os: "android" | "ios", c: object) => ({ os, family: "f", capabilities: c, label: os, channel: "production", versionCode: 1, versionName: "1.0", builtinSerial: 10 })

test("an iOS family below host API 10 can't run a motion bundle, also when its capabilities have no os", () => {
  const why = (b: unknown[]) => familiesView(b as unknown as Builds, bundles)[0]!.canRun.shop_11
  expect(why([build("ios", { ...caps, os: "ios" })])).toMatch(/Motion stub/)
  expect(why([build("ios", caps)])).toMatch(/Motion stub/) // learned from a build that sent store.os only
  expect(why([build("android", caps)])).toBeNull()
  expect(why([build("ios", { ...caps, os: "ios", hostApi: 10 })])).toBeNull()
})
