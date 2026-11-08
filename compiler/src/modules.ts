// The native modules a bundle calls, read from the source at build time: `nativeModule("Name", { version: N })` and
// `callNative("Name", method, { ..., __v: N })`. They become the bundle's requirements, so an OTA bundle never runs on
// an app that lacks a module (or has an older version of it) (docs/ota.md §3.2). The module name must be a string
// literal; the version a number literal (default 1, as in calls.ts).
import ts from "typescript"

export interface ModuleUse {
  name: string
  version: number
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
/** A file of @zero-native/core itself: the repo's packages/core/src, or the package as an app installs it. */
const CORE_SRC = /[\\/](?:packages|@zero-native)[\\/]core[\\/]src[\\/]/

export function nativeModuleUses(source: string, fileName: string): ModuleUse[] {
  if (!source.includes("nativeModule") && !source.includes("callNative")) return [] // quick skip (`nativeModule<T>(` too)
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const uses: ModuleUse[] = []
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
          if (!(SOFT_CORE_MODULES.has(first.text) && CORE_SRC.test(fileName))) uses.push({ name: first.text, version: version ?? 1 })
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
