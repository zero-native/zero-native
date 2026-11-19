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
  return { ...out, templates }
}

describe("H4: Canvas compilation", () => {
  test("compiles <Canvas commands={cmds()}> into Canvas component template with slot", () => {
    const { code, templates } = compile(`
      import { Canvas } from "@zeronative/ui"
      export function Screen(props: { cmds: () => any[] }) {
        return (
          <Canvas
            commands={props.cmds()}
            style={{ width: 300, height: 200 }}
          />
        )
      }
    `)
    expect(code).toContain("__zn.slot(")
    expect(code).toContain("__zn.canvasJson(props.cmds())")
    expect(templates[0].type).toBe("Canvas" as any)
    expect(templates[0].props.commands).toMatchObject({ $slot: "s0" })
    expect(templates[0].props.width).toBe(300)
    expect(templates[0].props.height).toBe(200)
  })
})
