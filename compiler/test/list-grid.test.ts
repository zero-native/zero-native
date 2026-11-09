// <List numColumns> / <FlatList numColumns> grids (registry 24): props for native, and the build errors.
import { describe, expect, test } from "bun:test"
import type { NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

function compile(attrs: string) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const src = `import { List, FlatList, Text } from "@zero-native/ui"
import { signal } from "@zero-native/core"
const items = signal([{ id: "a" }])
const n = signal(2)
export function F() { return <FlatList data={items()} renderItem={({ item }) => <Text>{item.id}</Text>} ${attrs} /> }`
  const out = compileModule(src, "test.tsx", ctx)
  const list = templates.find((t) => t?.type === "List")!
  return { ...out, props: list.props as Record<string, unknown> }
}
const err = (attrs: string) => {
  try {
    compile(attrs)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("numColumns", () => {
  test("a number; 1 is a plain list", () => {
    expect(compile(`numColumns={3}`).props.numColumns).toBe(3)
    expect(compile(`numColumns={1}`).props.numColumns).toBeUndefined()
  })
  test("from a signal: a slot", () => {
    const { props, code } = compile(`numColumns={n()}`)
    expect((props.numColumns as { $slot: string }).$slot).toBeDefined()
    expect(code).toContain("n()")
  })
  test("columnWrapperStyle: gap, justify, align, padding", () => {
    expect(compile(`numColumns={2} columnWrapperStyle={{ gap: 12, paddingHorizontal: 16 }}`).props.columnWrapper)
      .toBe("g12;j-1;a-1;p16,0,16,0")
    expect(compile(`numColumns={2} columnWrapperStyle={{ columnGap: 8, justifyContent: "space-between", alignItems: "center", padding: 4, paddingTop: 10 }}`).props.columnWrapper)
      .toBe("g8;j3;a1;p4,10,4,4")
    expect(compile(`numColumns={2} columnWrapperStyle={[{ paddingLeft: 6 }, { paddingRight: 2 }]}`).props.columnWrapper)
      .toBe("g0;j-1;a-1;p6,0,2,0")
  })
  test("errors", () => {
    expect(err(`numColumns={0}`)).toContain("numColumns must be a whole number from 1 to 12")
    expect(err(`numColumns={2.5}`)).toContain("numColumns must be a whole number from 1 to 12")
    expect(err(`columnWrapperStyle={{ gap: 4 }}`)).toContain("columnWrapperStyle needs numColumns")
    expect(err(`numColumns={2} columnWrapperStyle={{ backgroundColor: "red" }}`)).toContain('"backgroundColor" isn\'t supported')
    expect(err(`numColumns={2} columnWrapperStyle={{ gap: n() }}`)).toContain("columnWrapperStyle must be known at build time")
    expect(err(`numColumns={2} horizontal`)).toContain("can't be horizontal")
    expect(err(`numColumns={2} stickyHeaderIndices={[0]}`)).toContain("doesn't support stickyHeaderIndices")
    expect(err(`numColumns={2} reorderable`)).toContain("doesn't support reorderable")
  })
})
