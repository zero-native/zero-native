// Bun build plugin: compiles every .tsx file with the zero-native compiler during bundling, collects all templates
// into one .zn.ui file, and writes the manifest: component name → template id, and the route table read from the
// app's `defineRoutes({...})` (ARCHITECTURE §11; a route's index in the table is its number at runtime).
import type { BunPlugin } from "bun"
import { dirname, resolve } from "node:path"
import { existsSync } from "node:fs"
import ts from "typescript"
import { type NodeSpec, writeTemplateFile } from "@zero-native/template"
import { compileModule } from "./compile"
import { readRoutes, type RouteEntry } from "./routes"

/** One route in the manifest: the route entry with its screen's template id. */
export type ManifestRoute = RouteEntry & { screen: number }

export interface ZnManifest {
  components: Record<string, number>
  routes: ManifestRoute[]
}

export interface ZnBuild {
  plugin: BunPlugin
  /** After Bun.build: the .zn.ui bytes and the manifest. */
  outputs(): { templates: Uint8Array; manifest: ZnManifest }
}

export function znBuild(): ZnBuild {
  const specs: NodeSpec[] = []
  const components: Record<string, number> = {}
  let routes: { file: string; entries: RouteEntry[] } | null = null
  const ctx = {
    reserveTemplate() {
      specs.push(null as unknown as NodeSpec)
      return specs.length - 1
    },
    defineTemplate(id: number, spec: NodeSpec) {
      specs[id] = spec
    },
  }

  const plugin: BunPlugin = {
    name: "zero-native",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
        const source = await Bun.file(path).text()
        const staticImports = await loadStaticImports(source, path)
        const out = compileModule(source, path, ctx, staticImports)
        for (const [name, id] of Object.entries(out.components)) {
          if (name in components && components[name] !== id) {
            throw new Error(`${path}: component name "${name}" is used in two files; names must be unique for now`)
          }
          components[name] = id
        }
        return { contents: out.code, loader: "ts" }
      })
      // Plain .ts files pass through unchanged; the one with defineRoutes(...) is also read for the route table.
      build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text()
        if (source.includes("defineRoutes(") && !path.includes("node_modules")) {
          const entries = readRoutes(source, path)
          if (entries) {
            if (routes) throw new Error(`${path}: defineRoutes is already called in ${routes.file}; one per app`)
            routes = { file: path, entries }
          }
        }
        return { contents: source, loader: "ts" }
      })
    },
  }

  return {
    plugin,
    outputs() {
      const table: ManifestRoute[] = (routes?.entries ?? []).map((r) => {
        const screen = components[r.component]
        if (screen === undefined) {
          throw new Error(
            `${routes!.file}: route "${r.name}": screen ${r.component} has no template ` +
              `(it must be a component in a .tsx file whose root is a zero-native element)`,
          )
        }
        return { ...r, screen }
      })
      return { templates: writeTemplateFile(specs).bytes, manifest: { components, routes: table } }
    },
  }
}

/**
 * Named imports from relative `.ts` modules (design tokens, styles, constants) are loaded at build time so their
 * values can be folded into templates. Such modules must not have side effects. `.tsx` modules (components) are
 * never loaded this way.
 */
async function loadStaticImports(source: string, path: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>()
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith(".")) continue
    const base = resolve(dirname(path), spec)
    const file = [base, `${base}.ts`].find((f) => f.endsWith(".ts") && existsSync(f))
    if (!file) continue
    const named = stmt.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    const mod = await import(file)
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text
      if (imported in mod) out.set(el.name.text, mod[imported])
    }
  }
  return out
}
