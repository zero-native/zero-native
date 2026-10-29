import { expect, test } from "bun:test"
import { batch, computed, createRoot, effect, onCleanup, signal, untrack } from "../src/signals"

test("effect runs now and when a read signal changes", () => {
  const a = signal(1)
  const seen: number[] = []
  effect(() => seen.push(a()))
  a.set(2)
  a.set(2) // equal value: nothing
  expect(seen).toEqual([1, 2])
})

test("diamond: an effect sees consistent values and runs once per change", () => {
  const a = signal(1)
  const double = computed(() => a() * 2)
  const triple = computed(() => a() * 3)
  const seen: string[] = []
  effect(() => seen.push(`${double()}-${triple()}`))
  a.set(2)
  expect(seen).toEqual(["2-3", "4-6"])
})

test("a computed whose value didn't change stops the update", () => {
  const n = signal(1)
  const isOdd = computed(() => n() % 2 === 1)
  let runs = 0
  effect(() => {
    isOdd()
    runs++
  })
  n.set(3) // still odd
  expect(runs).toBe(1)
  n.set(4)
  expect(runs).toBe(2)
})

test("computeds are lazy and cached", () => {
  const a = signal(1)
  let evals = 0
  const c = computed(() => (evals++, a() + 1))
  expect(evals).toBe(0)
  expect(c()).toBe(2)
  expect(c()).toBe(2)
  expect(evals).toBe(1)
  a.set(5)
  expect(c()).toBe(6)
  expect(evals).toBe(2)
})

test("batch runs effects once at the end", () => {
  const a = signal(1)
  const b = signal(1)
  const seen: number[] = []
  effect(() => seen.push(a() + b()))
  batch(() => {
    a.set(2)
    b.set(3)
  })
  expect(seen).toEqual([2, 5])
})

test("untrack and peek don't subscribe", () => {
  const a = signal(1)
  const b = signal(1)
  let runs = 0
  effect(() => {
    a()
    untrack(() => b())
    b.peek()
    runs++
  })
  b.set(2)
  expect(runs).toBe(1)
  a.set(2)
  expect(runs).toBe(2)
})

test("dynamic dependencies: a branch no longer read stops triggering", () => {
  const useA = signal(true)
  const a = signal(1)
  const b = signal(1)
  let runs = 0
  effect(() => {
    runs++
    useA() ? a() : b()
  })
  useA.set(false)
  a.set(2) // no longer read
  expect(runs).toBe(2)
  b.set(2)
  expect(runs).toBe(3)
})

test("child effects and cleanups are disposed when the owner re-runs", () => {
  const outer = signal(1)
  const inner = signal(1)
  const log: string[] = []
  effect(() => {
    const o = outer()
    effect(() => log.push(`inner ${o}/${inner()}`))
    onCleanup(() => log.push(`cleanup ${o}`))
  })
  outer.set(2)
  inner.set(5) // only the new child runs
  expect(log).toEqual(["inner 1/1", "cleanup 1", "inner 2/1", "inner 2/5"])
})

test("createRoot dispose stops everything inside", () => {
  const a = signal(1)
  const seen: number[] = []
  let cleaned = false
  const dispose = createRoot((d) => {
    effect(() => seen.push(a()))
    onCleanup(() => (cleaned = true))
    return d
  })
  dispose()
  a.set(2)
  expect(seen).toEqual([1])
  expect(cleaned).toBe(true)
})

test("an effect that throws doesn't break other effects", () => {
  ;(globalThis as any).__zn_log = () => {}
  const a = signal(1)
  const seen: number[] = []
  effect(() => {
    if (a() === 2) throw new Error("boom")
  })
  effect(() => seen.push(a()))
  a.set(2)
  a.set(3)
  expect(seen).toEqual([1, 2, 3])
})

test("an effect writing a signal is handled in the same flush", () => {
  const a = signal(1)
  const b = signal(0)
  const seen: number[] = []
  effect(() => b.set(a() * 10))
  effect(() => seen.push(b()))
  a.set(2)
  expect(seen).toEqual([10, 20])
})
