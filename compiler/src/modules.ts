// The native modules a bundle calls, read from the source at build time: `nativeModule("Name", { version: N })` and
// `callNative("Name", method, { ..., __v: N })`. They become the bundle's requirements, so an OTA bundle never runs on
// an app that lacks a module (or has an older version of it) (docs/ota.md §3.2). The module name must be a string
// literal; the version a number literal (default 1, as in calls.ts).
import ts from "typescript"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface ModuleUse {
  name: string
  version: number
  /** A gated core module (GATED_CORE_MODULES) an app file needs by importing its API: it comes from core, not the file. */
  core?: true
}

/** `@zero-native/core`'s calls.ts implements nativeModule() with a variable name; it is the only file allowed to. */
const CALLS_IMPL = /[\\/]core[\\/]src[\\/]calls\.ts$/

/**
 * Core modules added after the first APKs went out (B4, 2026-11-08 review). Core loads all its files, so every bundle
 * "called" them, and every older APK refused every new bundle, even one that never opens a socket. These fail safely
 * when the app lacks them (native answers "unavailable"): WebSocket gives error, then close 1006; Splash.holdUntil
 * just doesn't hold the splash. So core's own calls to them are left out of the requirements. An app's own
 * callNative("WebSocket") still counts. Add a module here only if it fails safely the same way (second-opinions).
 */
export const SOFT_CORE_MODULES: ReadonlySet<string> = new Set(["Splash", "WebSocket"])

/**
 * Core modules a bundle needs only when the app uses their API (registry 24 motion: docs/gestures-and-motion-v1.md §5).
 * Core's own calls don't count; an app file that imports one of these names from @zero-native/core does, so an older
 * APK without the module refuses that bundle, and keeps running bundles that don't use it.
 */
export const GATED_CORE_MODULES: Readonly<Record<string, { version: number; names: ReadonlySet<string> }>> = {
  Motion: {
    version: 1,
    names: new Set(["useMotion", "useTimeline", "follow", "derive", "env", "usePan", "usePinch", "useZoom", "useRotate", "useTap",
      "useLongPress", "useFling", "Gesture"]),
  },
}
/** A file of @zero-native/core itself: the repo's packages/core/src, or the package as an app installs it. */
const CORE_SRC = /[\\/](?:packages|@zero-native)[\\/]core[\\/]src[\\/]/

export function nativeModuleUses(source: string, fileName: string): ModuleUse[] {
  const gated = !CORE_SRC.test(fileName) && source.includes("@zero-native/core")
  if (!gated && !source.includes("nativeModule") && !source.includes("callNative")) return [] // quick skip (`nativeModule<T>(` too)
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const uses: ModuleUse[] = []
  // An app file importing a gated core API (GATED_CORE_MODULES) needs that module.
  if (gated) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "@zero-native/core") continue
      const named = st.importClause?.namedBindings
      const names = named && ts.isNamedImports(named) ? named.elements.map((e) => (e.propertyName ?? e.name).text) : []
      // `import * as zn from "@zero-native/core"` can reach anything: it counts for every gated module.
      const star = !!named && ts.isNamespaceImport(named)
      for (const [module, g] of Object.entries(GATED_CORE_MODULES)) {
        if (star || names.some((n) => g.names.has(n))) uses.push({ name: module, version: g.version, core: true })
      }
    }
  }
  const where = (n: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
    return `${fileName}:${line + 1}:${character + 1}`
  }
  const numberProp = (obj: ts.Expression | undefined, key: string): number | null | undefined => {
    if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === key) {
        return ts.isNumericLiteral(p.initializer) ? Number(p.initializer.text) : null
      }
    }
    return undefined
  }

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const fn = n.expression.text
      if (fn === "nativeModule" || fn === "callNative") {
        const first = n.arguments[0]
        if (first && ts.isStringLiteralLike(first)) {
          const versionArg = fn === "nativeModule" ? n.arguments[1] : n.arguments[2]
          const version = numberProp(versionArg, fn === "nativeModule" ? "version" : "__v")
          if (version === null) {
            throw new Error(`${where(n)}: ${fn}("${first.text}"): the version must be a number literal (read at build time)`)
          }
          const coreOwn = CORE_SRC.test(fileName) && (SOFT_CORE_MODULES.has(first.text) || first.text in GATED_CORE_MODULES)
          if (!coreOwn) uses.push({ name: first.text, version: version ?? 1 })
        } else if (!CALLS_IMPL.test(fileName)) {
          throw new Error(
            `${where(n)}: ${fn}(...): the module name must be a string literal, so the build can list the native ` +
              "modules this bundle needs (OTA capability check)",
          )
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return uses
}

/** The OSes a native module can be on. */
export type ModuleOs = "android" | "ios"
export const BOTH_OSES: ReadonlySet<ModuleOs> = new Set(["android", "ios"])

/** Folder → the platforms of the package it is in (memo for platformsOf). */
const packagePlatforms = new Map<string, ReadonlySet<ModuleOs>>()

/**
 * The OSes a module call in [fileName] counts for (docs/ota-requires-per-os.md §2): the platforms of the plugin package
 * the file is in; both for @zero-native/core, the app's own files and anything that isn't a plugin. A plugin's platforms:
 * `zeroNative.platforms` when written, else its folders (`android/` or a `zeroNative.android` entry; `ios/`).
 */
export function platformsOf(fileName: string): ReadonlySet<ModuleOs> {
  let dir = dirname(fileName)
  const seen: string[] = []
  for (;;) {
    const known = packagePlatforms.get(dir)
    if (known) return remember(seen, known)
    seen.push(dir)
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) return remember(seen, pluginPlatforms(dir, pkgPath))
    const up = dirname(dir)
    if (up === dir) return remember(seen, BOTH_OSES)
    dir = up
  }
}

function remember(dirs: string[], p: ReadonlySet<ModuleOs>): ReadonlySet<ModuleOs> {
  for (const d of dirs) packagePlatforms.set(d, p)
  return p
}

function pluginPlatforms(dir: string, pkgPath: string): ReadonlySet<ModuleOs> {
  let zn: { platforms?: unknown; android?: unknown } | undefined
  try {
    zn = (JSON.parse(readFileSync(pkgPath, "utf8")) as { zeroNative?: typeof zn }).zeroNative
  } catch {
    return BOTH_OSES
  }
  if (!zn) return BOTH_OSES // not a plugin: core, the app, a plain library
  if (zn.platforms !== undefined) {
    const list = zn.platforms
    if (!Array.isArray(list) || list.length === 0 || !list.every((p) => p === "android" || p === "ios")) {
      throw new Error(`${pkgPath}: zeroNative.platforms must list "android" and / or "ios"`)
    }
    return new Set(list as ModuleOs[])
  }
  const found = new Set<ModuleOs>()
  if (zn.android !== undefined || existsSync(join(dir, "android"))) found.add("android")
  if (existsSync(join(dir, "ios"))) found.add("ios")
  return found.size > 0 ? found : BOTH_OSES // a plugin with no native side yet: not one OS's
}

/** What `packageOf` answers for @zero-native/core's own files (and gated core modules). */
export const CORE_PACKAGE = "@zero-native/core"

/** Folder → the name of the package it is in (memo for packageOf). */
const packageNames = new Map<string, string>()

/**
 * The package a module call in [fileName] comes from, for the bundle's `moduleFrom` (shown by the dashboard: core,
 * zero-native plugins, the app's own): the `name` of the nearest package.json; "" when there is none or it has no name.
 * Not signed and never checked by a phone: it only says where each needed module comes from.
 */
export function packageOf(fileName: string): string {
  if (CORE_SRC.test(fileName)) return CORE_PACKAGE
  let dir = dirname(fileName)
  const seen: string[] = []
  let name = ""
  for (;;) {
    const known = packageNames.get(dir)
    if (known !== undefined) {
      name = known
      break
    }
    seen.push(dir)
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const n = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown }).name
        name = typeof n === "string" ? n : ""
      } catch {
        name = ""
      }
      break
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const d of seen) packageNames.set(d, name)
  return name
}
