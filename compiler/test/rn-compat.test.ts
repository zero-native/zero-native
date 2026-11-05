// RN-compat fixes from docs/rn-compat-sweep.md (2026-11-05): React Native code that used to compile and then do the
// wrong thing now builds right or fails with a hint.
import { describe, expect, test } from "bun:test"
import { type NodeSpec } from "@zero-native/template"
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

const err = (src: string, statics: Record<string, unknown> = {}) => {
  try {
    compile(src, statics)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("P0.2: negative margin, padding and border width fail the build (second-opinions 113)", () => {
  test("a negative margin, in style, in a token or as a prop, says to use translate", () => {
    expect(err(`function A() { return <Column style={{ marginTop: -8 }} /> }`))
      .toMatch(/marginTop: -8: a negative margin isn't supported.*translateY: -8/)
    expect(err(`function A() { return <Column style={[{ padding: 4 }, { marginStart: -12 }]} /> }`))
      .toMatch(/marginStart: -12.*translateX: -12/)
    expect(err(`function A() { return <Column style={s.pull} /> }`, { s: { pull: { margin: -4 } } }))
      .toMatch(/margin: -4: a negative margin/)
    expect(err(`function A() { return <Column marginBottom={-2} /> }`)).toMatch(/marginBottom: -2/)
  })
  test("a negative padding or border width says to use 0", () => {
    expect(err(`function A() { return <Column style={{ paddingTop: -4 }} /> }`)).toMatch(/paddingTop: -4: can't be negative/)
    expect(err(`function A() { return <Scroll contentContainerStyle={{ paddingBottom: -1 }} /> }`)).toMatch(/paddingBottom: -1/)
    expect(err(`function A() { return <Box style={{ borderWidth: -1 }} /> }`)).toMatch(/borderWidth: -1: can't be negative/)
  })
  test("0, positive values and negative offsets still build", () => {
    const { templates } = compile(`function A() {
      return <Column style={{ margin: 0, marginTop: 8, padding: 0, top: -4, start: -2, transform: [{ translateY: -8 }] }} />
    }`)
    expect(templates[0]!.props).toMatchObject({ margin: 0, marginTop: 8, padding: 0, top: -4, start: -2, translateY: -8 })
  })
})
