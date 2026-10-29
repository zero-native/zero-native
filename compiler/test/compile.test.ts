import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Component, Prop, type NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

function compile(src: string, statics: Record<string, unknown> = {}) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx, new Map(Object.entries(statics)))
  return { ...out, templates }
}

describe("templates", () => {
  test("constants, tokens and style objects go into the template", () => {
    const { templates, code } = compile(
      `
      const s = StyleSheet.create({ card: { padding: 16, borderRadius: 12 } })
      export function Card() {
        return (
          <Column style={[s.card, { backgroundColor: c.surface }]} gap={8}>
            <Text fontSize={18}>Hello  world</Text>
          </Column>
        )
      }`,
      { c: { surface: "#FFFFFF" } },
    )
    expect(templates).toHaveLength(1)
    const root = templates[0]
    expect(root.type).toBe("Column")
    expect(root.props).toMatchObject({ padding: 16, borderRadius: 12, backgroundColor: "#FFFFFF", gap: 8 })
    expect(root.children[0].props).toMatchObject({ fontSize: 18, text: "Hello  world" })
    expect(code).not.toContain("<Column")
    expect(code).toContain('import * as __zn from "@zero-native/core"')
  })

  test("runtime expressions become slots; text mixes literals and expressions", () => {
    const { templates, code } = compile(`
      export function Counter() {
        const n = signal(0)
        return (
          <Pressable onPress={() => n.set(n() + 1)} style={{ backgroundColor: n() > 3 ? "#F00" : "#0F0" }}>
            <Text>Taps: {n()}</Text>
          </Pressable>
        )
      }`)
    const root = templates[0]
    expect((root.props as any).backgroundColor).toEqual({ $slot: "s0", default: null })
    expect((root.props as any).onPress).toEqual({ $event: "e0" })
    expect((root.children[0].props as any).text).toEqual({ $slot: "s1", default: "Taps: " })
    expect(code).toContain('__zn.slot(__i0, 0, () => (n() > 3 ? "#F00" : "#0F0"), 1);') // colour kind
    expect(code).toContain('__zn.slot(__i0, 1, () => "Taps: " + __zn.str(n()), 0);')
    expect(code).toContain("__zn.on(__i0, 1, () => n.set(n() + 1));")
  })

  test("&&, ternary and .map become anchors with their own templates", () => {
    const { templates, code } = compile(`
      export function List(props) {
        return (
          <Column>
            {props.show && <Text>shown</Text>}
            {props.ok ? <Text>yes</Text> : <Text>no</Text>}
            {props.items.map((it) => <Text key={it.id}>{it.name}</Text>)}
          </Column>
        )
      }`)
    expect(templates[0].children.map((c) => c.type)).toEqual(["Anchor", "Anchor", "Anchor"])
    expect(templates).toHaveLength(5) // root + shown + yes + no + row
    expect(code).toContain("__zn.when(__i0, 1, () => (props.show), () => __zn.view(1,")
    expect(code).toMatch(/__zn\.when\(__i0, 2, \(\) => \(props\.ok\), \(\) => __zn\.view\(2,[\s\S]*\(\) => __zn\.view\(3,/)
    expect(code).toContain("__zn.each(__i0, 3, () => (props.items), (it) => (it.id), (it) => __zn.view(4,")
  })

  test("user components mount at anchors with getter props", () => {
    const { templates, code } = compile(`
      function Key(props) { return <Text>{props.label}</Text> }
      export function Pad() {
        const k = signal("1")
        return <Row><Key label={k()} /><Key label="2" /></Row>
      }`)
    expect(templates).toHaveLength(2)
    expect(templates[1].children.map((c) => c.type)).toEqual(["Anchor", "Anchor"])
    expect(code).toContain('__zn.component(__i0, 1, Key, { get "label"() { return (k()) } });')
    expect(code).toContain('__zn.component(__i0, 2, Key, { "label": "2" });')
  })

  test("transforms, shadows, positions and press events", () => {
    const { templates, code } = compile(`
      export function A(p) {
        return (
          <Stack>
            <Box style={{ position: "absolute", top: 8, end: 8, zIndex: 2, elevation: 4,
                          transform: [{ scale: 0.98 }, { rotate: "45deg" }] }} />
            <Pressable onPressRepeat={() => p.del()} repeatDelay={300} haptic />
          </Stack>
        )
      }`)
    expect(templates[0].children[0].props).toMatchObject({ position: "absolute", top: 8, end: 8, zIndex: 2, elevation: 4, scale: 0.98, rotate: 45 })
    expect(templates[0].children[1].props).toMatchObject({ repeatDelay: 300, haptic: true, onPressRepeat: { $event: "e0" } })
    expect(code).toContain("__zn.on(__i0, 1, () => p.del());")
  })

  test("records which template each component returns", () => {
    const { components } = compile(`export function AScreen() { return <Column /> }
      const B = () => <Row />`)
    expect(components).toEqual({ AScreen: 0, B: 1 })
  })

  test("fontWeight normal and bold map to 400 and 700", () => {
    const { templates } = compile(`
      export function Heading() {
        return (
          <Column>
            <Text style={{ fontWeight: "bold" }}>Bold</Text>
            <Text style={{ fontWeight: "normal" }}>Normal</Text>
            <Text fontWeight="bold">Direct Bold</Text>
            <Text fontWeight="600">Numeric 600</Text>
          </Column>
        )
      }`)
    expect(templates[0].children[0].props).toMatchObject({ fontWeight: 700 })
    expect(templates[0].children[1].props).toMatchObject({ fontWeight: 400 })
    expect(templates[0].children[2].props).toMatchObject({ fontWeight: 700 })
    expect(templates[0].children[3].props).toMatchObject({ fontWeight: 600 })
  })
})

describe("errors point at the source", () => {
  const err = (src: string) => {
    try {
      compile(src)
    } catch (e) {
      return (e as Error).message
    }
    return "no error"
  }
  test("unknown props and style keys", () => {
    expect(err(`function A() { return <Row flexDirection="row" /> }`)).toMatch(/test\.tsx:1:\d+: unknown prop "flexDirection"/)
    expect(err(`function A() { return <Row style={{ margin2: 1 }} /> }`)).toMatch(/unknown style key "margin2"/)
  })
  test("fontWeight outside React Native's values", () => {
    expect(err(`function A() { return <Text fontWeight="heavy">x</Text> }`)).toMatch(/test\.tsx:1:\d+: fontWeight must be 100–900/)
    expect(err(`function A() { return <Text style={{ fontWeight: 450 }}>x</Text> }`)).toMatch(/fontWeight must be 100–900.*got 450/)
    expect(err(`function A() { return <Text fontWeight="1000">x</Text> }`)).toMatch(/fontWeight must be 100–900/)
  })
  test("a layout prop that changes at runtime", () => {
    expect(err(`function A(p) { return <Row gap={p.gap} /> }`)).toMatch(/"gap" must be known at build time/)
    // Per-edge padding may change (headers padded by insets()); the shorthands may not.
    expect(err(`function A(p) { return <Row style={{ paddingTop: p.top, paddingHorizontal: 20 }} /> }`)).toBe("no error")
    expect(err(`function A(p) { return <Row style={{ padding: p.top }} /> }`)).toMatch(/"padding" must be known at build time/)
  })
  test("text outside <Text>, missing keys, stray JSX", () => {
    expect(err(`function A() { return <Row>hi</Row> }`)).toMatch(/text must be inside <Text>/)
    expect(err(`function A(p) { return <Row>{p.xs.map((x) => <Text>{x}</Text>)}</Row> }`)).toMatch(/need a key/)
    expect(err(`const x = <Row />`)).toMatch(/only supported as the return value of a component/)
    expect(err(`function A(p) { return <Pressable onPress={() => <Row />} /> }`)).toMatch(/JSX isn't allowed here/)
  })
  test("invalid values are reported by the template writer with the location", () => {
    expect(err(`function A() { return <Row justifyContent="middle" /> }`)).toMatch(/test\.tsx:1:\d+: .*needs one of/)
  })
})

describe("end to end: compiled code runs on the view runtime", () => {
  test("mounts, reacts and removes", async () => {
    const { code, templates } = compile(`
      import { signal } from "@zero-native/core"
      function Row1(props) { return <Text>{props.label}</Text> }
      export const state = { items: signal([{ id: 1, n: "a" }, { id: 2, n: "b" }]), show: signal(true) }
      export function Screen() {
        return (
          <Column>
            {state.show() && <Text>banner</Text>}
            {state.items().map((it) => <Row1 key={it.id} label={it.n} />)}
          </Column>
        )
      }`)
    const dir = join(import.meta.dir, ".tmp")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `e2e-${Date.now()}.ts`)
    writeFileSync(file, code)

    const { installFakeHost } = await import("../../packages/core/test/fake-host")
    const host = installFakeHost()
    const core = await import("@zero-native/core")
    core.installRuntime()
    const mod = await import(file)
    core.renderRoot(0x80000001, mod.Screen, {})

    const kinds = () => host.ops.map((o) => o[0])
    // banner branch (template 1) + two rows (template of Row1 is 0? no: Row1 compiled first → 0)
    expect(kinds()).toEqual(["mount", "mount", "mount"])
    expect(templates[0].type).toBe("Text") // Row1
    expect(host.ops[1][6]).toEqual(["a"])
    host.ops.length = 0
    mod.state.show.set(false)
    mod.state.items.set([mod.state.items()[1]])
    expect(kinds()).toEqual(["remove", "remove"])
    expect(Component.Anchor).toBe(10)
    expect(Prop.text.id).toBe(50)
  })
})
