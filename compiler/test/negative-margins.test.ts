import { describe, expect, test } from "bun:test"
import { type NodeSpec } from "@zero-native/template"
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

describe("H3: Negative margins", () => {
  test("compiles negative margins into template", () => {
    const { templates } = compile(`
      import { Box } from "@zero-native/ui"
      export function Screen() {
        return (
          <Box style={{ marginTop: -16, marginStart: -8, marginBottom: -10 }} />
        )
      }
    `)
    expect(templates[0].props).toMatchObject({
      marginTop: -16,
      marginStart: -8,
      marginBottom: -10,
    })
  })

  test("negative padding still fails build", () => {
    expect(() =>
      compile(`
        import { Box } from "@zero-native/ui"
        export function Screen() {
          return <Box style={{ paddingTop: -10 }} />
        }
      `),
    ).toThrow("can't be negative")
  })
})
