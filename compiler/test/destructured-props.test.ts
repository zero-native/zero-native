import { describe, expect, test } from "bun:test"
import { type NodeSpec, writeTemplateFile } from "@zeronative/template"
import { compileModule } from "../src/compile"

function compile(src: string, statics: Record<string, unknown> = {}) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx, new Map(Object.entries(statics)))
  for (const info of Object.values(out.roots)) {
    for (const trap of info.traps) {
      throw new Error(`${trap.at}: ${trap.message}`)
    }
  }
  return { ...out, templates }
}

describe("destructured props rewrite", () => {
  // ---- Supported shapes ----
  test("1. simple destructured props rewrite to __p.prop", () => {
    const { code } = compile(`
export function Card({ title, amount }: { title: string; amount: number }) {
  return <Text>{title}: {amount}</Text>
}`)
    expect(code).toContain("Card(__p: { title: string; amount: number })")
    expect(code).toContain("__p.title")
    expect(code).toContain("__p.amount")
  })

  test("2. renamed prop { title: t } rewrites reads of t to __p.title", () => {
    const { code } = compile(`
export function Card({ title: t }: { title: string }) {
  return <Text>{t}</Text>
}`)
    expect(code).toContain("Card(__p: { title: string })")
    expect(code).toContain("__p.title")
    expect(code).not.toContain("() => __zn.str(t)")
  })

  test("3. default value { size = 'md' } rewrites to (__p.size === undefined ? 'md' : __p.size)", () => {
    const { code } = compile(`
export function Card({ size = "md" }: { size?: string }) {
  return <Text>{size}</Text>
}`)
    expect(code).toContain(`(__p.size === undefined ? "md" : __p.size)`)
  })

  test("4. renamed with default value { title: t = 'Untitled' }", () => {
    const { code } = compile(`
export function Card({ title: t = "Untitled" }: { title?: string }) {
  return <Text>{t}</Text>
}`)
    expect(code).toContain(`(__p.title === undefined ? "Untitled" : __p.title)`)
  })

  test("5. arrow function component with expression body", () => {
    const { code } = compile(`
export const Card = ({ title }: { title: string }) => <Text>{title}</Text>
`)
    expect(code).toContain("Card = (__p: { title: string }) =>")
    expect(code).toContain("__p.title")
  })

  test("6. shorthand property assignment { title } inside handler becomes title: __p.title", () => {
    const { code } = compile(`
export function Card({ title }: { title: string }) {
  const tap = () => {
    const meta = { title }
    alert(meta.title)
  }
  return <Pressable onPress={tap}><Text>{title}</Text></Pressable>
}`)
    expect(code).toContain("title: __p.title")
  })

  // ---- Refused shapes ----
  test("7. ...rest pattern is refused with clear build error", () => {
    expect(() =>
      compile(`
export function Card({ title, ...rest }: any) {
  return <Text>{title}</Text>
}`),
    ).toThrow("rest patterns are not supported")
  })

  test("8. nested pattern is refused with clear build error", () => {
    expect(() =>
      compile(`
export function Card({ user: { name } }: any) {
  return <Text>{name}</Text>
}`),
    ).toThrow("nested patterns are not supported")
  })

  test("9. array pattern is refused with clear build error", () => {
    expect(() =>
      compile(`
export function Card([a, b]: any) {
  return <Text>{a}</Text>
}`),
    ).toThrow("array pattern")
  })

  test("10. reassignment of destructured prop is refused", () => {
    expect(() =>
      compile(`
export function Card({ count }: { count: number }) {
  count++
  return <Text>{count}</Text>
}`),
    ).toThrow('assigns to destructured prop "count": props are read-only')

    expect(() =>
      compile(`
export function Card({ title }: { title: string }) {
  title = "new"
  return <Text>{title}</Text>
}`),
    ).toThrow('assigns to destructured prop "title": props are read-only')
  })

  test("11. non-constant default value is refused", () => {
    expect(() =>
      compile(`
function getDefault() { return "default" }
export function Card({ title = getDefault() }: { title?: string }) {
  return <Text>{title}</Text>
}`),
    ).toThrow('non-constant default value for prop "title"')
  })

  // ---- Scope and Shadowing ----
  test("12. shadowing in an arrow parameter is preserved", () => {
    const { code } = compile(`
export function Card({ title }: { title: string }) {
  const format = (title: string) => title.trim()
  return <Text>{format(title)}</Text>
}`)
    expect(code).toContain("(title: string) => title.trim()")
    expect(code).toContain("format(__p.title)")
  })

  test("13. shadowing in a nested const block is preserved", () => {
    const { code } = compile(`
export function Card({ title }: { title: string }) {
  if (true) {
    const title = "inner"
    console.log(title)
  }
  return <Text>{title}</Text>
}`)
    expect(code).toContain('const title = "inner"')
    expect(code).toContain("console.log(title)")
    expect(code).toContain("__p.title")
  })

  test("14. handler reading destructured prop", () => {
    const { code } = compile(`
export function Card({ title }: { title: string }) {
  const tap = () => alert(title)
  return <Pressable onPress={tap}><Text>{title}</Text></Pressable>
}`)
    expect(code).toContain("alert(__p.title)")
  })

  test("15. .map row with destructured prop", () => {
    const { code } = compile(`
export function Card({ title }: { title: string }) {
  const items = ["a", "b"]
  return (
    <Column>
      {items.map((item) => <Text key={item}>{title}: {item}</Text>)}
    </Column>
  )
}`)
    expect(code).toContain("__p.title")
    expect(code).toContain("item")
  })

  // ---- Template equivalence ----
  test("16. template bytes match the p.title form exactly", () => {
    const a = compile(`export function CardA(p: { title: string }) { return <Text>{p.title}</Text> }`)
    const b = compile(`export function CardB({ title }: { title: string }) { return <Text>{title}</Text> }`)

    const bytesA = writeTemplateFile(a.templates).bytes
    const bytesB = writeTemplateFile(b.templates).bytes
    expect(bytesA).toEqual(bytesB)
  })
})
