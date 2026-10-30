// Reads an app's `defineRoutes({...})` call at build time (ARCHITECTURE.md §11) and turns it into the route table of
// the bundle manifest. The file is parsed, never run: running it would also run the screen components.
//
// Rules (each broken rule is a build error with file:line:col):
//   - exactly one `defineRoutes({...})` call per app, with an object literal of `name: { path, screen, ...options }`
//   - names start with a letter (JS keeps key order only for non-number keys; the order is the route index)
//   - `path` is a string literal: "/" or "/segment/:param/..."; params are unique; no two routes share a pattern
//   - `screen` is a component name (imported or declared in the file); options are build-time constants
//   - one route has the path "/": it is where the app starts when there is nothing to restore or open
import ts from "typescript"
import { fold, NOT_STATIC } from "./fold"

export interface RouteEntry {
  name: string
  path: string
  /** The screen component's name; the build resolves it to a template id. */
  component: string
  transition: "push" | "modal" | "fade" | "none"
  safeArea: "all" | "none" | { top: boolean; bottom: boolean }
  statusBar: "dark" | "light"
  deepLink: boolean
  /** "resize" (default): the screen shrinks above the keyboard. "none": the keyboard covers the screen. */
  keyboard: "resize" | "none"
  /** false: not reopened after Android kills the app in the background (default true). */
  restore: boolean
}

const TRANSITIONS = ["push", "modal", "fade", "none"]
const OPTIONS = ["transition", "safeArea", "statusBar", "deepLink", "keyboard", "restore"]

/** The routes declared in [source], or null if it has no `defineRoutes` call. */
export function readRoutes(source: string, fileName: string): RouteEntry[] | null {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fail = (node: ts.Node, message: string): never => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    throw new Error(`${fileName}:${line + 1}:${character + 1}: ${message}`)
  }

  // Local name → exported name of imported components (`import { AmountScreen as Amount }`).
  const importedAs = new Map<string, string>()
  const declared = new Set<string>()
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const named = stmt.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) importedAs.set(el.name.text, (el.propertyName ?? el.name).text)
      }
      if (stmt.importClause?.name) importedAs.set(stmt.importClause.name.text, stmt.importClause.name.text)
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      declared.add(stmt.name.text)
    }
  }

  const calls: ts.CallExpression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "defineRoutes") calls.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  if (calls.length === 0) return null
  if (calls.length > 1) fail(calls[1], "only one defineRoutes(...) call per app")
  const arg = calls[0].arguments[0]
  if (calls[0].arguments.length !== 1 || !arg || !ts.isObjectLiteralExpression(arg)) {
    fail(calls[0], "defineRoutes needs one object literal: defineRoutes({ home: { path: \"/\", screen: Home } })")
  }

  const scope = { consts: new Map<string, ts.Expression>(), staticImports: new Map<string, unknown>() }
  const routes: RouteEntry[] = []
  const patterns = new Map<string, string>()
  for (const prop of (arg as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(prop)) fail(prop, "each route is written as name: { path, screen, ... }")
    const p = prop as ts.PropertyAssignment
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : fail(p.name, "route names must be plain names")
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) fail(p.name, `route name "${name}" must start with a letter (letters, digits, _)`)
    if (!ts.isObjectLiteralExpression(p.initializer)) fail(p.initializer, "a route is an object literal: { path, screen, ... }")

    let path: string | null = null
    let component: string | null = null
    const options: Record<string, unknown> = {}
    for (const field of (p.initializer as ts.ObjectLiteralExpression).properties) {
      if (!ts.isPropertyAssignment(field) || !ts.isIdentifier(field.name)) fail(field, "unsupported route entry")
      const f = field as ts.PropertyAssignment
      const key = (f.name as ts.Identifier).text
      if (key === "path") {
        if (!ts.isStringLiteral(f.initializer) && !ts.isNoSubstitutionTemplateLiteral(f.initializer)) {
          fail(f.initializer, "path must be a string literal")
        }
        path = (f.initializer as ts.StringLiteral).text
        checkPath(path, f.initializer)
      } else if (key === "screen") {
        if (!ts.isIdentifier(f.initializer)) fail(f.initializer, "screen must be a component name, e.g. screen: AmountScreen")
        const local = (f.initializer as ts.Identifier).text
        if (!importedAs.has(local) && !declared.has(local)) fail(f.initializer, `"${local}" is not imported or declared in this file`)
        component = importedAs.get(local) ?? local
      } else if (OPTIONS.includes(key)) {
        const v = fold(f.initializer, scope)
        if (v === NOT_STATIC) fail(f.initializer, `${key} must be a constant`)
        options[key] = v
        checkOption(key, v, f.initializer)
      } else {
        fail(f.name, `unknown route option "${key}" (use path, screen, ${OPTIONS.join(", ")})`)
      }
    }
    if (path === null) fail(p, `route "${name}" needs a path`)
    if (component === null) fail(p, `route "${name}" needs a screen`)

    const pattern = path!.replace(/:[^/]+/g, ":")
    if (patterns.has(pattern)) fail(p, `route "${name}" has the same path pattern as "${patterns.get(pattern)}"`)
    patterns.set(pattern, name)

    const safeArea = options.safeArea ?? "all"
    routes.push({
      name,
      path: path!,
      component: component!,
      transition: (options.transition as RouteEntry["transition"]) ?? "push",
      safeArea:
        typeof safeArea === "object"
          ? { top: (safeArea as any).top ?? true, bottom: (safeArea as any).bottom ?? true }
          : (safeArea as "all" | "none"),
      statusBar: (options.statusBar as RouteEntry["statusBar"]) ?? "dark",
      deepLink: (options.deepLink as boolean) ?? false,
      keyboard: (options.keyboard as RouteEntry["keyboard"]) ?? "resize",
      restore: (options.restore as boolean) ?? true,
    })
  }
  if (!routes.some((r) => r.path === "/")) fail(arg, 'one route needs path "/" (where the app starts)')
  return routes

  function checkPath(path: string, at: ts.Node) {
    if (path === "/") return
    if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
      fail(at, `path "${path}" must start with "/" and have no empty segments, e.g. "/pay/:merchantId"`)
    }
    const params = new Set<string>()
    for (const seg of path.slice(1).split("/")) {
      if (seg.startsWith(":")) {
        const p = seg.slice(1)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) fail(at, `path param ":${p}" must be a plain name`)
        if (params.has(p)) fail(at, `path param ":${p}" is used twice`)
        params.add(p)
      } else if (!/^[A-Za-z0-9._~-]+$/.test(seg)) {
        fail(at, `path segment "${seg}" may only use letters, digits and . _ ~ -`)
      }
    }
  }

  function checkOption(key: string, v: unknown, at: ts.Node) {
    const ok =
      key === "transition" ? TRANSITIONS.includes(v as string)
      : key === "statusBar" ? v === "dark" || v === "light"
      : key === "deepLink" || key === "restore" ? typeof v === "boolean"
      : key === "keyboard" ? v === "resize" || v === "none"
      : v === "all" || v === "none" ||
        (typeof v === "object" && v !== null &&
          Object.entries(v).every(([k, b]) => (k === "top" || k === "bottom") && typeof b === "boolean"))
    if (!ok) fail(at, `unsupported ${key} ${JSON.stringify(v)}`)
  }
}
