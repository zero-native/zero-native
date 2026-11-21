// Build warnings (compile.ts CompileOutput.warnings): code that builds but doesn't do what it says. buildApp prints
// and returns them; the build still succeeds.
import { describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { type NodeSpec } from "@zeronative/template"
import { compileModule } from "../src/compile"
import { buildApp } from "../src/build-app"

function warnings(src: string): string[] {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  return compileModule(src, "test.tsx", ctx, new Map()).warnings
}

const list = (listProps: string, row: string, rowProp = "row", key = "key={(r) => r.id} ") => `
import { List, Pressable, Row, Text } from "@zeronative/ui"
export function A(p) {
  return <List data={p.rows} ${key}${listProps}
    ${rowProp}={${row}} />
}`

describe("<List reorderable> row with onLongPress (Pavan's decision 7)", () => {
  test("onLongPress on the row warns, with where it is", () => {
    const w = warnings(list("reorderable", "(r) => <Pressable onLongPress={() => p.menu(r)}><Text>{r.t}</Text></Pressable>"))
    expect(w).toHaveLength(1)
    expect(w[0]).toStartWith("test.tsx:5:28: onLongPress in a row of <List reorderable>: a long press on a row starts the drag")
    expect(w[0]).toContain("iOS drops it; Android may still run it")
  })

  test("onLongPress inside the row, and on Text, warns once each", () => {
    const w = warnings(list("reorderable onReorder={(a, b) => p.move(a, b)}",
      "(r) => <Row><Pressable onLongPress={() => p.a(r)}><Text>a</Text></Pressable><Text onLongPress={() => p.b(r)}>b</Text></Row>"))
    expect(w).toHaveLength(2)
  })

  test("renderItem rows and both kinds of a two-kind row are checked", () => {
    expect(warnings(list("reorderable", "({ item }) => <Text onLongPress={() => p.m(item)}>{item.t}</Text>", "renderItem", ""))).toHaveLength(1)
    expect(warnings(list("reorderable", "(r) => r.big ? <Row><Text>big</Text></Row> : <Text onLongPress={() => p.m(r)}>x</Text>"))).toHaveLength(1)
  })

  test("no warning without reorderable, with reorderable={false}, or with pinned rows (no reorder then)", () => {
    const row = "(r) => <Text onLongPress={() => p.m(r)}>x</Text>"
    expect(warnings(list("", row))).toEqual([])
    expect(warnings(list("reorderable={false}", row))).toEqual([])
    expect(warnings(list("reorderable={EDIT}", row).replace("export function", "const EDIT = false\nexport function"))).toEqual([])
    expect(warnings(list("reorderable stickyHeaderIndices={[0]}", row))).toEqual([])
  })

  test("a row that is a component of this file: its onLongPress warns, saying which component and row", () => {
    const src = `
import { List, Pressable, Row, Text } from "@zeronative/ui"
function Label(p) { return <Text onLongPress={() => p.m()}>{p.t}</Text> }
function TaskRow({ task }) {
  return <Row><Pressable onLongPress={() => task.menu()}><Label t={task.t} m={task.m} /></Pressable><Label t="2" /></Row>
}
export function A(p) {
  return <List data={p.rows} key={(r) => r.id} reorderable row={(r) => <TaskRow task={r} />} />
}`
    const w = warnings(src)
    expect(w).toHaveLength(2) // Label is read once though the row uses it twice
    expect(w[0]).toStartWith("test.tsx:5:26: onLongPress in a row of <List reorderable> (in <TaskRow>, the row at 8:72):")
    expect(w[1]).toStartWith("test.tsx:3:34: onLongPress in a row of <List reorderable> (in <TaskRow> > <Label>, the row at 8:72):")
    // The same component as the row of a plain List: no warning.
    expect(warnings(src.replace(" reorderable ", " "))).toEqual([])
  })

  test("a <List> inside a reorderable row has its own rows: not checked as the outer row", () => {
    const src = `
import { List, Pressable, Row, Text } from "@zeronative/ui"
export function A(p) {
  return <List data={p.rows} key={(r) => r.id} reorderable
    row={(r) => <Row><List data={r.kids} key={(k) => k.id} row={(k) => <Text onLongPress={() => p.m(k)}>x</Text>} /></Row>} />
}`
    expect(warnings(src)).toEqual([])
  })

  test("reorderable from a value known only at runtime is a build error already, so the check always knows", () => {
    expect(() => warnings(list("reorderable={p.editing}", "(r) => <Text onLongPress={() => p.m(r)}>x</Text>")))
      .toThrow('"reorderable" must be known at build time')
  })

  test("onPress in a reorderable row is fine", () => {
    expect(warnings(list("reorderable", "(r) => <Pressable onPress={() => p.open(r)}><Text>x</Text></Pressable>"))).toEqual([])
  })

  test("buildApp prints the warning and still builds", async () => {
    const printed: string[] = []
    const spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => void printed.push(a.join(" ")))
    try {
      const app = await buildApp(join(import.meta.dir, "fixtures/reorder-warning/main.ts"))
      expect(app.manifest.components.Tasks).toBe(0)
      expect(app.warnings).toHaveLength(1)
      expect(app.warnings[0]).toMatch(/reorder-warning[\\/]tasks\.tsx:7:20: onLongPress in a row of <List reorderable>/)
      expect(printed).toEqual([`zero-native warning: ${app.warnings[0]}`])
    } finally {
      spy.mockRestore()
    }
  })
})
