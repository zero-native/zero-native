// Compiler pack (guide notes §47): build-time constants in component bodies and simple operators on them, and JSX
// held in variables (`const x = <A/>`, `const x = c ? <A/> : null`), with their errors.
import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { NodeSpec } from "@zero-native/template"
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

function err(src: string, statics: Record<string, unknown> = {}) {
  try {
    compile(src, statics)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

const props = (n: NodeSpec) => n.props as Record<string, unknown>

describe("build-time values: body consts, operators, template strings", () => {
  test("a const at the top of a component body can set a layout value", () => {
    const { templates } = compile(`
      export function Avatar(p) {
        const SIZE = 40
        const half = SIZE / 2
        return <Box style={{ width: SIZE, height: SIZE, borderRadius: half, margin: SIZE * 0.1 }} />
      }`)
    expect(props(templates[0])).toMatchObject({ width: 40, height: 40, borderRadius: 20, margin: 4 })
  })

  test("ternaries, ??, ||, &&, !, comparisons and math on constants", () => {
    const { templates } = compile(`
      const COMPACT = true
      const BASE = 8
      const NONE = null
      const sizes = { sm: 40, md: 48 }
      export function Button(p) {
        const pad = COMPACT ? BASE : BASE * 2
        return (
          <Column style={{ height: COMPACT ? sizes.sm : sizes.md, padding: pad, gap: NONE ?? 12, margin: 0 || 6 }}>
            <Text fontSize={BASE + 6 - 2} numberOfLines={!COMPACT ? 2 : 1}>{BASE >= 8 && "big"}</Text>
            <Text>{BASE % 3 === 2 ? "two" : "other"}</Text>
          </Column>
        )
      }`)
    expect(props(templates[0])).toMatchObject({ height: 40, padding: 8, gap: 12, margin: 6 })
    expect(props(templates[0].children[0])).toMatchObject({ fontSize: 12, numberOfLines: 1, text: "big" })
    expect(props(templates[0].children[1]).text).toBe("two")
  })

  test("template strings with constants are folded; with runtime values they stay a slot", () => {
    const { templates, code } = compile(`
      const RUPEE = "₹"
      const W = 120
      export function Price(p) {
        return (
          <Column>
            <Text>{\`\${RUPEE}\${W * 2}\`}</Text>
            <Box accessibilityLabel={\`https://x.test/\${W}.png\`} style={{ width: W, height: W }} />
            <Text>{\`\${RUPEE}\${p.amount}\`}</Text>
          </Column>
        )
      }`)
    expect(props(templates[0].children[0]).text).toBe("₹240")
    expect(props(templates[0].children[1]).accessibilityLabel).toBe("https://x.test/120.png")
    expect(props(templates[0].children[2]).text).toMatchObject({ $slot: "s0" })
    expect(code).toContain("__zn.str(`${RUPEE}${p.amount}`)")
  })

  test("a parameter or local with the same name hides a const (looked up as JavaScript does)", () => {
    const { templates } = compile(`
      const size = 20
      export function Grid(p) {
        return <Column>{p.items.map((size) => <Text key={size} fontSize={14}>{size}</Text>)}</Column>
      }
      export function Other(p) {
        let gap = 4
        return <Column gap={size}><Text>{gap}</Text></Column>
      }`)
    // In Grid, {size} is the .map parameter: a runtime text slot, not "20".
    const row = templates.find((t) => t?.type === "Text" && (t.props as any).fontSize === 14)!
    expect(props(row).text).toMatchObject({ $slot: "s0" })
    const other = templates.find((t) => t?.type === "Column" && (t.props as any).gap === 20)!
    expect(props(other.children[0]).text).toMatchObject({ $slot: "s0" })
  })

  test("a local let is not a build-time value", () => {
    expect(err(`export function A(p) { let a = "center"; return <Box style={{ alignItems: a }} /> }`)).toMatch(/"alignItems" must be known at build time/)
  })

  test("operators on runtime values stay runtime; only the used side of && / || must be known", () => {
    const { templates } = compile(`
      const OFF = false
      export function A(p) {
        return <Box style={{ width: 40 || p.w, height: OFF ? p.h : 30, opacity: p.o ? 1 : 0.5 }} />
      }`)
    expect(props(templates[0]).width).toBe(40)
    expect(props(templates[0]).opacity).toMatchObject({ $slot: "s0" })
  })
})

describe("JSX in variables (G4)", () => {
  test("const x = <A/> in a body, used twice: each use is its own copy", () => {
    const { templates, code } = compile(`
      export function Card(p) {
        const label = <Text fontSize={14}>{p.title}</Text>
        return <Column>{label}<Row>{label}</Row></Column>
      }`)
    expect(templates).toHaveLength(1)
    expect(templates[0].children[0].type).toBe("Text")
    expect(templates[0].children[1].children[0].type).toBe("Text")
    expect(code).not.toContain("const label")
    expect(code).not.toContain("<Text")
  })

  test("a JSX const at module level, and one that uses another", () => {
    const { templates } = compile(`
      const dot = <Box style={{ width: 4, height: 4 }} />
      export function Line(p) {
        const both = <Row>{dot}{dot}</Row>
        return <Column>{both}</Column>
      }`)
    const row = templates[0].children[0]
    expect(row.type).toBe("Row")
    expect(row.children.map((c) => c.type)).toEqual(["Box", "Box"])
  })

  test("const x = c ? <A/> : <B/> as a child becomes an anchor; nested ternaries with null work", () => {
    const { templates, code } = compile(`
      export function Status(p) {
        const badge = p.ok ? <Text>ok</Text> : p.wait ? <Text>wait</Text> : null
        return <Row>{badge}</Row>
      }`)
    expect(templates[0].children[0].type).toBe("Anchor")
    expect(code).toContain("__zn.when(__i0, 1, () => (p.ok)")
    // The nested choice is a Fragment with its own anchor.
    expect(templates.some((t) => t?.type === "Fragment" && t.children[0]?.type === "Anchor")).toBe(true)
  })

  test("return x, return c ? <A/> : <B/>, and an arrow body ternary", () => {
    const { templates, components, code } = compile(`
      export function A(p) {
        const body = <Text>a</Text>
        return body
      }
      export function B(p) {
        return p.big ? <Text fontSize={20}>B</Text> : <Text fontSize={12}>b</Text>
      }
      export const C = (p) => p.on && <Text>c</Text>
      `)
    expect(templates[components.A].type).toBe("Text")
    expect(templates[components.B].type).toBe("Fragment")
    expect(templates[components.B].children[0].type).toBe("Anchor")
    expect(templates[components.C].type).toBe("Fragment")
    expect(code).toContain("__zn.when(")
  })

  test("as a prop: icon={x} on a user component and refreshControl={x} on a Scroll", () => {
    const { code, templates } = compile(`
      function Tile(p) { return <Column>{p.icon}</Column> }
      export function Screen(p) {
        const icon = <Text>i</Text>
        const maybe = p.show ? <Text>m</Text> : null
        const refresh = <RefreshControl refreshing={p.busy} onRefresh={p.reload} />
        return (
          <Scroll refreshControl={refresh}>
            <Tile icon={icon} />
            <Tile icon={maybe} />
          </Scroll>
        )
      }`)
    expect(code).toMatch(/"icon": \(\) => __zn\.view\(/)
    // A conditional JSX prop: a getter over functions made once.
    expect(code).toMatch(/\(\(__zp1_0\) => \(\{ get "icon"\(\) \{ return \(p\.show\) \? __zp1_0 : null \} \}\)\)\(\(\) => __zn\.view\(/)
    const scroll = templates.find((t) => t?.type === "Scroll")!
    expect(props(scroll).refreshing).toMatchObject({ $slot: "s0" })
  })

  test("inside .map rows and List rows", () => {
    const { templates, code } = compile(`
      export function L(p) {
        const chevron = <Text>›</Text>
        return (
          <Column>
            {p.items.map((it) => <Row key={it.id}><Text>{it.name}</Text>{chevron}</Row>)}
            <List data={p.items} key={(it) => it.id} row={(it) => <Row>{chevron}</Row>} />
          </Column>
        )
      }`)
    const rows = templates.filter((t) => t?.type === "Row")
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.children.some((c) => c.type === "Text"))).toBe(true)
    expect(code).not.toContain("chevron")
  })

  test("<Card>{content}</Card> is the same as writing the JSX there", () => {
    const a = compile(`
      function Card(p) { return <Column>{p.children}</Column> }
      export function S(p) { const content = <Text>x</Text>; return <Card>{content}</Card> }`)
    const b = compile(`
      function Card(p) { return <Column>{p.children}</Column> }
      export function S(p) { return <Card><Text>x</Text></Card> }`)
    expect(a.templates).toEqual(b.templates)
  })

  test("a let that is never assigned again works like a const; an unused JSX const is dropped", () => {
    const { code } = compile(`
      export function A(p) {
        let x = <Text>x</Text>
        const unused = <Text>never</Text>
        return <Column>{x}</Column>
      }`)
    expect(code).not.toContain("never")
    expect(code).not.toContain("let x")
  })
})

describe("JSX in variables: errors with hints", () => {
  test("a let assigned again → one ternary", () => {
    expect(err(`export function A(p) { let x = <Text>a</Text>; if (p.b) x = <Text>b</Text>; return <Row>{x}</Row> }`))
      .toMatch(/x holds JSX and is assigned again: .*const x = cond \? <A \/> : <B \/>/)
    expect(err(`export function A(p) { let x; if (p.b) x = <Text>b</Text>; return <Row>{x}</Row> }`))
      .toMatch(/JSX can't be assigned to a variable later .*pick with one ternary/)
  })

  test("arr.push(<X/>) → .map; JSX in an array → in place or .map", () => {
    expect(err(`export function A(p) { const rows = []; for (const r of p.rs) rows.push(<Text>{r}</Text>); return <Column>{rows}</Column> }`))
      .toMatch(/JSX can't be collected in an array .*\.map/)
    expect(err(`export function A(p) { const xs = [<Text>a</Text>]; return <Column>{xs}</Column> }`))
      .toMatch(/JSX can't go in an array/)
  })

  test("a JSX const used outside JSX", () => {
    expect(err(`export function A(p) { const x = <Text>a</Text>; log(x); return <Column>{x}</Column> }`))
      .toMatch(/x holds JSX, which is compiled at build time, so it isn't a value at runtime/)
    expect(err(`export function A(p) { const x = <Text>a</Text>; return <Pressable onPress={() => show(x)}>{x}</Pressable> }`))
      .toMatch(/x holds JSX/)
    expect(err(`export function A(p) { const Header = <Text>a</Text>; return <Column><Header /></Column> }`))
      .toMatch(/Header holds JSX, not a component: show it with \{Header\}/)
    expect(err(`export const x = <Text>a</Text>`)).toMatch(/JSX can't be exported as a value/)
    expect(err(`const x = <Text>a</Text>\nexport { x }`)).toMatch(/x holds JSX/)
    expect(err(`export function A(p) { const x = <Text>a</Text>; return <Text>{x}</Text> }`))
      .toMatch(/a JSX const can't be used inside <Text>/)
  })

  test("JSX that would read a different name where it lands", () => {
    const msg = err(`
      export function A(p) {
        const item = p.first
        const label = <Text>{item.name}</Text>
        return <Column>{p.items.map((item) => <Row key={item.id}>{label}</Row>)}</Column>
      }`)
    expect(msg).toMatch(/test\.tsx:5:\d+: label is JSX that reads "item" \(line 4\), but here "item" is a different name/)
  })

  test("JSX in a lowercase helper → make it a component", () => {
    expect(err(`const renderRow = (r) => <Text>{r}</Text>`)).toMatch(/renderRow returns JSX but isn't a component: .*function RenderRow\(props\)/)
  })

  test("two consts in one statement, var", () => {
    expect(err(`export function A(p) { const a = <Text>a</Text>, n = 1; return <Row>{a}</Row> }`)).toMatch(/put a JSX const on its own line/)
    expect(err(`export function A(p) { var a = <Text>a</Text>; return <Row>{a}</Row> }`)).toMatch(/use const for JSX/)
  })
})

describe("JSX in variables: compiled code runs on the view runtime", () => {
  test("copies, a ternary root and a conditional JSX prop react like React", async () => {
    const { code, templates, components } = compile(`
      import { signal } from "@zero-native/core"
      export const state = { big: signal(false), show: signal(true) }
      function Tile(props) { return <Column>{props.icon}</Column> }
      export function Head() {
        return state.big() ? <Text fontSize={20}>BIG</Text> : <Text fontSize={12}>small</Text>
      }
      export function Screen() {
        const dot = <Text>•</Text>
        const maybe = state.show() ? <Text>shown</Text> : null
        return (
          <Column>
            {dot}
            <Head />
            <Tile icon={maybe} />
            {dot}
          </Column>
        )
      }`)
    const dir = join(import.meta.dir, ".tmp")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `jsxvars-${Date.now()}.ts`)
    writeFileSync(file, code)

    const { installFakeHost } = await import("../../packages/core/test/fake-host")
    const host = installFakeHost()
    const core = await import("@zero-native/core")
    core.installRuntime()
    const mod = await import(file)
    core.renderRoot(0x80000002, mod.Screen, {})

    const mounted = () => host.ops.filter((o) => o[0] === "mount").map((o) => o[1] as number)
    const shownTexts = () => mounted().map((t) => templates[t]).filter((t) => t.type === "Text").map((t) => t.props.text)
    // Screen, Head's fragment + its "small" branch, Tile, the "shown" icon.
    expect(shownTexts()).toEqual(["small", "shown"])
    const screen = templates[components.Screen]
    expect(screen.children.filter((c) => c.type === "Text").map((c) => (c.props as any).text)).toEqual(["•", "•"])

    host.ops.length = 0
    mod.state.big.set(true)
    expect(shownTexts()).toEqual(["BIG"])
    expect(host.ops.filter((o) => o[0] === "remove")).toHaveLength(1)

    host.ops.length = 0
    mod.state.show.set(false)
    expect(host.ops.map((o) => o[0])).toEqual(["remove"])
    host.ops.length = 0
    mod.state.show.set(true)
    expect(shownTexts()).toEqual(["shown"])
  })
})


describe("JSX in variables: source map", () => {
  test("code copied from a JSX const points at the line where the const is written", () => {
    const src = [
      `export function Screen() {`, // 0
      `  const n = signal(0)`, // 1
      `  const tap = <Pressable onPress={() => {`, // 2
      `    boom(n())`, // 3
      `  }}><Text>tap</Text></Pressable>`, // 4
      `  return <Column>{tap}</Column>`, // 5
      `}`, // 6
    ].join("\n")
    const { code, map } = compile(src)
    const lines = code.split("\n")
    const line = lines.findIndex((l) => l.includes("boom(n())"))
    expect(map.lookup(line, lines[line].indexOf("boom(n())"))).toEqual({ line: 3, col: 4 })
  })
})

describe("guide notes §47 example", () => {
  test("the sized-atom example compiles as written in the guide", async () => {
    // Read from the guide itself, so the guide can't drift from what really compiles.
    const guide = await Bun.file(join(import.meta.dir, "../../docs/guide-notes.md")).text()
    const section = guide.slice(guide.indexOf("## 47."), guide.indexOf("## 48."))
    const example = /```tsx\r?\n([\s\S]*?)```/.exec(section)?.[1]
    expect(example).toContain("export function PrimaryButton")
    // The example uses the app's own styles (s.base) and type tokens (t.button), as a real atom would import them.
    const { templates, components, code } = compile(example!, {
      s: { base: { alignItems: "center", justifyContent: "center", paddingStart: 20, paddingEnd: 20 } },
      t: { button: { fontSize: 16, fontWeight: "600" } },
    })
    const root = templates[components.PrimaryButton]
    expect(root.type).toBe("Fragment")
    const buttons = templates.filter((x) => x?.type === "Pressable")
    expect(buttons.map((b) => props(b).height).sort()).toEqual([48, 56])
    expect(buttons.every((b) => props(b).borderRadius === 16 && b.children[0].type === "Text")).toBe(true)
    expect(code).toContain('__zn.when(__i0, 1, () => (props.size === "lg")')
  })
})
