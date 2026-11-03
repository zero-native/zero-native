import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installAbort } from "../src/abort"
import { AppEvent } from "../src/app-events"
import { colorScheme, onLowMemory, scheme } from "../src/appearance"
import { installCalls } from "../src/calls"
import { onError } from "../src/errors"
import { installEvents } from "../src/events"
import { resetNavForTests, startApp } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { defineTask, resetTasksForTests } from "../src/tasks"
import { installTimers } from "../src/timers"
import { view } from "../src/view"

let host: FakeHost
const Home = () => view(0, () => {})
const send = (event: number, payload: string | number | null) => globalThis.__zn_onEvent(0, event, payload)
const task = (id: string, name: string, data: unknown = null) => send(AppEvent.Task, JSON.stringify({ id, name, data }))
const later = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const answers = () => host.calls.filter((c) => c.module === "Tasks").map((c) => [c.method, c.args.id, c.args.outcome])

beforeEach(() => {
  resetNavForTests()
  resetTasksForTests()
  host = installFakeHost()
  installEvents()
  installCalls()
  installAbort()
  installTimers({ replaceGlobals: false })
  startApp(defineRoutes({ home: { path: "/", screen: Home } }))
})

test("a task gets its data and answers done", async () => {
  const seen: unknown[] = []
  defineTask("sync", async (data) => void seen.push(data))
  task("1", "sync", { n: 1 })
  await later()
  expect(seen).toEqual([{ n: 1 }])
  expect(answers()).toEqual([["done", "1", "done"]])
})

test("a task that throws or rejects answers failed, and the error is reported", async () => {
  const errors: unknown[] = []
  onError((e) => errors.push(String(e)))
  defineTask("a", () => {
    throw new Error("sync throw")
  })
  defineTask("b", async () => {
    throw new Error("async throw")
  })
  task("1", "a")
  task("2", "b")
  await later()
  expect(answers()).toEqual([["done", "1", "failed"], ["done", "2", "failed"]])
  expect(errors).toEqual(["Error: sync throw", "Error: async throw"])
})

test("an unknown task answers no_task", () => {
  task("1", "nope")
  expect(answers()).toEqual([["done", "1", "no_task"]])
})

test("the time limit aborts the signal", async () => {
  let signal: AbortSignal | null = null
  defineTask("slow", (_, s) => {
    signal = s
    return new Promise(() => {})
  })
  task("1", "slow")
  await later()
  expect(signal!.aborted).toBe(false)
  send(AppEvent.Task, JSON.stringify({ id: "1", abort: true }))
  expect(signal!.aborted).toBe(true)
})

test("a name defined twice is a mistake", () => {
  defineTask("x", () => {})
  expect(() => defineTask("x", () => {})).toThrow('task "x" is defined twice')
})

test("colorScheme follows native, and scheme() picks by it", () => {
  send(AppEvent.ColorScheme, "light")
  expect(colorScheme()).toBe("light")
  expect(scheme("a", "b")).toBe("a")
  send(AppEvent.ColorScheme, "dark")
  expect(colorScheme()).toBe("dark")
  expect(scheme("a", "b")).toBe("b")
})

test("onLowMemory: a listener that throws doesn't stop the next one", () => {
  const heard: number[] = []
  onLowMemory(() => {
    throw new Error("bad")
  })
  const off = onLowMemory(() => heard.push(1))
  send(AppEvent.LowMemory, null)
  expect(heard).toEqual([1])
  off()
  send(AppEvent.LowMemory, null)
  expect(heard).toEqual([1])
})
