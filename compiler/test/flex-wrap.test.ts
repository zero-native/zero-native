// flexWrap on a Row (registry 24): props written for native ZnWrap.kt, and the build errors.
import { describe, expect, test } from "bun:test"
import type { NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

function compile(body: string) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const src = `import { Row, Column, View, Text, Box } from "@zero-native/ui"
import { signal } from "@zero-native/core"
const g = signal(4)
export function F() { return ${body} }`
  const out = compileModule(src, "test.tsx", ctx)
  return { ...out, props: templates[0].props as Record<string, unknown> }
}
const err = (body: string) => {
  try {
    compile(body)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("flexWrap", () => {
  test("a Row with wrap; gap is both ways, so no crossGap", () => {
    const { props } = compile(`<Row gap={8} style={{ flexWrap: "wrap" }}><Box /></Row>`)
    expect(props.flexWrap).toBe("wrap")
    expect(props.gap).toBe(8)
    expect(props.crossGap).toBeUndefined()
  })
  test("an RN View with flexDirection row", () => {
    const { props } = compile(`<View style={{ flexDirection: "row", flexWrap: "wrap", alignContent: "center" }}><Box /></View>`)
    expect(props.flexWrap).toBe("wrap")
    expect(props.alignContent).toBe("center")
  })
  test("columnGap along a line, rowGap between lines", () => {
    const { props } = compile(`<Row style={{ flexWrap: "wrap", columnGap: 10, rowGap: 4 }}><Box /></Row>`)
    expect(props.gap).toBe(10)
    expect(props.crossGap).toBe(4)
  })
  test("columnGap alone: the lines keep gap (or none)", () => {
    expect(compile(`<Row style={{ flexWrap: "wrap", gap: 6, columnGap: 10 }}><Box /></Row>`).props.crossGap).toBe(6)
    expect(compile(`<Row style={{ flexWrap: "wrap", columnGap: 10 }}><Box /></Row>`).props.crossGap).toBe(0)
  })
  test("rowGap from a signal is a slot", () => {
    const { props, code } = compile(`<Row style={{ flexWrap: "wrap", rowGap: g() }}><Box /></Row>`)
    expect((props.crossGap as { $slot: string }).$slot).toBeDefined()
    expect(code).toContain("g()")
  })
  test("nowrap is the default: nothing written, and alignContent is dropped", () => {
    const { props } = compile(`<Row style={{ flexWrap: "nowrap", alignContent: "center" }}><Box /></Row>`)
    expect(props.flexWrap).toBeUndefined()
    expect(props.alignContent).toBeUndefined()
  })
  test("errors: on a Column, wrap-reverse, alignContent stretch, from a signal", () => {
    expect(err(`<Column style={{ flexWrap: "wrap" }}><Box /></Column>`)).toContain('flexWrap: "wrap" works on a <Row>')
    expect(err(`<Row style={{ flexWrap: "wrap-reverse" }}><Box /></Row>`)).toContain('"wrap-reverse" isn\'t supported')
    expect(err(`<Row style={{ flexWrap: "wrap", alignContent: "stretch" }}><Box /></Row>`)).toContain('alignContent "stretch" isn\'t supported')
    expect(err(`<Row style={{ flexWrap: g() > 2 ? "wrap" : "nowrap" }}><Box /></Row>`)).toContain('"flexWrap" must be known at build time')
  })
})
