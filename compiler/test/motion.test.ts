// Gestures and motion (docs/gestures-and-motion-v1.md): derive → formula data, bindings and gestures as slots, and the
// Motion module requirement.
import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { type NodeSpec, writeTemplateFile } from "@zeronative/template"
import { compileModule } from "../src/compile"
import { compileDerives, compileFormula } from "../src/motion"
import { nativeModuleUses } from "../src/modules"

const isSlot = (v: unknown): boolean => typeof v === "object" && v !== null && "$slot" in (v as Record<string, unknown>)

function compile(src: string) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx, new Map())
  return { ...out, templates }
}

function formula(expr: string, names = { clamp: "clamp", interpolate: "interpolate", interpolateColor: "interpolateColor" }) {
  const sf = ts.createSourceFile("f.ts", `(${expr})`, ts.ScriptTarget.Latest, true)
  let e = (sf.statements[0] as ts.ExpressionStatement).expression
  while (ts.isParenthesizedExpression(e)) e = e.expression
  return compileFormula((e as ts.ArrowFunction).body as ts.Expression, sf, names)
}

/** Runs postfix tokens the way ZnFormula.kt does (for checking the compiler's output). */
function run(tokens: (string | number)[], inputs: number[], tables: unknown[][] = [], site = { sw: 0, sh: 0, pw: 0, ph: 0 }): number {
  const s: number[] = []
  const bin = (f: (x: number, y: number) => number) => {
    const y = s.pop()!
    const x = s.pop()!
    s.push(f(x, y))
  }
  for (const t of tokens) {
    if (typeof t === "number") s.push(t)
    else if (t.startsWith("$")) s.push(inputs[Number(t.slice(1))])
    else if (t in site) s.push(site[t as keyof typeof site])
    else if (t.startsWith("L")) {
      const [ins, outs] = tables[Number(t.slice(1))] as [number[], number[]]
      const x = s.pop()!
      let i = 0
      if (x <= ins[0]) s.push(outs[0])
      else if (x >= ins[ins.length - 1]) s.push(outs[outs.length - 1])
      else {
        while (i < ins.length - 2 && x > ins[i + 1]) i++
        s.push(outs[i] + ((outs[i + 1] - outs[i]) * (x - ins[i])) / (ins[i + 1] - ins[i]))
      }
    } else
      switch (t) {
        case "+": bin((x, y) => x + y); break
        case "-": bin((x, y) => x - y); break
        case "*": bin((x, y) => x * y); break
        case "/": bin((x, y) => (y === 0 ? 0 : x / y)); break
        case "%": bin((x, y) => (y === 0 ? 0 : x % y)); break
        case "<": bin((x, y) => +(x < y)); break
        case ">": bin((x, y) => +(x > y)); break
        case "&&": bin((x, y) => (x !== 0 ? y : x)); break
        case "||": bin((x, y) => (x !== 0 ? x : y)); break
        case "min": bin(Math.min); break
        case "max": bin(Math.max); break
        case "atan2": bin(Math.atan2); break
        case "hypot": bin(Math.hypot); break
        case "pow": bin(Math.pow); break
        case "neg": s.push(-s.pop()!); break
        case "!": s.push(+(s.pop()! === 0)); break
        case "abs": s.push(Math.abs(s.pop()!)); break
        case "?": {
          const no = s.pop()!
          const yes = s.pop()!
          s.push(s.pop()! !== 0 ? yes : no)
          break
        }
        case "clamp": {
          const hi = s.pop()!
          const lo = s.pop()!
          s.push(Math.min(Math.max(s.pop()!, lo), hi))
          break
        }
        default: throw new Error(`test runner lacks ${t}`)
      }
  }
  expect(s.length).toBe(1)
  return s[0]
}

describe("derive → postfix tokens", () => {
  test("arithmetic, precedence and inputs", () => {
    const f = formula("() => Math.abs(pan.x) / 120 + 2 * k")
    expect(f.inputs).toEqual(["pan.x", "k"])
    expect(f.tokens).toEqual(["$0", "abs", 120, "/", 2, "$1", "*", "+"])
    expect(run(f.tokens, [-240, 3])).toBe(8)
  })

  test("the same input twice is one input", () => {
    const f = formula("() => pan.x * pan.x")
    expect(f.inputs).toEqual(["pan.x"])
    expect(f.tokens).toEqual(["$0", "$0", "*"])
  })

  test("conditional, comparisons, && || !", () => {
    const f = formula("() => (a > 10 && !b) ? a : -a")
    expect(run(f.tokens, [20, 0])).toBe(20)
    expect(run(f.tokens, [20, 1])).toBe(-20)
    expect(run(f.tokens, [5, 0])).toBe(-5)
  })

  test("Math.min with many values chains; Math.PI is a constant", () => {
    const f = formula("() => Math.min(a, b, c) * Math.PI")
    expect(f.tokens).toEqual(["$0", "$1", "min", "$2", "min", Math.PI, "*"])
  })

  test("atan2 keeps JS's argument order (a dial)", () => {
    const f = formula("() => Math.atan2(y, x)")
    expect(run(f.tokens, [1, 0])).toBeCloseTo(Math.PI / 2)
  })

  test("clamp, interpolate with a table, self / parent sizes", () => {
    const f = formula('() => clamp(interpolate(pan.x, [0, 100], [0, 1], "clamp"), 0, self.width - parent.width)')
    expect(f.tables).toEqual([[[0, 100], [0, 1], 0, 0]])
    expect(f.tokens).toContain("L0")
    expect(f.tokens).toContain("sw")
    expect(f.tokens).toContain("pw")
    expect(run(f.tokens, [50], f.tables, { sw: 10, sh: 0, pw: 0, ph: 0 })).toBe(0.5)
  })

  test("interpolateColor only as the whole formula", () => {
    const f = formula('() => interpolateColor(p, [0, 1], ["#ffffff", "#000000"])')
    expect(f.color).toBe(true)
    expect(f.tokens).toEqual(["$0", "C0"])
    expect(() => formula('() => 1 + interpolateColor(p, [0, 1], ["#fff", "#000"])')).toThrow(/whole formula/)
  })

  test("pan.x() reads a motion value (the same input as pan.x); your own functions fail with a hint", () => {
    const a = formula("() => pan.x() * 2 + pan.x")
    expect(a.tokens).toEqual(["$0", 2, "*", "$0", "+"])
    expect(a.inputs).toEqual(["pan.x"])
    expect(formula("() => Math.abs(v()) / s.items[0]()").inputs).toEqual(["v", "s.items[0]"])
    expect(() => formula("() => scaleFor(pan.x)")).toThrow(/can't call scaleFor/)
    expect(() => formula("() => pan.x(1)")).toThrow(/can't call pan.x/)
    expect(() => formula("() => `a${x}`")).toThrow(/can't use/)
  })

  test("interpolate tables take the file's top-level number consts", () => {
    const src = ["const OPEN = -144", "const GONE = -220", "const f = derive(() => interpolate(x(), [GONE, OPEN], [1, 0]))"].join("\n")
    const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true)
    const arrow = ((sf.statements[2] as ts.VariableStatement).declarationList.declarations[0].initializer as ts.CallExpression).arguments[0] as ts.ArrowFunction
    const out = compileFormula(arrow.body as ts.Expression, sf, { interpolate: "interpolate" })
    expect(out.tables[0]).toEqual([[-220, -144], [1, 0], 0, 0])
    expect(() => formula("() => interpolate(x, [LATER, 1], [0, 1])")).toThrow(/top-level const/)
  })

  test("the step and stack limits", () => {
    const long = "() => " + Array.from({ length: 40 }, (_, i) => `a${i}`).join(" + ")
    expect(() => formula(long)).toThrow(/at most 64/)
  })
})

describe("compileDerives rewrites calls in place", () => {
  test("only when derive comes from @zeronative/core; lines kept", () => {
    const src = `import { derive, interpolate } from "@zeronative/core"
const w = derive(() =>
  interpolate(pan.x, [0, 1], [0, 2]))
const n = 1`
    const out = compileDerives(src, "a.ts")
    expect(out).toContain('derive.__f(["$0","L0"], [pan.x], [[[0,1],[0,2],0,0]], false)')
    expect(out.split("\n").length).toBe(src.split("\n").length)
    expect(out.split("\n")[3]).toBe("const n = 1")
    expect(compileDerives("const x = derive(() => 1)", "b.ts")).toBe("const x = derive(() => 1)")
  })

  test("errors name the file and line", () => {
    const src = `import { derive } from "@zeronative/core"
const w = derive(() => f(x))`
    expect(() => compileDerives(src, "c.ts")).toThrow(/c\.ts:2:11: derive: can't call f/)
  })

  test("an import alias works", () => {
    const out = compileDerives(`import { derive as d } from "@zeronative/core"\nd(() => a * 2)`, "d.ts")
    expect(out).toContain('d.__f(["$0",2,"*"], [a], [], false)')
  })
})

describe("bindings and gestures in templates", () => {
  test("a motion value in a transform, opacity and gesture are slots; 3D keys exist", () => {
    const { templates, code } = compile(`
      import { Box } from "@zeronative/ui"
      import { usePan } from "@zeronative/core"
      export function Card() {
        const pan = usePan({ axis: "x" })
        return <Box gesture={pan} style={{ opacity: pan.progress, transform: [{ translateX: pan.x }, { rotateY: "30deg" }], blurRadius: 4 }} />
      }
    `)
    const p = templates[0]!.props as Record<string, unknown>
    expect(isSlot(p.gesture)).toBe(true)
    expect(isSlot(p.translateX)).toBe(true)
    expect(isSlot(p.opacity)).toBe(true)
    expect(p.rotateY).toBe(30)
    expect(p.blurRadius).toBe(4)
    expect(code).toContain("pan.x")
    // Registry 24 for the new props.
    expect(writeTemplateFile(templates).registry).toBe(24)
  })

  test("flip and stretch presets write 8 numbers and need registry 24; old presets stay 4", () => {
    const { templates } = compile(`
      import { Box, Column } from "@zeronative/ui"
      export function A() {
        return <Column><Box enter="flip-x" exit="stretch-y" /><Box enter="fade" /></Column>
      }
    `)
    const [flip, fade] = templates[0]!.children!.map((c) => c.props as Record<string, unknown>)
    expect(flip.enter).toBe("0,0,0,1,90,0,1,1|t220e1")
    expect(flip.exit).toBe("1,0,0,1,0,0,1,0|t160e2")
    expect(fade.enter).toBe("0,0,0,1|t220e1")
    expect(writeTemplateFile(templates).registry).toBe(24)
    const old = compile(`import { Box } from "@zeronative/ui"
export function B() { return <Box enter="fade" /> }`)
    expect(writeTemplateFile(old.templates).registry).toBeLessThan(24)
  })

  test("List motion, reorderable and onReorder; sharedTag is a slot", () => {
    const { templates, code } = compile(`
      import { Image, List, Text } from "@zeronative/ui"
      import { useElementMotion } from "@zeronative/core"
      export function A(p) {
        const m = useElementMotion()
        return <List data={p.rows} key={(r) => r.id} motion={m} reorderable onReorder={(a, b) => p.move(a, b)}
          row={(r) => <Image src={r.src} sharedTag={"store-" + r.id} />} />
      }
    `)
    const list = templates.find((t) => t?.type === "List")!.props as Record<string, unknown>
    expect(isSlot(list.motion)).toBe(true)
    expect(list.reorderable).toBe(true)
    expect(code).toContain('split(",")')
    const img = templates.find((t) => t?.type === "Image")!.props as Record<string, unknown>
    expect(isSlot(img.sharedTag)).toBe(true)
  })

  test("an Svg part's trim and fill take motion values as slots", () => {
    const { templates } = compile(`
      import { Svg, Path } from "@zeronative/ui"
      import { useMotion } from "@zeronative/core"
      export function Ring() {
        const p = useMotion(0)
        return <Svg viewBox="0 0 24 24" size={24}><Path d="M2 12h20" stroke="#000" trimEnd={p} fill={p.mapColor([0, 1], ["#000000", "#ffffff"])} /></Svg>
      }
    `)
    const part = templates[0]!.children!.map((c) => c.props as Record<string, unknown>).find((x) => "trimEnd" in x)!
    expect(isSlot(part.trimEnd)).toBe(true)
    expect(isSlot(part.fill)).toBe(true)
  })
})

describe("the Motion module requirement", () => {
  test("an app file importing a motion API needs Motion 1", () => {
    expect(nativeModuleUses(`import { usePan, signal } from "@zeronative/core"`, "C:/app/src/Card.tsx")).toEqual([{ name: "Motion", version: 1, core: true }])
    expect(nativeModuleUses(`import { signal } from "@zeronative/core"`, "C:/app/src/Card.tsx")).toEqual([])
    expect(nativeModuleUses(`import * as zn from "@zeronative/core"`, "C:/app/src/x.ts")).toEqual([{ name: "Motion", version: 1, core: true }])
  })

  test("core's own Motion calls don't count", () => {
    const src = `callNative("Motion", "animate", { ...args, __v: 1 })`
    expect(nativeModuleUses(src, "C:/zn/packages/core/src/motion.ts")).toEqual([])
  })
})
