// React habits that compile but go wrong (guide notes §61, second-opinions 144). A zn component's body runs once, so a
// value it reads there is read once. Found by the RN dos / don'ts sweep (B1, B2, T1–T3), checked again 2026-11-05.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"
import { znBuild } from "../src/plugin"

/** Builds an app whose route "home" shows [screen] (a component in screens.tsx). */
async function build(screens: string, screen = "S") {
  const dir = mkdtempSync(join(tmpdir(), "zn-once-"))
  writeFileSync(join(dir, "screens.tsx"), `import { Column, Row, Text, Pressable } from "@zero-native/ui"\n${screens}`)
  writeFileSync(
    join(dir, "routes.ts"),
    `import { defineRoutes } from "@zero-native/core"
import * as s from "./screens"
import { ${screen} } from "./screens"
export const keep = s
export const routes = defineRoutes({ home: { path: "/", screen: ${screen} } })`,
  )
  const zn = znBuild()
  const out = await Bun.build({ entrypoints: [join(dir, "routes.ts")], plugins: [zn.plugin], packages: "external", target: "browser" })
  if (!out.success) throw new Error(out.logs.map(String).join("\n"))
  return zn.outputs(await out.outputs[0]!.text())
}
const fails = async (screens: string, screen = "S") => {
  try {
    await build(screens, screen)
  } catch (e: any) {
    if (e.errors && Array.isArray(e.errors)) {
      return e.errors.map((x: any) => x.message || String(x)).join("\n")
    }
    return (e as Error).message
  }
  return "no error"
}

describe("B2: async component", () => {
  test("is a build error with the fix", () => {
    const ctx = { reserveTemplate: () => 0, defineTemplate: () => {} }
    expect(() => compileModule(`async function Late() { return <Text>late</Text> }`, "a.tsx", ctx)).toThrow(
      "a.tsx:1:1: Late is an async function: a component can't wait",
    )
  })
})

describe("T3: destructured props", () => {
  test("in a child: simple destructured props compiles and reads live", async () => {
    await build(`
function Row1({ title }: { title: string }) { return <Text>{title}</Text> }
const t = () => "a"; export function S() { return <Column><Row1 title={t()} /></Column> }`)
  })
  test("in a child: rest pattern is a build error", async () => {
    const msg = await fails(`
function Row1({ ...rest }: any) { return <Text>hi</Text> }
export function S() { return <Column><Row1 /></Column> }`)
    expect(msg).toContain("Row1 takes its props destructured with a rest pattern (...rest)")
  })
  test("in a child: nested pattern is a build error", async () => {
    const msg = await fails(`
function Row1({ user: { name } }: any) { return <Text>{name}</Text> }
export function S() { return <Column><Row1 user={{ name: 'a' }} /></Column> }`)
    expect(msg).toContain("Row1 takes its props destructured with a nested pattern")
  })
  test("in a child: array pattern is a build error", async () => {
    const msg = await fails(`
function Row1([a, b]: any) { return <Text>{a}</Text> }
export function S() { return <Column><Row1 /></Column> }`)
    expect(msg).toContain("Row1 takes its props as an array pattern")
  })
  test("in a screen: fine (route params don't change while it is open)", async () => {
    await build(`export function S({ id }: { id: string }) { return <Column><Text>{id}</Text></Column> }`)
  })
})

describe("T2: early return on a value that can change", () => {
  test("top-level guard in a child: compiles to branch component (H2)", async () => {
    await build(`
import { signal } from "@zero-native/core"
const loading = signal(true)
function Body() { if (loading()) return <Text>wait</Text>; return <Text>done</Text> }
export function S() { return <Column><Body /></Column> }`)
  })
  test("top-level guard returning null: compiles to branch component (H2)", async () => {
    await build(`
const store = { ready: () => true }
function Body() { if (!store.ready()) return null; return <Text>done</Text> }
export function S() { return <Column><Body /></Column> }`)
  })
  test("early return in a refused shape (e.g. inside loop): build error", async () => {
    const msg = await fails(`
import { signal } from "@zero-native/core"
const loading = signal(true)
function Body() {
  while (true) { if (loading()) return <Text>wait</Text>; break }
  return <Text>done</Text>
}
export function S() { return <Column><Body /></Column> }`)
    expect(msg).toContain("early return inside a loop")
  })
  test("a constant, or a value read inside a handler: fine", async () => {
    await build(`
const COMPACT = false
function Body(p: { items: string[] }) {
  const tap = () => { if (p.items.length === 0) return; }
  if (COMPACT) return <Row />
  return <Pressable onPress={tap}><Text>x</Text></Pressable>
}
export function S() { return <Column><Body items={[]} /></Column> }`)
  })
})

describe("T1: a body value worked out once", () => {
  test("from props in a child: build error (the payment sheet's 'missing ₹9')", async () => {
    const msg = await fails(`
function Sheet(p: { amount: number }) {
  const missing = p.amount <= 0
  return <Text>{missing ? "missing" : "applied"}</Text>
}
const amt = () => 9; export function S() { return <Column><Sheet amount={amt()} /></Column> }`)
    expect(msg).toContain("screens.tsx:5:17: missing is worked out once, when Sheet mounts (line 4)")
    expect(msg).toContain("const missing = computed(() => ...)")
  })
  test("from a signal, also in a screen: build error", async () => {
    const msg = await fails(`
import { signal } from "@zero-native/core"
const total = signal(0)
export function S() {
  const shown = total() * 2
  return <Column><Text>{shown}</Text></Column>
}`)
    expect(msg).toContain("shown is worked out once, when S mounts (line 6)")
  })
  test("through another body value: build error", async () => {
    expect(await fails(`
function Sheet(p: { amount: number }) {
  const a = p.amount
  const label = a > 0 ? "paid" : "due"
  return <Text>{label}</Text>
}
const amt = () => 9; export function S() { return <Column><Sheet amount={amt()} /></Column> }`)).toContain("label is worked out once")
  })
  test("fine: props in a screen, computed, a handler, a factory, JSX in a const", async () => {
    await build(`
import { computed } from "@zero-native/core"
const makeController = () => ({ id: 1 })
function Sheet(p: { amount: number; onPay: (n: number) => void }) {
  const controller = makeController()
  const amount = p.amount
  const missing = computed(() => p.amount <= 0)
  const label = <Text>{p.amount}</Text>
  return (
    <Pressable onPress={() => p.onPay(amount + controller.id)}>
      <Text>{missing() ? "missing" : "applied"}</Text>
      {label}
    </Pressable>
  )
}
export function S(p: { id: string }) {
  const title = "Order " + p.id
  return <Column><Text>{title}</Text><Sheet amount={9} onPay={() => {}} /></Column>
}`)
  })
})

describe("props traps count only where props can change while the component stays mounted", () => {
  const sheet = `
function Sheet(p: { amount: number }) {
  const missing = p.amount <= 0
  return <Text>{missing ? "missing" : "applied"}</Text>
}`
  test("fixed props: fine", async () => {
    await build(`${sheet}\nexport function S() { return <Column><Sheet amount={9} /></Column> }`)
  })
  test("a row (.map, List renderItem): fine, a row mounts again when its item changes", async () => {
    await build(`${sheet}
import { signal } from "@zero-native/core"
const bills = signal([{ id: 1, amount: 9 }])
export function S() {
  return <Column>{bills().map((b) => <Sheet key={b.id} amount={b.amount} />)}</Column>
}`)
  })
  test("passed down from a parent whose prop reads a signal: build error", async () => {
    const msg = await fails(`${sheet}
import { signal } from "@zero-native/core"
const total = signal(9)
function Card(p: { amount: number }) { return <Column><Sheet amount={p.amount} /></Column> }
export function S() { return <Column><Card amount={total()} /></Column> }`)
    expect(msg).toContain("missing is worked out once, when Sheet mounts")
  })
  test("passed down from a screen's params: fine", async () => {
    await build(`${sheet}\nexport function S(p: { amount: number }) { return <Column><Sheet amount={p.amount} /></Column> }`)
  })
})

describe("B1: a child that returns null", () => {
  test("shows nothing, with no error (was a TypeError on v.templateId)", async () => {
    const templates: NodeSpec[] = []
    const ctx = {
      reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
      defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
    }
    const { code } = compileModule(
      `function Never() { return null as any }
       export function Screen() { return <Column><Text>top</Text><Never /></Column> }`,
      "b1.tsx", ctx,
    )
    const dir = join(import.meta.dir, ".tmp")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `b1-${Date.now()}.ts`)
    writeFileSync(file, code)
    const { installFakeHost } = await import("../../packages/core/test/fake-host")
    const host = installFakeHost()
    const core = await import("@zero-native/core")
    core.installRuntime()
    const mod = await import(file)
    core.renderRoot(0x80000201, mod.Screen, {})
    expect(host.logs.filter((l) => l[0] >= 3 && l[1].includes("left empty"))).toEqual([])
    expect(host.ops.filter((o) => o[0] === "mount")).toEqual([])
  })
})

// R52 (app-home-tabs, 2026-11-06): a restorableSignal / persistedSignal is a Signal, like signal(...). Its start value is
// read once on purpose (as signal's); the name was wrongly taken for "a value worked out once".
describe("restorableSignal and persistedSignal are signals", () => {
  test("a start value from a signal, read live in the JSX: fine", async () => {
    await build(`
import { persistedSignal, restorableSignal } from "@zero-native/core"
const profile = { user: () => ({ name: "Ravi", city: "Pune" }) }
export function S() {
  const user = profile.user()
  const name = restorableSignal("name", user?.name || "")
  const city = persistedSignal("city", user?.city || "")
  return <Column><Text>{name()}</Text><Text>{city()}</Text></Column>
}`)
  })
  test("a plain value from the same signal is still a build error", async () => {
    expect(await fails(`
const profile = { user: () => ({ name: "Ravi" }) }
export function S() {
  const name = profile.user()?.name || ""
  return <Column><Text>{name}</Text></Column>
}`)).toContain("name is worked out once")
  })
})
