import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { flowStore } from "../src/flowstore"

let host: FakeHost
beforeEach(() => {
  host = installFakeHost()
})

test("write, read, list, remove as JSON", () => {
  expect(flowStore.read("flow-checkout")).toEqual({ status: "missing" })
  expect(flowStore.write("flow-checkout", { step: "paying", amountPaise: 40000 })).toBe(true)
  expect(host.store.get("flow-checkout")).toBe('{"step":"paying","amountPaise":40000}')
  expect(flowStore.read("flow-checkout")).toEqual({ status: "ok", value: { step: "paying", amountPaise: 40000 } })
  expect(flowStore.list()).toEqual(["flow-checkout"])
  expect(flowStore.remove("flow-checkout")).toBe(true)
  expect(flowStore.read("flow-checkout")).toEqual({ status: "missing" })
})

test("a damaged file (both copies) or unreadable JSON reads as broken", () => {
  host.broken.add("nav")
  expect(flowStore.read("nav")).toEqual({ status: "broken" })
  host.store.set("x", "{not json")
  expect(flowStore.read("x")).toEqual({ status: "broken" })
})
