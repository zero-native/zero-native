import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { signal } from "../src/signals"
import { component, each, on, renderRoot, slot, SlotKind, view, when, type View } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001

beforeEach(() => {
  host = installFakeHost()
  installEvents()
})

/** Ops of a kind, ignoring instance ids (which keep counting across tests). */
const kinds = () => host.ops.map((o) => o[0])

test("a root binds slots as patches and reacts to signals", () => {
  const count = signal(1)
  renderRoot(ROOT, () => view(0, (i) => slot(i, 0, () => `n=${count()}`)), {})
  count.set(2)
  expect(host.ops).toEqual([
    ["patch", ROOT, 0, "n=1"],
    ["patch", ROOT, 0, "n=2"],
  ])
})

test("colour slots send ARGB numbers", () => {
  renderRoot(ROOT, () => view(0, (i) => slot(i, 0, () => "#3D26ED", SlotKind.Color)), {})
  expect(host.ops).toEqual([["patch", ROOT, 0, 0xff3d26ed]])
})

test("a component mounts once with its first slot values inside MOUNT", () => {
  const label = signal("a")
  const Child = (p: { label: string }): View => view(7, (i) => slot(i, 0, () => p.label))
  renderRoot(ROOT, () => view(0, (i) => component(i, 3, Child, { get label() { return label() } })), {})
  const [op] = host.ops
  expect(op[0]).toBe("mount")
  expect(op.slice(1, 4)).toEqual([7, ROOT, 3]) // template, parent, anchor
  expect(op[6]).toEqual(["a"])
  label.set("b") // props are getters: the child's slot updates
  expect(host.ops[1]).toEqual(["patch", op[4] as number, 0, "b"])
})

test("when: swaps branches, removes the old one, and doesn't remount for the same branch", () => {
  const on_ = signal(true)
  const other = signal(0)
  renderRoot(
    ROOT,
    () =>
      view(0, (i) =>
        when(i, 2, () => (other(), on_()), () => view(1, () => {}), () => view(2, () => {})),
      ),
    {},
  )
  other.set(1) // same branch: nothing
  on_.set(false)
  expect(kinds()).toEqual(["mount", "remove", "mount"])
  expect(host.ops[0][1]).toBe(1)
  expect(host.ops[2][1]).toBe(2)
  expect(host.ops[1][1]).toBe(host.ops[0][4]) // removed the first branch's instance
})

test("when without else: nothing mounted while false", () => {
  const show = signal(false)
  renderRoot(ROOT, () => view(0, (i) => when(i, 1, show, () => view(1, () => {}))), {})
  expect(host.ops).toEqual([])
  show.set(true)
  show.set(false)
  expect(kinds()).toEqual(["mount", "remove"])
})

test("each: keyed rows mount, move and remove with the fewest ops", () => {
  type Item = { id: string }
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" }
  const items = signal<Item[]>([a, b, c])
  renderRoot(
    ROOT,
    () => view(0, (i) => each(i, 4, items, (it) => it.id, (it) => view(9, (r) => slot(r, 0, () => it.id)))),
    {},
  )
  expect(host.ops.map((o) => [o[0], o[5], o[6]])).toEqual([
    ["mount", 0, ["a"]],
    ["mount", 1, ["b"]],
    ["mount", 2, ["c"]],
  ])
  const ids = Object.fromEntries(host.ops.map((o) => [(o[6] as any)[0], o[4]]))
  host.ops.length = 0

  items.set([c, a]) // b removed, c moved to the front
  expect(host.ops).toEqual([
    ["remove", ids.b],
    ["move", ids.c, 0],
  ])
  host.ops.length = 0

  items.set([c, b, a]) // b comes back as a new row at index 1
  expect(host.ops.map((o) => [o[0], o[0] === "mount" ? o[5] : null])).toEqual([["mount", 1]])
})

test("each: a changed item with the same key is mounted again", () => {
  const items = signal([{ id: 1, name: "x" }])
  renderRoot(ROOT, () => view(0, (i) => each(i, 0, items, (it) => it.id, (it) => view(9, (r) => slot(r, 0, () => it.name)))), {})
  items.set([{ id: 1, name: "y" }])
  expect(kinds()).toEqual(["mount", "remove", "mount"])
  expect(host.ops[2][6]).toEqual(["y"])
})

test("disposing a branch stops its effects and unregisters its events", () => {
  const show = signal(true)
  const n = signal(0)
  let taps = 0
  renderRoot(
    ROOT,
    () =>
      view(0, (i) =>
        when(i, 1, show, () =>
          view(5, (b) => {
            slot(b, 0, () => n())
            on(b, 1, () => taps++)
          }),
        ),
      ),
    {},
  )
  const branchId = host.ops[0][4] as number
  show.set(false)
  host.ops.length = 0
  n.set(1) // the removed branch must not patch
  globalThis.__zn_onEvent(branchId, 1, null)
  expect(host.ops).toEqual([])
  expect(taps).toBe(0)
})

test("a component's body runs inside its instance: its effects stop when it is removed", () => {
  const show = signal(true)
  const tick = signal(0)
  const seen: number[] = []
  const Child = (): View => {
    // a body-level effect, like a component's own timer or derived state
    globalThis.__zn_log(0, "child body")
    const { effect } = require("../src/signals")
    effect(() => seen.push(tick()))
    return view(3, () => {})
  }
  renderRoot(ROOT, () => view(0, (i) => when(i, 0, show, () => Child())), {})
  show.set(false)
  tick.set(1)
  expect(seen).toEqual([0])
})

// ---- A part of a screen that throws (step 3.9) ----------------------------------------------------------------------

test("a child that throws leaves only its part empty; what it sent is removed; the rest keeps working", () => {
  const label = signal("a")
  const Bad = () => {
    throw new Error("bad row")
  }
  // A child that sends MOUNT, then a grandchild component throws while it builds: the grandchild is left out, the
  // child itself stays (only the failing part is empty).
  const Inner = () => view(5, (i) => component(i, 1, Bad, {}))
  renderRoot(ROOT, () => view(0, (i) => {
    slot(i, 0, () => label())
    component(i, 3, Inner, {})
    when(i, 4, () => true, () => Bad())
  }), {})
  expect(kinds()).toEqual(["patch", "mount"]) // the root's value, Inner; Bad (twice) never got as far as MOUNT
  expect(host.logs.filter(([, m]) => m.includes("a part of the screen (left empty) threw")).length).toBe(2)
  label.set("b") // the screen still works
  expect(host.ops.at(-1)).toEqual(["patch", ROOT, 0, "b"])
})

test("a child that throws after its MOUNT went out is removed again", () => {
  const Half = () => view(6, (i) => {
    on(i, 1, () => {})
    // ready() runs inside component(): MOUNT is sent, then the grandchild's body throws.
    component(i, 2, () => view(7, () => {
      throw new Error("late")
    }), {})
    throw new Error("after mount")
  })
  renderRoot(ROOT, () => view(0, (i) => component(i, 3, Half, {})), {})
  const [mount, remove] = host.ops.filter((o) => o[0] === "mount" || o[0] === "remove")
  expect(mount[0]).toBe("mount")
  expect(remove).toEqual(["remove", mount[4]])
})
