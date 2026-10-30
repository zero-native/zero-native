import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { installCalls } from "../src/calls"
import { createStorage, persistedSignal, storage } from "../src/storage"
import { SecureStore } from "../src/secure-store"
import { createRoot } from "../src/signals"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("values come back with the type they were saved with", () => {
  storage.set("name", "चाय ☕")
  storage.set("count", 3)
  storage.set("onboarded", true)
  storage.set("blob", new Uint8Array([9, 9, 1, 2, 3]).subarray(2))
  expect(storage.get("name")).toBe("चाय ☕")
  expect(storage.getNumber("count")).toBe(3)
  expect(storage.getBoolean("onboarded")).toBe(true)
  expect([...storage.getBytes("blob")!]).toEqual([1, 2, 3])
  expect(storage.get("missing")).toBeUndefined()
  expect(storage.getString("missing")).toBeUndefined()
  expect(host.kv.get("zn.default")!.get("count")).toBe(3)
})

test("a typed getter on another type is a TypeError, never a wrong value", () => {
  storage.set("count", 3)
  expect(() => storage.getString("count")).toThrow('holds a number, not a string')
  storage.set("blob", new Uint8Array([1]))
  expect(() => storage.getNumber("blob")).toThrow("holds bytes, not a number")
  expect(() => storage.getBytes("count")).toThrow("not bytes")
})

test("bad values and keys fail clearly", () => {
  expect(() => storage.set("x", null as any)).toThrow("Use delete()")
  expect(() => storage.set("x", { a: 1 } as any)).toThrow("JSON.stringify")
  expect(() => storage.set("", "v")).toThrow("non-empty")
  expect(() => createStorage("../evil")).toThrow("1-64 characters")
})

test("a failed save throws and doesn't notify", () => {
  globalThis.__zn_kv_set = () => false
  const seen: Array<string | null> = []
  storage.onChange((k) => seen.push(k))
  expect(() => storage.set("k", "v")).toThrow("could not save")
  expect(seen).toEqual([])
})

test("stores are separate; keys, delete and clear; same id gives the same object", () => {
  const user = createStorage("user.42")
  expect(createStorage("user.42")).toBe(user)
  user.set("a", 1)
  user.set("b", 2)
  storage.set("a", "default")
  expect(user.keys().sort()).toEqual(["a", "b"])
  user.delete("a")
  expect(user.has("a")).toBe(false)
  user.clear()
  expect(user.keys()).toEqual([])
  expect(storage.get("a")).toBe("default")
})

test("onChange reports keys; it ends when the screen closes", () => {
  const user = createStorage("user.7")
  const seen: Array<string | null> = []
  const dispose = createRoot((d) => {
    user.onChange((k) => seen.push(k))
    return d
  })
  user.set("a", 1)
  user.delete("a")
  user.clear()
  dispose()
  user.set("b", 2)
  expect(seen).toEqual(["a", "a", null])
})

test("persistedSignal starts from the saved value and saves every set", () => {
  const prefs = createStorage("prefs.test")
  const lang = persistedSignal("lang", "en", { storage: prefs })
  expect(lang()).toBe("en")
  lang.set("kn")
  expect(prefs.getString("lang")).toBe('"kn"')
  // A new signal (e.g. after the app restarts) starts from what was saved.
  const again = persistedSignal("lang", "en", { storage: prefs })
  expect(again()).toBe("kn")
  const draft = persistedSignal<{ amount: number } | undefined>("draft", undefined, { storage: prefs })
  draft.set({ amount: 1250 })
  expect(prefs.getString("draft")).toBe('{"amount":1250}')
  draft.set(undefined)
  expect(prefs.has("draft")).toBe(false)
  prefs.set("broken", "{nope")
  expect(persistedSignal("broken", 1, { storage: prefs })()).toBe(1)
  expect(host.logs.some(([l, m]) => l === 2 && m.includes("not JSON"))).toBe(true)
})

test("SecureStore calls native, isn't tied to the screen, and maps missing to null", async () => {
  let p!: Promise<string | null>
  const dispose = createRoot((d) => {
    p = SecureStore.get("token")
    return d
  })
  dispose()
  const c = host.calls[0]!
  expect(c).toMatchObject({ module: "SecureStore", method: "get", args: { key: "token", __v: 1 } })
  expect(host.cancelled).toEqual([])
  globalThis.__zn_onEvent(0, 7, JSON.stringify({ id: c.id, ok: true, value: null }))
  expect(await p).toBeNull()
  await expect(SecureStore.set("token", 5 as any)).rejects.toThrow("must be a string")
  await expect(SecureStore.get("")).rejects.toThrow("non-empty")
})
