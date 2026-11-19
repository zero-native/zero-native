// Registry needs the template file can't see: features that ride in a value built at runtime, so the writer only sees
// the prop (an older one). Found in the app's source instead, and added to the bundle's `requires.registry`, so an
// older APK refuses the bundle (keeps its own) rather than running it with parts silently missing (docs/ota.md §3.2).
//
// Canvas (registry 24): new commands and paint keys go inside `commands` (registry 23). A 23 app skips each one it
// doesn't know (a warning in logcat), so a chart would draw without its clip, image or shadow.
import ts from "typescript"
import { CANVAS_24_SINCE } from "@zeronative/template"

/** draw.<name>() calls added in registry 24. */
const CANVAS_24_COMMANDS: ReadonlySet<string> = new Set(["image", "paragraph", "clipRoundRect", "clipPath"])
/** Paint and path option keys added in registry 24 (in any object of a file that uses the canvas API). */
const CANVAS_24_KEYS: ReadonlySet<string> = new Set([
  "sweepGradient", "blendMode", "shadow", "blur", "trimStart", "trimEnd", "trimOffset",
])
/** The canvas API names a file imports from @zeronative/core when it builds commands. */
const CANVAS_NAMES: ReadonlySet<string> = new Set(["draw", "smoothPath", "CanvasPaint", "CanvasCommand", "CanvasPathOptions"])
/** A file of @zeronative/core itself (its own canvas.ts names every key). */
const CORE_SRC = /[\\/](?:packages|@zeronative)[\\/]core[\\/]src[\\/]/

/**
 * The registry version [source] needs for what the template file can't see, or 0. Over-counts on purpose: a paint
 * key name in a file that uses the canvas API counts even if that object never reaches a canvas (the cost is only that
 * the bundle needs the newer app; missing one would make a 23 app draw it wrong).
 */
export function sourceRegistryNeed(source: string, fileName: string): number {
  if (CORE_SRC.test(fileName) || !source.includes("@zeronative/core")) return 0
  if (!/\bdraw\b|smoothPath|Canvas(?:Paint|Command|PathOptions)/.test(source)) return 0 // quick skip
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  let canvas = false
  let drawName: string | null = null
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "@zeronative/core") continue
    const named = st.importClause?.namedBindings
    if (named && ts.isNamespaceImport(named)) canvas = true
    if (named && ts.isNamedImports(named)) {
      for (const e of named.elements) {
        const name = (e.propertyName ?? e.name).text
        if (CANVAS_NAMES.has(name)) canvas = true
        if (name === "draw") drawName = e.name.text
      }
    }
  }
  if (!canvas) return 0
  let need = 0
  const visit = (n: ts.Node): void => {
    if (need) return
    // draw.image(...) etc. (also through a namespace import: zn.draw.image)
    if (ts.isPropertyAccessExpression(n) && CANVAS_24_COMMANDS.has(n.name.text)) {
      const obj = n.expression
      if ((ts.isIdentifier(obj) && obj.text === drawName) || (ts.isPropertyAccessExpression(obj) && obj.name.text === "draw")) {
        need = CANVAS_24_SINCE
        return
      }
    }
    // draw.clipRect(x, y, w, h, { op: ... })
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "clipRect") {
      const opts = n.arguments[4]
      if (opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name?.getText(sf) === "op")) {
        need = CANVAS_24_SINCE
        return
      }
    }
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && CANVAS_24_KEYS.has(n.name.getText(sf))) {
      need = CANVAS_24_SINCE
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return need
}
