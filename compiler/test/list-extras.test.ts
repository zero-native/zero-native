import { describe, expect, test } from "bun:test"
import { type NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

function compile(src: string) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx)
  return { ...out, templates }
}

describe("H3: List Header, Footer, and Empty Component", () => {
  test("ListHeaderComponent, ListFooterComponent, ListEmptyComponent compile into list call", () => {
    const { code, templates } = compile(`
      import { List, Text } from "@zero-native/ui"
      export function Screen(props: { items: string[] }) {
        return (
          <List
            data={props.items}
            key={(item) => item}
            row={(item) => <Text>{item}</Text>}
            ListHeaderComponent={<Text>Header Title</Text>}
            ListFooterComponent={<Text>Footer Copyright</Text>}
            ListEmptyComponent={<Text>No Items Found</Text>}
          />
        )
      }
    `)
    expect(code).toContain("header: () =>")
    expect(code).toContain("footer: () =>")
    expect(code).toContain("empty: () =>")
    expect(templates[2].props.text).toBe("Header Title")
    expect(templates[3].props.text).toBe("Footer Copyright")
    expect(templates[4].props.text).toBe("No Items Found")
  })

  test("List components passed as identifiers", () => {
    const { code } = compile(`
      import { List, Text } from "@zero-native/ui"
      function MyHeader() { return <Text>Header</Text> }
      function MyEmpty() { return <Text>Empty</Text> }
      export function Screen(props: { items: string[] }) {
        return (
          <List
            data={props.items}
            key={(item) => item}
            row={(item) => <Text>{item}</Text>}
            ListHeaderComponent={MyHeader}
            ListEmptyComponent={MyEmpty}
          />
        )
      }
    `)
    expect(code).toContain("header: () => MyHeader({})")
    expect(code).toContain("empty: () => MyEmpty({})")
  })
})
