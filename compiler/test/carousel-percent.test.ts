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

describe("H3: Carousel percent widths", () => {
  test("compiles itemWidth as percent into itemWidthPercent", () => {
    const { templates } = compile(`
      import { Box, Carousel } from "@zeronative/ui"
      export function Screen() {
        return (
          <Carousel itemWidth="80%">
            <Box style={{ height: 100 }} />
            <Box style={{ height: 100 }} />
          </Carousel>
        )
      }
    `)
    expect(templates[0].props.itemWidthPercent).toBe(80)
  })

  test("compiles pageWidth as percent into itemWidthPercent", () => {
    const { templates } = compile(`
      import { Box, Carousel } from "@zeronative/ui"
      export function Screen() {
        return (
          <Carousel pageWidth="75%">
            <Box style={{ height: 100 }} />
            <Box style={{ height: 100 }} />
          </Carousel>
        )
      }
    `)
    expect(templates[0].props.itemWidthPercent).toBe(75)
  })

  test("compiles numeric itemWidth into itemWidth unchanged", () => {
    const { templates } = compile(`
      import { Box, Carousel } from "@zeronative/ui"
      export function Screen() {
        return (
          <Carousel itemWidth={320}>
            <Box style={{ height: 100 }} />
          </Carousel>
        )
      }
    `)
    expect(templates[0].props.itemWidth).toBe(320)
  })

  test("refuses percent > 100%", () => {
    expect(() =>
      compile(`
        import { Box, Carousel } from "@zeronative/ui"
        export function Screen() {
          return (
            <Carousel itemWidth="120%">
              <Box style={{ height: 100 }} />
            </Carousel>
          )
        }
      `),
    ).toThrow("between 1% and 100%")
  })
})
