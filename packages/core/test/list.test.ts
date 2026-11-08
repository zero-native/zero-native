import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { signal } from "../src/signals"
import { list, renderRoot, slot, view } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001
const NODE = 2
const RANGE = 11 // event ids the compiler would assign
const END = 12

beforeEach(() => {
  host = installFakeHost()
  installEvents()
})

interface Item {
  id: number
  kind: "header" | "row"
  name: string
}
const make = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, kind: i % 10 === 0 ? "header" : "row", name: `m${i}` }))

/** A screen with one <List>: headers use template 5, rows template 6 (as the compiler would emit). */
function screen(data: () => Item[], onEndReached?: () => void) {
  renderRoot(
    ROOT,
    () =>
      view(0, (i) =>
        list<Item>(i, NODE, {
          data,
          key: (it) => it.id,
          row: (it) => (it.kind === "header" ? view(5, (r) => slot(r, 0, () => it.name)) : view(6, (r) => slot(r, 0, () => it.name))),
          type: (it) => (it.kind === "header" ? 5 : 6),
          rangeEvent: RANGE,
          endEvent: END,
          onEndReached,
        }),
      ),
    {},
  )
}
const of = (k: string) => host.ops.filter((o) => o[0] === k)
const range = (a: number, b: number) => globalThis.__zn_onEvent(ROOT, RANGE, `${a},${b}`)

test("sends every key and type once, then mounts only the first screen of rows", () => {
  screen(() => make(1000))
  const [set] = of("listSet")
  expect(set[1]).toBe(ROOT)
  expect((set[3] as string[]).length).toBe(1000)
  expect((set[4] as number[]).slice(0, 2)).toEqual([5, 6])
  const rows = of("listRow")
  expect(rows.length).toBe(16 + 12) // initial 16 visible + 12 ahead
  expect(rows[0][3]).toBe("0")
  // Each row is a MOUNT (with its values) followed by the LIST_ROW that binds it to its key.
  const firstMount = host.ops.find((o) => o[0] === "mount")!
  expect(firstMount[1]).toBe(5) // header template
  expect(firstMount[6]).toEqual(["m0"])
})

test("scrolling mounts rows near the range and removes rows that left the wider band", () => {
  screen(() => make(1000))
  host.ops.length = 0
  range(500, 515)
  const keys = of("listRow").map((o) => Number(o[3]))
  expect(Math.min(...keys)).toBe(492) // 8 behind
  expect(Math.max(...keys)).toBe(527) // 12 ahead
  expect(of("remove").length).toBe(28) // all first-screen rows are far behind now
  host.ops.length = 0
  range(501, 516) // a small move: one new row ahead, nothing removed
  expect(of("listRow").map((o) => o[3])).toEqual(["528"])
  expect(of("remove")).toEqual([])
})

test("a new row at the top is one splice; existing rows stay mounted", () => {
  const data = signal(make(100))
  screen(() => data())
  host.ops.length = 0
  data.set([{ id: -1, kind: "row", name: "new" }, ...data()])
  expect(of("listSplice")).toEqual([["listSplice", ROOT, NODE, 0, 0, ["-1"], [6]]])
  expect(of("listRow").map((o) => o[3])).toEqual(["-1"]) // only the new row mounts
  expect(of("remove")).toEqual([])
})

test("removing one row and changing one item", () => {
  const data = signal(make(50))
  screen(() => data())
  host.ops.length = 0
  const next = data().filter((it) => it.id !== 3)
  next[4] = { ...next[4], name: "changed" } // same key, new object → mounted again
  data.set(next)
  // Keys only lost "3": one splice removing it. The changed item keeps its key, so it isn't in the splice; its row
  // is mounted again with the new values.
  expect(of("listSplice")).toEqual([["listSplice", ROOT, NODE, 3, 1, [], []]])
  // "28" slides into the window because a row above it is gone.
  expect(of("listRow").map((o) => o[3])).toEqual(["5", "28"])
  expect(host.ops.find((o) => o[0] === "mount")![6]).toEqual(["changed"])
})

test("duplicate keys are logged and made unique", () => {
  screen(() => [
    { id: 1, kind: "row", name: "a" },
    { id: 1, kind: "row", name: "b" },
  ])
  expect(of("listSet")[0][3]).toEqual(["1", "1#1"])
  expect(host.logs.some(([lvl, m]) => lvl === 3 && m.includes("duplicate key 1"))).toBe(true)
})

test("onEndReached reaches the handler", () => {
  let ends = 0
  screen(() => make(30), () => ends++)
  globalThis.__zn_onEvent(ROOT, END, null)
  expect(ends).toBe(1)
})

test("stickyHeaderIndices rows stay mounted wherever the list is (registry 15)", () => {
  const sticky = signal<number[]>([0, 200])
  renderRoot(
    ROOT,
    () =>
      view(0, (i) =>
        list<Item>(i, NODE, {
          data: () => make(1000),
          key: (it) => it.id,
          row: (it) => view(6, (r) => slot(r, 0, () => it.name)),
          type: () => 6,
          rangeEvent: RANGE,
          endEvent: END,
          sticky: () => sticky(),
        }),
      ),
    {},
  )
  // At the start: the first screen, plus row 200 (pinned, so it shows as soon as the list reaches it).
  expect(of("listRow").map((o) => Number(o[3]))).toContain(200)
  host.ops.length = 0
  range(500, 515)
  // Far down: row 0 is pinned, so it isn't removed with the other first-screen rows.
  expect(of("remove").length).toBe(27) // the 28 first-screen rows less row 0; row 200 stays too
  expect(of("listRow").map((o) => Number(o[3]))).not.toContain(0) // still mounted, not mounted again
  host.ops.length = 0
  sticky.set([0, 600]) // a new pinned row mounts at once, wherever the list is
  expect(of("listRow").map((o) => o[3])).toEqual(["600"])
})

test("ListHeaderComponent, ListFooterComponent, ListEmptyComponent mount as special rows", () => {
  renderRoot(
    ROOT,
    () =>
      view(0, (i) =>
        list<Item>(i, NODE, {
          data: () => [],
          key: (it) => it.id,
          row: (it) => view(6, (r) => slot(r, 0, () => it.name)),
          type: () => 6,
          rangeEvent: RANGE,
          endEvent: END,
          header: () => view(10, (r) => slot(r, 0, () => "Header Title")),
          footer: () => view(11, (r) => slot(r, 0, () => "Footer Copyright")),
          empty: () => view(12, (r) => slot(r, 0, () => "No Items")),
        }),
      ),
    {},
  )
  const rows = of("listRow")
  const boundKeys = rows.map((r) => r[3])
  expect(boundKeys).toContain("__zn_header")
  expect(boundKeys).toContain("__zn_footer")
  expect(boundKeys).toContain("__zn_empty")
})
