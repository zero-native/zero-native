import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { installFakeHost } from "./fake-host"
import { AppEvent } from "../src/app-events"
import { callNative, installCalls } from "../src/calls"
import { installEvents, resetEventsForTests } from "../src/events"
import { resetNavForTests, startApp } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { view } from "../src/view"

test("every app event has its own number", () => {
  const numbers = Object.values(AppEvent)
  expect(new Set(numbers).size).toBe(numbers.length)
})

test("Kotlin's ZnAppEvent uses the same numbers", () => {
  const kt = readFileSync(join(import.meta.dir, "../../../android/runtime/src/main/java/dev/zeronative/runtime/ZnAppEvent.kt"), "utf8")
  const kotlin = Object.fromEntries([...kt.matchAll(/const val ([A-Z_]+) = (\d+)/g)].map((m) => [m[1], Number(m[2])]))
  const upper = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
  for (const [name, n] of Object.entries(AppEvent)) expect(`${name}=${kotlin[upper(name)]}`).toBe(`${name}=${n}`)
  expect(Object.keys(kotlin).filter((k) => k !== "APP").length).toBe(Object.keys(AppEvent).length)
})

test("native calls still settle after startApp (step 3.9 gave RETRY the call-answer number and broke them)", async () => {
  const host = installFakeHost()
  resetEventsForTests()  // only this test's handlers: other files' startApp left theirs (a false "already has a handler")
  installEvents()
  installCalls()
  resetNavForTests()
  startApp(defineRoutes({ home: { path: "/", screen: () => view(0, () => {}) } }))
  const answer = callNative<string>("Device", "info", {})
  const id = host.calls.at(-1)!.id
  globalThis.__zn_onEvent(0, AppEvent.CallResult, JSON.stringify({ id, ok: true, value: "Lava" }))
  expect(await answer).toBe("Lava")
  expect(host.logs.filter(([, m]) => m.includes("already has a handler"))).toEqual([])
})
