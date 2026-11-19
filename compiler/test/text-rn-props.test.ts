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

describe("H3: Text selectable and auto-fit font", () => {
  test("compiles static selectable and adjustsFontSizeToFit props", () => {
    const { templates } = compile(`
      import { Text } from "@zeronative/ui"
      export function Screen() {
        return (
          <Text
            selectable
            adjustsFontSizeToFit
            minimumFontScale={0.5}
            numberOfLines={2}
          >
            Auto fitting and selectable text
          </Text>
        )
      }
    `)
    expect(templates[0].props).toMatchObject({
      selectable: true,
      adjustsFontSizeToFit: true,
      minimumFontScale: 0.5,
      numberOfLines: 2,
    })
  })

  test("compiles dynamic selectable boolean slot", () => {
    const { code, templates } = compile(`
      import { Text } from "@zeronative/ui"
      export function Screen(props: { canSelect: () => boolean }) {
        return (
          <Text selectable={props.canSelect()}>
            Dynamic selectable
          </Text>
        )
      }
    `)
    expect(code).toContain("__zn.slot(")
    expect(templates[0].props.selectable).toMatchObject({ $slot: "s0" })
  })
})
