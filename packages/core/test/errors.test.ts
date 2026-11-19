import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installRejectionTracking, onError, reportError, type ErrorInfo } from "../src/errors"
import { resetNavForTests } from "../src/nav"

let host: FakeHost
beforeEach(() => {
  host = installFakeHost()
  resetNavForTests()  // no screen on top: another file's startApp may have left one (errors carry the top screen)
})

test("onError hears every reported error; an error in a handler is only logged; off() stops it", () => {
  const heard: Array<[unknown, ErrorInfo]> = []
  const off = onError((e, info) => heard.push([e, info]))
  const offBad = onError(() => {
    throw new Error("handler bug")
  })
  const boom = new Error("boom")
  reportError("timer callback", boom)
  reportError(`screen "amount"`, boom, "screen", "amount")
  expect(heard).toEqual([
    [boom, { kind: "handler", where: "timer callback", screen: null }],
    [boom, { kind: "screen", where: `screen "amount"`, screen: "amount" }],
  ])
  expect(host.logs.filter(([, m]) => m.includes("onError handler threw")).length).toBe(2)
  off()
  offBad()
  reportError("timer callback", boom)
  expect(heard.length).toBe(2)
})

test("Hermes' rejection tracker is switched on and reports unhandled rejections as async errors", () => {
  let options: { allRejections: boolean; onUnhandled: (id: number, e: unknown) => void } | null = null
  ;(globalThis as Record<string, unknown>).HermesInternal = { enablePromiseRejectionTracker: (o: typeof options) => (options = o) }
  try {
    installRejectionTracking()
    expect(options!.allRejections).toBe(true)
    const heard: ErrorInfo[] = []
    const off = onError((_, info) => heard.push(info))
    options!.onUnhandled(1, new TypeError("x is undefined"))
    off()
    expect(heard).toEqual([{ kind: "async", where: "an async task (a Promise nobody caught)", screen: null }])
    expect(host.logs.some(([, m]) => m.includes("a Promise nobody caught") && m.includes("x is undefined"))).toBe(true)
  } finally {
    delete (globalThis as Record<string, unknown>).HermesInternal
  }
})
