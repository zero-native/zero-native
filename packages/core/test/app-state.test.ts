import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost } from "./fake-host"
import { appState, onAppState, resetAppStateForTests, type AppState } from "../src/app-state"
import { onError } from "../src/errors"
import { installEvents } from "../src/events"
import { AppEvent, resetNavForTests, startApp } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { createRoot } from "../src/signals"
import { view } from "../src/view"

let heard: AppState[]
const NATIVE_ROOT = 0x80000001
const routes = defineRoutes({ home: { path: "/", screen: () => view(0, () => {}) } })

const send = (event: number, payload: string) => globalThis.__zn_onEvent(0, event, payload)
const state = (s: string) => send(AppEvent.AppState, s)
const start = () => send(AppEvent.Start, JSON.stringify([{ entry: NATIVE_ROOT, route: 0, params: {} }]))

beforeEach(() => {
  resetNavForTests()
  resetAppStateForTests()
  installFakeHost()
  installEvents()
  heard = []
  startApp(routes)
})

afterEach(() => resetNavForTests()) // the top screen shows in error reports of other test files

test("the app is in the background until screens open, and the start is no change to report", () => {
  onAppState((s) => heard.push(s))
  expect(appState()).toBe("background")
  start()
  expect(appState()).toBe("active")
  state("active") // the Activity resumes after START
  expect(heard).toEqual([])
})

test("listeners hear each change once", () => {
  start()
  onAppState((s) => heard.push(s))
  state("background")
  state("background")
  state("active")
  expect(heard).toEqual(["background", "active"])
  expect(appState()).toBe("active")
})

test("the function it returns stops the listener", () => {
  start()
  const off = onAppState((s) => heard.push(s))
  off()
  state("background")
  expect(heard).toEqual([])
})

test("a listener set on a screen stops when the screen closes", () => {
  start()
  const close = createRoot((dispose) => {
    onAppState((s) => heard.push(s)) // stands in for a screen: its owner ends when it closes
    return dispose
  })
  state("background")
  close()
  state("active")
  expect(heard).toEqual(["background"])
})

test("a listener that throws is reported, and the others still run", () => {
  start()
  const errors: unknown[] = []
  const stop = onError((e) => errors.push(e))
  onAppState(() => {
    throw new Error("boom")
  })
  onAppState((s) => heard.push(s))
  state("background")
  stop()
  expect(errors.length).toBe(1)
  expect(heard).toEqual(["background"])
})
