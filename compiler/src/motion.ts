// derive(() => expr) → data native runs every frame (docs/gestures-and-motion-v1.md §2.4, D1; runtime: core motion.ts
// __deriveFormula, android ZnFormula.kt). The arrow is never run: its expression becomes postfix tokens, and every
// leaf that isn't a number, Math.*, self / parent or a known helper becomes an input that the generated code reads
// where the arrow was (a motion value, or a number fixed at that moment).
//
//   derive(() => Math.abs(pan.x) / 120)
//   → derive.__f(["$0","abs",120,"/"], [pan.x], [], false)
//
// The call is replaced in place with the same number of lines, so source maps stay right line by line.
import ts from "typescript"

export const MAX_OPS = 64
export const MAX_STACK = 16

const MATH_FNS: Record<string, number> = {
  abs: 1, floor: 1, ceil: 1, round: 1, sign: 1, sqrt: 1, sin: 1, cos: 1, tan: 1, exp: 1, log: 1,
  pow: 2, atan2: 2, hypot: -2, min: -2, max: -2, // -2: two or more (chained)
}
const MATH_CONSTS: Record<string, number> = { PI: Math.PI, E: Math.E }
const BINARY: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!=",
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
}
const SELF: Record<string, string> = { "self.width": "sw", "self.height": "sh", "parent.width": "pw", "parent.height": "ph" }
const EXTRAPOLATE: Record<string, number> = { clamp: 0, extend: 1, identity: 2 }

export interface CompiledFormula {
  tokens: (string | number)[]
  /** Source text of each input, in "$k" order. */
  inputs: string[]
  tables: unknown[][]
  color: boolean
}

/** Compiles one derive body. Throws an Error naming the problem (the caller adds the position). */
export function compileFormula(body: ts.Expression, sf: ts.SourceFile, names: { clamp?: string; interpolate?: string; interpolateColor?: string }): CompiledFormula {
  const tokens: (string | number)[] = []
  const inputs: string[] = []
  const tables: unknown[][] = []
  let color = false
  let depth = 0
  let maxDepth = 0
  const push = (t: string | number, pops: number) => {
    tokens.push(t)
    depth = depth - pops + 1
    maxDepth = Math.max(maxDepth, depth)
  }
  const text = (n: ts.Node) => n.getText(sf)
  const numberArray = (n: ts.Expression, what: string): number[] => {
    const e = unwrap(n)
    if (!ts.isArrayLiteralExpression(e)) throw new Error(`${what} must be an array of numbers written in place`)
    return e.elements.map((x) => {
      const u = unwrap(x)
      // A number, or a top-level `const NAME = 120` of this file (the table is fixed at build time).
      const v = constNumber(x) ?? (ts.isIdentifier(u) ? fileConsts(sf).get(u.text) ?? null : null)
      if (v === null) throw new Error(`${what}: ${text(x)} is not a number (write it in place, or as a top-level const of this file)`)
      return v
    })
  }
  const stringArray = (n: ts.Expression, what: string): string[] => {
    const e = unwrap(n)
    if (!ts.isArrayLiteralExpression(e)) throw new Error(`${what} must be an array of colour strings written in place`)
    return e.elements.map((x) => {
      if (!ts.isStringLiteralLike(x)) throw new Error(`${what}: ${text(x)} is not a colour string`)
      return x.text
    })
  }
  const extrapolateOf = (n: ts.Expression | undefined): number => {
    if (!n) return 0
    const e = unwrap(n)
    let s: string | null = null
    if (ts.isStringLiteralLike(e)) s = e.text
    else if (ts.isPropertyAccessExpression(e) && /^Extrapolat(e|ion)$/.test(text(e.expression))) s = e.name.text.toLowerCase()
    else if (ts.isObjectLiteralExpression(e)) {
      const p = e.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === "extrapolate")
      if (p && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) s = p.initializer.text
    }
    if (s === null || !(s in EXTRAPOLATE)) throw new Error(`interpolate: extrapolate must be "clamp", "extend" or "identity" written in place`)
    return EXTRAPOLATE[s]
  }

  const visit = (n: ts.Expression, top: boolean): void => {
    const e = unwrap(n)
    const num = constNumber(e)
    if (num !== null) return push(num, 0)
    if (ts.isPrefixUnaryExpression(e)) {
      visit(e.operand, false)
      if (e.operator === ts.SyntaxKind.MinusToken) return push("neg", 1)
      if (e.operator === ts.SyntaxKind.PlusToken) return
      if (e.operator === ts.SyntaxKind.ExclamationToken) return push("!", 1)
      throw new Error(`can't use ${ts.tokenToString(e.operator)} in a formula`)
    }
    if (ts.isBinaryExpression(e)) {
      const op = BINARY[e.operatorToken.kind]
      if (!op) throw new Error(`can't use ${e.operatorToken.getText(sf)} in a formula`)
      visit(e.left, false)
      visit(e.right, false)
      return push(op, 2)
    }
    if (ts.isConditionalExpression(e)) {
      visit(e.condition, false)
      visit(e.whenTrue, false)
      visit(e.whenFalse, false)
      return push("?", 3)
    }
    if (ts.isPropertyAccessExpression(e) && text(e) in SELF) return push(SELF[text(e)], 0)
    if (ts.isPropertyAccessExpression(e) && text(e.expression) === "Math") {
      const c = MATH_CONSTS[e.name.text]
      if (c === undefined) throw new Error(`Math.${e.name.text} isn't a number a formula can use`)
      return push(c, 0)
    }
    if (ts.isCallExpression(e)) {
      const callee = text(e.expression)
      const args = e.arguments
      if (ts.isPropertyAccessExpression(e.expression) && text(e.expression.expression) === "Math") {
        const fn = e.expression.name.text
        const arity = MATH_FNS[fn]
        if (arity === undefined) throw new Error(`Math.${fn} can't be used in a formula`)
        if (arity === -2) {
          if (args.length < 2) throw new Error(`Math.${fn} needs two or more values`)
          visit(args[0], false)
          for (let i = 1; i < args.length; i++) {
            visit(args[i], false)
            push(fn, 2)
          }
          return
        }
        if (args.length !== arity) throw new Error(`Math.${fn} takes ${arity} value${arity > 1 ? "s" : ""}`)
        args.forEach((a) => visit(a, false))
        return push(fn, arity)
      }
      if (names.clamp && callee === names.clamp) {
        if (args.length !== 3) throw new Error("clamp(x, min, max) takes 3 values")
        args.forEach((a) => visit(a, false))
        return push("clamp", 3)
      }
      if (names.interpolate && callee === names.interpolate) {
        if (args.length < 3 || args.length > 4) throw new Error("interpolate(x, [inputs], [outputs], extrapolate?)")
        const ins = numberArray(args[1], "interpolate inputs")
        const outs = numberArray(args[2], "interpolate outputs")
        if (ins.length < 2 || ins.length !== outs.length) throw new Error("interpolate needs 2 or more inputs and as many outputs")
        for (let i = 1; i < ins.length; i++) if (ins[i] < ins[i - 1]) throw new Error("interpolate inputs must go up")
        visit(args[0], false)
        tables.push([ins, outs, extrapolateOf(args[3]), 0])
        return push(`L${tables.length - 1}`, 1)
      }
      if (names.interpolateColor && callee === names.interpolateColor) {
        if (!top) throw new Error("interpolateColor must be the whole formula (its last step), e.g. derive(() => interpolateColor(x, [0, 1], [\"#fff\", \"#000\"]))")
        if (args.length !== 3) throw new Error("interpolateColor(x, [inputs], [colours])")
        const ins = numberArray(args[1], "interpolateColor inputs")
        const outs = stringArray(args[2], "interpolateColor colours")
        if (ins.length < 2 || ins.length !== outs.length) throw new Error("interpolateColor needs 2 or more inputs and as many colours")
        visit(args[0], false)
        tables.push([ins, outs, 0, 1])
        color = true
        return push(`C${tables.length - 1}`, 1)
      }
      // pan.x() reads a motion value, as it does in JS: the same input as a bare pan.x, and it typechecks as a number.
      if (args.length === 0 && (ts.isIdentifier(e.expression) || ts.isPropertyAccessExpression(e.expression) || ts.isElementAccessExpression(e.expression))) {
        return visit(e.expression, top)
      }
      throw new Error(`can't call ${callee}() in a formula. Inside derive, read a motion value as pan.x() and use ` +
        "numbers, Math, clamp, interpolate; compute anything else in JS (one frame late) or use a native plugin source")
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      if (ts.isIdentifier(e) && (e.text === "self" || e.text === "parent")) throw new Error(`use ${e.text}.width or ${e.text}.height`)
      if (ts.isIdentifier(e) && e.text === "undefined") throw new Error("undefined isn't a number")
      const src = text(e)
      let k = inputs.indexOf(src)
      if (k < 0) {
        k = inputs.length
        inputs.push(src)
      }
      return push(`$${k}`, 0)
    }
    if (e.kind === ts.SyntaxKind.TrueKeyword) return push(1, 0)
    if (e.kind === ts.SyntaxKind.FalseKeyword) return push(0, 0)
    throw new Error(`can't use "${text(e)}" in a formula (numbers, motion values, maths, ? : only)`)
  }
  visit(body, true)
  if (tokens.length > MAX_OPS) throw new Error(`the formula has ${tokens.length} steps; at most ${MAX_OPS}. Split it into two derive() values`)
  if (maxDepth > MAX_STACK) throw new Error(`the formula needs ${maxDepth} values at once; at most ${MAX_STACK}. Split it into two derive() values`)
  return { tokens, inputs, tables, color }
}

const constsCache = new WeakMap<ts.SourceFile, Map<string, number>>()

/** The file's top-level `const NAME = <number>` (also `-120`), for interpolate tables. */
function fileConsts(sf: ts.SourceFile): Map<string, number> {
  let m = constsCache.get(sf)
  if (m) return m
  m = new Map()
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue
      const v = constNumber(d.initializer)
      if (v !== null) m.set(d.name.text, v)
    }
  }
  constsCache.set(sf, m)
  return m
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression
  return e
}

function constNumber(e: ts.Expression): number | null {
  e = unwrap(e)
  if (ts.isNumericLiteral(e)) return Number(e.text)
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(unwrap(e.operand))) {
    return -Number((unwrap(e.operand) as ts.NumericLiteral).text)
  }
  return null
}

/** The local names the file gives to core's derive helpers (import { derive as d } works too). */
function coreNames(sf: ts.SourceFile): Record<string, string> {
  const out: Record<string, string> = {}
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "@zeronative/core") continue
    const named = st.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const el of named.elements) {
      const real = (el.propertyName ?? el.name).text
      if (["derive", "clamp", "interpolate", "interpolateColor"].includes(real)) out[real] = el.name.text
    }
  }
  return out
}

/**
 * Replaces every derive(() => expr) in [code] (a module's source, or the compiler's output for a .tsx) with the
 * compiled call. Returns [code] unchanged when there is none. Errors name the file, line and what to change.
 */
export function compileDerives(code: string, fileName: string): string {
  if (!code.includes("derive")) return code
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind)
  const names = coreNames(sf)
  const derive = names.derive
  if (!derive) return code
  const edits: { start: number; end: number; text: string }[] = []
  const where = (n: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
    return `${fileName}:${line + 1}:${character + 1}`
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === derive) {
      const fn = n.arguments[0]
      if (n.arguments.length !== 1 || !fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters.length > 0) {
        throw new Error(`${where(n)}: derive takes one arrow with no parameters: derive(() => pan.x * 2)`)
      }
      let body: ts.Expression | undefined
      if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) body = fn.body
      else {
        const block = fn.body as ts.Block
        const ret = block.statements.length === 1 ? block.statements[0] : undefined
        if (ret && ts.isReturnStatement(ret) && ret.expression) body = ret.expression
      }
      if (!body) throw new Error(`${where(n)}: derive's arrow must be one expression: derive(() => pan.x * 2)`)
      let f: CompiledFormula
      try {
        f = compileFormula(body, sf, names)
      } catch (e) {
        throw new Error(`${where(n)}: derive: ${(e as Error).message}`)
      }
      const original = code.slice(n.getStart(sf), n.getEnd())
      const lines = (original.match(/\n/g) ?? []).length
      const call = `${derive}.__f(${JSON.stringify(f.tokens)}, [${f.inputs.join(", ")}], ${JSON.stringify(f.tables)}, ${f.color})`
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: call + "\n".repeat(lines) })
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (edits.length === 0) return code
  let out = code
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}
