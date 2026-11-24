import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeSpec } from "@zeronative/template"
import { compileModule } from "../src/compile"
import { znBuild } from "../src/plugin"

function compile(src: string, statics: Record<string, unknown> = {}) {
  const templates: NodeSpec[] = []
  const views: string[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
    nativeView: (name: string, where: string) => void views.push(`${name} ${where}`),
  }
  const out = compileModule(src, "test.tsx", ctx, new Map(Object.entries(statics)))
  return { ...out, templates, views }
}
const err = (body: string) => {
  try {
    compile(`export function F() { return ${body} }`)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("<NativeView>", () => {
  test("name and constant props go into the template", () => {
    const { templates, code, views } = compile(`
      export function F() { return <NativeView name="scanner.qr" props={{ torch: false }} style={{ height: 200 }} /> }`)
    expect(templates[0].type).toBe("NativeView")
    expect((templates[0].props as any).viewName).toBe("scanner.qr")
    expect((templates[0].props as any).viewProps).toBe('{"torch":false}')
    expect((templates[0].props as any).height).toBe(200)
    expect(code).not.toContain("JSON.stringify")
    expect(views).toEqual(["scanner.qr test.tsx:2:36"])
  })

  test("props that change become one slot of JSON text; events are parsed", () => {
    const { templates, code } = compile(`
      export function F() {
        const on = signal(false)
        return <NativeView name="scanner.qr" props={{ torch: on() }} onEvent={(e) => log(e.name)} />
      }`)
    expect((templates[0].props as any).viewProps).toEqual({ $slot: "s0", default: null })
    expect(code).toContain("__zn.slot(__i0, 0, () => __zn.viewPropsJson({ torch: on() }), 0);")
    expect(code).toContain("__zn.on(__i0, 1, (__znPayload) => ((e) => log(e.name))(JSON.parse(__znPayload)));")
  })

  test("the event wrapper doesn't hide the names the handler uses", () => {
    const { code } = compile(`
      export function F(p) { return <NativeView name="a.b" onEvent={(e) => p.onDone(e)} /> }`)
    expect(code).toContain("((e) => p.onDone(e))(JSON.parse(__znPayload))")
    expect(code).not.toContain("(p) =>")
  })

  test("a .map row can be a NativeView", () => {
    const { templates } = compile(`
      export function F() { return <Column>{items().map((i) => <NativeView key={i} name="a.b" />)}</Column> }`)
    expect(templates[1].type).toBe("NativeView")
  })

  test("testID and pointerEvents pass through as on any element (A112)", () => {
    const { templates } = compile(`
      export function F() { return <NativeView name="a.b" testID="qr" pointerEvents="none" /> }`)
    expect((templates[0].props as any).testID).toBe("qr")
    expect((templates[0].props as any).pointerEvents).toBe("none")
    // Same output as a Column's.
    const col = compile(`export function F() { return <Column testID="qr" pointerEvents="none" /> }`).templates[0]
    expect((col.props as any).testID).toBe("qr")
    expect((col.props as any).pointerEvents).toBe("none")
  })

  test("a pointerEvents that changes is a slot", () => {
    const { templates, code } = compile(`
      export function F() {
        const off = signal(false)
        return <NativeView name="a.b" pointerEvents={off() ? "none" : "auto"} testID={"q" + "r"} />
      }`)
    expect((templates[0].props as any).pointerEvents).toEqual({ $slot: "s0", default: null })
    expect((templates[0].props as any).testID).toBe("qr")
    expect(code).toContain(`__zn.slot(__i0, 0, () => (off() ? "none" : "auto"), 0);`)
  })

  test("errors", () => {
    expect(err(`<NativeView name="a.b" testID />`)).toContain("testID needs a value")
    expect(err(`<NativeView name="a.b" accessibilityLabel="x" />`)).toContain("testID and pointerEvents")
    expect(err(`<NativeView />`)).toContain("needs a name")
    expect(err(`<NativeView name={n} />`)).toContain("string literal")
    expect(err(`<NativeView name="qr" />`)).toContain('must be "<plugin>.<name>"')
    expect(err(`<NativeView name="a.b" width={10} />`)).toContain('not "width"')
    expect(err(`<NativeView name="a.b"><Text>x</Text></NativeView>`)).toContain("takes no children")
    expect(err(`<NativeView name="a.b" key={1} />`)).toContain("only used on the root")
  })
})

describe("a native name's plugin (D3)", () => {
  async function build(source: string) {
    const dir = mkdtempSync(join(tmpdir(), "zn-view-"))
    const file = join(dir, "a.tsx")
    writeFileSync(file, source)
    const zn = znBuild()
    const out = await Bun.build({ entrypoints: [file], plugins: [zn.plugin], packages: "external", target: "browser" })
    const js = await out.outputs[0]!.text()
    return zn.outputs(js)
  }
  const view = `export function F() { return <NativeView name="scanner.qr" /> }`

  test("a view whose plugin the app doesn't use fails the build", async () => {
    expect(build(view)).rejects.toThrow('"scanner.qr" belongs to a plugin module "scanner"')
  })

  test("a view passes when any code uses its module", async () => {
    const out = await build(`const Scanner = nativeModule("Scanner", 1)\n${view}`)
    expect(out.requires.modules).toEqual({ Scanner: 1 })
  })
})
