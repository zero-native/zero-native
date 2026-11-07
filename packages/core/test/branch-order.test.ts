// A branch's guard runs before the branch's own parts (ask from the ZeroBill payment pass, 2026-11-07). One update
// that turns `cond && <X/>` off and also changes what X reads must remove X first, as React does (top-down): X's
// slots never run with the value its guard just ruled out.
import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { onError } from "../src/errors"
import { batch, signal } from "../src/signals"
import { each, insert, renderRoot, slot, view, when } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001

beforeEach(() => {
  host = installFakeHost()
  installEvents()
})

test("one update that closes a branch and nulls what it reads: the branch goes first, its slots don't run", () => {
  const errors: string[] = []
  const stop = onError((e) => errors.push(String(e.message ?? e)))
  // The checkout shape: the body reads sessionData first, then the transaction its guard checks.
  const session = signal<{ merchant?: { name: string } } | null>({ merchant: { name: "Ravi" } })
  const txn = signal<{ merchant: { name: string } } | null>({ merchant: { name: "Ravi" } })
  const close = renderRoot(ROOT, () =>
    view(0, (i) =>
      when(i, 1, () => txn() !== null, () => view(1, (b) => slot(b, 0, () => session()?.merchant?.name || txn()!.merchant.name))),
    ),
  undefined)
  const body = host.ops.filter((o) => o[0] === "mount").at(-1)![4] as number

  batch(() => {
    session.set(null) // the store's set writes the fields in this order
    txn.set(null)
  })

  expect(errors).toEqual([])
  expect(host.ops.some((o) => o[0] === "remove" && o[1] === body)).toBe(true)
  stop()
  close()
})

// `noise` is read only by the part's slot, and set first, so the slot is queued before its guard (the bad order).
function catchErrors() {
  const errors: string[] = []
  const stop = onError((e) => errors.push(String(e.message ?? e)))
  return { errors, stop }
}

test("{props.x} (insert): a part that goes away doesn't update first", () => {
  const { errors, stop } = catchErrors()
  const noise = signal(0)
  const txn = signal<{ m: string } | null>({ m: "a" })
  const close = renderRoot(ROOT, () =>
    view(0, (i) => insert(i, 1, () => (txn() ? () => view(1, (b) => slot(b, 0, () => `${noise()} ${txn()!.m}`)) : null))),
  undefined)
  batch(() => {
    noise.set(1)
    txn.set(null)
  })
  expect(errors).toEqual([])
  stop()
  close()
})

test("each: a row whose item is gone is removed before its slot reads the gone item", () => {
  const { errors, stop } = catchErrors()
  const noise = signal(0)
  const ids = signal(["a", "b"])
  const names = signal<Record<string, { name: string }>>({ a: { name: "A" }, b: { name: "B" } })
  const close = renderRoot(ROOT, () =>
    view(0, (i) =>
      each(i, 1, () => ids(), (id) => id, (id) => view(1, (b) => slot(b, 0, () => `${noise()} ${names()[id]!.name}`))),
    ),
  undefined)
  batch(() => {
    noise.set(1)
    names.set({ a: { name: "A" } })
    ids.set(["a"])
  })
  expect(errors).toEqual([])
  expect(host.ops.filter((o) => o[0] === "patch").at(-1)?.[3]).toBe("1 A") // the kept row still updated
  stop()
  close()
})

test("a branch inside a branch: the outer one decides first", () => {
  const { errors, stop } = catchErrors()
  const noise = signal(0)
  const user = signal<{ name: string } | null>({ name: "Ravi" })
  const close = renderRoot(ROOT, () =>
    view(0, (i) =>
      when(i, 1, () => user() !== null, () =>
        view(1, (b) =>
          when(b, 1, () => noise() >= 0, () => view(2, (c) => slot(c, 0, () => `${noise()} ${user()!.name}`))),
        ),
      ),
    ),
  undefined)
  batch(() => {
    noise.set(1)
    user.set(null)
  })
  expect(errors).toEqual([])
  stop()
  close()
})

test("a branch that stays open still updates its parts, once", () => {
  const txn = signal<{ m: string } | null>({ m: "a" })
  let runs = 0
  const close = renderRoot(ROOT, () =>
    view(0, (i) =>
      when(i, 1, () => txn() !== null, () => view(1, (b) => slot(b, 0, () => (runs++, txn()!.m)))),
    ),
  undefined)
  txn.set({ m: "b" })
  expect(runs).toBe(2)
  expect(host.ops.filter((o) => o[0] === "patch").at(-1)?.[3]).toBe("b")
  close()
})
