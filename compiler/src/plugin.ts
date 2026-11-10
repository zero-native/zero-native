// Bun build plugin: compiles every .tsx file with the zero-native compiler during bundling, collects all templates
// into one .zn.ui file, and writes the manifest: component name → template id, and the route table read from the
// app's `defineRoutes({...})` (ARCHITECTURE §11; a route's index in the table is its number at runtime).
import { sourceRegistryNeed } from "./needs"
import type { BunPlugin } from "bun"
import { dirname, join, resolve } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import ts from "typescript"
import { type NodeSpec, writeTemplateFile } from "@zero-native/template"
import { compileModule, type ComponentRoots, type OnceTrap, type PropUse } from "./compile"
import type { LineMap } from "./sourcemap"
import { readRoutes, type RouteEntry } from "./routes"
import { BOTH_OSES, CORE_PACKAGE, nativeModuleUses, packageOf, platformsOf, type ModuleOs } from "./modules"
import { compileDerives } from "./motion"
import { fontFamilyProblem, type FontTable } from "./fonts"
import { HOST_API_VERSION } from "@zero-native/core/src/host-api"

/** One route in the manifest: the route entry with its screen's template id (-1 for a native screen). */
export type ManifestRoute = RouteEntry & { screen: number }

export interface ZnManifest {
  components: Record<string, number>
  routes: ManifestRoute[]
  /** The app's fonts (registry 24, compiler/src/fonts.ts): family → faces. Absent when the app has none. */
  fonts?: FontTable
}

/**
 * What an app must have to run this bundle (docs/ota.md §3.2): the lowest registry version that has everything the
 * templates use, the host API of the bundled `@zero-native/core`, and every native module called with the highest
 * version asked for. The Hermes bytecode format is added after hermesc (tools/hermesc.ts).
 */
export interface BundleRequires {
  registry: number
  hostApi: number
  /** Modules needed on both OSes. */
  modules: Record<string, number>
  /** Modules needed on one OS only (from Android-only or iOS-only plugins: docs/ota-requires-per-os.md). */
  os?: Partial<Record<ModuleOs, Record<string, number>>>
}

export interface ZnBuild {
  plugin: BunPlugin
  /**
   * After Bun.build: the .zn.ui bytes, the manifest, and the bundle's [js] with the template ids filled in.
   * Templates are numbered by file path, then by their order in the file, so the same source always gives the same
   * bytes (one bundle = one SHA-256, docs/ota.md §3.1; small binary patches later), whatever order Bun loaded files.
   */
  /**
   * `moduleFrom`: each needed module → the package it comes from (modules.ts packageOf; core wins when core calls it
   * too). Goes in zn-bundle.json next to `requires`, not in it: not signed, only for the dashboard.
   */
  outputs(js: string): { templates: Uint8Array; manifest: ZnManifest; js: string; requires: BundleRequires; moduleFrom: Record<string, string> }
  /** After Bun.build: per .tsx file (absolute path), compiler output position → TSX position. */
  maps: Map<string, LineMap>
}

/** Template id placeholder in generated code: fixed width, so filling it in (padded with spaces) moves no column. */
const PLACEHOLDER = /__znT(\d{6})__/g
const placeholder = (n: number) => `__znT${String(n).padStart(6, "0")}__`

/**
 * [fonts]: the app's font table (fonts.ts scanFonts; undefined: the app has no assets/fonts). Every fontFamily is
 * checked against it, and it goes into the manifest.
 */
export function znBuild(options: { fonts?: FontTable } = {}): ZnBuild {
  // Indexed by reservation number (the order templates were reserved in, which depends on Bun's load order).
  const specs: NodeSpec[] = []
  const reservedBy: { file: string; seq: number }[] = []
  /** Component name → reservation number. */
  const components: Record<string, number> = {}
  /** Component name → what it returns (reservation numbers), to check screens once the route table is known. */
  const roots = new Map<string, ComponentRoots>()
  /** File → its components' uses with props that can change (compile.ts propUses), for the props traps. */
  const propUses = new Map<string, PropUse[]>()
  const maps = new Map<string, LineMap>()
  let routes: { file: string; entries: RouteEntry[] } | null = null
  let compiling = "" // the file being compiled; compileModule is synchronous, so no two files interleave
  let seqInFile = 0
  /** Native module name → the highest version any loaded file asks for. */
  const modules = new Map<string, number>()
  /** Native module name → the OSes of the packages that call it (modules.ts platformsOf). */
  const moduleOses = new Map<string, Set<ModuleOs>>()
  /** Native module name → the packages whose files call it (modules.ts packageOf). */
  const modulePackages = new Map<string, Set<string>>()
  /** The registry version app sources need beyond what the templates show (compiler needs.ts: canvas commands). */
  let sourceNeed = 0
  const addModules = (source: string, path: string) => {
    const uses = nativeModuleUses(source, path)
    const oses = uses.length > 0 ? platformsOf(path) : BOTH_OSES
    const pkg = uses.length > 0 ? packageOf(path) : ""
    for (const { name, version, core } of uses) {
      modules.set(name, Math.max(modules.get(name) ?? 0, version))
      const pkgs = modulePackages.get(name) ?? new Set<string>()
      pkgs.add(core ? CORE_PACKAGE : pkg)
      modulePackages.set(name, pkgs)
      const set = moduleOses.get(name) ?? new Set<ModuleOs>()
      for (const os of oses) set.add(os)
      moduleOses.set(name, set)
    }
    sourceNeed = Math.max(sourceNeed, sourceRegistryNeed(source, path))
  }
  /** Every <NativeView>, checked in outputs(), when all files are read. */
  const nativeViews: { name: string; where: string }[] = []
  /** Every fontFamily name, checked in outputs() against the app's fonts. */
  const fontUses: { name: string; where: string }[] = []
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
    fontFamily(name: string, where: string) {
      fontUses.push({ name, where })
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
        for (const [name, r] of Object.entries(out.roots)) roots.set(name, r)
        propUses.set(path, out.propUses)
        maps.set(path, out.map)
        // derive(() => ...) → formula data (compiler motion.ts); line count kept, so the map stays right per line.
        return { contents: compileDerives(out.code, path), loader: "ts" }
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
        return { contents: compileDerives(source, path), loader: "ts" }
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
      for (const f of fontUses) {
        const problem = fontFamilyProblem(f.name, options.fonts)
        if (problem) throw new Error(`${f.where}: ${problem}`)
      }
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
        checkScreenRoots(r.name, r.component!, roots.get(r.component!), specs)
        return { ...r, screen }
      })
      checkOnceTraps(roots, new Set(table.map((r) => r.component).filter((c): c is string => !!c)), [...propUses.values()].flat())
      const file = writeTemplateFile(finalSpecs)
      // Both OSes, or one OS's own part (requires.os), by the packages that call each module
      const sortedModules: Record<string, number> = {}
      const osModules: Partial<Record<ModuleOs, Record<string, number>>> = {}
      const moduleFrom: Record<string, string> = {}
      for (const [name, version] of [...modules.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        // Core wins (a core module that a plugin also calls is still core's); then the first other package by name
        const pkgs = [...(modulePackages.get(name) ?? [])].sort()
        moduleFrom[name] = pkgs.includes(CORE_PACKAGE) ? CORE_PACKAGE : (pkgs.find((p) => p !== "") ?? "")
        const oses = moduleOses.get(name) ?? BOTH_OSES
        if (oses.size === 1) {
          const os = [...oses][0]
          ;(osModules[os] ??= {})[name] = version
        } else {
          sortedModules[name] = version
        }
      }
      return {
        templates: file.bytes,
        manifest: { components: finalComponents, routes: table, ...(options.fonts ? { fonts: options.fonts } : {}) },
        js: filledJs,
        requires: {
          registry: Math.max(file.registry, sourceNeed),
          hostApi: HOST_API_VERSION,
          modules: sortedModules,
          ...(Object.keys(osModules).length > 0 ? { os: osModules } : {}),
        },
        moduleFrom,
      }
    },
  }
}

/**
 * A React habit that reads a value once (compile.ts checkOnceTraps, guide notes §61) fails the build.
 * A trap that reads a signal always counts. A trap that only reads props counts only when that component's props can
 * change while it stays mounted: it is used outside a row with a prop that reads a signal, or passes on the props of a
 * parent whose props can change (followed up the tree). Not in a screen (its props are its route's params, which
 * don't change while it is open), and not in a row (a row mounts again when its item changes, so its body is fresh).
 */
function checkOnceTraps(roots: Map<string, ComponentRoots>, screens: Set<string>, uses: PropUse[]): void {
  const liveProps = new Set<string>()
  for (const u of uses) if (u.live === "signal") liveProps.add(u.component)
  for (let grew = true; grew; ) {
    grew = false
    for (const u of uses) {
      if (u.live === "parentProps" && liveProps.has(u.parent) && !liveProps.has(u.component)) {
        liveProps.add(u.component)
        grew = true
      }
    }
  }
  for (const [name, info] of roots) {
    const counts = (t: OnceTrap) => !t.fromProps || (liveProps.has(name) && !screens.has(name))
    const trap = info.traps.find(counts)
    if (trap) throw new Error(`${trap.at}: ${trap.message}`)
  }
}

/**
 * Native draws a screen's root from the one template in the manifest before the screen's JS runs; JS then fills in
 * that root. So a screen must always return the same template: a second, different JSX return (or `return null`)
 * would be filled into a root that isn't there, and the screen stays blank with no error (guide notes §4). Returns
 * that compile to the same template (the same JSX shape, other values) are fine. Children don't have this problem:
 * JS mounts each one with the template it returned.
 */
function checkScreenRoots(route: string, component: string, info: ComponentRoots | undefined, specs: NodeSpec[]): void {
  if (!info) return
  // Not "move the whole screen into a child": a child that throws is left empty in release builds (guide notes §26),
  // so the screen would go blank, where an error in the screen itself shows the error screen with "Try again".
  const fix = `keep one return with the screen's main content in it, and put only the piece that changes in a ` +
    `branch: {loading() ? <Spinner /> : null}. Don't move the whole screen into a child component: if it throws, a ` +
    `release build leaves it empty and the screen goes blank (guide notes §4)`
  if (info.others.length > 0) {
    throw new Error(
      `${info.others[0]}: screen ${component} (route "${route}") returns something that isn't its JSX here ` +
        `(null, or a value): a screen must always return its own JSX, so ${fix}`,
    )
  }
  const first = info.templates[0]!
  const same = (id: number) =>
    id === first || (id >= 0 && first >= 0 && JSON.stringify(specs[id]) === JSON.stringify(specs[first]))
  const other = info.templates.findIndex((id) => !same(id))
  if (other < 0) return
  throw new Error(
    `${info.at[other]}: screen ${component} (route "${route}") has a second JSX return that differs from the ` +
      `first one (${info.at[0]}): a screen needs one JSX return, so ${fix}`,
  )
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
    // Issue A16: a .ts file that imports a .tsx file (an index.ts that re-exports components) is not loaded. Bun would
    // read that .tsx as React JSX here ("Cannot find package 'react'"), not with the zero-native compiler. Its values
    // are then not folded: they are read at runtime, like any value not known at build time.
    if (reachesTsx(file, new Set())) continue
    // The query makes Bun load the file again: `zn dev` rebuilds in the same process, and tokens may have changed.
    const mod = await import(`${file}?t=${Date.now()}`)
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text
      if (imported in mod) out.set(el.name.text, mod[imported])
    }
  }
  return out
}

/**
 * True when the .ts / .js file [file] imports or re-exports a .tsx / .jsx file, directly or through other relative
 * files. Type-only imports don't count (Bun drops them). [seen] stops loops.
 */
function reachesTsx(file: string, seen: Set<string>): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  for (const stmt of sf.statements) {
    let spec: ts.Expression | undefined
    if (ts.isImportDeclaration(stmt) && !stmt.importClause?.isTypeOnly) spec = stmt.moduleSpecifier
    else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) spec = stmt.moduleSpecifier
    if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith(".")) continue
    const base = resolve(dirname(file), spec.text)
    const target = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find(
      (f) => /\.[jt]sx?$/.test(f) && existsSync(f),
    )
    if (!target) continue
    if (/\.[jt]sx$/.test(target) || reachesTsx(target, seen)) return true
  }
  return false
}
