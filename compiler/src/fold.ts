// Build-time constant folding: decides which JSX prop values are known at build time (so they go into the template)
// and computes them. Anything not foldable stays a runtime expression (a slot) or is a build error.
//
// Foldable: literals, -number, template strings without ${}, object/array literals of foldables, `StyleSheet.create`,
// module-level `const` bindings with foldable initialisers, member access on foldables, and named imports from `.ts`
// modules (design tokens, styles) that the compiler loads at build time (`staticImports`).
import ts from "typescript"

export const NOT_STATIC: unique symbol = Symbol("not static")
export type Folded = unknown | typeof NOT_STATIC

export interface FoldScope {
  /** Module-level `const` initialisers by name. */
  consts: Map<string, ts.Expression>
  /** Named imports resolved at build time: local name → value (already evaluated). */
  staticImports: Map<string, unknown>
}

export function fold(expr: ts.Expression, scope: FoldScope, seen = new Set<string>()): Folded {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return fold(expr.expression, scope, seen)
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return Number(expr.text)
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const v = fold(expr.operand, scope, seen)
    return typeof v === "number" ? -v : NOT_STATIC
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {}
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = propertyKey(p.name)
        if (key === null) return NOT_STATIC
        const v = fold(p.initializer, scope, seen)
        if (v === NOT_STATIC) return NOT_STATIC
        out[key] = v
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
  return NOT_STATIC
}

function propertyKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}
