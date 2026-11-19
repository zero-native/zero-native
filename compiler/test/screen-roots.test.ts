// A screen must always return one template (guide notes §4): native draws the root from the manifest's template
// before JS runs, so a second, different return used to leave the screen blank with no error. The app build fails now.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { znBuild } from "../src/plugin"

/** Builds an app whose route "home" shows [screen] (a component in screens.tsx), plus any [extraRoutes]. */
async function build(screens: string, screen = "S", extraRoutes = "") {
  const dir = mkdtempSync(join(tmpdir(), "zn-roots-"))
  writeFileSync(join(dir, "screens.tsx"), `import { Column, Row, Text } from "@zeronative/ui"\n${screens}`)
  writeFileSync(
    join(dir, "routes.ts"),
    `import { defineRoutes } from "@zeronative/core"
import * as s from "./screens"
import { ${screen} } from "./screens"
export const keep = s
export const routes = defineRoutes({ home: { path: "/", screen: ${screen} }${extraRoutes} })`,
  )
  const zn = znBuild()
  const out = await Bun.build({ entrypoints: [join(dir, "routes.ts")], plugins: [zn.plugin], packages: "external", target: "browser" })
  if (!out.success) {
    console.log("OUT LOGS:", JSON.stringify(out.logs, Object.getOwnPropertyNames(out.logs[0] || {})))
    throw new Error(out.logs.map((l: any) => l.message || String(l)).join("\n"))
  }
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

describe("a screen's returns", () => {
  test("top-level guard in a screen builds successfully into one template (H2)", async () => {
    await build(`
export function S(p: { cond: boolean }) {
  if (p.cond) { return <Column style={{ flex: 1 }} /> }
  return <Column><Text>hi</Text></Column>
}`)
  })

  test("the screen that found it (ZeroBill's VerifyScreen, 2026-11-05) fails on multi-statement guard; its one-return rewrite builds", async () => {
    // The original: an empty screen while there's no draft, then a 0 ms timer goes to login.
    // It has multiple statements in the guard block, so early returns refuse it.
    expect(await fails(`
import { nav, signal } from "@zeronative/core"
const draftOf = (): { phone: string } | null => null
export function VerifyScreen() {
  const draft = draftOf()
  if (!draft) {
    setTimeout(() => nav.replace("login"), 0)
    return <Column style={{ flex: 1 }} />
  }
  const code = signal("")
  return (
    <Column style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text>Enter the code sent to {draft.phone}</Text>
      <Text>{code()}</Text>
    </Column>
  )
}`, "VerifyScreen")).toContain("VerifyScreen has an unsupported early return shape")
    // The rewrite: the screen keeps its main content; only the piece that needs the draft is in a branch.
    await build(`
import { nav, signal } from "@zeronative/core"
const draftOf = (): { phone: string } | null => null
export function VerifyScreen() {
  const draft = draftOf()
  if (!draft) setTimeout(() => nav.replace("login"), 0)
  const code = signal("")
  return (
    <Column style={{ flex: 1, padding: 16, gap: 12 }}>
      {draft ? <Text>Enter the code sent to {draft.phone}</Text> : null}
      <Text>{code()}</Text>
    </Column>
  )
}`, "VerifyScreen")
  })

  test("returns with the same JSX shape and other values are fine (one template on screen)", async () => {
    const out = await build(`
export function S(p: { a: boolean; n: string }) {
  if (p.a) return <Text>{p.n}</Text>
  return <Text>{p.n + "!"}</Text>
}`)
    expect(out.manifest.routes[0]!.screen).toBe(out.manifest.components.S!)
  })

  test("`if (x) return null` before the JSX compiles to branch component (H2)", async () => {
    await build(`
export function S(p: { x: boolean }) {
  if (p.x) return null
  return <Column><Text>hi</Text></Column>
}`)
  })

  test("bare `return` compiles to branch component, returning helper fails", async () => {
    await build(`
export function S(p: { x: boolean }) {
  if (p.x) return
  return <Column />
}`)
    expect(await fails(`
function Body() { return <Text>hi</Text> }
export function S(p: { x: boolean }) {
  if (p.x) return Body()
  return <Column />
}`)).toContain("returns something that isn't its JSX")
  })

  test("returning another component in a guard branch builds into branch component (H2)", async () => {
    await build(`
export function Loading() { return <Text>wait</Text> }
export function S(p: { x: boolean }) {
  if (p.x) return <Loading />
  return <Column><Text>hi</Text></Column>
}`)
  })

  test("returns inside switch / case fail the build (refused shape)", async () => {
    expect(await fails(`
export function S(p: { k: string }) {
  switch (p.k) {
    case "a": return <Column><Text>a</Text></Column>
    case "b": return <Row />
    default: return <Column><Text>c</Text></Column>
  }
}`)).toContain("S has an early return inside a switch statement")
    expect(await fails(`
export function S(p: { k: string }) {
  switch (p.k) {
    case "a": return <Text>{p.k}</Text>
    default: return <Text>{p.k + "?"}</Text>
  }
}`)).toContain("S has an early return inside a switch statement")
  })

  test("`return cond ? <A /> : <B />` keeps working (one template with an anchor)", async () => {
    const out = await build(`
export function S(p: { x: boolean }) {
  return p.x ? <Column style={{ flex: 1 }} /> : <Column><Text>hi</Text></Column>
}`)
    expect(out.manifest.routes[0]!.screen).toBe(out.manifest.components.S!)
    // An arrow with an expression body too.
    await build(`export const S = (p: { x: boolean }) => (p.x ? <Row /> : null)`)
  })

  test("JSX variables (G4): one return of a ternary const works; const in guard builds (H2)", async () => {
    await build(`
export function S(p: { x: boolean }) {
  const body = p.x ? <Row /> : <Column><Text>hi</Text></Column>
  return body
}`)
    await build(`
export function S(p: { x: boolean }) {
  const empty = <Column style={{ flex: 1 }} />
  if (p.x) return empty
  return <Column><Text>hi</Text></Column>
}`)
  })

  test("one return in parens or a fragment is fine", async () => {
    await build(`
export function S() {
  return (
    <Column><Text>hi</Text></Column>
  )
}`)
    await build(`
export function S() {
  return (
    <>
      <Text>a</Text>
      <Text>b</Text>
    </>
  )
}`)
  })

  test("returns inside nested functions don't count", async () => {
    await build(`
export function S(p: { items: string[] }) {
  const pick = (s: string) => { if (!s) return null; return s }
  const tap = () => { if (p.items.length === 0) return; pick("x") }
  return <Pressable onPress={tap}>{p.items.map((i) => <Text key={i}>{pick(i)}</Text>)}</Pressable>
}`)
  })

  test("a child that returns early on a prop compiles to branch component (H2)", async () => {
    await build(`
export function Badge(p: { on: boolean }) {
  if (p.on) return <Text>on</Text>
  return <Row />
}
const on = () => true; export function S() { return <Column><Badge on={on()} /></Column> }`)
  })

  test("native routes are not checked", async () => {
    await build(
      `export function S() { return <Column /> }\nconst Scanner = nativeModule("Scanner", 1)`,
      "S",
      `, scan: { path: "/scan", native: "scanner.full" }`,
    )
  })
})
