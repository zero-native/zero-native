// A push asked for while a screen is being built goes on top of it, and one asked for while START builds the first
// screens goes on top of all of them, before NAV STARTED (native then opens it with no slide-in). ZeroBill: a payment
// restored after a kill opens checkout over Home at start (2026-11-07).
import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { AppEvent, nav, resetNavForTests, startApp } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { effect } from "../src/signals"
import { slot, view } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001
const PUSH = 1, STARTED = 8

let openFromBody: string | null = null
let openFromEffect: string | null = null
const Home = () => {
  if (openFromBody) nav.push(openFromBody as "checkout")
  effect(() => {
    if (openFromEffect) nav.push(openFromEffect as "checkout")
  })
  return view(0, (i) => slot(i, 0, () => "home"))
}
const Checkout = () => view(1, (i) => slot(i, 0, () => "checkout"))
const Offers = () => view(2, (i) => slot(i, 0, () => "offers"))
const routes = defineRoutes({
  home: { path: "/", screen: Home },
  checkout: { path: "/checkout", screen: Checkout },
  offers: { path: "/offers", screen: Offers },
})

const send = (event: number, payload: string) => globalThis.__zn_onEvent(0, event, payload)
const navOps = () => host.ops.filter((o) => o[0] === "nav").map((o) => [o[1], o[3]]) // [kind, route]

beforeEach(() => {
  resetNavForTests()
  host = installFakeHost()
  installEvents()
  openFromBody = null
  openFromEffect = null
  startApp(routes)
})

test("a push from the first screen's body at START: on top of it, before NAV STARTED", () => {
  openFromBody = "checkout"
  send(AppEvent.Start, JSON.stringify([{ entry: ROOT, route: 0, params: {} }]))
  expect(navOps()).toEqual([[PUSH, 1], [STARTED, 0]])
  expect(nav.current()?.name).toBe("checkout")
  expect(nav.depth()).toBe(2)
  // Home's patch comes first, then checkout's: the order JS and native both keep.
  expect(host.ops.filter((o) => o[0] === "patch").map((o) => o[3])).toEqual(["home", "checkout"])
  expect(nav.back()).toBe(true)
  expect(nav.current()?.name).toBe("home")
})

test("a push from an effect the first screen starts: same", () => {
  openFromEffect = "checkout"
  send(AppEvent.Start, JSON.stringify([{ entry: ROOT, route: 0, params: {} }]))
  expect(navOps()).toEqual([[PUSH, 1], [STARTED, 0]])
  expect(nav.current()?.name).toBe("checkout")
})

test("a restored stack of two: the push goes on top of both, not between them", () => {
  openFromBody = "checkout"
  send(AppEvent.Start, JSON.stringify([
    { entry: ROOT, route: 0, params: {} },
    { entry: ROOT + 1, route: 2, params: {} },
  ]))
  expect(navOps()).toEqual([[PUSH, 1], [STARTED, 0]])
  nav.back()
  expect(nav.current()?.name).toBe("offers")
})

test("after START, a push from a screen's body goes on top of that screen", () => {
  send(AppEvent.Start, JSON.stringify([{ entry: ROOT, route: 0, params: {} }]))
  host.ops.length = 0
  openFromBody = "checkout"
  nav.push("home")
  expect(navOps()).toEqual([[PUSH, 0], [PUSH, 1]])
  expect(nav.depth()).toBe(3)
  expect(nav.current()?.name).toBe("checkout")
  nav.back()
  expect(nav.current()?.name).toBe("home")
})

test("no push asked: START is as before", () => {
  send(AppEvent.Start, JSON.stringify([{ entry: ROOT, route: 0, params: {} }]))
  expect(navOps()).toEqual([[STARTED, 0]])
})
