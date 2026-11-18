import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { type NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

/**
 * The names the compiled module reads that nothing declares: each is a ReferenceError on the phone (hermesc takes an
 * unknown name as a global, so the build does not catch it). TypeScript's own check, on the output alone (no lib, no
 * imports resolved), so test sources must not use globals.
 */
function undeclared(code: string): string[] {
  const file = "out.tsx"
  const out = ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const host = ts.createCompilerHost({})
  host.getSourceFile = (name) => (name === file ? out : undefined)
  host.fileExists = (name) => name === file
  const program = ts.createProgram([file], { noLib: true, noEmit: true, types: [] }, host)
  return program.getSemanticDiagnostics(out)
    .filter((d) => d.code === 2304) // Cannot find name 'x'.
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
}

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

  test("the tail component's template id goes through ctx.ref, so the app build can fill in the final id", () => {
    // Before 2026-11-10 it wrote the raw reservation number, which depends on Bun's load order: the same code gave
    // different bytecode from one build to the next (a later line set the right id, so phones were fine).
    const ctx = {
      reserveTemplate: (() => {
        let n = 0
        return () => n++
      })(),
      defineTemplate: () => {},
      ref: (id: number) => `__ID${id}__`,
    }
    const { code } = compileModule(
      `
      import { Text, Column } from "@zero-native/ui"
      export function Card(props: { loading: () => boolean }) {
        if (props.loading()) return <Text>Loading...</Text>
        return <Column><Text>Done</Text></Column>
      }
    `,
      "test.tsx",
      ctx,
      new Map(),
    )
    const lines = code.split("\n").filter((l) => l.includes("Card__after1.__zt"))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/Card__after1\.__zt = __ID\d+__;/)
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

  test("the undeclared-name check sees a name nothing declares", () => {
    expect(undeclared(`function f() { return zz }`)).toEqual(["Cannot find name 'zz'."])
    expect(undeclared(compile(`
      import { signal } from "@zero-native/core"
      import { Text } from "@zero-native/ui"
      export function Card(props: { id: string }) {
        const s = signal(0)
        if (props.id === "0") return <Text>Zero</Text>
        return <Text>{s()}</Text>
      }
    `).code)).toEqual([])
  })

  // Review 2026-11-18 #2: only plain `const x = ...` names were passed to the tail, so these built and then threw
  // ReferenceError when the guard turned false (a blank screen in release).
  test("pre-guard destructured consts are passed to the tail", () => {
    const { code } = compile(`
      import { Text } from "@zero-native/ui"
      declare function useStore(): { data: () => { name: string }, loading: () => boolean }
      export function Card() {
        const { data, loading } = useStore()
        if (loading()) return <Text>Loading</Text>
        return <Text>{data().name}</Text>
      }
    `)
    expect(code).toContain('Card__after1({ get "data"() { return (data) } })')
    expect(code).toContain('const data = __znProps["data"];')
    expect(undeclared(code)).toEqual([])
  })

  test("pre-guard array, nested, renamed and rest patterns are passed to the tail", () => {
    const { code } = compile(`
      import { Text } from "@zero-native/ui"
      declare function rows(): [string, { inner: string, other: string }, ...string[]]
      export function Card(props: { ready: () => boolean }) {
        const [first, { inner, other: renamed }, ...rest] = rows()
        if (!props.ready()) return <Text>Waiting</Text>
        return <Text>{first + inner + renamed + rest.length}</Text>
      }
    `)
    for (const k of ["first", "inner", "renamed", "rest"]) expect(code).toContain(`const ${k} = __znProps["${k}"];`)
    expect(code).not.toContain('__znProps["other"]')
    expect(undeclared(code)).toEqual([])
  })

  test("pre-guard function and class declarations are passed to the tail", () => {
    const { code } = compile(`
      import { Text } from "@zero-native/ui"
      export function Card(props: { id: string, loading: () => boolean }) {
        function fmt(x: string) { var local = "#"; return local + x }
        class Money { constructor(public v: string) {} }
        if (props.loading()) return <Text>Loading</Text>
        return <Text>{fmt(new Money(props.id).v)}</Text>
      }
    `)
    expect(code).toContain('const fmt = __znProps["fmt"];')
    expect(code).toContain('const Money = __znProps["Money"];')
    // A var inside the helper is the helper's own, not the component's.
    expect(code).not.toContain('__znProps["local"]')
    expect(undeclared(code)).toEqual([])
  })

  test("a pre-guard var inside a block is passed to the tail", () => {
    const { code } = compile(`
      import { Text } from "@zero-native/ui"
      export function Card(props: { id: string, loading: () => boolean }) {
        if (props.id === "x") { var extra = "!" }
        if (props.loading()) return <Text>Loading</Text>
        return <Text>{props.id + extra}</Text>
      }
    `)
    expect(code).toContain('const extra = __znProps["extra"];')
    expect(undeclared(code)).toEqual([])
  })

  test("refused: pre-guard destructured let that is reassigned", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      declare function pair(): [number, number]
      export function Bad(props: { id: string }) {
        let [a, b] = pair()
        b = 2
        if (props.id === "0") return <Text>Zero</Text>
        return <Text>{a + b}</Text>
      }
    `)).toMatch(/Bad has a pre-guard "let b" that is reassigned/)
  })

  test("refused: tail assigns to a pre-guard destructured name", () => {
    expect(err(`
      import { Text } from "@zero-native/ui"
      declare function useStore(): { count: number }
      export function Bad(props: { id: string }) {
        let { count } = useStore()
        if (props.id === "0") return <Text>Zero</Text>
        count = 5
        return <Text>{count}</Text>
      }
    `)).toMatch(/Bad assigns to pre-guard variable "count" after an early return guard/)
  })

  // Review 2026-11-18 #3: a pre-guard JSX variable was passed to the tail as a value (its declaration is gone from
  // the JS), and the names its JSX reads were not passed at all.
  test("a pre-guard JSX variable is not passed to the tail, the names it reads are", () => {
    const { code } = compile(`
      import { Text, Column } from "@zero-native/ui"
      export function Card(p: { id: string, loading: () => boolean }) {
        const title = "T" + p.id
        const header = <Text>{title}</Text>
        if (p.loading()) return <Text>Spinner</Text>
        return <Column>{header}</Column>
      }
    `)
    expect(code).not.toContain('get "header"()')
    expect(code).not.toContain('__znProps["header"]')
    expect(code).toContain('Card__after1({ get "title"() { return (title) } })')
    expect(code).toContain('const title = __znProps["title"];')
    expect(undeclared(code)).toEqual([])
  })

  test("a pre-guard JSX variable that holds another one passes the props and names of both", () => {
    const { code } = compile(`
      import { Text, Column, Pressable } from "@zero-native/ui"
      declare function pay(id: string): void
      export function Card(p: { id: string, loading: () => boolean }) {
        const title = "T"
        const icon = <Text>{p.id}</Text>
        const header = <Pressable onPress={() => pay(p.id)}><Column>{icon}<Text>{title}</Text></Column></Pressable>
        if (p.loading()) return <Text>Spinner</Text>
        return <Column>{header}</Column>
      }
    `)
    expect(code).toContain('const p = __znProps["p"];')
    expect(code).toContain('const title = __znProps["title"];')
    expect(code).not.toContain('__znProps["icon"]')
    expect(code).not.toContain('__znProps["header"]')
    expect(undeclared(code)).toEqual([])
  })

  test("a module-level JSX variable used in the tail is not passed", () => {
    const { code } = compile(`
      import { Text, Column } from "@zero-native/ui"
      const label = "L"
      const badge = <Text>{label}</Text>
      export function Card(p: { loading: () => boolean }) {
        if (p.loading()) return <Text>Spinner</Text>
        return <Column>{badge}</Column>
      }
    `)
    expect(code).toContain("() => Card__after1({})")
    expect(undeclared(code)).toEqual([])
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
