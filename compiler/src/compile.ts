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
import { dirname, resolve as resolvePath } from "node:path"
import ts from "typescript"
import {
  Component,
  DynamicProps,
  el,
  Enum,
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
import { NATIVE_NAME } from "./routes"
import { assemble, type LineMap, markCopied } from "./sourcemap"
import { type CompiledSvg, compileSvgFile, compileSvgTree } from "./svg"
import type { SvgAttr, SvgNode } from "./svg-xml"

export interface CompileContext {
  /** Reserves the next template id (its index in the app's .zn.ui file). Parents reserve before their branches. */
  reserveTemplate(): number
  /** Stores the template for a reserved id. */
  defineTemplate(id: number, spec: NodeSpec): void
  /**
   * How generated code writes template [id]. Default: the number. The app build (plugin.ts) writes a placeholder
   * instead and numbers all templates once every file is compiled, so ids don't depend on the order Bun loads files.
   */
  ref?(id: number): string
  /** A <NativeView> names [name]; [where] is its place in the source. The app build checks its plugin once all files are read. */
  nativeView?(name: string, where: string): void
  /** Compiles the .svg file at [path] (absolute). Default: read it from disk (svg.ts, cached). */
  svg?(path: string): CompiledSvg
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


// Animation (step 3.6): what `animate` can name, and the easings a tween can use (index = native easing id).
const ANIMATABLE = ["opacity", "backgroundColor", "scale", "scaleX", "scaleY", "translateX", "translateY", "rotate"]
const EASINGS = ["standard", "ease-out", "ease-in", "linear"]

// SVG (docs/svg.md): react-native-svg element names inside <Svg> → SVG tags.
const SVG_TAGS: Record<string, string> = {
  G: "g", Path: "path", Rect: "rect", Circle: "circle", Ellipse: "ellipse", Line: "line", Polyline: "polyline",
  Polygon: "polygon", Defs: "defs", LinearGradient: "linearGradient", RadialGradient: "radialGradient", Stop: "stop",
  ClipPath: "clipPath", Mask: "mask", Use: "use", Symbol: "symbol",
  // Refused by the SVG compiler with a hint; named here so the message is about SVG, not about zn's own Text / Image.
  Text: "text", TSpan: "tspan", TextPath: "textPath", Image: "image", Pattern: "pattern",
}
/** SVG attributes that are camelCase in SVG itself; every other camelCase prop becomes kebab-case (strokeWidth). */
const SVG_CAMEL = new Set([
  "viewBox", "gradientUnits", "gradientTransform", "spreadMethod", "clipPathUnits", "preserveAspectRatio", "maskUnits",
  "maskContentUnits", "patternUnits", "patternContentUnits", "patternTransform",
])
/** What a part (and an inline element's runtime value) can set at runtime. */
const PART_PROPS = ["fill", "stroke", "opacity"] as const
/** Props of the Svg node itself (`.svg` component or inline <Svg>), besides style and the SVG content. */
const SVG_NODE_PROPS = ["color", "autoMirror", "accessibilityLabel", "accessibilityHint", "accessibilityHidden", "accessibilityRole"]

/**
 * [svgImports]: local names that are .svg files (absolute path), imported directly or through a `.ts` file that
 * re-exports them (plugin.ts finds both). `<Name .../>` becomes an Svg node; the name is not a JS value.
 */
export function compileModule(
  source: string,
  fileName: string,
  ctx: CompileContext,
  staticImports: Map<string, unknown> = new Map(),
  svgImports: Map<string, string> = new Map(),
): CompileOutput {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const ref = (id: number) => ctx.ref?.(id) ?? String(id)
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

  const uiImports = new Set<string>()
  // ---- Module scan --------------------------------------------------------------------------------------------
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause
      const namedSvgOnly =
        !clause?.name &&
        !!clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((e) => svgImports.has(e.name.text))
      if (stmt.moduleSpecifier.text === UI_MODULE) {
        // Intrinsic components are only imported for types; the compiler handles them.
        edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: "" })
        const named = clause?.namedBindings
        if (named && ts.isNamedImports(named)) for (const e of named.elements) uiImports.add(e.name.text)
      } else if (stmt.moduleSpecifier.text.endsWith(".svg") || namedSvgOnly) {
        // SVG files are compiled into the templates; nothing of them is left in the JS (docs/svg.md §4.1).
        if (stmt.moduleSpecifier.text.endsWith(".svg")) {
          if (!clause?.name || clause.namedBindings) fail(stmt, 'import an .svg file as a default import: import Logo from "./logo.svg"')
          if (!stmt.moduleSpecifier.text.startsWith(".")) fail(stmt.moduleSpecifier, "import .svg files by a relative path (./icons/check.svg)")
          svgImports.set(clause!.name!.text, resolvePath(dirname(fileName), stmt.moduleSpecifier.text))
        }
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
  for (const name of svgImports.keys()) userComponents.delete(name)
  // Intrinsics are registry names that aren't shadowed by a user component of the same name.
  const isIntrinsic = (tag: string) => tag in Component && tag !== "Anchor" && !userComponents.has(tag)
  const isSvgFile = (tag: string) => svgImports.has(tag)
  /** An SVG element name (Path, Circle, ...) imported from @zero-native/ui: only valid inside <Svg>. */
  const isSvgChild = (tag: string) => tag in SVG_TAGS && !(tag in Component) && uiImports.has(tag) && !userComponents.has(tag)

  // An imported SVG is a build-time name: only `<Name ... />` is allowed (docs/svg.md §4.1).
  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n) || !svgImports.has(n.text)) return
    const p = n.parent
    if (ts.isImportClause(p) || ts.isImportSpecifier(p)) return
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) return
    fail(n, `${n.text} is an SVG file, which is compiled at build time: use it as JSX (<${n.text} />, or icon={<${n.text} />}), not as a value`)
  })

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
  for (const [name, id] of Object.entries(components)) pieces.push({ generatedAt: source.length, text: `\n${name}.__zt = ${ref(id)};` })
  const { code, map } = assemble(source, pieces)
  return { code, components, map }

  // ---- Templates ----------------------------------------------------------------------------------------------

  /**
   * A root JSX expression → code that produces a View; plus its template id (null for a bare user component).
   * A fragment `<>...</>` becomes a template whose root is a Fragment node: its children join the parent's layout.
   */
  function compileRoot(jsx: JsxNode, depth = 0, allowKey = false): { code: string; templateId: number | null } {
    if (!ts.isJsxFragment(jsx)) {
      const tag = tagName(jsx)
      if (isSvgChild(tag)) fail(jsx, `<${tag}> is an SVG element: it only works inside <Svg>`)
      if (!isIntrinsic(tag) && !isSvgFile(tag)) return { code: `${tag}(${propsObject(jsx, depth)})`, templateId: null }
    }
    return compileTemplate(jsx, depth, (b) => element(jsx, b, allowKey))
  }

  /**
   * The children written inside a user component (`<Card>...</Card>`) → code for a View: the one element itself, or a
   * Fragment holding them all. The component shows it where it writes `{props.children}`.
   */
  function compileChildren(at: ts.Node, kids: ts.NodeArray<ts.JsxChild>, depth: number): string {
    const real = kids.filter((k) => !(ts.isJsxText(k) && k.text.trim() === "") && !(ts.isJsxExpression(k) && !k.expression))
    if (real.length === 1 && (ts.isJsxElement(real[0]) || ts.isJsxSelfClosingElement(real[0]) || ts.isJsxFragment(real[0]))) {
      return compileRoot(real[0] as JsxNode, depth).code
    }
    return compileTemplate(at, depth, (b) => {
      b.nodes++
      return el("Fragment", {}, ...childList(kids, b))
    }).code
  }

  /** Builds one template with [build] and returns the code that sets up an instance of it. */
  function compileTemplate(at: ts.Node, depth: number, build: (b: Builder) => NodeSpec): { code: string; templateId: number } {
    const inst = `__i${depth}`
    const id = ctx.reserveTemplate() // before branches, so a screen's template comes before its parts
    const b: Builder = { nodes: 0, slots: 0, events: 0, binds: [], kids: [], inst, depth }
    const spec = build(b)
    let ids
    try {
      ids = templateIds(spec)
    } catch (e) {
      return fail(at, (e as Error).message)
    }
    ctx.defineTemplate(id, spec)
    const resolve = (s: string) =>
      s
        .replace(/@@S:(\w+)@@/g, (_, n) => String(ids.slots[n]))
        .replace(/@@E:(\w+)@@/g, (_, n) => String(ids.events[n]))
    const lines = [...b.binds.map(resolve), `${RUNTIME}.ready(${inst});`, ...b.kids.map(resolve)]
    return { code: `${RUNTIME}.view(${ref(id)}, (${inst}) => {\n  ${lines.join("\n  ")}\n})`, templateId: id }
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

  function element(jsx: JsxNode, b: Builder, allowKey = false): NodeSpec {
    if (ts.isJsxFragment(jsx)) {
      b.nodes++
      return el("Fragment", {}, ...childList(jsx.children, b))
    }
    const node = jsx
    const tag = tagName(node)
    if (isSvgFile(tag)) return svgFileElement(node, b, allowKey)
    if (!isIntrinsic(tag)) fail(node, `"${tag}" is not a zero-native component`)
    if (tag === "Fragment") fail(node, "write a fragment as <>...</>")
    if (tag === "Svg") return inlineSvgElement(node, b, allowKey)
    if (tag === "SvgPart") fail(node, "<SvgPart> is made by the compiler: use parts={{ id: { fill } }} on the SVG")
    if (tag === "List") return listElement(node, b)
    if (tag === "NativeView") return nativeViewElement(node, b, allowKey)
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    // <TextField value={...} onChangeText={...}>: the handler is bound after the loop, wrapped by textInput().
    let changeText: { ev: string; handler: string } | null = null
    let valueSlot: { s: string; expr: ts.Expression } | null = null

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
      if (name === "ref") {
        // Not a handler: the field's handle goes into the ref (core text-field.ts fieldRef).
        if (tag !== "TextField") fail(a, "`ref` works only on <TextField> (focus(), blur(), clear()); other elements have no handle")
        if (!init || !ts.isJsxExpression(init) || !init.expression) {
          fail(a, "ref needs an object made by createRef(): const r = createRef<TextFieldHandle>(), then ref={r}")
        }
        const ev = `e${b.events++}`
        ;(props as any).ref = eventRef(ev)
        b.binds.push(`${RUNTIME}.fieldRef(${b.inst}, @@E:${ev}@@, ${text((init as ts.JsxExpression).expression!)});`)
        continue
      }
      if (name in EventKind) {
        if (!init || !ts.isJsxExpression(init) || !init.expression) fail(a, `${name} needs a function`)
        const ev = `e${b.events++}`
        ;(props as any)[name] = eventRef(ev)
        const handler = text((init as ts.JsxExpression).expression!)
        if (tag === "TextField" && name === "onChangeText") changeText = { ev, handler }
        else b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${handler});`)
        continue
      }
      if (!(name in Prop)) fail(a, `unknown prop "${name}" on <${tag}>`)
      if (tag === "TextField" && name === "value" && init && ts.isJsxExpression(init) && init.expression) {
        const before = b.slots
        setProp(props, b, name, init.expression, a)
        if (b.slots > before) valueSlot = { s: `s${before}`, expr: init.expression }
        continue
      }
      if (!init) setProp(props, b, name as PropName, ts.factory.createTrue(), a)
      else if (ts.isStringLiteral(init)) setStatic(props, name as PropName, decodeEntities(init.text), a)
      else if (ts.isJsxExpression(init) && init.expression) setProp(props, b, name as PropName, init.expression, a)
      else fail(a, `unsupported value for "${name}"`)
    }
    if (changeText) {
      const { ev, handler } = changeText
      b.binds.push(
        valueSlot
          ? `${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${RUNTIME}.textInput(${b.inst}, @@S:${valueSlot.s}@@, () => (${text(valueSlot.expr)}), ${handler}));`
          : `${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${handler});`,
      )
    }

    let children: NodeSpec[] = []
    const kids = ts.isJsxElement(node) ? node.children : ts.factory.createNodeArray<ts.JsxChild>()
    if (tag === "Text") {
      textChildren(node, kids, props, b)
    } else if (tag === "TextField") {
      if (kids.some((k) => !(ts.isJsxText(k) && k.text.trim() === ""))) fail(node, "<TextField> takes no children")
    } else {
      children = childList(kids, b)
    }
    return el(tag as keyof typeof Component, props, ...children)
  }

  /**
   * <NativeView name="scanner.qr" props={{ torch }} onEvent={(e) => ...} style={...} />: a plugin's Compose view
   * (docs/plugins.md §5). The props go as JSON text, so only a real change reaches the view.
   */
  function nativeViewElement(node: ts.JsxElement | ts.JsxSelfClosingElement, b: Builder, allowKey: boolean): NodeSpec {
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    let viewName: string | null = null
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      const init = a.initializer
      const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
      if (name === "key") {
        if (!allowKey) fail(a, "`key` is only used on the root element of a `.map(...)` row")
      } else if (name === "style") {
        if (!expr) fail(a, "style needs an object: style={{ ... }}")
        styleProps(expr!, props, b)
      } else if (name === "name") {
        // A literal, as the build checks it against the app's plugins.
        if (!init || !ts.isStringLiteral(init)) fail(a, 'name must be a string literal, e.g. name="scanner.qr"')
        viewName = (init as ts.StringLiteral).text
        if (!NATIVE_NAME.test(viewName)) fail(a, `name "${viewName}" must be "<plugin>.<name>", e.g. "scanner.qr"`)
        setStatic(props, "viewName", viewName, a)
      } else if (name === "props") {
        if (!expr) fail(a, "props needs an object: props={{ ... }}")
        const v = fold(expr!, scope)
        if (v === NOT_STATIC) {
          const s = `s${b.slots++}`
          props.viewProps = slotRef(s, null) as never
          b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => JSON.stringify(${text(expr!)}), 0);`)
        } else if (v !== undefined) {
          setStatic(props, "viewProps", JSON.stringify(v), a)
        }
      } else if (name === "onEvent") {
        if (!expr) fail(a, "onEvent needs a function")
        const ev = `e${b.events++}`
        ;(props as any).onNativeEvent = eventRef(ev)
        // A name no app uses: the handler's own `p` or `e` must not be hidden by this wrapper.
        b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, (__znPayload) => (${text(expr!)})(JSON.parse(__znPayload)));`)
      } else {
        fail(a, `<NativeView> takes name, props, onEvent and style, not "${name}"`)
      }
    }
    if (viewName === null) fail(node, '<NativeView> needs a name, e.g. name="scanner.qr"')
    const kids = ts.isJsxElement(node) ? node.children : []
    if (kids.some((k) => !(ts.isJsxText(k) && k.text.trim() === ""))) fail(node, "<NativeView> takes no children")
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    ctx.nativeView?.(viewName!, `${fileName}:${line + 1}:${character + 1}`)
    return el("NativeView", props)
  }

  // ---- SVG (docs/svg.md) ------------------------------------------------------------------------------------------

  /** Where [node] is, as "file:line:col" (for SVG errors, which carry their own position). */
  function whereIs(node: ts.Node): string {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return `${fileName}:${line + 1}:${character + 1}`
  }

  /** Runs the SVG compiler; its errors already say where (the .svg file, or the TSX for inline SVG). */
  function svgCompile(run: () => CompiledSvg, node: ts.Node): CompiledSvg {
    try {
      return run()
    } catch (e) {
      const msg = (e as Error).message
      // An error inside an .svg file: also say which TSX element uses it.
      throw new Error(msg.startsWith(fileName) ? msg : `${msg}\n  (used at ${whereIs(node)})`)
    }
  }

  /**
   * The Svg node's own props that aren't SVG content: style, size (→ width and height), color (currentColor),
   * autoMirror, accessibility. Returns false for any other prop, so the caller decides.
   */
  function svgNodeProp(name: string, a: ts.JsxAttribute, props: NodeProps & Record<string, unknown>, b: Builder, allowKey: boolean): boolean {
    const init = a.initializer
    const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
    if (name === "key") {
      if (!allowKey) fail(a, "`key` is only used on the root element of a `.map(...)` row")
      return true
    }
    if (name === "style") {
      if (!expr) fail(a, "style needs an object: style={{ ... }}")
      styleProps(expr!, props, b)
      return true
    }
    if (name === "size" || name === "width" || name === "height") {
      const v = !init ? NOT_STATIC : ts.isStringLiteral(init) ? Number(init.text) : expr ? fold(expr, scope) : NOT_STATIC
      if (typeof v !== "number" || !(v > 0)) fail(a, `${name} must be a positive number of dp known at build time (it sets the SVG's size)`)
      if (name !== "height") props.width = v as number
      if (name !== "width") props.height = v as number
      return true
    }
    if (!SVG_NODE_PROPS.includes(name)) return false
    if (!init) setProp(props, b, name as PropName, ts.factory.createTrue(), a)
    else if (ts.isStringLiteral(init)) setStatic(props, name as PropName, decodeEntities(init.text), a)
    else if (expr) setProp(props, b, name as PropName, expr, a)
    else fail(a, `unsupported value for "${name}"`)
    return true
  }

  /** Default size, and the rules every Svg node shares. */
  function svgNode(node: ts.Node, svg: CompiledSvg, props: NodeProps & Record<string, unknown>, parts: NodeSpec[], b: Builder): NodeSpec {
    if ("color" in props && !svg.usesCurrentColor) {
      fail(node, 'color sets currentColor, but this SVG has none: add fill="currentColor" where the colour should change, or use parts')
    }
    const hasW = props.width !== undefined
    const hasH = props.height !== undefined
    if (!hasW && !hasH) {
      props.width = svg.width
      props.height = svg.height
    } else if (hasW !== hasH && props.aspectRatio === undefined) {
      props.aspectRatio = svg.width / svg.height
    }
    props.svg = svg.data
    b.nodes += parts.length // SvgPart children, in tree order right after the Svg node
    return el("Svg", props, ...parts)
  }

  /** `<Logo size={24} color={c.ink} parts={{ ring: { fill: brand() } }} />` for `import Logo from "./logo.svg"`. */
  function svgFileElement(node: ts.JsxElement | ts.JsxSelfClosingElement, b: Builder, allowKey: boolean): NodeSpec {
    const tag = tagName(node)
    if (ts.isJsxElement(node) && node.children.some((k) => !(ts.isJsxText(k) && k.text.trim() === ""))) {
      fail(node, `<${tag}> (an SVG file) takes no children`)
    }
    const path = svgImports.get(tag)!
    const svg = svgCompile(() => (ctx.svg ? ctx.svg(path) : compileSvgFile(path)), node)
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const parts: NodeSpec[] = []
    for (const attr of (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      if (svgNodeProp(name, a, props, b, allowKey)) continue
      if (name !== "parts") {
        fail(a, `unknown prop "${name}" on <${tag}> (an SVG: use size, style, color, parts, autoMirror, accessibilityLabel)`)
      }
      const expr = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined
      if (!expr || !ts.isObjectLiteralExpression(unwrap(expr))) fail(a, "parts needs an object: parts={{ ring: { fill: c.brand } }}")
      for (const p of (unwrap(expr!) as ts.ObjectLiteralExpression).properties) {
        if (!ts.isPropertyAssignment(p)) fail(p, "write each part as name: { fill, stroke, opacity }")
        const pa = p as ts.PropertyAssignment
        const id = pa.name.getText(sf).replace(/^["']|["']$/g, "")
        const index = svg.parts.get(id)
        if (index === undefined) {
          const known = [...svg.parts.keys()]
          fail(pa.name, `${tag} has no part "${id}" (${known.length > 0 ? `its parts: ${known.join(", ")}` : "it has no elements with an id"})`)
        }
        const value = unwrap(pa.initializer)
        if (!ts.isObjectLiteralExpression(value)) fail(pa.initializer, `part "${id}" needs an object: { fill, stroke, opacity }`)
        const partProps: NodeProps & Record<string, unknown> = { part: index }
        for (const q of (value as ts.ObjectLiteralExpression).properties) {
          if (!ts.isPropertyAssignment(q)) fail(q, "write part values as fill: ..., opacity: ...")
          const k = (q as ts.PropertyAssignment).name.getText(sf)
          if (!(PART_PROPS as readonly string[]).includes(k)) fail(q, `a part can set ${PART_PROPS.join(", ")} (phase 2 adds transforms), not "${k}"`)
          setProp(partProps, b, k as PropName, (q as ts.PropertyAssignment).initializer, q)
        }
        parts.push(el("SvgPart", partProps))
      }
    }
    return svgNode(node, svg, props, parts, b)
  }

  /**
   * Inline `<Svg viewBox="..."><Path d="..." fill={...} /></Svg>` with react-native-svg's names. The whole subtree
   * becomes one Svg node: the SVG compiler gets the same tree a .svg file gives. An element whose fill, stroke or
   * opacity changes at runtime becomes a part (with an id of its own if it has none).
   */
  function inlineSvgElement(node: ts.JsxElement | ts.JsxSelfClosingElement, b: Builder, allowKey: boolean): NodeSpec {
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const runtime: Array<{ id: string; prop: string; expr: ts.Expression; at: ts.Node }> = []
    let auto = 0

    const convert = (jsx: ts.JsxElement | ts.JsxSelfClosingElement, local: FoldScope, inRow: boolean, isRoot: boolean): SvgNode => {
      const opening = ts.isJsxElement(jsx) ? jsx.openingElement : jsx
      const jsxTag = tagName(jsx)
      const tag = isRoot ? "svg" : SVG_TAGS[jsxTag]
      if (!tag) fail(jsx, jsxTag === "Svg" ? "a nested <Svg> isn't supported: use a <G>" : `<${jsxTag}> can't be inside <Svg> (use ${Object.keys(SVG_TAGS).slice(0, 16).join(", ")})`)
      const n: SvgNode = { tag: tag!, attrs: new Map(), children: [], text: "", at: whereIs(jsx) }
      const dynamic: Array<{ prop: string; expr: ts.Expression; at: ts.Node }> = []
      for (const attr of opening.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
        const a = attr as ts.JsxAttribute
        const name = a.name.getText(sf)
        if (isRoot && svgNodeProp(name, a, props, b, allowKey)) continue
        if (name === "key" && inRow) continue
        const svgName = name === "xlinkHref" ? "xlink:href" : SVG_CAMEL.has(name) ? name : name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())
        const init = a.initializer
        let v: unknown = NOT_STATIC
        if (!init) fail(a, `"${name}" needs a value`)
        else if (ts.isStringLiteral(init)) v = init.text
        else if (ts.isJsxExpression(init) && init.expression) v = fold(init.expression, local)
        if (v === NOT_STATIC) {
          const expr = ts.isJsxExpression(init!) ? init.expression : undefined
          if (!expr || !(PART_PROPS as readonly string[]).includes(svgName)) {
            fail(a, `SVG "${name}" must be known at build time; only ${PART_PROPS.join(", ")} can change at runtime ` +
              "(geometry is fixed: move it with a part transform in phase 2, or choose between two shapes with a ternary)")
          }
          if (inRow) fail(a, "inside a build-time .map(...) in <Svg>, values must be known at build time")
          dynamic.push({ prop: svgName, expr: expr!, at: a })
          // A stand-in the SVG compiler can work with: drawn until JS sets the value (transparent / fully opaque).
          v = svgName === "opacity" ? "1" : "#00000000"
        }
        const text =
          typeof v === "number" ? String(v)
          : typeof v === "string" ? v
          : Array.isArray(v) && v.every((x) => typeof x === "number") ? v.join(" ")
          : fail(a, `SVG "${name}" needs a string or a number`)
        n.attrs.set(svgName, { value: text as string, at: whereIs(a) } satisfies SvgAttr)
      }
      if (dynamic.length > 0) {
        let id = n.attrs.get("id")?.value
        if (id === undefined) {
          id = `__zn${auto++}`
          n.attrs.set("id", { value: id, at: n.at })
        }
        for (const d of dynamic) runtime.push({ id, ...d })
      }
      for (const child of ts.isJsxElement(jsx) ? jsx.children : []) {
        if (ts.isJsxText(child)) {
          if (child.text.trim() !== "") fail(child, "text inside <Svg> isn't supported (SVG text isn't either): put a <Text> over the SVG in a <Stack>")
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue
          const e = unwrap(child.expression)
          if (isJsx(e) && !ts.isJsxFragment(e)) {
            n.children.push(convert(e as ts.JsxElement, local, inRow, false))
            continue
          }
          // {ITEMS.map((it, i) => <Circle .../>)} over an array known at build time: expanded here.
          if (
            ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "map" &&
            e.arguments.length === 1 && (ts.isArrowFunction(e.arguments[0]!) || ts.isFunctionExpression(e.arguments[0]!))
          ) {
            const list = fold(e.expression.expression, local)
            if (!Array.isArray(list)) fail(e, "inside <Svg>, .map(...) works only over an array known at build time (a module const)")
            const fn = e.arguments[0] as ts.ArrowFunction
            const names = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : fail(p, "use plain parameter names in .map")))
            const body = ts.isBlock(fn.body)
              ? (fn.body.statements.length === 1 && ts.isReturnStatement(fn.body.statements[0]!) ? fn.body.statements[0].expression : undefined)
              : fn.body
            const row = body && unwrap(body)
            if (!row || !isJsx(row) || ts.isJsxFragment(row)) fail(fn, "a .map row inside <Svg> must return one SVG element")
            ;(list as unknown[]).forEach((item, i) => {
              const statics = new Map(local.staticImports)
              if (names[0]) statics.set(names[0], item)
              if (names[1]) statics.set(names[1], i)
              n.children.push(convert(row as ts.JsxElement, { consts: local.consts, staticImports: statics }, true, false))
            })
            continue
          }
          fail(child, "inside <Svg>, only SVG elements and build-time .map(...) are allowed; to hide an element, set its opacity")
        } else if (ts.isJsxFragment(child)) {
          fail(child, "fragments aren't supported inside <Svg>: use a <G>")
        } else {
          n.children.push(convert(child as ts.JsxElement, local, inRow, false))
        }
      }
      return n
    }

    const root = convert(node, scope, false, true)
    const svg = svgCompile(() => compileSvgTree(root), node)
    const byId = new Map<string, NodeProps & Record<string, unknown>>()
    for (const r of runtime) {
      let partProps = byId.get(r.id)
      if (!partProps) {
        const index = svg.parts.get(r.id)
        if (index === undefined) fail(r.at, "this element draws nothing, so its value can't change at runtime")
        partProps = { part: index }
        byId.set(r.id, partProps)
      }
      setProp(partProps, b, r.prop as PropName, r.expr, r.at)
    }
    return svgNode(node, svg, props, [...byId.values()].map((p) => el("SvgPart", p)), b)
  }

  /** The children of an element (or fragment), in order. Fragments inside are flattened: they add no node. */
  function childList(kids: ts.NodeArray<ts.JsxChild>, b: Builder): NodeSpec[] {
    const children: NodeSpec[] = []
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
    return children
  }

  function childElement(node: JsxNode, b: Builder): NodeSpec[] {
    if (ts.isJsxFragment(node)) return childList(node.children, b)
    const tag = tagName(node)
    if (isSvgChild(tag)) fail(node, `<${tag}> is an SVG element: it only works inside <Svg>`)
    if (isIntrinsic(tag) || isSvgFile(tag)) return [element(node, b)]
    // A user component: an anchor where its instance mounts.
    const index = b.nodes++
    b.kids.push(`${RUNTIME}.component(${b.inst}, ${index}, ${tag}, ${propsObject(node, b.depth + 1)});`)
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
      // Any other expression: a View passed in, like `{props.children}` or `{props.header}` (runtime: insert()).
      const v = fold(e, scope)
      if (typeof v === "string" || typeof v === "number") fail(e, "text must be inside <Text>")
      b.kids.push(`${RUNTIME}.insert(${b.inst}, ${index}, () => (${text(e)}));`)
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
      if (root.templateId !== null) return { code: root.code, type: ref(root.templateId) }
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
      : name === "animate" ? animateSpec(value, at)
      : name === "enter" || name === "exit" ? transitionSpec(value, name, at)
      : value
  }

  // ---- Animation (step 3.6, ARCHITECTURE §10): build-time values, encoded for native (registry: animate / enter / exit).

  /** 250 | "spring" | "bouncy" | { duration, easing? } | { spring: { damping?, stiffness? } } → "t250e0" / "s0.75,400". */
  function timing(v: unknown, at: ts.Node, what: string): string {
    const ms = (n: unknown) => {
      if (typeof n !== "number" || !(n >= 0 && n <= 10_000)) fail(at, `${what}: a duration is 0–10000 ms, got ${JSON.stringify(n)}`)
      return Math.round(n as number)
    }
    if (typeof v === "number") return `t${ms(v)}e0`
    if (v === "spring") return "s0.75,400"
    if (v === "bouncy") return "s0.45,400"
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      if ("spring" in o) {
        const sp = (o.spring ?? {}) as Record<string, unknown>
        const damping = sp.damping ?? 0.75
        const stiffness = sp.stiffness ?? 400
        if (typeof damping !== "number" || damping <= 0 || typeof stiffness !== "number" || stiffness <= 0) {
          fail(at, `${what}: spring needs damping > 0 (1 = no bounce) and stiffness > 0`)
        }
        return `s${damping},${stiffness}`
      }
      if ("duration" in o) {
        const easing = o.easing ?? "standard"
        const e = EASINGS.indexOf(easing as string)
        if (e < 0) fail(at, `${what}: easing must be one of ${EASINGS.join(", ")}`)
        return `t${ms(o.duration)}e${e}`
      }
    }
    return fail(at, `${what}: use a duration in ms (250), "spring", "bouncy", { duration, easing } or { spring: { damping, stiffness } }`)
  }

  function isTiming(v: unknown): boolean {
    if (typeof v === "number" || v === "spring" || v === "bouncy") return true
    return !!v && typeof v === "object" && ("duration" in (v as object) || "spring" in (v as object))
  }

  /** animate={250} (every animatable prop of the element) or animate={{ opacity: 200, translateY: "spring" }}. */
  function animateSpec(v: unknown, at: ts.Node): string {
    if (isTiming(v)) return `*=${timing(v, at, "animate")}`
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(at, "animate needs a timing (250, \"spring\") or { prop: timing }")
    const parts: string[] = []
    for (const [k, t] of Object.entries(v as object)) {
      if (!ANIMATABLE.includes(k)) fail(at, `animate: "${k}" can't be animated (use ${ANIMATABLE.join(", ")})`)
      parts.push(`${Prop[k as PropName].id}=${timing(t, at, `animate.${k}`)}`)
    }
    return parts.join(";")
  }

  /**
   * enter / exit: a preset ("fade", "fade-up", "fade-down", "scale", "pop") or { opacity, translateX, translateY,
   * scale, duration | spring, easing }: the state the element enters from, or exits to.
   * → "opacity,translateX,translateY,scale|timing".
   */
  function transitionSpec(v: unknown, kind: "enter" | "exit", at: ts.Node): string {
    const into = kind === "enter" ? 1 : -1 // "up" means: enters from below, leaves upward
    const presets: Record<string, Record<string, unknown>> = {
      fade: { opacity: 0 },
      "fade-up": { opacity: 0, translateY: 16 * into },
      "fade-down": { opacity: 0, translateY: -16 * into },
      scale: { opacity: 0, scale: 0.92 },
      pop: { opacity: 0, scale: 0.85, ...(kind === "enter" ? { timing: "bouncy" } : {}) },
    }
    const o = typeof v === "string" ? presets[v] : (v as Record<string, unknown>)
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      fail(at, `${kind}: use a preset (${Object.keys(presets).join(", ")}) or { opacity, translateX, translateY, scale, duration }`)
    }
    const known = ["opacity", "translateX", "translateY", "scale", "duration", "easing", "spring", "timing"]
    for (const k of Object.keys(o)) if (!known.includes(k)) fail(at, `${kind}: unknown key "${k}"`)
    const num = (k: string, d: number) => {
      const x = o[k] ?? d
      if (typeof x !== "number") fail(at, `${kind}.${k} must be a number`)
      return x as number
    }
    const t =
      "timing" in o ? timing(o.timing, at, kind)
      : "spring" in o || "duration" in o ? timing(o, at, kind)
      : kind === "enter" ? "t220e1" // ease-out: arrives fast, settles slowly
      : "t160e2" // ease-in: leaves a little faster than it came
    return `${num("opacity", 1)},${num("translateX", 0)},${num("translateY", 0)},${num("scale", 1)}|${t}`
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
            if (v !== NOT_STATIC) {
              transform(v, props, p)
              continue
            }
            // Entries may change at runtime (step 3.6): [{ translateY: open() ? 0 : 40 }]. Each is its own slot.
            const list = unwrap(p.initializer)
            if (!ts.isArrayLiteralExpression(list)) fail(p, "transform must be an array literal like [{ scale: x }]")
            for (const item of (list as ts.ArrayLiteralExpression).elements) {
              const obj = unwrap(item)
              const entry = ts.isObjectLiteralExpression(obj) ? obj.properties : undefined
              if (!entry || entry.length !== 1 || !ts.isPropertyAssignment(entry[0]!)) {
                fail(item, "each transform entry has exactly one key, e.g. { translateY: y() }")
              }
              const pa = entry![0] as ts.PropertyAssignment
              const tk = pa.name.getText(sf)
              const tv = fold(pa.initializer, scope)
              if (tv !== NOT_STATIC) transform([{ [tk]: tv }], props, pa)
              else if (["scale", "scaleX", "scaleY", "translateX", "translateY", "rotate"].includes(tk)) {
                setProp(props, b, tk as PropName, pa.initializer, pa) // rotate at runtime: a number of degrees
              } else fail(pa, `unsupported transform "${tk}"`)
            }
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
    type Part = { lit: string } | { expr: ts.Expression }
    // Spans: nested <Text> elements. Each run of text with one style is a span; the outer text's own runs have style {}.
    const spans: Array<{ style: Record<string, unknown>; parts: Part[] }> = []
    let nested = false
    const add = (style: Record<string, unknown>, part: Part) => {
      const last = spans[spans.length - 1]
      if (last && last.style === style) last.parts.push(part)
      else spans.push({ style, parts: [part] })
    }
    const walk = (children: ts.NodeArray<ts.JsxChild>, style: Record<string, unknown>) => {
      for (const child of children) {
        if (ts.isJsxText(child)) {
          const t = jsxText(child.text)
          if (t) add(style, { lit: t })
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue
          if (isJsx(unwrap(child.expression))) fail(child, "inside <Text>, write nested text as <Text>...</Text> directly")
          const v = fold(child.expression, scope)
          if (v !== NOT_STATIC) add(style, { lit: v === null || v === undefined || v === false ? "" : String(v) })
          else add(style, { expr: child.expression })
        } else if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && tagName(child) === "Text") {
          nested = true
          const inner = { ...style, ...spanStyle(child) }
          if (ts.isJsxElement(child)) walk(child.children, inner)
        } else {
          fail(child, "<Text> can only contain text, {expressions} and nested <Text> spans")
        }
      }
    }
    walk(kids, {})
    if (spans.length === 0) return
    if ("text" in props) fail(node, "use either the text prop or children, not both")

    // Without spans: one string. With spans: the spans' texts joined by U+001F, and their styles in `spans`.
    const sep = nested ? "\u001f" : ""
    const allParts = spans.flatMap((s, i) => (i > 0 && sep ? [{ lit: sep } as Part, ...s.parts] : s.parts))
    if (nested) props.spans = JSON.stringify(spans.map((s) => s.style))
    if (allParts.every((p) => "lit" in p)) {
      props.text = allParts.map((p) => (p as { lit: string }).lit).join("")
      return
    }
    const s = `s${b.slots++}`
    // Default (shown before JS runs): the literal parts, so the skeleton already reads well.
    props.text = slotRef(s, allParts.map((p) => ("lit" in p ? p.lit : "")).join("")) as never
    const js = allParts.map((p) => ("lit" in p ? JSON.stringify(p.lit) : `${RUNTIME}.str(${text(p.expr)})`)).join(" + ")
    b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => ${js}, 0);`)
  }

  /**
   * A nested <Text>'s own style, for its span. Build-time values only, and only what a span can change: colour, size,
   * weight, italic, underline / line-through, letter spacing, background. Values go to native as in templates
   * (colours as ARGB numbers, enums as their numbers).
   */
  function spanStyle(node: ts.JsxElement | ts.JsxSelfClosingElement): Record<string, unknown> {
    const allowed = ["color", "fontSize", "fontWeight", "fontStyle", "textDecorationLine", "letterSpacing", "backgroundColor"]
    const out: Record<string, unknown> = {}
    const put = (key: string, value: unknown, at: ts.Node) => {
      if (!allowed.includes(key)) fail(at, `"${key}" isn't supported on a nested <Text> span (use ${allowed.join(", ")})`)
      if (value === undefined || value === null) return
      if (key === "fontWeight") out[key] = fontWeight(value, at)
      else if (key === "color" || key === "backgroundColor") {
        try {
          out[key] = parseColor(String(value))
        } catch (e) {
          fail(at, (e as Error).message)
        }
      } else if (key === "fontStyle" || key === "textDecorationLine") {
        const table = Enum[key] as Record<string, number>
        if (!(String(value) in table)) fail(at, `${key} must be one of ${Object.keys(table).join(", ")}`)
        out[key] = table[String(value)]
      } else out[key] = value
    }
    const merge = (obj: unknown, at: ts.Node) => {
      if (obj === null || obj === undefined || obj === false) return
      if (Array.isArray(obj)) return obj.forEach((o) => merge(o, at))
      if (typeof obj !== "object") fail(at, "style entries must be objects")
      for (const [k, v] of Object.entries(obj as object)) put(k, v, at)
    }
    for (const attr of (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      if (name in EventKind) fail(a, `${name} on a nested <Text> span isn't supported yet`)
      const init = a.initializer
      const value =
        !init ? true
        : ts.isStringLiteral(init) ? init.text
        : ts.isJsxExpression(init) && init.expression ? fold(init.expression, scope)
        : NOT_STATIC
      if (value === NOT_STATIC) fail(a, `a span's "${name}" must be known at build time (a literal, a const or a token)`)
      if (name === "style") merge(value, a)
      else put(name, value, a)
    }
    return out
  }

  /**
   * Props object for a user component: expressions become getters, so the child reads them reactively. JSX passed as
   * a prop (`header={<Title/>}`) and the children written inside the element become functions that make a View;
   * the component shows them with `{props.header}` / `{props.children}`. [depth]: for the templates' setup code.
   */
  function propsObject(node: ts.JsxElement | ts.JsxSelfClosingElement, depth: number): string {
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    const parts: string[] = []
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      if (name === "key") continue
      if (name === "children") fail(a, "write children between the tags: <Card>...</Card>")
      const init = a.initializer
      const jsx = init && ts.isJsxExpression(init) && init.expression ? unwrap(init.expression) : null
      if (!init) parts.push(`${JSON.stringify(name)}: true`)
      else if (ts.isStringLiteral(init)) parts.push(`${JSON.stringify(name)}: ${JSON.stringify(decodeEntities(init.text))}`)
      else if (jsx && isJsx(jsx)) parts.push(`${JSON.stringify(name)}: () => ${compileRoot(jsx as JsxNode, depth).code}`)
      else if (ts.isJsxExpression(init) && init.expression) parts.push(`get ${JSON.stringify(name)}() { return (${text(init.expression)}) }`)
      else fail(a, `unsupported value for "${name}"`)
    }
    if (ts.isJsxElement(node) && node.children.some((c) => !(ts.isJsxText(c) && c.text.trim() === "") && !(ts.isJsxExpression(c) && !c.expression))) {
      parts.push(`"children": () => ${compileChildren(node, node.children, depth)}`)
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
