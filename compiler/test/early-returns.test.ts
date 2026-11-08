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

describe("H2: Early returns in components", () => {
  test("simple early return compiles to nested branch and generated tail component", () => {
    const { code, roots, templates } = compile(`
      import { Text, Column } from "@zero-native/ui"
      export function Card(props: { loading: () => boolean, title: string }) {
        if (props.loading()) return <Text>Loading...</Text>
        const total = 42
        return <Column><Text>{props.title}: {total}</Text></Column>
      }
    `)
    expect(code).toContain("Card__after1")
    expect(code).toContain("function Card__after1(__znProps: any)")
    expect(roots["Card"].templates).toHaveLength(1)
    expect(roots["Card__after1"]).toBeDefined()
    expect(roots["Card__after1"].templates).toHaveLength(1)
    expect(roots["Card"].traps).toHaveLength(0)
    expect(roots["Card__after1"].traps).toHaveLength(0)
  })

  test("two consecutive guards become nested ternary in source order", () => {
    const { code, roots } = compile(`
      import { Text } from "@zero-native/ui"
      export function Card(props: { loading: () => boolean, error: () => boolean }) {
        if (props.loading()) return <Text>Loading</Text>
        if (props.error()) return <Text>Error</Text>
        return <Text>Content</Text>
      }
    `)
    expect(code).toContain("Card__after1")
    expect(roots["Card"].templates).toHaveLength(1)
    expect(roots["Card__after1"].templates).toHaveLength(1)
  })

  test("pre-guard signal, plain value and function are passed to tail", () => {
    const { code } = compile(`
      import { signal } from "@zero-native/core"
      import { Text } from "@zero-native/ui"
      export function Card(props: { id: string }) {
        const s = signal(0)
        const base = 100
        const helper = () => "help"
        if (props.id === "0") return <Text>Zero</Text>
        return <Text>{s() + base + helper()}</Text>
      }
    `)
    expect(code).toContain('get "s"()')
    expect(code).toContain('get "base"()')
    expect(code).toContain('get "helper"()')
    expect(code).toContain("const s = __znProps[\"s\"];")
    expect(code).toContain("const base = __znProps[\"base\"];")
    expect(code).toContain("const helper = __znProps[\"helper\"];")
  })

  test("guard in a screen passes checkScreenRoots (exactly 1 template in roots)", () => {
    const { roots } = compile(`
      import { Text } from "@zero-native/ui"
      export function Screen(props: { id: string, ready: () => boolean }) {
        if (!props.ready()) return <Text>Waiting...</Text>
        return <Text>Ready: {props.id}</Text>
      }
    `)
    expect(roots["Screen"].templates).toHaveLength(1)
    expect(roots["Screen"].others).toHaveLength(0)
  })

  test("guard works with destructured props", () => {
    const { code, roots } = compile(`
      import { Text } from "@zero-native/ui"
      export function Card({ id, loading }: { id: string, loading: () => boolean }) {
        if (loading()) return <Text>Loading...</Text>
        return <Text>ID: {id}</Text>
      }
    `)
    expect(code).toContain("Card__after1")
    expect(code).toContain('get "__p"()')
    expect(roots["Card"].templates).toHaveLength(1)
    expect(roots["Card__after1"].templates).toHaveLength(1)
  })

  test("refused: return inside loop", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function Bad(props: { items: string[] }) {
        for (const item of props.items) {
          if (item === "stop") return <Text>Stopped</Text>
        }
        return <Text>End</Text>
      }
    `)).toMatch(/Bad has an early return inside a loop/)
  })

  test("refused: return inside try block", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function Bad() {
        try {
          return <Text>A</Text>
        } catch {
          return <Text>B</Text>
        }
      }
    `)).toMatch(/Bad has an early return inside a try block/)
  })

  test("refused: return inside switch statement", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function Bad(props: { status: string }) {
        switch (props.status) {
          case "a": return <Text>A</Text>
          default: return <Text>Default</Text>
        }
      }
    `)).toMatch(/Bad has an early return inside a switch statement/)
  })

  test("refused: nested early return in non-top-level block", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function Bad(props: { a: boolean, b: boolean }) {
        if (props.a) {
          if (props.b) return <Text>B</Text>
        }
        return <Text>End</Text>
      }
    `)).toMatch(/Bad has a nested early return/)
  })

  test("refused: generator component", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function* Bad() {
        if (true) return <Text>A</Text>
        return <Text>B</Text>
      }
    `)).toMatch(/Bad is a generator function/)
  })

  test("refused: pre-guard let that is reassigned", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function Bad(props: { id: string }) {
        let x = 1
        x = 2
        if (props.id === "0") return <Text>Zero</Text>
        return <Text>{x}</Text>
      }
    `)).toMatch(/Bad has a pre-guard "let x" that is reassigned/)
  })

  test("refused: tail assigns to pre-guard variable", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      export function Bad(props: { id: string }) {
        let count = 0
        if (props.id === "0") return <Text>Zero</Text>
        count = 5
        return <Text>{count}</Text>
      }
    `)).toMatch(/Bad assigns to pre-guard variable "count" after an early return guard/)
  })

  test("three guards with else-if chain", () => {
    const { code, roots } = compile(`
      import { Text } from "@zero-native/ui"
      export function Card(props: { a: () => boolean, b: () => boolean, c: () => boolean }) {
        if (props.a()) {
          return <Text>A</Text>
        } else if (props.b()) {
          return <Text>B</Text>
        } else if (props.c()) {
          return <Text>C</Text>
        }
        return <Text>Default</Text>
      }
    `)
    expect(code).toContain("Card__after1")
    expect(roots["Card"].templates).toHaveLength(1)
    expect(roots["Card__after1"].templates).toHaveLength(1)
  })

  test("tail with once-trap is still caught", () => {
    const { roots } = compile(`
      import { signal } from "@zero-native/core"
      import { Text } from "@zero-native/ui"
      const store = { amount: signal(10) }
      export function Card(props: { ready: () => boolean }) {
        if (!props.ready()) return <Text>Waiting...</Text>
        const missing = store.amount() <= 0
        return <Text>{missing ? "Yes" : "No"}</Text>
      }
    `)
    expect(roots["Card__after1"].traps.length).toBeGreaterThan(0)
    expect(roots["Card__after1"].traps[0].message).toContain("missing")
  })

  test("error positions point at user line", () => {
    const message = err(`
      import { Text } from "@zero-native/ui"
      export function Card(props: { x: number }) {
        let count = 0
        if (props.x === 0) return <Text>Zero</Text>
        count = 10
        return <Text>{count}</Text>
      }
    `)
    expect(message).toMatch(/test\.tsx:6:\d+: Card assigns to pre-guard variable "count"/)
  })
})
