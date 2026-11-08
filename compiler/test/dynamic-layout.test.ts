import { describe, expect, test } from "bun:test"
import { type NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

const isSlot = (v: unknown): boolean => typeof v === "object" && v !== null && "$slot" in (v as Record<string, unknown>)

function compile(src: string, statics: Record<string, unknown> = {}) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx, new Map(Object.entries(statics)))
  return { ...out, templates }
}

const err = (src: string, statics: Record<string, unknown> = {}) => {
  try {
    compile(src, statics)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("H1: Dynamic Layout Values", () => {
  test("dynamic dimensions compile to slot expressions", () => {
    const { code, templates } = compile(`
      import { View } from "@zero-native/ui"
      export function Box(props: { w: () => number, h: () => number }) {
        return <View style={{ width: props.w(), height: props.h(), minWidth: 50, maxWidth: props.w() * 2, minHeight: 10, maxHeight: 100 }} />
      }
    `)
    expect(code).toContain("props.w()")
    expect(code).toContain("props.h()")
    expect(isSlot(templates[0]!.props.width)).toBe(true)
    expect(isSlot(templates[0]!.props.height)).toBe(true)
    expect(isSlot(templates[0]!.props.maxWidth)).toBe(true)
    expect(templates[0]!.props.minWidth).toBe(50)
    expect(templates[0]!.props.minHeight).toBe(10)
    expect(templates[0]!.props.maxHeight).toBe(100)
  })

  test("dynamic flex and flexGrow compile to flex slot", () => {
    const { code, templates } = compile(`
      import { View } from "@zero-native/ui"
      export function FlexBox(props: { f: () => number }) {
        return (
          <Row>
            <View style={{ flex: props.f() }} />
            <View style={{ flexGrow: props.f() + 1 }} />
          </Row>
        )
      }
    `)
    expect(code).toContain("props.f()")
    expect(isSlot(templates[0]!.children[0]!.props.flex)).toBe(true)
    expect(isSlot(templates[0]!.children[1]!.props.flex)).toBe(true)
  })

  test("dynamic margins and padding shorthands compile to slots", () => {
    const { code, templates } = compile(`
      import { View } from "@zero-native/ui"
      export function Spaced(props: { m: () => number, p: () => number }) {
        return <View style={{ margin: props.m(), marginHorizontal: props.m() * 2, padding: props.p(), paddingVertical: props.p() + 4 }} />
      }
    `)
    expect(code).toContain("props.m()")
    expect(code).toContain("props.p()")
    expect(isSlot(templates[0]!.props.margin)).toBe(true)
    expect(isSlot(templates[0]!.props.marginHorizontal)).toBe(true)
    expect(isSlot(templates[0]!.props.padding)).toBe(true)
    expect(isSlot(templates[0]!.props.paddingVertical)).toBe(true)
  })

  test("dynamic gap, rowGap, columnGap compile to slot on Row and Column", () => {
    const { code, templates } = compile(`
      export function Layouts(props: { g: () => number }) {
        return (
          <Column style={{ gap: props.g() }}>
            <Row style={{ columnGap: props.g() * 2 }} />
          </Column>
        )
      }
    `)
    expect(code).toContain("props.g()")
    expect(isSlot(templates[0]!.props.gap)).toBe(true)
    expect(isSlot(templates[0]!.children[0]!.props.gap)).toBe(true)
  })

  test("dynamic radii, typography, aspectRatio, and display compile to slots", () => {
    const { code, templates } = compile(`
      import { View } from "@zero-native/ui"
      export function StyledText(props: { r: () => number, size: () => number, show: () => boolean, ratio: () => number }) {
        return (
          <View style={{ borderRadius: props.r(), aspectRatio: props.ratio(), display: props.show() ? "flex" : "none" }}>
            <Text style={{ fontSize: props.size(), lineHeight: props.size() * 1.5, letterSpacing: 0.5 }}>
              Dynamic Text
            </Text>
          </View>
        )
      }
    `)
    expect(code).toContain("props.r()")
    expect(code).toContain("props.size()")
    expect(code).toContain('props.show() ? "flex" : "none"')
    expect(code).toContain("props.ratio()")
    expect(isSlot(templates[0]!.props.borderRadius)).toBe(true)
    expect(isSlot(templates[0]!.props.aspectRatio)).toBe(true)
    expect(isSlot(templates[0]!.props.display)).toBe(true)
    expect(isSlot(templates[0]!.children[0]!.props.fontSize)).toBe(true)
    expect(isSlot(templates[0]!.children[0]!.props.lineHeight)).toBe(true)
    expect(templates[0]!.children[0]!.props.letterSpacing).toBe(0.5)
  })

  test("dynamic offsets on Stack children compile to slots", () => {
    const { code, templates } = compile(`
      import { View } from "@zero-native/ui"
      export function StackItem(props: { t: () => number, s: () => number }) {
        return (
          <Stack>
            <View style={{ position: "absolute", top: props.t(), start: props.s() }} />
          </Stack>
        )
      }
    `)
    expect(code).toContain("props.t()")
    expect(code).toContain("props.s()")
    expect(isSlot(templates[0]!.children[0]!.props.top)).toBe(true)
    expect(isSlot(templates[0]!.children[0]!.props.start)).toBe(true)
  })

  test("structural properties fail at build time with helpful error message", () => {
    expect(err(`
      import { View } from "@zero-native/ui"
      export function Bad(props: { d: () => string }) {
        return <View style={{ flexDirection: props.d() }} />
      }
    `)).toMatch(/flexDirection must be known at build time/)

    expect(err(`
      import { View } from "@zero-native/ui"
      export function Bad(props: { a: () => string }) {
        return <View style={{ alignItems: props.a() }} />
      }
    `)).toMatch(/"alignItems" must be known at build time/)

    expect(err(`
      import { View } from "@zero-native/ui"
      export function Bad(props: { j: () => string }) {
        return <View style={{ justifyContent: props.j() }} />
      }
    `)).toMatch(/"justifyContent" must be known at build time/)

    expect(err(`
      import { View } from "@zero-native/ui"
      export function Bad(props: { w: () => string }) {
        return <View style={{ flexWrap: props.w() }} />
      }
    `)).toMatch(/flexWrap must be known at build time/)

    expect(err(`
      import { View } from "@zero-native/ui"
      export function Bad(props: { p: () => string }) {
        return <View style={{ position: props.p() }} />
      }
    `)).toMatch(/"position" must be known at build time/)
  })

  test("static layout properties continue to produce static prop values without slots", () => {
    const { templates } = compile(`
      import { View } from "@zero-native/ui"
      export function StaticBox() {
        return <View style={{ width: 100, height: 200, margin: 16, padding: 8, gap: 12, borderRadius: 8, fontSize: 14 }} />
      }
    `)
    expect(templates[0]!.props).toMatchObject({
      width: 100,
      height: 200,
      margin: 16,
      padding: 8,
      gap: 12,
      borderRadius: 8,
      fontSize: 14,
    })
    expect(isSlot(templates[0]!.props.width)).toBe(false)
    expect(isSlot(templates[0]!.props.height)).toBe(false)
  })
})
