// Compiler fixes from the 2026-11-08 review of Gemini's batches 1 and 2
// (docs/cross-communication/2026-11-08-opus-review-of-gemini-batches.md). One test per finding, named by its number.
import { describe, expect, test } from "bun:test"
import { type NodeSpec } from "@zeronative/template"
import { compileModule } from "../src/compile"

function compile(src: string) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx)
  // Some errors are traps: reported when the component is built (as in destructured-props.test.ts).
  for (const info of Object.values(out.roots)) for (const trap of info.traps) throw new Error(`${trap.at}: ${trap.message}`)
  return { ...out, templates }
}

/** The first node of [tag] in [spec], depth first. */
function find(spec: NodeSpec, tag: string): NodeSpec | undefined {
  if (spec.type === tag) return spec
  for (const k of spec.children ?? []) {
    const hit = find(k, tag)
    if (hit) return hit
  }
  return undefined
}

describe("review fixes 2026-11-08", () => {
  test("B2: a runtime function imported from ui is a build error", () => {
    expect(() => compile(`
      import { List, listController, Text } from "@zeronative/ui"
      export function S() { const c = listController(); return <Text>x</Text> }
    `)).toThrow(/"listController" is not part of @zeronative\/ui at runtime\. Import it from "@zeronative\/core"/)
  })

  test("B2: types and components from ui still compile", () => {
    expect(() => compile(`
      import { Text, type ListRef } from "@zeronative/ui"
      import type { ViewStyle } from "@zeronative/ui"
      export function S() { return <Text>x</Text> }
    `)).not.toThrow()
  })

  test("M5: a default that names an earlier prop reads that prop", () => {
    const { code } = compile(`
      export function Card({ a, b = a }: { a: string; b?: string }) {
        return <Text>{b}</Text>
      }`)
    expect(code).toContain("(__p.b === undefined ? __p.a : __p.b)")
    expect(code).not.toMatch(/\? a :/)
  })

  test("M5: the earlier prop's own default is kept", () => {
    const { code } = compile(`
      export function Card({ a = "x", b = a }: { a?: string; b?: string }) {
        return <Text>{b}</Text>
      }`)
    expect(code).toContain(`(__p.b === undefined ? (__p.a === undefined ? "x" : __p.a) : __p.b)`)
  })

  test("M5: a default that names a later prop is a build error", () => {
    expect(() => compile(`
      export function Card({ b = a, a }: { a: string; b?: string }) {
        return <Text>{b}</Text>
      }`)).toThrow(/names "a", which comes after it/)
  })

  test("M6: a flex row Touchable in a Row doesn't fill the Row's height", () => {
    const { templates } = compile(`
      import { Column, Row, Text, TouchableOpacity } from "@zeronative/ui"
      export function Bar() {
        return (
          <Row>
            <TouchableOpacity style={{ flex: 1, flexDirection: "row", alignItems: "center" }} onPress={() => {}}>
              <Text>Pay</Text>
            </TouchableOpacity>
          </Row>
        )
      }`)
    const press = find(templates[0], "Pressable")!
    const inner = find(press, "Row")!
    expect(inner.props.height).toBeUndefined()
  })

  test("M6: in a Column, flex sets the height, so the inner Row fills it", () => {
    const { templates } = compile(`
      import { Column, Row, Text, TouchableOpacity } from "@zeronative/ui"
      export function Bar() {
        return (
          <Column style={{ height: 200 }}>
            <TouchableOpacity style={{ flex: 1, flexDirection: "row" }} onPress={() => {}}>
              <Text>Pay</Text>
            </TouchableOpacity>
          </Column>
        )
      }`)
    const inner = find(find(templates[0], "Pressable")!, "Row")!
    expect(inner.props.height).toBe("100%")
  })

  test("H1 minor: flexShrink / flexBasis from a variable is a build error again", () => {
    const src = (k: string) => `
      import { Box } from "@zeronative/ui"
      export function A(p: { v: number }) { return <Box style={{ ${k}: p.v }} /> }`
    expect(() => compile(src("flexShrink"))).toThrow(/flexShrink must be known at build time/)
    expect(() => compile(src("flexBasis"))).toThrow(/flexBasis must be known at build time/)
  })

  test("Canvas takes no children", () => {
    expect(() => compile(`
      import { Canvas, Text } from "@zeronative/ui"
      export function C() { return <Canvas style={{ width: 10, height: 10 }} commands={[]}><Text>x</Text></Canvas> }
    `)).toThrow(/<Canvas> takes no children/)
  })
})

describe("review fixes 2026-11-08: List header forms", () => {
  const header = (h: string) => {
    const { code } = compile(`
      import { List, Text } from "@zeronative/ui"
      export function S(p: { items: string[]; on: boolean; header: any }) {
        return <List data={p.items} key={(i) => i} row={(i) => <Text>{i}</Text>} ListHeaderComponent={${h}} />
      }`)
    const at = code.indexOf(", header: ")
    return code.slice(at, at + 60)
  }
  for (const h of ["() => (<Text>H</Text>)", "() => { return <Text>H</Text> }", "() => <Text>H</Text>", "<Text>H</Text>"]) {
    test(`${h} is compiled to a view`, () => expect(header(h)).toStartWith(", header: () => __zn.view("))
  }
  test("cond ? <X/> : null and cond && <X/>", () => {
    expect(header("p.on ? <Text>H</Text> : null")).toStartWith(", header: () => ((p.on) ? __zn.view(")
    expect(header("p.on && <Text>H</Text>")).toStartWith(", header: () => ((p.on) ? __zn.view(")
  })
  test("props.header is handed to core (which calls it)", () => {
    expect(header("p.header")).toStartWith(", header: () => (p.header)")
  })
})

describe("review fixes 2026-11-08: small compiler crashes", () => {
  test("<Carousel itemWidth> with no value is a build error, not a crash", () => {
    expect(() => compile(`
      import { Carousel, Text } from "@zeronative/ui"
      export function C() { return <Carousel itemWidth><Text>a</Text></Carousel> }
    `)).toThrow(/itemWidth needs a value/)
  })

  test("a helper function after the last return, with guards, gets a clear message", () => {
    expect(() => compile(`
      import { Text } from "@zeronative/ui"
      export function C(p: { on: boolean }) {
        if (!p.on) return <Text>off</Text>
        return <Text>{label()}</Text>
        function label() { return "on" }
      }
    `)).toThrow(/declares function label after its return/)
  })
})

describe("review fixes 2026-11-08: B5, the registry an older app checks", () => {
  test("a negative margin needs registry 23", async () => {
    const { el, writeTemplateFile } = await import("@zeronative/template")
    expect(writeTemplateFile([el("Column", { marginHorizontal: -16 })]).registry).toBe(23)
    expect(writeTemplateFile([el("Column", { style: { marginTop: -4 } })]).registry).toBe(23)
    expect(writeTemplateFile([el("Column", { marginTop: 4 })]).registry).toBeLessThan(23)
  })

  test("a List with only a header needs registry 23", async () => {
    const { writeTemplateFile } = await import("@zeronative/template")
    const { templates } = compile(`
      import { List, Text } from "@zeronative/ui"
      export function S(p: { items: string[] }) {
        return <List data={p.items} key={(i) => i} row={(i) => <Text>{i}</Text>} ListHeaderComponent={<Text>H</Text>} />
      }`)
    expect(writeTemplateFile(templates).registry).toBe(23)
  })
})

test("B5 control: the same List without a header stays below 23", async () => {
  const { writeTemplateFile } = await import("@zeronative/template")
  const { templates } = compile(`
    import { List, Text } from "@zeronative/ui"
    export function S(p: { items: string[] }) {
      return <List data={p.items} key={(i) => i} row={(i) => <Text>{i}</Text>} />
    }`)
  expect(writeTemplateFile(templates).registry).toBeLessThan(23)
})
