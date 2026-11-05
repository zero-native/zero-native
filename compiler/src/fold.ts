// Build-time constant folding: decides which JSX prop values are known at build time (so they go into the template)
// and computes them. Anything not foldable stays a runtime expression (a slot) or is a build error.
//
// Foldable: literals, -number, template strings, object/array literals of foldables, `StyleSheet.create`,
// `StyleSheet.absoluteFill`, `StyleSheet.hairlineWidth`, `StyleSheet.flatten` (RN-compat sweep P1.12),
// `const` bindings with foldable initialisers (module level, or inside a component body: guide notes §47), member
// access on foldables, and named imports from `.ts` modules (design tokens, styles) that the compiler loads at build
// time (`staticImports`). Also simple operators on foldables: `c ? a : b`, `??`, `||`, `&&`, `!`,
// `=== !== == != < > <= >=`, `+ - * / %`.
//
// A name is looked up where it is written, as JavaScript does: a `.map((size) => ...)` parameter or a local `let` with
// the same name as a const hides the const, so it is not folded.
import ts from "typescript"

export const NOT_STATIC: unique symbol = Symbol("not static")

/** StyleSheet.absoluteFill: fills the parent `Stack` (RN's left / right are start / end in zn). */
export const ABSOLUTE_FILL = { position: "absolute", top: 0, start: 0, end: 0, bottom: 0 } as const
/**
 * StyleSheet.hairlineWidth, in dp. React Native rounds 0.4 dp to one real pixel on each phone; a build can't know the
 * phone, so it is 0.4 dp: one pixel or a little more on most phones (packages/ui has the same number).
 */
export const HAIRLINE_WIDTH = 0.4
export type Folded = unknown | typeof NOT_STATIC

export interface FoldScope {
  /** Module-level `const` initialisers by name. */
  consts: Map<string, ts.Expression>
  /** Named imports resolved at build time: local name → value (already evaluated). */
  staticImports: Map<string, unknown>
  /** Values a build-time loop gives its parameters (inline SVG `.map`): used first, by name. */
  locals?: Map<string, unknown>
}

export function fold(expr: ts.Expression, scope: FoldScope, seen = new Set<unknown>()): Folded {
  if (
    ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)
  ) {
    return fold(expr.expression, scope, seen)
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return Number(expr.text)
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(expr)) {
    const v = fold(expr.operand, scope, seen)
    if (v === NOT_STATIC) return NOT_STATIC
    if (expr.operator === ts.SyntaxKind.MinusToken) return typeof v === "number" ? -v : NOT_STATIC
    if (expr.operator === ts.SyntaxKind.PlusToken) return typeof v === "number" ? v : NOT_STATIC
    if (expr.operator === ts.SyntaxKind.ExclamationToken) return !v
    return NOT_STATIC
  }
  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text
    for (const span of expr.templateSpans) {
      const v = fold(span.expression, scope, seen)
      if (!isPrimitive(v)) return NOT_STATIC
      out += String(v) + span.literal.text
    }
    return out
  }
  if (ts.isConditionalExpression(expr)) {
    const c = fold(expr.condition, scope, seen)
    if (c === NOT_STATIC) return NOT_STATIC
    return fold(c ? expr.whenTrue : expr.whenFalse, scope, seen)
  }
  if (ts.isBinaryExpression(expr)) return binary(expr, scope, seen)
  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {}
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = propertyKey(p.name)
        if (key === null) return NOT_STATIC
        const v = fold(p.initializer, scope, seen)
        if (v === NOT_STATIC) return NOT_STATIC
        out[key] = v
      } else if (ts.isShorthandPropertyAssignment(p) && !p.objectAssignmentInitializer) {
        const v = fold(p.name, scope, seen)
        if (v === NOT_STATIC) return NOT_STATIC
        out[p.name.text] = v
      } else if (ts.isSpreadAssignment(p)) {
        const v = fold(p.expression, scope, seen)
        if (v === NOT_STATIC || typeof v !== "object" || v === null) return NOT_STATIC
        Object.assign(out, v)
      } else {
        return NOT_STATIC
      }
    }
    return out
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const out: unknown[] = []
    for (const e of expr.elements) {
      const v = fold(e, scope, seen)
      if (v === NOT_STATIC) return NOT_STATIC
      out.push(v)
    }
    return out
  }
  if (ts.isIdentifier(expr)) {
    const name = expr.text
    if (scope.locals?.has(name)) return scope.locals.get(name)
    const local = localBinding(expr)
    if (local === "hidden") return NOT_STATIC
    if (local) {
      // A const inside a function (a component body): its initialiser, looked up where it is written.
      if (seen.has(local)) return NOT_STATIC
      seen.add(local)
      const v = fold(local.initializer!, scope, seen)
      seen.delete(local)
      return v
    }
    if (name === "undefined") return undefined
    if (scope.staticImports.has(name)) return scope.staticImports.get(name)
    const init = scope.consts.get(name)
    if (!init || seen.has(name)) return NOT_STATIC
    seen.add(name)
    const v = fold(init, scope, seen)
    seen.delete(name)
    return v
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // React Native's StyleSheet.absoluteFill / absoluteFillObject: the same style, known at build time.
    if (
      ts.isIdentifier(expr.expression) && expr.expression.text === "StyleSheet" && !scope.consts.has("StyleSheet") &&
      !scope.staticImports.has("StyleSheet") && (expr.name.text === "absoluteFill" || expr.name.text === "absoluteFillObject")
    ) {
      return { ...ABSOLUTE_FILL }
    }
    if (
      ts.isIdentifier(expr.expression) && expr.expression.text === "StyleSheet" && !scope.consts.has("StyleSheet") &&
      !scope.staticImports.has("StyleSheet") && expr.name.text === "hairlineWidth"
    ) {
      return HAIRLINE_WIDTH
    }
    const obj = fold(expr.expression, scope, seen)
    if (obj === NOT_STATIC || typeof obj !== "object" || obj === null) return NOT_STATIC
    const name = expr.name.text
    return Object.prototype.hasOwnProperty.call(obj, name) ? (obj as Record<string, unknown>)[name] : NOT_STATIC
  }
  if (ts.isElementAccessExpression(expr)) {
    const obj = fold(expr.expression, scope, seen)
    const key = fold(expr.argumentExpression, scope, seen)
    if (obj === NOT_STATIC || typeof obj !== "object" || obj === null) return NOT_STATIC
    if (typeof key !== "string" && typeof key !== "number") return NOT_STATIC
    return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : NOT_STATIC
  }
  // StyleSheet.create({...}) is the identity at build time.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "StyleSheet" &&
    expr.expression.name.text === "create" &&
    expr.arguments.length === 1
  ) {
    return fold(expr.arguments[0], scope, seen)
  }
  // StyleSheet.flatten([a, b]): one object, later entries winning, falsy entries skipped (as in React Native).
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "StyleSheet" &&
    expr.expression.name.text === "flatten" &&
    expr.arguments.length === 1
  ) {
    const v = fold(expr.arguments[0], scope, seen)
    if (v === NOT_STATIC) return NOT_STATIC
    const out: Record<string, unknown> = {}
    const merge = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(merge)
      else if (x && typeof x === "object") Object.assign(out, x)
    }
    merge(v)
    return out
  }
  return NOT_STATIC
}

function isPrimitive(v: unknown): v is string | number | boolean | null | undefined {
  return v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
}

/** `a ?? b`, `a || b`, `a && b` (only the side that is used must be known), comparisons and arithmetic. */
function binary(expr: ts.BinaryExpression, scope: FoldScope, seen: Set<unknown>): Folded {
  const op = expr.operatorToken.kind
  const left = fold(expr.left, scope, seen)
  if (left === NOT_STATIC) return NOT_STATIC
  const K = ts.SyntaxKind
  if (op === K.QuestionQuestionToken) return left ?? fold(expr.right, scope, seen)
  if (op === K.BarBarToken) return left || fold(expr.right, scope, seen)
  if (op === K.AmpersandAmpersandToken) return left && fold(expr.right, scope, seen)
  const right = fold(expr.right, scope, seen)
  if (!isPrimitive(left) || !isPrimitive(right)) return NOT_STATIC
  const l = left as any
  const r = right as any
  const num = (n: number) => (Number.isFinite(n) ? n : NOT_STATIC)
  const nums = typeof l === "number" && typeof r === "number"
  switch (op) {
    case K.EqualsEqualsEqualsToken: return l === r
    case K.ExclamationEqualsEqualsToken: return l !== r
    case K.EqualsEqualsToken: return l == r
    case K.ExclamationEqualsToken: return l != r
    case K.LessThanToken: return nums || (typeof l === "string" && typeof r === "string") ? l < r : NOT_STATIC
    case K.GreaterThanToken: return nums || (typeof l === "string" && typeof r === "string") ? l > r : NOT_STATIC
    case K.LessThanEqualsToken: return nums || (typeof l === "string" && typeof r === "string") ? l <= r : NOT_STATIC
    case K.GreaterThanEqualsToken: return nums || (typeof l === "string" && typeof r === "string") ? l >= r : NOT_STATIC
    case K.PlusToken:
      if (nums) return num(l + r)
      // Joining text: a string with a string or a number (as `${a}${b}`); nothing else turns into text by accident.
      if ((typeof l === "string" || typeof l === "number") && (typeof r === "string" || typeof r === "number")) return String(l) + String(r)
      return NOT_STATIC
    case K.MinusToken: return nums ? num(l - r) : NOT_STATIC
    case K.AsteriskToken: return nums ? num(l * r) : NOT_STATIC
    case K.SlashToken: return nums ? num(l / r) : NOT_STATIC
    case K.PercentToken: return nums ? num(l % r) : NOT_STATIC
    default: return NOT_STATIC
  }
}

/**
 * Where [id] is declared, below the module: a `const` with an initialiser (foldable), "hidden" (a parameter, a `let`,
 * a function... that is not a build-time value), or undefined (not declared inside any function or block: a module
 * name). Identifiers made by the compiler (no parent) count as module names.
 */
export function localBinding(id: ts.Identifier): ts.VariableDeclaration | "hidden" | undefined {
  const name = id.text
  for (let n: ts.Node | undefined = id.parent; n && !ts.isSourceFile(n); n = n.parent) {
    const found = declaredIn(n, name)
    if (found) return found
  }
  return undefined
}

/** The declaration of [name] that [scope] itself makes (its parameters, its statements), if any. */
export function declaredIn(scope: ts.Node, name: string): ts.VariableDeclaration | "hidden" | undefined {
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) if (bindsName(p.name, name)) return "hidden"
    if ((ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === name) return "hidden"
    // `var` anywhere in the body belongs to the function.
    const body = (scope as ts.FunctionLikeDeclaration).body
    if (body && ts.isBlock(body) && hasVar(body, name)) return "hidden"
    return undefined
  }
  if (ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
    for (const s of scope.statements) {
      if (ts.isVariableStatement(s)) {
        const isConst = (s.declarationList.flags & ts.NodeFlags.Const) !== 0
        for (const d of s.declarationList.declarations) {
          if (!bindsName(d.name, name)) continue
          return isConst && ts.isIdentifier(d.name) && d.initializer ? d : "hidden"
        }
      } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) && s.name?.text === name) {
        return "hidden"
      }
    }
    return undefined
  }
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer
    if (init && ts.isVariableDeclarationList(init) && init.declarations.some((d) => bindsName(d.name, name))) return "hidden"
    return undefined
  }
  if (ts.isCatchClause(scope)) {
    return scope.variableDeclaration && bindsName(scope.variableDeclaration.name, name) ? "hidden" : undefined
  }
  return undefined
}

function bindsName(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name
  return b.elements.some((e) => !ts.isOmittedExpression(e) && bindsName(e.name, name))
}

const varNames = new WeakMap<ts.Node, Set<string>>()

function hasVar(body: ts.Node, name: string): boolean {
  let names = varNames.get(body)
  if (!names) {
    const found = new Set<string>()
    const add = (b: ts.BindingName) => {
      if (ts.isIdentifier(b)) found.add(b.text)
      else for (const e of b.elements) if (!ts.isOmittedExpression(e)) add(e.name)
    }
    const walk = (n: ts.Node) => {
      if (ts.isFunctionLike(n)) return
      if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
        for (const d of n.declarations) add(d.name)
      }
      ts.forEachChild(n, walk)
    }
    ts.forEachChild(body, walk)
    names = found
    varNames.set(body, names)
  }
  return names.has(name)
}

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}
