// The zero-native compiler (ARCHITECTURE.md §5.3, §6): turns TSX components into
//   - templates (NodeSpec trees, written to .zn.ui at the end of the build), and
//   - plain TypeScript that sets up each instance: slot bindings, events and child mounts (packages/core view.ts).
//
// A component is a module-level function whose name starts with a capital letter and which returns JSX. Its body
// runs once per instance; its returned JSX becomes `__zn.view(templateId, setup)`.
//
// Supported in JSX (anything else is a build error with a file:line:col):
//   - intrinsic components from the registry (Column, Row, Text, Pressable, ...) and user components
//   - props: build-time constants go into the template; other expressions become slots (only for props the
//     registry allows to change at runtime); event props (onPress, ...) become handlers
//   - style={{...}} / style={[a, b]} / StyleSheet.create: folded at build time; non-constant values inside a style
//     object become slots like any prop
//   - children: elements, `{cond && <X/>}`, `{cond ? <A/> : <B/>}`, `{list.map(item => <Row key={...}/>)}`;
//     inside <Text>: literal text and `{expressions}`
import ts from "typescript"
import {
  Component,
  DynamicProps,
  el,
  event as eventRef,
  parseColor,
  EventKind,
  type NodeProps,
  type NodeSpec,
  Prop,
  type PropName,
  slot as slotRef,
  templateIds,
} from "@zero-native/template"
import { fold, NOT_STATIC, type FoldScope } from "./fold"
import { assemble, type LineMap, markCopied } from "./sourcemap"

export interface CompileContext {
  /** Reserves the next template id (its index in the app's .zn.ui file). Parents reserve before their branches. */
  reserveTemplate(): number
  /** Stores the template for a reserved id. */
  defineTemplate(id: number, spec: NodeSpec): void
}

export interface CompileOutput {
  code: string
  /** Component name → template id of its (first) returned JSX. */
  components: Record<string, number>
  /** Output position → TSX position (for `zn dev` error screens). */
  map: LineMap
}

const RUNTIME = "__zn"
const UI_MODULE = "@zero-native/ui"
type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment

export function compileModule(
  source: string,
  fileName: string,
  ctx: CompileContext,
  staticImports: Map<string, unknown> = new Map(),
): CompileOutput {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const scope: FoldScope = { consts: new Map(), staticImports }
  const userComponents = new Set<string>()
  const candidates: Array<{ name: string; fn: ts.FunctionLikeDeclaration }> = []
  // `at`: where generated code points in the source map (the JSX element, not the parenthesis around it).
  const edits: Array<{ start: number; end: number; text: string; at?: number }> = []
  const components: Record<string, number> = {}

  const fail = (node: ts.Node, message: string): never => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    throw new Error(`${fileName}:${line + 1}:${character + 1}: ${message}`)
  }
  const text = (node: ts.Node) => {
    forEachDescendant(node, (n) => {
      if (isJsx(n)) fail(n, "JSX isn't allowed here (only as children, in `&&` / `? :` branches, or in `.map(...)` rows)")
    })
    // Marked, so the source map can point errors inside handlers and expressions at their exact TSX line.
    return markCopied(node.getStart(sf), source.slice(node.getStart(sf), node.getEnd()))
  }

  // ---- Module scan --------------------------------------------------------------------------------------------
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.moduleSpecifier.text === UI_MODULE) {
        // Intrinsic components are only imported for types; the compiler handles them.
        edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: "" })
      } else {
        const named = stmt.importClause?.namedBindings
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) if (isCapitalized(el.name.text)) userComponents.add(el.name.text)
        }
        if (stmt.importClause?.name && isCapitalized(stmt.importClause.name.text)) {
          userComponents.add(stmt.importClause.name.text)
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name && isCapitalized(stmt.name.text)) {
      userComponents.add(stmt.name.text)
      candidates.push({ name: stmt.name.text, fn: stmt })
    } else if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue
        scope.consts.set(d.name.text, d.initializer)
        const init = unwrap(d.initializer)
        if (isCapitalized(d.name.text) && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          userComponents.add(d.name.text)
          candidates.push({ name: d.name.text, fn: init })
        }
      }
    }
  }
  // Intrinsics are registry names that aren't shadowed by a user component of the same name.
  const isIntrinsic = (tag: string) => tag in Component && tag !== "Anchor" && !userComponents.has(tag)

  // ---- Components ---------------------------------------------------------------------------------------------
  for (const { name, fn } of candidates) {
    const body = fn.body
    if (!body) continue
    const roots: ts.Expression[] = []
    if (ts.isBlock(body)) {
      forEachDescendant(body, (n) => {
        if (ts.isReturnStatement(n) && n.expression && isJsx(unwrap(n.expression))) roots.push(n.expression)
      }, /* stopAtFunctions */ true)
    } else if (isJsx(unwrap(body))) {
      roots.push(body)
    }
    for (const r of roots) {
      const compiled = compileRoot(unwrap(r) as JsxNode)
      edits.push({ start: r.getStart(sf), end: r.getEnd(), text: compiled.code, at: unwrap(r).getStart(sf) })
      if (compiled.templateId !== null && !(name in components)) components[name] = compiled.templateId
    }
  }

  // Any JSX left outside a component's return is unsupported.
  const replaced = edits.filter((e) => e.text !== "")
  forEachDescendant(sf, (n) => {
    if (isJsx(n) && !replaced.some((e) => n.getStart(sf) >= e.start && n.getEnd() <= e.end)) {
      fail(n, "JSX is only supported as the return value of a component (a capitalised module-level function)")
    }
  })

  const pieces: Parameters<typeof assemble>[1] = []
  if (replaced.length > 0) pieces.push({ generatedAt: 0, text: `import * as ${RUNTIME} from "@zero-native/core";\n` })
  let at = 0
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    pieces.push({ copyFrom: at, text: source.slice(at, e.start) })
    pieces.push({ generatedAt: e.at ?? e.start, text: e.text })
    at = e.end
  }
  pieces.push({ copyFrom: at, text: source.slice(at) })
  // Each component's template id, readable at runtime without running it (a <List> row's type, in any file).
  for (const [name, id] of Object.entries(components)) pieces.push({ generatedAt: source.length, text: `\n${name}.__zt = ${id};` })
  const { code, map } = assemble(source, pieces)
  return { code, components, map }

  // ---- Templates ----------------------------------------------------------------------------------------------

  /** A root JSX expression → code that produces a View; plus its template id (null for a bare user component). */
  function compileRoot(jsx: JsxNode, depth = 0, allowKey = false): { code: string; templateId: number | null } {
    if (ts.isJsxFragment(jsx)) fail(jsx, "a component must return one root element (fragments aren't supported yet)")
    const tag = tagName(jsx as ts.JsxElement | ts.JsxSelfClosingElement)
    if (!isIntrinsic(tag)) {
      return { code: `${tag}(${propsObject(jsx as ts.JsxElement | ts.JsxSelfClosingElement)})`, templateId: null }
    }
    const inst = `__i${depth}`
    const id = ctx.reserveTemplate() // before branches, so a screen's template comes before its parts
    const b: Builder = { nodes: 0, slots: 0, events: 0, binds: [], kids: [], inst, depth }
    const spec = element(jsx as ts.JsxElement | ts.JsxSelfClosingElement, b, allowKey)
    let ids
    try {
      ids = templateIds(spec)
    } catch (e) {
      return fail(jsx, (e as Error).message)
    }
    ctx.defineTemplate(id, spec)
    const resolve = (s: string) =>
      s
        .replace(/@@S:(\w+)@@/g, (_, n) => String(ids.slots[n]))
        .replace(/@@E:(\w+)@@/g, (_, n) => String(ids.events[n]))
    const lines = [...b.binds.map(resolve), `${RUNTIME}.ready(${inst});`, ...b.kids.map(resolve)]
    return { code: `${RUNTIME}.view(${id}, (${inst}) => {\n  ${lines.join("\n  ")}\n})`, templateId: id }
  }

  interface Builder {
    nodes: number
    slots: number
    events: number
    binds: string[]
    kids: string[]
    inst: string
    depth: number
  }

  function element(node: ts.JsxElement | ts.JsxSelfClosingElement, b: Builder, allowKey = false): NodeSpec {
    const tag = tagName(node)
    if (!isIntrinsic(tag)) fail(node, `"${tag}" is not a zero-native component`)
    if (tag === "List") return listElement(node, b)
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const opening = ts.isJsxElement(node) ? node.openingElement : node

    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      if (name === "key") {
        if (!allowKey) fail(a, "`key` is only used on the root element of a `.map(...)` row")
        continue
      }
      const init = a.initializer
      if (name === "style") {
        if (!init || !ts.isJsxExpression(init) || !init.expression) fail(a, "style needs an object: style={{ ... }}")
        styleProps((init as ts.JsxExpression).expression!, props, b)
        continue
      }
      if (name in EventKind) {
        if (!init || !ts.isJsxExpression(init) || !init.expression) fail(a, `${name} needs a function`)
        const ev = `e${b.events++}`
        ;(props as any)[name] = eventRef(ev)
        b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${text((init as ts.JsxExpression).expression!)});`)
        continue
      }
      if (!(name in Prop)) fail(a, `unknown prop "${name}" on <${tag}>`)
      if (!init) setProp(props, b, name as PropName, ts.factory.createTrue(), a)
      else if (ts.isStringLiteral(init)) setStatic(props, name as PropName, decodeEntities(init.text), a)
      else if (ts.isJsxExpression(init) && init.expression) setProp(props, b, name as PropName, init.expression, a)
      else fail(a, `unsupported value for "${name}"`)
    }

    const children: NodeSpec[] = []
    const kids = ts.isJsxElement(node) ? node.children : ts.factory.createNodeArray<ts.JsxChild>()
    if (tag === "Text") {
      textChildren(node, kids, props, b)
    } else {
      for (const child of kids) {
        if (ts.isJsxText(child)) {
          if (child.text.trim() !== "") fail(child, "text must be inside <Text>")
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue // {/* comment */}
          const e = unwrap(child.expression)
          if (isJsx(e)) children.push(...childElement(e as JsxNode, b))
          else children.push(anchor(e, b))
        } else {
          children.push(...childElement(child as JsxNode, b))
        }
      }
    }
    return el(tag as keyof typeof Component, props, ...children)
  }

  function childElement(node: JsxNode, b: Builder): NodeSpec[] {
    if (ts.isJsxFragment(node)) fail(node, "fragments aren't supported yet")
    const tag = tagName(node as ts.JsxElement)
    if (isIntrinsic(tag)) return [element(node as ts.JsxElement, b)]
    // A user component: an anchor where its instance mounts.
    const index = b.nodes++
    b.kids.push(`${RUNTIME}.component(${b.inst}, ${index}, ${tag}, ${propsObject(node as ts.JsxElement)});`)
    return [el("Anchor")]
  }

  /** `{cond && <X/>}`, `{c ? <A/> : <B/>}` or `{list.map(...)}` → an Anchor plus the code that mounts into it. */
  function anchor(e: ts.Expression, b: Builder): NodeSpec {
    const index = b.nodes++
    const branch = (x: ts.Expression) => {
      const j = unwrap(x)
      if (!isJsx(j)) fail(x, "a branch must be JSX or null")
      return `() => ${compileRoot(j as JsxNode, b.depth + 1).code}`
    }
    const isNullish = (x: ts.Expression) => {
      const u = unwrap(x)
      return u.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(u) && u.text === "undefined")
    }

    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      b.kids.push(`${RUNTIME}.when(${b.inst}, ${index}, () => (${text(e.left)}), ${branch(e.right)});`)
    } else if (ts.isConditionalExpression(e)) {
      const cond = text(e.condition)
      if (isNullish(e.whenTrue)) {
        b.kids.push(`${RUNTIME}.when(${b.inst}, ${index}, () => !(${cond}), ${branch(e.whenFalse)});`)
      } else if (isNullish(e.whenFalse)) {
        b.kids.push(`${RUNTIME}.when(${b.inst}, ${index}, () => (${cond}), ${branch(e.whenTrue)});`)
      } else {
        b.kids.push(`${RUNTIME}.when(${b.inst}, ${index}, () => (${cond}), ${branch(e.whenTrue)}, ${branch(e.whenFalse)});`)
      }
    } else if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === "map" &&
      e.arguments.length === 1 &&
      (ts.isArrowFunction(e.arguments[0]) || ts.isFunctionExpression(e.arguments[0]))
    ) {
      const fn = e.arguments[0] as ts.ArrowFunction
      if (fn.parameters.length < 1 || fn.parameters.length > 2) fail(fn, "a .map row function takes (item) or (item, index)")
      const params = fn.parameters.map((p) => text(p)).join(", ")
      let rowJsx: ts.Expression | undefined
      if (ts.isBlock(fn.body)) {
        const ret = fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0]) ? fn.body.statements[0] : null
        rowJsx = ret?.expression
      } else {
        rowJsx = fn.body
      }
      const root = rowJsx && unwrap(rowJsx)
      if (!root || !isJsx(root) || ts.isJsxFragment(root)) fail(fn, "a .map row must return one JSX element")
      const rootEl = root as ts.JsxElement | ts.JsxSelfClosingElement
      const keyAttr = (ts.isJsxElement(rootEl) ? rootEl.openingElement : rootEl).attributes.properties.find(
        (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "key",
      ) as ts.JsxAttribute | undefined
      const keyInit = keyAttr?.initializer
      if (!keyInit || !ts.isJsxExpression(keyInit) || !keyInit.expression) {
        fail(rootEl, "list rows need a key: <Row key={item.id} ...>")
      }
      const keyExpr = text((keyInit as ts.JsxExpression).expression!)
      const row = compileRoot(rootEl, b.depth + 1, /* allowKey */ true).code
      b.kids.push(
        `${RUNTIME}.each(${b.inst}, ${index}, () => (${text(e.expression.expression)}), (${params}) => (${keyExpr}), (${params}) => ${row});`,
      )
    } else {
      fail(e, "children can be JSX, `cond && <X/>`, `cond ? <A/> : <B/>` or `list.map(item => <X key={...}/>)`")
    }
    return el("Anchor")
  }

  /**
   * `<List data={...} key={(it) => ...} row={(it) => ...} onEndReached={...} style={...} />` (docs/lists.md).
   * Each JSX leaf of the row function (`cond ? <A/> : <B/>` picks between row kinds) becomes a row template; the
   * runtime mounts rows only near the visible range. Also emitted: `type(item)`, the leaf's template id computed
   * without building the row (a user component's id comes from `Comp.__zt`, set where it is compiled).
   */
  function listElement(node: ts.JsxElement | ts.JsxSelfClosingElement, b: Builder): NodeSpec {
    const index = b.nodes++
    if (ts.isJsxElement(node) && node.children.some((c) => !(ts.isJsxText(c) && c.text.trim() === ""))) {
      fail(node, "<List> takes no children: rows come from its row={(item) => <Row/>} function")
    }
    const props: NodeProps & Record<string, unknown> = {}
    const special: Record<string, ts.Expression> = {}
    for (const attr of (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      const init = a.initializer
      const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
      if (name === "data" || name === "key" || name === "row" || name === "onEndReached") {
        if (!expr) fail(a, `${name} needs an expression: ${name}={...}`)
        special[name] = expr!
      } else if (name === "style") {
        if (!expr) fail(a, "style needs an object: style={{ ... }}")
        styleProps(expr!, props, b)
      } else if (name in Prop) {
        if (!init) setProp(props, b, name as PropName, ts.factory.createTrue(), a)
        else if (ts.isStringLiteral(init)) setStatic(props, name as PropName, decodeEntities(init.text), a)
        else if (expr) setProp(props, b, name as PropName, expr, a)
        else fail(a, `unsupported value for "${name}"`)
      } else {
        fail(a, `unknown prop "${name}" on <List> (use data, key, row, onEndReached, style)`)
      }
    }
    for (const required of ["data", "key", "row"]) {
      if (!special[required]) fail(node, `<List> needs ${required}={...}`)
    }

    const fn = unwrap(special.row)
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) fail(special.row, "row must be a function: row={(item) => <Row/>}")
    const rowFn = fn as ts.ArrowFunction
    if (rowFn.parameters.length < 1 || rowFn.parameters.length > 2) fail(rowFn, "row takes (item) or (item, index)")
    const params = rowFn.parameters.map((p) => text(p)).join(", ")
    let body: ts.Expression | undefined
    if (ts.isBlock(rowFn.body)) {
      const only = rowFn.body.statements.length === 1 ? rowFn.body.statements[0] : null
      body = only && ts.isReturnStatement(only) ? only.expression : undefined
    } else {
      body = rowFn.body
    }
    if (!body) fail(rowFn, "row must return its JSX directly: row={(item) => <Row/>}")

    const branches = (e: ts.Expression): { code: string; type: string } => {
      const u = unwrap(e)
      if (ts.isConditionalExpression(u)) {
        const cond = text(u.condition)
        const yes = branches(u.whenTrue)
        const no = branches(u.whenFalse)
        return { code: `(${cond}) ? ${yes.code} : ${no.code}`, type: `(${cond}) ? ${yes.type} : ${no.type}` }
      }
      if (!isJsx(u) || ts.isJsxFragment(u)) {
        fail(u, "a row must be one JSX element, or `cond ? <A/> : <B/>` to pick between row kinds")
      }
      const root = compileRoot(u as JsxNode, b.depth + 1, /* allowKey */ true)
      if (root.templateId !== null) return { code: root.code, type: String(root.templateId) }
      const tag = tagName(u as ts.JsxElement)
      return { code: root.code, type: `(${tag}.__zt ?? 0)` }
    }
    const rows = branches(body!)

    const range = `e${b.events++}`
    ;(props as any).onRange = eventRef(range)
    let end = "0"
    let onEnd = "undefined"
    if (special.onEndReached) {
      const ev = `e${b.events++}`
      ;(props as any).onEndReached = eventRef(ev)
      end = `@@E:${ev}@@`
      onEnd = text(special.onEndReached)
    }
    b.kids.push(
      `${RUNTIME}.list(${b.inst}, ${index}, { data: () => (${text(special.data)}), key: ${text(special.key)}, ` +
        `row: (${params}) => ${rows.code}, type: (${params}) => ${rows.type}, ` +
        `rangeEvent: @@E:${range}@@, endEvent: ${end}, onEndReached: ${onEnd} });`,
    )
    return el("List", props)
  }

  /** A build-time prop value → the template. Values with React Native aliases are normalised here. */
  function setStatic(props: Record<string, unknown>, name: PropName, value: unknown, at: ts.Node) {
    props[name] =
      name === "fontWeight" ? fontWeight(value, at)
      : name === "backgroundImage" ? linearGradient(value, at)
      : value
  }

  /**
   * React Native's `backgroundImage` (CSS `linear-gradient(...)`) → "angle|argb@position|..." for native. Supports an
   * angle (`180deg`) or a side (`to bottom`, `to right`, ...), then 2+ colours with optional `N%` positions.
   */
  function linearGradient(value: unknown, at: ts.Node): string {
    const s = typeof value === "string" ? value.trim() : ""
    const m = /^linear-gradient\((.*)\)$/s.exec(s)
    if (!m) return fail(at, 'backgroundImage needs "linear-gradient(...)" (only linear gradients are supported)')
    // Split on commas outside parentheses (rgba(...) has its own commas).
    const parts: string[] = []
    let depth = 0
    let cur = ""
    for (const ch of m[1]) {
      if (ch === "(") depth++
      if (ch === ")") depth--
      if (ch === "," && depth === 0) {
        parts.push(cur.trim())
        cur = ""
      } else cur += ch
    }
    parts.push(cur.trim())
    const sides: Record<string, number> = {
      "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
      "to top right": 45, "to bottom right": 135, "to bottom left": 225, "to top left": 315,
    }
    let angle = 180 // CSS default: top to bottom
    const deg = /^(-?\d*\.?\d+)deg$/.exec(parts[0])
    if (deg) {
      angle = Number(deg[1])
      parts.shift()
    } else if (parts[0] in sides) {
      angle = sides[parts.shift()!]
    }
    if (parts.length < 2) fail(at, "linear-gradient needs at least 2 colours")
    const stops = parts.map((p) => {
      const sm = /^(.*?)(?:\s+(-?\d*\.?\d+)%)?$/.exec(p)!
      let argb = 0
      try {
        argb = parseColor(sm[1].trim())
      } catch (e) {
        fail(at, `backgroundImage: ${(e as Error).message}`)
      }
      return `${argb}@${sm[2] === undefined ? -1 : Number(sm[2]) / 100}`
    })
    return [String(angle), ...stops].join("|")
  }

  /** React Native font weights: 100–900 in steps of 100 (number or "600"), "normal" = 400, "bold" = 700. */
  function fontWeight(value: unknown, at: ts.Node): number {
    const n =
      value === "normal" ? 400
      : value === "bold" ? 700
      : typeof value === "string" && /^[1-9]00$/.test(value) ? Number(value)
      : value
    if (typeof n !== "number" || !Number.isInteger(n / 100) || n < 100 || n > 900) {
      fail(at, `fontWeight must be 100–900 in steps of 100, "normal" or "bold" (got ${JSON.stringify(value)})`)
    }
    return n as number
  }

  /** A prop value: constant → template; otherwise a slot (if the registry allows it to change at runtime). */
  function setProp(props: Record<string, unknown>, b: Builder, name: PropName, expr: ts.Expression, at: ts.Node) {
    const v = fold(expr, scope)
    if (v !== NOT_STATIC) {
      if (v !== undefined) setStatic(props, name, v, at)
      return
    }
    if (!DynamicProps.has(name)) {
      fail(at, `"${name}" must be known at build time (a literal, a const or a design token); ` +
        `only ${[...DynamicProps].join(", ")} can change at runtime yet`)
    }
    const s = `s${b.slots++}`
    props[name] = slotRef(s, null) as never
    const kind = Prop[name].type === "color" ? 1 : 0
    b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => (${text(expr)}), ${kind});`)
  }

  /** RN transform list → flat props: [{ scale: 0.9 }, { rotate: "45deg" }] → scale: 0.9, rotate: 45. */
  function transform(list: unknown, props: Record<string, unknown>, at: ts.Node) {
    const allowed = ["scale", "scaleX", "scaleY", "translateX", "translateY", "rotate"]
    if (!Array.isArray(list)) fail(at, "transform must be an array like [{ scale: 0.98 }]")
    for (const entry of list as unknown[]) {
      const pairs = entry && typeof entry === "object" ? Object.entries(entry) : []
      if (pairs.length !== 1) fail(at, "each transform entry has exactly one key, e.g. { rotate: '45deg' }")
      const [key, raw] = pairs[0]
      if (!allowed.includes(key)) fail(at, `unsupported transform "${key}" (use ${allowed.join(", ")})`)
      let value = raw
      if (key === "rotate") {
        const m = typeof raw === "string" ? /^(-?\d+(\.\d+)?)deg$/.exec(raw) : null
        if (typeof raw !== "number" && !m) fail(at, 'rotate needs degrees, e.g. "45deg"')
        value = typeof raw === "number" ? raw : Number(m![1])
      }
      props[key] = value
    }
  }

  function styleProps(expr: ts.Expression, props: Record<string, unknown>, b: Builder) {
    const merge = (obj: unknown, at: ts.Node) => {
      if (obj === null || obj === undefined || obj === false) return
      if (Array.isArray(obj)) return obj.forEach((o) => merge(o, at))
      if (typeof obj !== "object") fail(at, "style entries must be objects")
      for (const [k, v] of Object.entries(obj as object)) {
        if (k === "transform") {
          transform(v, props, at)
          continue
        }
        if (!(k in Prop)) fail(at, `unknown style key "${k}"`)
        if (v !== undefined) setStatic(props, k as PropName, v, at)
      }
    }
    const folded = fold(expr, scope)
    if (folded !== NOT_STATIC) return merge(folded, expr)

    const e = unwrap(expr)
    const objectEntry = (o: ts.ObjectLiteralExpression) => {
      for (const p of o.properties) {
        if (ts.isSpreadAssignment(p)) {
          const v = fold(p.expression, scope)
          if (v === NOT_STATIC) fail(p, "spreads in a style object must be constants")
          merge(v, p)
        } else if (ts.isPropertyAssignment(p)) {
          const key = p.name.getText(sf).replace(/^["']|["']$/g, "")
          if (key === "transform") {
            const v = fold(p.initializer, scope)
            if (v === NOT_STATIC) fail(p, "transform must be known at build time for now")
            transform(v, props, p)
            continue
          }
          if (!(key in Prop)) fail(p, `unknown style key "${key}"`)
          setProp(props, b, key as PropName, p.initializer, p)
        } else {
          fail(p, "unsupported style entry")
        }
      }
    }
    if (ts.isObjectLiteralExpression(e)) return objectEntry(e)
    if (ts.isArrayLiteralExpression(e)) {
      for (const item of e.elements) {
        const v = fold(item, scope)
        if (v !== NOT_STATIC) merge(v, item)
        else if (ts.isObjectLiteralExpression(unwrap(item))) objectEntry(unwrap(item) as ts.ObjectLiteralExpression)
        else fail(item, "a style array entry must be a constant or an object; for conditions use a ternary inside the object, e.g. { color: on ? a : b }")
      }
      return
    }
    fail(expr, "style must be an object, an array, or a constant")
  }

  /** <Text> content: literal text and {expressions}. All constant → static text; otherwise one text slot. */
  function textChildren(node: ts.Node, kids: ts.NodeArray<ts.JsxChild>, props: Record<string, unknown>, b: Builder) {
    const parts: Array<{ lit: string } | { expr: ts.Expression }> = []
    for (const child of kids) {
      if (ts.isJsxText(child)) {
        const t = jsxText(child.text)
        if (t) parts.push({ lit: t })
      } else if (ts.isJsxExpression(child)) {
        if (!child.expression) continue
        const v = fold(child.expression, scope)
        if (v !== NOT_STATIC) parts.push({ lit: v === null || v === undefined || v === false ? "" : String(v) })
        else parts.push({ expr: child.expression })
      } else {
        fail(child, "<Text> can only contain text and {expressions} (nested elements aren't supported yet)")
      }
    }
    if (parts.length === 0) return
    if ("text" in props) fail(node, "use either the text prop or children, not both")
    if (parts.every((p) => "lit" in p)) {
      props.text = parts.map((p) => (p as { lit: string }).lit).join("")
      return
    }
    const s = `s${b.slots++}`
    // Default (shown before JS runs): the literal parts, so the skeleton already reads well.
    props.text = slotRef(s, parts.map((p) => ("lit" in p ? p.lit : "")).join("")) as never
    const js = parts.map((p) => ("lit" in p ? JSON.stringify(p.lit) : `${RUNTIME}.str(${text(p.expr)})`)).join(" + ")
    b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => ${js}, 0);`)
  }

  /** Props object for a user component: expressions become getters, so the child reads them reactively. */
  function propsObject(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
    if (ts.isJsxElement(node) && node.children.some((c) => !(ts.isJsxText(c) && c.text.trim() === ""))) {
      fail(node, "children for user components aren't supported yet")
    }
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    const parts: string[] = []
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      if (name === "key") continue
      const init = a.initializer
      if (!init) parts.push(`${JSON.stringify(name)}: true`)
      else if (ts.isStringLiteral(init)) parts.push(`${JSON.stringify(name)}: ${JSON.stringify(decodeEntities(init.text))}`)
      else if (ts.isJsxExpression(init) && init.expression) parts.push(`get ${JSON.stringify(name)}() { return (${text(init.expression)}) }`)
      else fail(a, `unsupported value for "${name}"`)
    }
    return `{ ${parts.join(", ")} }`
  }

  function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
    const t = (ts.isJsxElement(node) ? node.openingElement : node).tagName
    if (!ts.isIdentifier(t)) fail(t, "only plain component names are supported (no Foo.Bar)")
    return (t as ts.Identifier).text
  }
}

// ---- Helpers ------------------------------------------------------------------------------------------------------

function isCapitalized(name: string) {
  return /^[A-Z]/.test(name)
}

function isJsx(n: ts.Node): boolean {
  return ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression
  return e
}

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void, stopAtFunctions = false) {
  const walk = (n: ts.Node) => {
    visit(n)
    if (stopAtFunctions && n !== node && ts.isFunctionLike(n)) return
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(node, walk)
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

/** HTML entities in JSX text and string attributes, decoded as React does (`&amp;`, `&#8377;`, `&#x20B9;`). */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** JSX text whitespace rules (as in React): lines are trimmed, blank lines dropped, lines joined with one space. */
function jsxText(raw: string): string {
  return decodeEntities(jsxWhitespace(raw))
}

function jsxWhitespace(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/)
  if (lines.length === 1) return raw
  return lines
    .map((line, i) => {
      let t = line.replace(/\t/g, " ")
      if (i > 0) t = t.replace(/^ +/, "")
      if (i < lines.length - 1) t = t.replace(/ +$/, "")
      return t
    })
    .filter((t) => t !== "")
    .join(" ")
}
