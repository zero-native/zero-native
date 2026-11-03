import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Component, Prop, type NodeSpec, writeTemplateFile } from "@zero-native/template"
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

describe("feeds: gradients and rails", () => {
  test("HTML entities in JSX text and string attributes are decoded, as in React", () => {
    const { templates } = compile(`
      function A(p) {
        return (
          <Column>
            <Text>Tap to view &amp; redeem &#8377;5 &#x20B9;6</Text>
            <Child label="a &lt; b" />
          </Column>
        )
      }`)
    expect(templates[0].children[0].props).toMatchObject({ text: "Tap to view & redeem ₹5 ₹6" })
  })
  test("backgroundImage linear-gradient is parsed at build time", () => {
    const { templates } = compile(`
      function A() {
        return (
          <Column>
            <Box style={{ backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 100%)" }} />
            <Box style={{ backgroundImage: "linear-gradient(to right, #047857, #0F172A)" }} />
          </Column>
        )
      }`)
    expect(templates[0].children[0].props).toMatchObject({ backgroundImage: `180|0@0|${0xd9000000}@1` })
    expect(templates[0].children[1].props).toMatchObject({ backgroundImage: `90|${0xff047857}@-1|${0xff0f172a}@-1` })
  })
  test("a .map inside a horizontal Scroll is a rail of keyed card instances", () => {
    const { code, templates } = compile(`
      function Rail(p) {
        return <Scroll horizontal style={{ gap: 12, paddingHorizontal: 16 }}>{p.items.map((o) => <Box key={o.id} />)}</Scroll>
      }`)
    expect(templates[0].type).toBe("Scroll")
    expect(templates[0].props).toMatchObject({ horizontal: true, gap: 12, paddingHorizontal: 16 })
    expect(code).toMatch(/__zn\.each\(__i0, 1, \(\) => \(p\.items\)/)
  })
  test("a Carousel: pages from .map, settings in the template, onPageChange as an event", () => {
    const { code, templates } = compile(`
      function Banners(p) {
        return (
          <Carousel itemWidth={300} autoAdvance={4500} dots style={{ gap: 12, paddingHorizontal: 16 }}
            onPageChange={(i) => p.seen(i)}>
            {p.offers.map((o) => <Box key={o.id} />)}
          </Carousel>
        )
      }`)
    expect(templates[0].type).toBe("Carousel")
    expect(templates[0].props).toMatchObject({ itemWidth: 300, autoAdvance: 4500, dots: true, gap: 12 })
    expect(code).toMatch(/__zn\.on\(__i0, \d+, \(i\) => p\.seen\(i\)\)/)
    expect(code).toMatch(/__zn\.each\(__i0, 1, \(\) => \(p\.offers\)/)
  })
  test("gradient errors", () => {
    const err = (src: string) => {
      try {
        compile(src)
      } catch (e) {
        return (e as Error).message
      }
      return "no error"
    }
    expect(err(`function A() { return <Box style={{ backgroundImage: "radial-gradient(red, blue)" }} /> }`))
      .toMatch(/only linear gradients/)
    expect(err(`function A() { return <Box style={{ backgroundImage: "linear-gradient(#000)" }} /> }`)).toMatch(/at least 2/)
  })
})

describe("<List>", () => {
  test("each row kind is its own template; type() picks it without building the row", () => {
    const { templates, code } = compile(`
      function Card(p) { return <Column><Text>{p.it.name}</Text></Column> }
      export function Feed(p) {
        return (
          <Column style={{ flex: 1 }}>
            <List data={p.items} key={(it) => it.id} style={{ flex: 1 }} onEndReached={() => p.more()}
              row={(it) => it.kind === "header" ? <Text fontSize={18}>{it.title}</Text> : <Card it={it} />} />
          </Column>
        )
      }`)
    const feed = templates.find((t) => t?.children?.[0]?.type === "List")!
    expect(feed.children[0].props).toMatchObject({ flex: 1 })
    // Header leaf = a template; Card leaf = the component (its id from Card.__zt at runtime).
    expect(code).toMatch(/__zn\.list\(__i0, 1, \{ data: \(\) => \(p\.items\), key: \(it\) => it\.id/)
    expect(code).toMatch(/type: \(it\) => \(it\.kind === "header"\) \? \d+ : \(Card\.__zt \?\? 0\)/)
    expect(code).toMatch(/onEndReached: \(\) => p\.more\(\)/)
    expect(code).toMatch(/Card\.__zt = \d+;/)
    expect(code).toMatch(/Feed\.__zt = \d+;/)
  })
  test("errors", () => {
    const err = (src: string) => {
      try {
        compile(src)
      } catch (e) {
        return (e as Error).message
      }
      return "no error"
    }
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} /> }`)).toMatch(/<List> needs row/)
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={(i) => i.ok && <Row/>} /> }`))
      .toMatch(/a row must be one JSX element/)
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={(i) => <Row/>}><Row/></List> }`))
      .toMatch(/takes no children/)
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

describe("source map (zn dev error lines)", () => {
  test("copied code maps to its TSX line and column; generated code to its JSX", () => {
    const src = [
      `import { Column, Pressable, Text } from "@zero-native/ui"`, // 0
      `export function Screen() {`, // 1
      `  const n = signal(0)`, // 2
      `  return (`, // 3
      `    <Column>`, // 4
      `      <Pressable onPress={() => {`, // 5
      `        boom(n())`, // 6
      `      }}>`, // 7
      `        <Text>Count {n()}</Text>`, // 8
      `      </Pressable>`, // 9
      `    </Column>`, // 10
      `  )`, // 11
      `}`, // 12
    ].join("\n")
    const { code, map } = compile(src)
    expect(code).not.toMatch(/[\u0001-\u0003]/) // markers are gone
    const lines = code.split("\n")
    const at = (needle: string) => {
      const line = lines.findIndex((l) => l.includes(needle))
      return map.lookup(line, lines[line].indexOf(needle))
    }
    expect(at("boom(n())")).toEqual({ line: 6, col: 8 })
    expect(at("const n = signal(0)")).toEqual({ line: 2, col: 2 })
    expect(at("__zn.ready")?.line).toBe(4) // generated: points at the screen's root element
  })
})

describe("fragments, children and spans (step 3.2)", () => {
  test("a fragment root becomes a Fragment template; a fragment child is flattened", () => {
    const { templates } = compile(`
      export function Pair() {
        return (
          <>
            <Text>A</Text>
            <Column>
              <>
                <Text>B</Text>
                <Text>C</Text>
              </>
            </Column>
          </>
        )
      }`)
    const root = templates[0]
    expect(root.type).toBe("Fragment")
    expect(root.children.map((c) => c.type)).toEqual(["Text", "Column"])
    expect(root.children[1].children.map((c) => (c.props as any).text)).toEqual(["B", "C"]) // no extra node
  })

  test("children and JSX props of a user component become functions; {props.children} is an insert", () => {
    const { templates, code } = compile(`
      function Card(props) {
        return <Column padding={8}>{props.header}{props.children}</Column>
      }
      export function Screen() {
        return (
          <Column>
            <Card header={<Text>Title</Text>}>
              <Text>One</Text>
              <Text>Two</Text>
            </Card>
          </Column>
        )
      }`)
    expect(templates[0].children.map((c) => c.type)).toEqual(["Anchor", "Anchor"])
    expect(code).toContain("__zn.insert(__i0, 1, () => (props.header));")
    expect(code).toContain("__zn.insert(__i0, 2, () => (props.children));")
    expect(code).toMatch(/"header": \(\) => __zn\.view\(\d+,/)
    expect(code).toMatch(/"children": \(\) => __zn\.view\(\d+,/)
    const fragment = templates.find((t) => t?.type === "Fragment")!
    expect(fragment.children.map((c) => (c.props as any).text)).toEqual(["One", "Two"])
  })

  test("one child is passed as itself, with no Fragment", () => {
    const { templates, code } = compile(`
      function Card(props) { return <Column>{props.children}</Column> }
      export function Screen() {
        return <Column><Card><Text>Only</Text></Card></Column>
      }`)
    expect(templates.some((t) => t?.type === "Fragment")).toBe(false)
    expect(code).toMatch(/"children": \(\) => __zn\.view\(/)
  })

  test("nested <Text> becomes spans: styles as JSON, texts joined by U+001F", () => {
    const { templates, code } = compile(`
      export function T() {
        const name = signal("Asha")
        return (
          <Column>
            <Text>Pay <Text fontWeight="bold" color="#047857">₹400</Text> now</Text>
            <Text>Hi <Text style={{ fontStyle: "italic" }}>{name()}</Text>!</Text>
          </Column>
        )
      }`)
    const [a, b] = templates[0].children
    expect((a.props as any).text).toBe("Pay \u001f₹400\u001f now")
    expect(JSON.parse((a.props as any).spans)).toEqual([{}, { fontWeight: 700, color: 0xff047857 }, {}])
    expect(JSON.parse((b.props as any).spans)).toEqual([{}, { fontStyle: 1 }, {}])
    const sep = JSON.stringify("\u001f") // how the separator appears in the generated code
    expect(code).toContain(`() => "Hi " + ${sep} + __zn.str(name()) + ${sep} + "!"`)
  })

  test("spans reject runtime styles and events", () => {
    expect(() =>
      compile(`export function T() { const c = signal("#000"); return <Text>a <Text color={c()}>b</Text></Text> }`),
    ).toThrow(/must be known at build time/)
    expect(() => compile(`export function T() { return <Text>a <Text onPress={() => 1}>b</Text></Text> }`)).toThrow(
      /isn't supported yet/,
    )
  })

  test("a controlled TextField wraps onChangeText with textInput()", () => {
    const { templates, code } = compile(`
      export function F() {
        const amount = signal("")
        return <TextField value={amount()} onChangeText={(t) => amount.set(t)} keyboardType="number-pad" />
      }`)
    expect(templates[0].type).toBe("TextField")
    expect((templates[0].props as any).value).toEqual({ $slot: "s0", default: null })
    expect(code).toContain("__zn.on(__i0, 1, __zn.textInput(__i0, 0, () => (amount()), (t) => amount.set(t)));")
  })

  test("a TextField ref gets an event id and is bound with fieldRef()", () => {
    const { templates, code } = compile(`
      export function F() {
        const code = createRef()
        return <TextField ref={code} onFocus={() => 1} />
      }`)
    const p = templates[0].props as any
    expect(p.ref).toBeDefined()
    expect(p.onFocus).toBeDefined()
    expect(p.ref).not.toEqual(p.onFocus)
    expect(code).toMatch(/__zn\.fieldRef\(__i0, \d+, code\);/)
  })

  test("ref works only on TextField, and needs a value", () => {
    expect(() => compile(`export function T() { const r = createRef(); return <Box ref={r} /> }`)).toThrow(/only on <TextField>/)
    expect(() => compile(`export function T() { return <TextField ref /> }`)).toThrow(/createRef/)
  })
})

describe("animation (step 3.6)", () => {
  test("animate and enter / exit are encoded at build time; transforms can change at runtime", () => {
    const { templates, code } = compile(`
      export function F() {
        const open = signal(false)
        return (
          <Box
            style={{ opacity: open() ? 1 : 0, transform: [{ translateY: open() ? 0 : 40 }, { scale: 0.98 }] }}
            animate={{ opacity: 200, translateY: "spring", rotate: { duration: 300, easing: "ease-out" } }}
            enter="fade-up"
            exit={{ opacity: 0, scale: 0.9, duration: 120 }}
          />
        )
      }`)
    const p = templates[0].props as any
    expect(p.animate).toBe(`${Prop.opacity.id}=t200e0;${Prop.translateY.id}=s0.75,400;${Prop.rotate.id}=t300e1`)
    expect(p.enter).toBe("0,0,16,1|t220e1")
    expect(p.exit).toBe("0,0,0,0.9|t120e0")
    expect(p.scale).toBe(0.98)
    expect(p.translateY).toEqual({ $slot: "s1", default: null })
    expect(code).toContain("() => (open() ? 0 : 40)")
  })

  test("animate shorthand and exit presets move the other way", () => {
    const { templates } = compile(`export function F() { return <Box animate={250} exit="fade-up" /> }`)
    expect((templates[0].props as any).animate).toBe("*=t250e0")
    expect((templates[0].props as any).exit).toBe("0,0,-16,1|t160e2")
  })

  test("bad animation values fail with a clear message", () => {
    expect(() => compile(`export function F() { return <Box animate={{ fontSize: 200 }} /> }`)).toThrow("can't be animated")
    expect(() => compile(`export function F() { return <Box enter="spin" /> }`)).toThrow("use a preset")
    expect(() => compile(`export function F() { return <Box animate={-5} /> }`)).toThrow("0–10000 ms")
  })
})

describe("motion options: loops, keyframes, delay, bezier (registry 11)", () => {
  const props = (src: string) => compile(`export function F() { return ${src} }`).templates[0]!.props as any
  const err = (src: string) => {
    try {
      compile(`export function F() { return ${src} }`)
    } catch (e) {
      return (e as Error).message
    }
    return "no error"
  }
  const id = (k: keyof typeof Prop) => Prop[k].id

  test("a spinner, a pulse, a shake and a colour loop are encoded after ~", () => {
    expect(props(`<Box animate={{ rotate: { duration: 900, easing: "linear", repeat: "forever", from: 0 } }} style={{ transform: [{ rotate: 360 }] }} />`).animate)
      .toBe(`${id("rotate")}=t900e3~f0~r-1`)
    expect(props(`<Box animate={{ scale: { duration: 600, repeat: 3, reverse: true, from: 1, delay: 200, repeatDelay: 100 } }} />`).animate)
      .toBe(`${id("scale")}=t600e0~d200~f1~r3~v~g100`)
    expect(props(`<Box animate={{ translateX: { duration: 300, keyframes: [0, -8, 8, -8, 0], times: [0, 0.2, 0.5, 0.8, 1] } }} />`).animate)
      .toBe(`${id("translateX")}=t300e0~k0:-8:8:-8:0~m0:0.2:0.5:0.8:1`)
    expect(props(`<Box animate={{ backgroundColor: { duration: 800, repeat: "forever", reverse: true, from: "#EEE" } }} />`).animate)
      .toBe(`${id("backgroundColor")}=t800e0~f#FFEEEEEE~r-1~v`)
    expect(props(`<Box animate={{ opacity: { spring: { damping: 0.5 }, from: 0, repeat: 2 } }} />`).animate)
      .toBe(`${id("opacity")}=s0.5,400~f0~r2`)
  })

  test("delay and cubic-bezier on value changes and on enter / exit", () => {
    expect(props(`<Box animate={{ duration: 250, easing: [0.4, 0, 0.2, 1], delay: 80 }} />`).animate).toBe("*=t250e4~b0.4:0:0.2:1~d80")
    expect(props(`<Box enter={{ opacity: 0, translateY: 12, delay: 120 }} />`).enter).toBe("0,0,12,1|t220e1~d120")
    expect(props(`<Box exit={{ opacity: 0, duration: 100, delay: 40 }} />`).exit).toBe("0,0,0,1|t100e0~d40")
  })

  test("old timings are written exactly as before and need no new registry", () => {
    const { templates } = compile(`export function F() { return <Box animate={{ opacity: 200, rotate: { duration: 300, easing: "ease-out" } }} enter="fade" /> }`)
    expect((templates[0]!.props as any).animate).toBe(`${id("opacity")}=t200e0;${id("rotate")}=t300e1`)
    expect(writeTemplateFile(templates).registry).toBe(8)
    const looped = compile(`export function F() { return <Box animate={{ rotate: { duration: 900, repeat: "forever", from: 0 } }} /> }`)
    expect(writeTemplateFile(looped.templates).registry).toBe(11)
  })

  test("paused and replay can change at runtime", () => {
    const { templates, code } = compile(`export function F() {
      const tries = signal(0)
      const on = signal(true)
      return <Box paused={!on()} replay={tries()} animate={{ translateX: { duration: 300, keyframes: [0, -8, 8, 0] } }} />
    }`)
    expect((templates[0]!.props as any).paused).toEqual({ $slot: "s0", default: null })
    expect((templates[0]!.props as any).replay).toEqual({ $slot: "s1", default: null })
    expect(code).toContain("() => (tries())")
  })

  test("wrong motion options fail with a hint", () => {
    expect(err(`<Box animate={{ duration: 300, repeat: 2, from: 0 }} />`)).toContain("belong to one prop")
    expect(err(`<Box animate={{ scale: { duration: 300, repeat: 2 } }} />`)).toContain("repeat needs a start")
    expect(err(`<Box animate={{ scale: { duration: 300, from: 0, reverse: true } }} />`)).toContain("reverse needs repeat")
    expect(err(`<Box animate={{ scale: { duration: 300, from: 0, repeat: 0 } }} />`)).toContain("how many times it plays")
    expect(err(`<Box animate={{ scale: { duration: 300, from: 0, keyframes: [0, 1] } }} />`)).toContain("not both")
    expect(err(`<Box animate={{ scale: { duration: 300, keyframes: [1] } }} />`)).toContain("at least 2 values")
    expect(err(`<Box animate={{ scale: { duration: 300, keyframes: [0, 1], times: [0, 0.5] } }} />`)).toContain("one number per keyframe")
    expect(err(`<Box animate={{ scale: { duration: 300, keyframes: [0, 1], times: [0.1, 1] } }} />`)).toContain("rising from 0 to 1")
    expect(err(`<Box animate={{ scale: { duration: 300, times: [0, 1] } }} />`)).toContain("times goes with keyframes")
    expect(err(`<Box animate={{ scale: { spring: {}, keyframes: [0, 1] } }} />`)).toContain("need a duration")
    expect(err(`<Box animate={{ scale: { duration: 300, easing: [2, 0, 0.2, 1] } }} />`)).toContain("x1 and x2 must be within 0–1")
    expect(err(`<Box animate={{ scale: { duration: 300, easing: [0.4, 0] } }} />`)).toContain("4 numbers")
    expect(err(`<Box animate={{ backgroundColor: { duration: 300, from: 1, repeat: 2 } }} />`)).toContain("must be colours")
    expect(err(`<Box animate={{ scale: { duration: 300, from: "#fff", repeat: 2 } }} />`)).toContain("must be numbers")
    expect(err(`<Box animate={{ scale: { duration: 300, delay: 99999 } }} />`)).toContain("delay is 0–60000 ms")
    expect(err(`<Box animate={{ scale: { duration: 300, loop: true } }} />`)).toContain('unknown key "loop"')
    expect(err(`<Box enter={{ opacity: 0, duration: 200, repeat: 2 }} />`)).toContain(`"repeat" isn't for enter / exit`)
    expect(err(`<Box enter={{ opacity: 0, timing: "spring", delay: 50 }} />`)).toContain("with delay, give the timing")
  })
})
