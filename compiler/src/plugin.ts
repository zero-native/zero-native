// Bun build plugin: compiles every .tsx file with the zero-native compiler during bundling, collects all templates
// into one .zn.ui file, and writes the manifest: component name → template id, and the route table read from the
// app's `defineRoutes({...})` (ARCHITECTURE §11; a route's index in the table is its number at runtime).
import type { BunPlugin } from "bun"
import { dirname, join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import ts from "typescript"
import { type NodeSpec, writeTemplateFile } from "@zero-native/template"
import { compileModule } from "./compile"
import type { LineMap } from "./sourcemap"
import { readRoutes, type RouteEntry } from "./routes"
import { nativeModuleUses } from "./modules"
import { HOST_API_VERSION } from "@zero-native/core/src/host-api"

/** One route in the manifest: the route entry with its screen's template id (-1 for a native screen). */
export type ManifestRoute = RouteEntry & { screen: number }

export interface ZnManifest {
  components: Record<string, number>
  routes: ManifestRoute[]
}

/**
 * What an app must have to run this bundle (docs/ota.md §3.2): the lowest registry version that has everything the
 * templates use, the host API of the bundled `@zero-native/core`, and every native module called with the highest
 * version asked for. The Hermes bytecode format is added after hermesc (tools/hermesc.ts).
 */
export interface BundleRequires {
  registry: number
  hostApi: number
  modules: Record<string, number>
}

export interface ZnBuild {
  plugin: BunPlugin
  /**
   * After Bun.build: the .zn.ui bytes, the manifest, and the bundle's [js] with the template ids filled in.
   * Templates are numbered by file path, then by their order in the file, so the same source always gives the same
   * bytes (one bundle = one SHA-256, docs/ota.md §3.1; small binary patches later), whatever order Bun loaded files.
   */
  outputs(js: string): { templates: Uint8Array; manifest: ZnManifest; js: string; requires: BundleRequires }
  /** After Bun.build: per .tsx file (absolute path), compiler output position → TSX position. */
  maps: Map<string, LineMap>
}

/** Template id placeholder in generated code: fixed width, so filling it in (padded with spaces) moves no column. */
const PLACEHOLDER = /__znT(\d{6})__/g
const placeholder = (n: number) => `__znT${String(n).padStart(6, "0")}__`

export function znBuild(): ZnBuild {
  // Indexed by reservation number (the order templates were reserved in, which depends on Bun's load order).
  const specs: NodeSpec[] = []
  const reservedBy: { file: string; seq: number }[] = []
  /** Component name → reservation number. */
  const components: Record<string, number> = {}
  const maps = new Map<string, LineMap>()
  let routes: { file: string; entries: RouteEntry[] } | null = null
  let compiling = "" // the file being compiled; compileModule is synchronous, so no two files interleave
  let seqInFile = 0
  /** Native module name → the highest version any loaded file asks for. */
  const modules = new Map<string, number>()
  const addModules = (source: string, path: string) => {
    for (const { name, version } of nativeModuleUses(source, path)) {
      modules.set(name, Math.max(modules.get(name) ?? 0, version))
    }
  }
  /** Every <NativeView>, checked in outputs(), when all files are read. */
  const nativeViews: { name: string; where: string }[] = []
  const ctx = {
    reserveTemplate() {
      specs.push(null as unknown as NodeSpec)
      reservedBy.push({ file: compiling, seq: seqInFile++ })
      return specs.length - 1
    },
    defineTemplate(id: number, spec: NodeSpec) {
      specs[id] = spec
    },
    ref: placeholder,
    nativeView(name: string, where: string) {
      nativeViews.push({ name, where })
    },
  }

  const plugin: BunPlugin = {
    name: "zero-native",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
        const source = await Bun.file(path).text()
        addModules(source, path)
        const staticImports = await loadStaticImports(source, path)
        compiling = path
        seqInFile = 0
        const out = compileModule(source, path, ctx, staticImports, svgReexports(source, path))
        for (const [name, id] of Object.entries(out.components)) {
          if (name in components && components[name] !== id) {
            throw new Error(`${path}: component name "${name}" is used in two files; names must be unique for now`)
          }
          components[name] = id
        }
        maps.set(path, out.map)
        return { contents: out.code, loader: "ts" }
      })
      // .svg files are compiled into the templates where they are used (docs/svg.md §6); the compiler removes their
      // imports from .tsx files. What Bun still bundles (an icons.ts that re-exports them) gets an empty value.
      build.onLoad({ filter: /\.svg$/ }, () => ({ contents: "export default {}", loader: "js" }))
      // Plain .ts files pass through unchanged; the one with defineRoutes(...) is also read for the route table.
      build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text()
        addModules(source, path)
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
    maps,
    outputs(js: string) {
      // Final ids: by file path, then by order in the file.
      const order = reservedBy
        .map((r, reservation) => ({ ...r, reservation }))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.seq - b.seq))
      const finalId: number[] = []
      order.forEach((r, id) => (finalId[r.reservation] = id))
      const finalSpecs = order.map((r) => specs[r.reservation])
      const finalComponents: Record<string, number> = {}
      for (const [name, reservation] of Object.entries(components).sort((a, b) => finalId[a[1]] - finalId[b[1]])) {
        finalComponents[name] = finalId[reservation]
      }
      const filledJs = js.replace(PLACEHOLDER, (token, n: string) => {
        const id = finalId[Number(n)]
        if (id === undefined) throw new Error(`zero-native: unknown template placeholder ${token} in the bundle`)
        return String(id).padEnd(token.length)
      })

      for (const v of nativeViews) checkNativeName(v.name, `${v.where}: <NativeView>`, modules)
      const table: ManifestRoute[] = (routes?.entries ?? []).map((r) => {
        if (r.native !== undefined) {
          checkNativeName(r.native, `${routes!.file}: route "${r.name}"`, modules)
          return { ...r, screen: -1 }
        }
        const screen = finalComponents[r.component!]
        if (screen === undefined) {
          throw new Error(
            `${routes!.file}: route "${r.name}": screen ${r.component} has no template ` +
              `(it must be a component in a .tsx file whose root is a zero-native element)`,
          )
        }
        return { ...r, screen }
      })
      const file = writeTemplateFile(finalSpecs)
      const sortedModules = Object.fromEntries([...modules.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      return {
        templates: file.bytes,
        manifest: { components: finalComponents, routes: table },
        js: filledJs,
        requires: { registry: file.registry, hostApi: HOST_API_VERSION, modules: sortedModules },
      }
    },
  }
}

/**
 * A native screen or view "<plugin>.<name>" belongs to its plugin's module (docs/plugins.md D3): the bundle must need that
 * module, so an app without the plugin never runs it, and the "unknown name" case can't reach a phone.
 */
function checkNativeName(name: string, where: string, modules: Map<string, number>): void {
  const plugin = name.split(".")[0]!
  if ([...modules.keys()].some((m) => m.toLowerCase() === plugin)) return
  throw new Error(`${where}: "${name}" belongs to a plugin module "${plugin}", but no code in the app uses it: import the plugin`)
}

/**
 * SVG files imported by name through a relative `.ts` file that re-exports them (`icons.ts`:
 * `export { default as Check } from "./check-rounded.svg"`, also through further `export { X } from "./more"`).
 * Local name → absolute .svg path. Direct `import X from "./x.svg"` imports are found by the compiler itself.
 */
export function svgReexports(source: string, path: string): Map<string, string> {
  const out = new Map<string, string>()
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith(".") || spec.endsWith(".svg")) continue
    const named = stmt.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const el of named.elements) {
      const svg = findSvgExport(resolve(dirname(path), spec), (el.propertyName ?? el.name).text, 0)
      if (svg) out.set(el.name.text, svg)
    }
  }
  return out
}

/** The .svg file that module [base] (a path without extension, or a folder with index.ts) exports as [name]. */
function findSvgExport(base: string, name: string, depth: number): string | null {
  if (depth > 8) return null
  const file = [base, `${base}.ts`, join(base, "index.ts")].find((f) => f.endsWith(".ts") && existsSync(f))
  if (!file) return null
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith(".") || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue
    for (const el of stmt.exportClause.elements) {
      if (el.name.text !== name) continue
      const from = (el.propertyName ?? el.name).text
      const target = resolve(dirname(file), spec)
      if (spec.endsWith(".svg")) return from === "default" ? target : null
      return findSvgExport(target, from, depth + 1)
    }
  }
  return null
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
    // The query makes Bun load the file again: `zn dev` rebuilds in the same process, and tokens may have changed.
    const mod = await import(`${file}?t=${Date.now()}`)
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text
      if (imported in mod) out.set(el.name.text, mod[imported])
    }
  }
  return out
}
