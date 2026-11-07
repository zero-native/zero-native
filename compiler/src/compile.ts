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
//   - JSX in a variable (`const x = <A/>`, `const x = c ? <A/> : null`, guide notes §47): each use in JSX gets its own
//     copy; `return c ? <A/> : <B/>` is a Fragment root with one anchor
import { existsSync, readFileSync, writeFileSync } from "node:fs"
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
import { declaredIn, fold, NOT_STATIC, type FoldScope } from "./fold"
import { NATIVE_NAME } from "./routes"
import { assemble, type LineMap, markCopied } from "./sourcemap"
import { type CompiledSvg, compileSvgFile, compileSvgTree } from "./svg"
import { BASE_PROPS, STYLE_KEYS, TAG_PROPS } from "./tag-props"
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
  /**
   * Component name → every returned JSX's template id (in source order), and where it returns something that isn't
   * JSX (`return null`, a bare `return`). The app build checks screens with this: native draws a screen's root from
   * one template before JS runs, so a screen must always return that same template (guide notes §4).
   */
  roots: Record<string, ComponentRoots>
  /** Uses of components with props that can change while they stay mounted (for the props traps, plugin.ts). */
  propUses: PropUse[]
  /** Output position → TSX position (for `zn dev` error screens). */
  map: LineMap
}

/** What one component returns (CompileOutput.roots). */
export interface ComponentRoots {
  /** Template id of each JSX return; -1 for one that returns another component (`return <Other />`). */
  templates: number[]
  /** Where each JSX return is (`file:line:col`), same order as [templates]. */
  at: string[]
  /** Where each non-JSX return is (`file:line:col`). */
  others: string[]
  /** React habits that read a value once (checkOnceTraps); the app build turns them into errors (plugin.ts). */
  traps: OnceTrap[]
}

/** A use of a component, outside a row, with a prop that can change while it stays mounted (CompileOutput.propUses). */
export interface PropUse {
  component: string
  /** The component whose JSX has this use. */
  parent: string
  live: "signal" | "parentProps"
}

/** A value the component's body reads once, where it can change later (guide notes §61). */
export interface OnceTrap {
  /** `file:line:col` */
  at: string
  /** Only props were read. A screen's props are its route's params, which don't change while it's open: fine there. */
  fromProps: boolean
  message: string
}

const RUNTIME = "__zn"
/** What a nested <Text> span can change (ZnTemplate.kt parseSpans; core text-spans.ts for spans at runtime). */
const SPAN_STYLE_KEYS = ["color", "fontSize", "fontWeight", "fontStyle", "textDecorationLine", "letterSpacing", "backgroundColor"]
const UI_MODULE = "@zero-native/ui"
type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment


// Animation (step 3.6): what `animate` can name, and the easings a tween can use (index = native easing id).
const ANIMATABLE = ["opacity", "backgroundColor", "scale", "scaleX", "scaleY", "translateX", "translateY", "rotate"]
const EASINGS = ["standard", "ease-out", "ease-in", "linear"]
// Pull to refresh (guide notes §41): only on a vertical Scroll and on List.
const REFRESH_PROPS = ["refreshing", "onRefresh", "refreshColor", "refreshBackground"]
// iOS shadow keys: React Native on Android ignores them (its shadows come from elevation and shadowColor), so zn
// accepts and drops them too, and a shared style ports as it is (RN props pack 2).
const IGNORED_STYLE_KEYS = new Set(["shadowOffset", "shadowOpacity", "shadowRadius"])

/**
 * RN / CSS transformOrigin → "x y" as fractions of the element's size (registry 20). One to three values, as a string
 * ("left", "top left", "50% 100%") or an array (["0%", "50%"]): keywords left / center / right / top / bottom and
 * percents. One value: a keyword sets its own axis, a percent sets x; the other axis is the centre. "top left" works in
 * either order. A third value (z) must be 0. Lengths (dp, px) fail: zn's pivot is a fraction of the size.
 */
export function transformOriginOf(v: unknown): string | { error: string } {
  const bad = (why: string) => ({ error: `transformOrigin ${JSON.stringify(v)}: ${why}. Use keywords (left, center, right, top, bottom) or percents, e.g. "left" or "0% 50%"` })
  const parts = typeof v === "string" ? v.trim().split(/\s+/) : Array.isArray(v) ? v.map((x) => (typeof x === "number" ? String(x) : x)) : null
  if (!parts || parts.length < 1 || parts.length > 3 || parts.some((p) => typeof p !== "string" || p === "")) return bad("must be 1 to 3 values")
  if (parts.length === 3 && !/^0(px|dp)?$/.test(parts[2]!)) return bad("a z value other than 0 isn't supported")
  const xs: Record<string, number> = { left: 0, center: 0.5, right: 1 }
  const ys: Record<string, number> = { top: 0, center: 0.5, bottom: 1 }
  const pct = (p: string) => (/^-?\d+(\.\d+)?%$/.test(p) ? Number(p.slice(0, -1)) / 100 : null)
  let [a, b] = parts as string[]
  if (b === undefined) {
    if (a! in ys && a !== "center") return `0.5 ${ys[a!]}`
    const x = xs[a!] ?? pct(a!)
    return x === null || x === undefined ? bad(`"${a}" isn't a keyword or a percent`) : `${x} 0.5`
  }
  if ((a! in ys && a !== "center") || (b in xs && b !== "center")) [a, b] = [b, a!] // "top left" → "left top"
  const x = xs[a!] ?? pct(a!)
  const y = ys[b] ?? pct(b)
  if (x === null || x === undefined) return bad(`"${a}" isn't a horizontal keyword or a percent`)
  if (y === null || y === undefined) return bad(`"${b}" isn't a vertical keyword or a percent`)
  return `${x} ${y}`
}
// RN's contentContainerStyle on <Scroll> / <List> (2026-11-05): only padding, which scrolls with the content.
const PADDING_KEYS = new Set(["padding", "paddingHorizontal", "paddingVertical", "paddingTop", "paddingBottom", "paddingStart", "paddingEnd"])
// Compose refuses a negative padding, and margin and border widths are drawn as padding: a negative value here made the
// app crash while reading the bundle. So it fails the build (second-opinions 113); the runtime also clamps at 0.
const MARGIN_KEYS = new Set(["margin", "marginHorizontal", "marginVertical", "marginTop", "marginBottom", "marginStart", "marginEnd"])
const NOT_NEGATIVE_KEYS = new Set([...PADDING_KEYS, "borderWidth", "borderTopWidth", "borderBottomWidth"])
// Taps are taken only by <Pressable> (RN-compat sweep P0.5): on any other element these did nothing, with no error.
const PRESS_EVENTS = new Set(["onPress", "onPressIn", "onPressOut", "onLongPress", "onPressRepeat"])
// ---- React Native names (RN-compat sweep P1, 2026-11-05) ----------------------------------------------------------
// Each is a rename at build time: no new APK, and nothing changes for code that uses the zn names.
/** RN component names. Only when imported from @zero-native/ui, so an app's own `View` component is never taken. */
const RN_TAGS: Record<string, string> = {
  View: "Column", // or Row, from a build-time flexDirection (viewTag)
  FlatList: "List",
  TouchableOpacity: "Pressable",
  TouchableHighlight: "Pressable",
  TouchableWithoutFeedback: "Pressable",
  ActivityIndicator: "Spinner",
}
/**
 * RN style keys with another zn name. Left / right become start / end: the same in a left-to-right app; in a
 * right-to-left one they flip, where RN's left / right don't. A start / end key written too wins, as in RN.
 */
const RN_STYLE_RENAMES: Record<string, string> = {
  marginLeft: "marginStart",
  marginRight: "marginEnd",
  paddingLeft: "paddingStart",
  paddingRight: "paddingEnd",
  left: "start",
  right: "end",
}
/** RN ScrollView / FlatList props that change nothing on screen in zn (speed hints, iOS only): accepted and dropped. */
const SCROLL_DROPPED = new Set([
  "initialNumToRender", "maxToRenderPerBatch", "windowSize", "updateCellsBatchingPeriod", "removeClippedSubviews",
  "extraData", "getItemLayout", "scrollEventThrottle", "bounces", "alwaysBounceVertical", "alwaysBounceHorizontal",
  "nestedScrollEnabled", "directionalLockEnabled", "automaticallyAdjustContentInsets", "contentInsetAdjustmentBehavior",
])
/** RN `role` values that zn has (accessibilityRole), by RN name. */
const RN_ROLES: Record<string, string> = {
  button: "button", header: "header", heading: "header", image: "image", img: "image", link: "link", text: "text",
  switch: "switch", checkbox: "checkbox", none: "none", presentation: "none",
}
/** What to use for RN components that @zero-native/ui doesn't have, in the build error. */
const RN_MISSING_TAGS: Record<string, string> = {
  SafeAreaView: "delete it and set the route option `safeArea` (for a coloured header, use insets().top)",
  KeyboardAvoidingView: 'delete it: the route option `keyboard: "resize"` (the default) keeps fields above the keyboard',
  ScrollView: "use <Scroll>",
  TextInput: "use <TextField>",
  SectionList: "flatten the sections into one <List> data array with header items",
  ImageBackground: "put an <Image> and the content in a <Stack>",
}
// Events whose payload is JSON from native, handed over as RN's event object: `(e) => e.nativeEvent.layout.width`.
const NATIVE_EVENT_EVENTS = new Set(["onLoad", "onError", "onLayout"])
const IMAGE_EVENTS = new Set(["onLoad", "onError", "onLoadEnd"])
// React Native Modal props that do nothing on Android: accepted and dropped, so a Modal ports as it is.
const MODAL_IOS_ONLY = new Set(["presentationStyle", "hardwareAccelerated", "supportedOrientations", "onOrientationChange"])
/** RN's other autoComplete names for the same Android autofill hint (registry 17, R36). */
const AUTOCOMPLETE_ALIASES: Record<string, string> = {
  "one-time-code": "sms-otp", "name-given": "given-name", "name-family": "family-name", "current-password": "password",
  "password-new": "new-password", "name-middle-initial": "name-middle",
}
// React Native StatusBar props that zn doesn't need: accepted and dropped. `translucent`: each route's safeArea decides
// whether a screen draws under the bar; `animated` and the iOS ones change nothing on Android.
const STATUS_BAR_DROPPED = new Set(["animated", "translucent", "networkActivityIndicatorVisible", "showHideTransition"])

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
/**
 * What else a part can have (docs/svg.md §9, registry 13): transforms around the part's own centre (viewBox units,
 * degrees), "draw the line" trims (0–1 of its length), and its own animate / paused / replay. Static or runtime.
 */
const PART_MOTION = [
  "rotate", "scale", "scaleX", "scaleY", "translateX", "translateY", "trimStart", "trimEnd", "trimOffset",
  "animate", "paused", "replay",
] as const
/**
 * What a part of an .svg file can also set (registry 13, docs/svg.md §16): the stroke width and dash offset of the
 * strokes inside it (viewBox units). Not on inline elements: there strokeWidth is the SVG attribute.
 */
const FILE_PART_PROPS = ["strokeWidth", "dashOffset"] as const
const PART_ANIMATABLE = [
  "opacity", "fill", "stroke", "rotate", "scale", "scaleX", "scaleY", "translateX", "translateY", "trimStart", "trimEnd", "trimOffset",
  "strokeWidth", "dashOffset",
]
const PART_TURNS = ["rotate", "scale", "scaleX", "scaleY"]
/** Props of the Svg node itself (`.svg` component or inline <Svg>), besides style and the SVG content. */
const SVG_NODE_PROPS = [
  "color", "autoMirror", "accessibilityLabel", "accessibilityHint", "accessibilityHidden", "accessibilityRole", "paused", "replay",
]

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
  // An event handler: a function written in place stays as it is; anything else (`props.onPress`, `cond ? f : undefined`)
  // is read when the event comes, and an undefined one does nothing, as in React Native (core view.ts latest()).
  const isInPlaceFunction = (e: ts.Expression) => {
    const u = unwrap(e)
    return ts.isArrowFunction(u) || ts.isFunctionExpression(u)
  }
  // A handler made by a call (`once(pay)`, `debounce(submit)`, `tapped("x")`) is made once, when the element mounts,
  // and kept: making it again on every tap would reset what it remembers, so a once / double-tap guard would do nothing.
  const isHandlerCall = (e: ts.Expression) => ts.isCallExpression(unwrap(e))
  const handlerCode = (e: ts.Expression, b: Builder) => {
    if (isInPlaceFunction(e)) return text(e)
    if (!isHandlerCall(e)) return `${RUNTIME}.latest(() => (${text(e)}))`
    const h = `__zh${b.events}_${b.binds.length}`
    b.binds.push(`const ${h} = (${text(e)});`)
    return `${RUNTIME}.latest(() => ${h})`
  }

  const uiImports = new Set<string>()
  /**
   * The tags of the elements whose children are being compiled now, innermost last (fragments add none). A branch
   * (`{c && <X/>}`) or a `.map` row is compiled while its parent is on this list, so it is checked against the
   * element it is drawn in. A component's root isn't: its parent is in another function (RN-compat sweep P0.4).
   */
  const parents: string[] = []
  /** True while the style of a <View> is read: its flexDirection picked Row or Column (viewTag) and is dropped. */
  let flexDirectionOk = false
  /** The style objects whose start / end keys came from RN's left / right (so a written start / end beats them). */
  const rnAliased = new WeakMap<object, Set<string>>()
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
  const isRnTag = (tag: string) => tag in RN_TAGS && uiImports.has(tag) && !userComponents.has(tag)
  const isIntrinsic = (tag: string) => (tag in Component && tag !== "Anchor" && !userComponents.has(tag)) || isRnTag(tag)
  const isSvgFile = (tag: string) => svgImports.has(tag)
  /** An SVG element name (Path, Circle, ...) imported from @zero-native/ui: only valid inside <Svg>. */
  const isSvgChild = (tag: string) => tag in SVG_TAGS && !(tag in Component) && uiImports.has(tag) && !userComponents.has(tag)
  /**
   * A tag imported from @zero-native/ui that zn doesn't have (`<SafeAreaView>`): the import is removed, so it would
   * be a call of a missing function, a crash at run time. A build error instead (RN-compat sweep, guide notes §56).
   */
  const notInUiCheck = (node: ts.Node, tag: string) => {
    if (!uiImports.has(tag) || userComponents.has(tag) || isIntrinsic(tag) || isSvgChild(tag) || tag === "RefreshControl") return
    fail(node, `<${tag}> is not in @zero-native/ui: ${RN_MISSING_TAGS[tag] ?? "see docs/rn-compatibility.md for what to use"}`)
  }

  // An imported SVG is a build-time name: only `<Name ... />` is allowed (docs/svg.md §4.1).
  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n) || !svgImports.has(n.text)) return
    const p = n.parent
    if (ts.isImportClause(p) || ts.isImportSpecifier(p)) return
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) return
    fail(n, `${n.text} is an SVG file, which is compiled at build time: use it as JSX (<${n.text} />, or icon={<${n.text} />}), not as a value`)
  })

  // ---- JSX in variables (guide notes §47) ---------------------------------------------------------------------
  // `const x = <A/>` / `const x = c ? <A/> : null` (module level or in a component body; also a `let` never assigned
  // again). JSX is compiled at build time, so x is not a value at runtime: each place that uses x in JSX gets its own
  // copy of the JSX (as React: one element shown twice is two instances), and the declaration leaves the JS.
  interface JsxBinding {
    name: string
    decl: ts.VariableDeclaration
    stmt: ts.VariableStatement
    /** The block (or the file) that declares it: where its name is looked up. */
    scope: ts.Node
    init: ts.Expression
    used: boolean
    free?: Array<{ name: string; at: ts.Identifier }>
  }
  const jsxBindings = new Map<string, JsxBinding[]>()
  const consumed = new Set<ts.Identifier>()
  const collectBindings = (stmt: ts.Statement, scopeNode: ts.Node) => {
    if (!ts.isVariableStatement(stmt)) return
    const list = stmt.declarationList
    const jsxDecls = list.declarations.filter((d) => ts.isIdentifier(d.name) && d.initializer && isJsxValue(d.initializer))
    if (jsxDecls.length === 0) return
    if (jsxDecls.length !== list.declarations.length) fail(stmt, "put a JSX const on its own line: const x = <A />")
    if (!(list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) fail(stmt, "use const for JSX: const x = <A />")
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      fail(stmt, "JSX can't be exported as a value (it is compiled at build time): export a component instead, " +
        "export function Header() { return <Title /> }")
    }
    for (const d of jsxDecls) {
      const name = (d.name as ts.Identifier).text
      const bnd: JsxBinding = { name, decl: d, stmt, scope: scopeNode, init: d.initializer!, used: false }
      jsxBindings.set(name, [...(jsxBindings.get(name) ?? []), bnd])
    }
  }
  for (const stmt of sf.statements) collectBindings(stmt, sf)
  for (const { fn } of candidates) {
    if (!fn.body || !ts.isBlock(fn.body)) continue
    const visit = (block: ts.Node) => {
      ts.forEachChild(block, function walk(n): void {
        if (ts.isFunctionLike(n) || ts.isClassLike(n)) return
        if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
          for (const s of n.statements) collectBindings(s, n)
        }
        ts.forEachChild(n, walk)
      })
    }
    for (const s of fn.body.statements) collectBindings(s, fn.body)
    visit(fn.body)
  }

  // ---- Components ---------------------------------------------------------------------------------------------
  const rootsOf: Record<string, ComponentRoots> = {}
  const where = (n: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
    return `${fileName}:${line + 1}:${character + 1}`
  }
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  /**
   * React habits that compile but go wrong (guide notes §61, second-opinions 144). A zn component's body runs once,
   * when it mounts (as in SolidJS; React runs it on every render). So a value the body reads is read once, and the
   * screen keeps it. Each of these is a build error with the fix, so it can't reach a phone:
   * - an async component (it gives a Promise, not its JSX);
   * - destructured props, `function Row({ title })` (each prop read once);
   * - an early return on a value that can change, `if (loading()) return <Spinner />` (the branch is picked once);
   * - a body value from props or a signal used in the JSX, `const missing = p.amount <= 0` (worked out once).
   * "Can change" means: reads the props object, or calls a function with no arguments (how a signal is read) other
   * than a `use...()` helper. Reads inside a nested function (a handler, `computed(() => ...)`) are fine: they run later.
   */
  // Names in this file made with a zn function that gives a Signal: signal, computed, restorableSignal (nav.ts) and
  // persistedSignal (storage.ts). Their start value is read once on purpose; the name itself is read live (R52).
  const signalNames = new Set<string>()
  forEachDescendant(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer) return
    const init = unwrap(n.initializer)
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && /^(signal|computed|restorableSignal|persistedSignal)$/.test(init.expression.text)) {
      signalNames.add(n.name.text)
    }
  })
  /**
   * Async is always an error. The other traps go to the app build (plugin.ts checkOnceTraps), which knows the screens:
   * a screen's props are its route's params, which don't change while it is open, so a trap that only reads props is
   * fine in a screen. A child's props can change.
   */
  /**
   * Where each user component is used with props that can change while it stays mounted (for the props traps). A
   * use inside a function (a `.map` row, a List's renderItem) isn't recorded: a row mounts again when its item changes,
   * so its body starts fresh (checked 2026-11-05). `signal`: a prop reads a signal (a call with no arguments);
   * `parentProps`: a prop passes on the parent's props, so it can change if the parent's can (plugin.ts follows it).
   */
  const propUses: PropUse[] = []
  {
    const fnName = new Map<ts.Node, string>(candidates.map((c) => [c.fn, c.name]))
    forEachDescendant(sf, (n) => {
      if (!ts.isJsxSelfClosingElement(n) && !ts.isJsxOpeningElement(n)) return
      const tag = n.tagName.getText(sf)
      if (!userComponents.has(tag) || isIntrinsic(tag)) return
      let parentFn: ts.Node | undefined
      let nested = false
      for (let a: ts.Node = n.parent; a; a = a.parent) {
        if (fnName.has(a)) { parentFn = a; break }
        if (ts.isFunctionLike(a)) nested = true
      }
      if (!parentFn || nested) return
      const pfn = parentFn as ts.FunctionLikeDeclaration
      const parentProps = pfn.parameters[0] && ts.isIdentifier(pfn.parameters[0].name) ? pfn.parameters[0].name.text : undefined
      let live: PropUse["live"] = null
      for (const attr of n.attributes.properties) {
        const e = ts.isJsxSpreadAttribute(attr) ? attr.expression : attr.initializer
        if (!e) continue
        const check = (x: ts.Node) => {
          if (live === "signal") return
          if (ts.isCallExpression(x) && x.arguments.length === 0) {
            const c = x.expression
            const callee = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isIdentifier(c) ? c.text : ""
            const obj = ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : ""
            if (callee && !NOT_SIGNAL_METHODS.has(callee) && !NOT_SIGNAL_OBJECTS.has(obj) && !/^use[A-Z]/.test(callee)) live = "signal"
          } else if (ts.isIdentifier(x) && x.text === parentProps && live === null) {
            live = "parentProps"
          }
        }
        check(e)
        forEachDescendant(e, check, /* stopAtFunctions */ true)
      }
      if (live) propUses.push({ component: tag, parent: fnName.get(parentFn)!, live })
    })
  }

  function checkOnceTraps(name: string, fn: ts.FunctionLikeDeclaration, jsxRoots: ts.Expression[], otherReturns: ts.Node[]): OnceTrap[] {
    const traps: OnceTrap[] = []
    if (ts.canHaveModifiers(fn) && ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      fail(fn, `${name} is an async function: a component can't wait (it would give a Promise, not its JSX). Load ` +
        `the data in an effect or a store, keep it in a signal, and show {data() ? <Content /> : <Spinner />}`)
    }
    const param = fn.parameters[0]
    if (param && (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name))) {
      traps.push({ at: where(param), fromProps: true, message: `${name} takes its props destructured: a component's ` +
        `body runs once, so each prop is read once and never updates. Write ${name}(p) and read p.title where you ` +
        `use it (in the JSX or a handler)` })
    }
    const propsName = param && ts.isIdentifier(param.name) ? param.name.text : undefined
    const body = fn.body
    if (!body || !ts.isBlock(body)) return traps
    // Body names worked out from a value that can change → their line, and whether only props were read.
    const live = new Map<string, { line: number; props: boolean }>()

    /** The first read in [n] of a value that can change (not inside a nested function), or undefined. */
    const liveRead = (n: ts.Node): { node: ts.Node; props: boolean } | undefined => {
      let found: { node: ts.Node; props: boolean } | undefined
      const check = (x: ts.Node) => {
        if (found) return
        if (ts.isIdentifier(x)) {
          const parent = x.parent
          const isName = (ts.isPropertyAccessExpression(parent) && parent.name === x) ||
            (ts.isPropertyAssignment(parent) && parent.name === x)
          if (!isName && x.text === propsName) found = { node: x, props: true }
          else if (!isName && live.has(x.text)) found = { node: x, props: live.get(x.text)!.props }
        } else if (ts.isCallExpression(x) && x.arguments.length === 0) {
          // A signal read: `store.amount()` (a method on an object, not a built-in one), or `loading()` where loading
          // is a signal / computed made in this file. A factory (`lottieController()`) or an imported bare function
          // isn't one: zn can't tell them apart, so those aren't checked (guide notes §61).
          const e = x.expression
          if (ts.isPropertyAccessExpression(e)) {
            const obj = ts.isIdentifier(e.expression) ? e.expression.text : ""
            // `p.title.trim()` reads props: that counts as props, found above (the identifier p comes first).
            if (!NOT_SIGNAL_METHODS.has(e.name.text) && !NOT_SIGNAL_OBJECTS.has(obj) && !/^use[A-Z]/.test(e.name.text) &&
              obj !== propsName) found = { node: x, props: false }
          } else if (ts.isIdentifier(e) && signalNames.has(e.text)) {
            found = { node: x, props: false }
          }
        }
      }
      check(n)
      if (!(ts.isFunctionLike(n))) forEachDescendant(n, check, /* stopAtFunctions */ true)
      return found
    }
    const what = (r: ts.Node) => {
      const t = r.getText(sf)
      return `"${t.length > 40 ? t.slice(0, 40) + "…" : t}"`
    }

    // An early return: more than one return, and one sits under an `if` / `switch` on a value that can change.
    const returns = [...jsxRoots.map((r) => r.parent), ...otherReturns]
    if (returns.length > 1) {
      outer: for (const ret of returns) {
        for (let a: ts.Node = ret; a && a !== body; a = a.parent) {
          const cond = ts.isIfStatement(a.parent) && a.parent.expression !== a ? a.parent.expression
            : ts.isCaseClause(a.parent) || ts.isDefaultClause(a.parent) ? a.parent.parent.parent.expression
            : undefined
          const r = cond && liveRead(cond)
          if (r) {
            traps.push({ at: where(ret), fromProps: r.props, message: `${name} returns early here, on ` +
              `${what(cond)} (line ${lineOf(cond)}), which can change. A component's body runs once, so this ` +
              `choice is made once and the screen keeps the first branch. Choose in one return instead: ` +
              `return loading() ? <Spinner /> : <Content /> (a child), or put only the changing piece in a branch: ` +
              `return <Column>{loading() ? <Spinner /> : null}...</Column>` })
            break outer
          }
        }
      }
    }

    // A body value from a value that can change, shown by the JSX: it was worked out once. Uses inside a handler are
    // not checked: keeping a value from mount (`const controller = p.controller ?? make()`) is a real pattern there.
    for (const stmt of body.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const d of stmt.declarationList.declarations) {
        if (!d.initializer || isJsxValue(d.initializer)) continue
        if (ts.isIdentifier(d.name) && signalNames.has(d.name.text)) continue // a signal / computed: read live
        let hasJsx = false
        forEachDescendant(d.initializer, (x) => void (isJsx(x) && (hasJsx = true)))
        if (hasJsx) continue
        const r = liveRead(d.initializer)
        if (!r) continue
        const names: string[] = []
        const collect = (b: ts.BindingName) => {
          if (ts.isIdentifier(b)) names.push(b.text)
          else for (const el of b.elements) if (!ts.isOmittedExpression(el)) collect(el.name)
        }
        collect(d.name)
        for (const nm of names) live.set(nm, { line: lineOf(d), props: r.props })
      }
    }
    if (live.size === 0) return traps
    const seen = new Set<string>()
    for (const root of jsxRoots) {
      forEachDescendant(root, (x) => {
        if (!ts.isIdentifier(x) || !live.has(x.text) || seen.has(x.text)) return
        const parent = x.parent
        if ((ts.isPropertyAccessExpression(parent) && parent.name === x) || ts.isJsxAttribute(parent)) return
        // `store.items()`: the body value holds an object (made from a prop, say) whose method is read live. Fine.
        if (ts.isPropertyAccessExpression(parent) && parent.expression === x && ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent) return
        seen.add(x.text)
        const l = live.get(x.text)!
        traps.push({ at: where(x), fromProps: l.props, message: `${x.text} is worked out once, when ${name} mounts ` +
          `(line ${l.line}), from a value that can change, so the screen keeps its first value. Work it out where ` +
          `it is shown, in the JSX ({p.amount <= 0 ? "Missing" : "Applied"}), or make it live: ` +
          `const ${x.text} = computed(() => ...), and show ${x.text}()` })
      }, /* stopAtFunctions */ true)
    }
    return traps
  }
  for (const { name, fn } of candidates) {
    const body = fn.body
    if (!body) continue
    const roots: ts.Expression[] = []
    const others: ts.Node[] = []
    if (ts.isBlock(body)) {
      forEachDescendant(body, (n) => {
        if (!ts.isReturnStatement(n)) return
        if (n.expression && isJsxValue(n.expression)) roots.push(n.expression)
        else others.push(n)
      }, /* stopAtFunctions */ true)
    } else if (isJsxValue(body)) {
      roots.push(body)
    }
    const info: ComponentRoots = { templates: [], at: [], others: [], traps: roots.length > 0 ? checkOnceTraps(name, fn, roots, others) : [] }
    for (const r of roots) {
      const v = seeThrough(r)
      const compiled = isJsx(v) ? compileRoot(v as JsxNode) : valueTemplate(v, 0)
      edits.push({ start: r.getStart(sf), end: r.getEnd(), text: compiled.code, at: v.getStart(sf) })
      // -1: returns another component (<Other />), so its View carries that component's template.
      info.templates.push(compiled.templateId ?? -1)
      info.at.push(where(r))
      if (compiled.templateId !== null && !(name in components)) components[name] = compiled.templateId
    }
    if (roots.length > 0) {
      info.others = others.map(where)
      rootsOf[name] = info
    }
  }

  // Every use of a JSX variable must have been compiled: anything else would read a name that is gone from the JS.
  const allBindings = [...jsxBindings.values()].flat()
  const dead = allBindings.filter((bnd) => !bnd.used)
  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n) || !jsxBindings.has(n.text) || !isReference(n)) return
    const bnd = bindingOf(n)
    if (!bnd || n === bnd.decl.name) return
    if (isAssigned(n)) {
      fail(n, `${bnd.name} holds JSX and is assigned again: JSX is compiled at build time, so pick with one ternary ` +
        `instead, const ${bnd.name} = cond ? <A /> : <B /> (use null for "nothing")`)
    }
    if (consumed.has(n) || dead.some((d) => inside(n, d.init))) return
    const p = n.parent
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) {
      fail(n, `${bnd.name} holds JSX, not a component: show it with {${bnd.name}}, or make it a component (a function)`)
    }
    fail(n, `${bnd.name} holds JSX, which is compiled at build time, so it isn't a value at runtime: use it only in ` +
      `JSX ({${bnd.name}}, icon={${bnd.name}}, return ${bnd.name}). To pass a piece of screen around, make it a component`)
  })
  for (const bnd of allBindings) {
    if (!edits.some((e) => e.start === bnd.stmt.getStart(sf))) edits.push({ start: bnd.stmt.getStart(sf), end: bnd.stmt.getEnd(), text: "" })
  }

  // Any JSX left outside a component's return is unsupported.
  const replaced = edits.filter((e) => e.text !== "")
  forEachDescendant(sf, (n) => {
    if (!isJsx(n) || replaced.some((e) => n.getStart(sf) >= e.start && n.getEnd() <= e.end)) return
    if (allBindings.some((bnd) => inside(n, bnd.init))) return
    fail(n, outsideHint(n))
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
  return { code, components, roots: rootsOf, propUses, map }

  // ---- JSX variables --------------------------------------------------------------------------------------------

  /** The JSX variable [id] names where it is written (a parameter or local of the same name hides it), if any. */
  function bindingOf(id: ts.Identifier): JsxBinding | undefined {
    const list = jsxBindings.get(id.text)
    if (!list) return undefined
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      if (ts.isSourceFile(n) || declaredIn(n, id.text) !== undefined) return list.find((bnd) => bnd.scope === n)
    }
    return undefined
  }

  /** JSX, a JSX variable, or `c ? X : Y` / `c && X` whose branches are those (or null), with JSX on at least one side. */
  function isJsxValue(e: ts.Expression): boolean {
    const u = unwrap(e)
    if (isJsx(u)) return true
    if (ts.isIdentifier(u)) return bindingOf(u) !== undefined
    if (ts.isConditionalExpression(u)) {
      const t = isJsxValue(u.whenTrue)
      const f = isJsxValue(u.whenFalse)
      return (t || f) && (t || isNullish(u.whenTrue)) && (f || isNullish(u.whenFalse))
    }
    if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isJsxValue(u.right)
    return false
  }

  /**
   * [e] with a JSX variable replaced by the JSX it holds (followed through variables that hold variables). The use is
   * checked: each name the JSX reads must mean the same thing here as where the JSX is written.
   */
  function seeThrough(e: ts.Expression): ts.Expression {
    const u = unwrap(e)
    if (!ts.isIdentifier(u)) return u
    const bnd = bindingOf(u)
    if (!bnd) return u
    consumed.add(u)
    bnd.used = true
    for (const f of freeNames(bnd, new Set())) {
      for (let n: ts.Node | undefined = u.parent; n && n !== bnd.scope; n = n.parent) {
        if (declaredIn(n, f.name) === undefined) continue
        const { line } = sf.getLineAndCharacterOfPosition(f.at.getStart(sf))
        fail(u, `${bnd.name} is JSX that reads "${f.name}" (line ${line + 1}), but here "${f.name}" is a different ` +
          `name (a parameter or local with the same name), so this copy would read the wrong value: rename one of them`)
      }
    }
    return seeThrough(bnd.init)
  }

  /** The names a JSX variable's JSX reads from outside itself (also through the JSX variables it uses). */
  function freeNames(bnd: JsxBinding, seen: Set<JsxBinding>): Array<{ name: string; at: ts.Identifier }> {
    if (bnd.free) return bnd.free
    seen.add(bnd)
    const out: Array<{ name: string; at: ts.Identifier }> = []
    const visit = (n: ts.Node) => {
      if (ts.isTypeNode(n)) return
      if (ts.isIdentifier(n) && isReference(n)) {
        let internal = false
        for (let p: ts.Node | undefined = n.parent; p && !internal; p = p === bnd.init ? undefined : p.parent) {
          if (declaredIn(p, n.text) !== undefined) internal = true
        }
        if (!internal) {
          out.push({ name: n.text, at: n })
          const inner = bindingOf(n)
          if (inner && !seen.has(inner)) out.push(...freeNames(inner, seen))
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(bnd.init)
    bnd.free = out
    return out
  }

  /** `c ? <A/> : <B/>` (or `c && <A/>`) as a whole View: a Fragment holding one anchor that shows the branch. */
  function valueTemplate(e: ts.Expression, depth: number): { code: string; templateId: number } {
    return compileTemplate(e, depth, (b) => {
      b.nodes++
      return el("Fragment", {}, anchor(e, b))
    })
  }

  /** A better message for JSX in a place the compiler doesn't take. */
  function outsideHint(n: ts.Node): string {
    let at: ts.Node = n
    while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isConditionalExpression(at.parent) ||
      (ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) {
      at = at.parent
    }
    const p = at.parent
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) &&
      ["push", "unshift", "concat", "splice"].includes(p.expression.name.text)) {
      return "JSX can't be collected in an array (it is compiled at build time): show a list with .map in JSX, " +
        "{items.map((it) => <Row key={it.id} ... />)}"
    }
    if (ts.isArrayLiteralExpression(p)) {
      return "JSX can't go in an array (it is compiled at build time): write each element in place, or use " +
        "{items.map((it) => <Row key={it.id} ... />)} over data"
    }
    if (ts.isBinaryExpression(p) && p.right === at && isAssignmentOp(p.operatorToken.kind)) {
      return "JSX can't be assigned to a variable later (it is compiled at build time): pick with one ternary, " +
        "const x = cond ? <A /> : <B /> (use null for \"nothing\")"
    }
    let fn: ts.Node | undefined = n.parent
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
    const fnName = fn && (
      (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name) ? fn.name.text
      : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text
      : undefined)
    if (fnName && !isCapitalized(fnName)) {
      const cap = fnName[0].toUpperCase() + fnName.slice(1)
      return `${fnName} returns JSX but isn't a component: give it a capital name (function ${cap}(props) ...) and ` +
        `use it as <${cap} ... />, or write the JSX in place (a const works too: const x = <A />)`
    }
    return "JSX works only in a component (a capitalised module-level function): as what it returns, as a child, " +
      "as a prop, or in a const used in those places"
  }

  // ---- Templates ----------------------------------------------------------------------------------------------

  /**
   * A root JSX expression → code that produces a View; plus its template id (null for a bare user component).
   * A fragment `<>...</>` becomes a template whose root is a Fragment node: its children join the parent's layout.
   */
  function compileRoot(jsx: JsxNode, depth = 0, allowKey = false): { code: string; templateId: number | null } {
    if (!ts.isJsxFragment(jsx)) {
      const tag = tagName(jsx)
      if (isSvgChild(tag)) fail(jsx, `<${tag}> is an SVG element: it only works inside <Svg>`)
      notInUiCheck(jsx, tag)
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
    // `<Card>{content}</Card>` with `const content = <A/>`: the same as writing <A/> there.
    const only = real.length === 1 && ts.isJsxExpression(real[0]) ? real[0].expression : undefined
    if (only && ts.isIdentifier(unwrap(only))) {
      const v = seeThrough(only)
      if (isJsx(v)) return compileRoot(v as JsxNode, depth).code
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
    const written = tagName(node)
    // RN names (P1): <View> is a Column or a Row; <FlatList> a List; the Touchables a Pressable; ActivityIndicator a Spinner.
    const rn = isRnTag(written) ? written : null
    const tag = rn === "View" ? viewTag(node) : rn ? RN_TAGS[rn] : written
    if (isSvgFile(tag)) return svgFileElement(node, b, allowKey)
    if (!isIntrinsic(tag)) fail(node, `"${tag}" is not a zero-native component`)
    if (tag === "Fragment") fail(node, "write a fragment as <>...</>")
    if (tag === "Svg") return inlineSvgElement(node, b, allowKey)
    if (tag === "SvgPart") fail(node, "<SvgPart> is made by the compiler: use parts={{ id: { fill } }} on the SVG")
    if (tag === "List") return listElement(node, b)
    if (tag === "NativeView") return nativeViewElement(node, b, allowKey)
    if (tag === "OtpInput") return otpInputElement(node, b, allowKey)
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    // <TextField value={...} onChangeText={...}>: the handler is bound after the loop, wrapped by textInput().
    let changeText: { ev: string; handler: string } | null = null
    let valueSlot: { s: string; expr: ts.Expression } | null = null
    let contentStyle: ts.JsxAttribute | null = null
    const rnLater: RnLater = {}

    // A failed check stops the whole file's compile, so no try / finally is needed to reset it.
    flexDirectionOk = rn === "View"
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      let name = a.name.getText(sf)
      const renamed = rnAttribute(tag, rn, name, a, props, b, rnLater)
      if (renamed === true) continue
      if (renamed) name = renamed
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
      if (name === "refreshControl") {
        refreshControl(a, props, b)
        continue
      }
      if (name === "contentContainerStyle") {
        if (tag !== "Scroll") fail(a, "contentContainerStyle works only on <Scroll> and <List>")
        contentStyle = a // after the loop, so it can be checked against style's padding
        continue
      }
      if (name in EventKind) {
        if (!init || !ts.isJsxExpression(init) || !init.expression) fail(a, `${name} needs a function`)
        const ev = `e${b.events++}`
        ;(props as any)[name] = eventRef(ev)
        const handlerExpr = (init as ts.JsxExpression).expression!
        const handler = handlerCode(handlerExpr, b)
        if (IMAGE_EVENTS.has(name) && tag !== "Image") fail(a, `${name} works only on <Image>`)
        if (PRESS_EVENTS.has(name) && tag !== "Pressable") {
          fail(a, `${name} works only on <Pressable>: on <${tag}> the tap would do nothing. Wrap it: ` +
            `<Pressable ${name}={...}><${tag} .../></Pressable>`)
        }
        tagPropCheck(tag, name, a)
        if (tag === "TextField" && name === "onChangeText") changeText = { ev, handler }
        else if (NATIVE_EVENT_EVENTS.has(name)) {
          // A name no app uses: the handler's own `p` or `e` must not be hidden by this wrapper.
          b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, (__znPayload) => (${handler})({ nativeEvent: JSON.parse(__znPayload) }));`)
        } else b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${handler});`)
        if (name === "onLongPress" && !isInPlaceFunction(handlerExpr)) {
          // Registry 14: native waits for a long press only while the prop holds a handler, so a wrapper that passes
          // `onLongPress={props.onLongPress}` without one still gets onPress for a long hold, as in React Native.
          const s = `s${b.slots++}`
          props.hasLongPress = slotRef(s, null) as never
          b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => (${text(handlerExpr)}) != null, 0);`)
        }
        continue
      }
      // textContentType is iOS's autofill hint: RN ignores it on Android, and so does zn (autoComplete is the one).
      if (IGNORED_STYLE_KEYS.has(name) || (tag === "Modal" && MODAL_IOS_ONLY.has(name)) || (tag === "TextField" && name === "textContentType")) continue
      if ((tag === "StatusBar" || tag === "NavigationBar") && STATUS_BAR_DROPPED.has(name)) continue
      if (!(name in Prop)) fail(a, `unknown prop "${name}" on <${tag}>`)
      tagPropCheck(tag, name, a)
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
    flexDirectionOk = false
    rnFinish(tag, rn, props, b, rnLater, opening)
    if (contentStyle) contentContainerStyle(contentStyle, props, b)
    if ("hitSlop" in props && tag !== "Pressable") fail(opening, "hitSlop works only on <Pressable> (the element that takes the tap)")
    stackChildCheck(props, opening)
    if ((tag === "StatusBar" || tag === "NavigationBar") && ts.isJsxElement(node) && node.children.some((k) => !(ts.isJsxText(k) && k.text.trim() === ""))) {
      fail(node, `<${tag}> takes no children`)
    }
    const refresh = REFRESH_PROPS.filter((k) => k in props)
    if (refresh.length > 0 && (tag !== "Scroll" || props.horizontal === true)) {
      fail(opening, `${refresh[0]}: pull to refresh works only on a vertical <Scroll> or a <List>`)
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
      parents.push(tag)
      try {
        children = childList(kids, b)
      } finally {
        parents.pop()
      }
    }
    return el(tag as keyof typeof Component, props, ...children)
  }

  // ---- React Native names (RN-compat sweep P1, 2026-11-05) --------------------------------------------------------

  /** What an RN prop leaves for after the attribute loop (rnFinish). */
  interface RnLater {
    underlayColor?: unknown
    activeOpacity?: unknown
    animating?: ts.Expression | false
  }

  /** <View>: a <Row> when its style says flexDirection: "row" (known at build time), else a <Column>. */
  function viewTag(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    const attr = opening.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "style") as
      | ts.JsxAttribute
      | undefined
    const init = attr?.initializer
    const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
    // The last flexDirection written wins, as in a style array. NOT_STATIC: written, but not known at build time.
    const flat = (x: unknown): unknown =>
      Array.isArray(x) ? x.reduce((acc: unknown, y) => flat(y) ?? acc, undefined)
      : x && typeof x === "object" ? (x as Record<string, unknown>).flexDirection : undefined
    const find = (e: ts.Expression): unknown => {
      const v = fold(e, scope)
      if (v !== NOT_STATIC) return flat(v)
      const u = unwrap(e)
      let found: unknown = undefined
      if (ts.isArrayLiteralExpression(u)) {
        for (const item of u.elements) found = find(item) ?? found
      } else if (ts.isObjectLiteralExpression(u)) {
        for (const p of u.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/^["']|["']$/g, "") === "flexDirection") {
            found = fold(p.initializer, scope)
          } else if (ts.isSpreadAssignment(p)) found = find(p.expression) ?? found
        }
      }
      return found
    }
    const dir = expr ? find(expr) : undefined
    if (dir === NOT_STATIC) {
      fail(attr!, "flexDirection on <View> must be known at build time: zero-native makes it a <Row> or a <Column>")
    }
    if (dir === undefined || dir === "column") return "Column"
    if (dir === "row") return "Row"
    return fail(attr!, `flexDirection "${String(dir)}" isn't supported: use "row" or "column" (for a reversed order, reverse the children)`)
  }

  function unknownStyleKey(k: string): string {
    if (k === "flexDirection") {
      return 'unknown style key "flexDirection": pick the element instead, <Row> or <Column> (or <View> from ' +
        "@zero-native/ui, which picks one from a flexDirection known at build time). A Pressable or a Touchable lays " +
        "out its children as a column: put a <Row> inside it"
    }
    return `unknown style key "${k}"`
  }

  /**
   * An RN style key → the zn key, or null when it is dropped (it changes nothing in zn) or already set here. [value]
   * gives the folded value (NOT_STATIC if it is known only at runtime). Keys zn has are returned as they are.
   */
  function rnStyleKey(k: string, value: () => unknown, props: Record<string, unknown>, at: ts.Node): string | null {
    const known = () => {
      const v = value()
      if (v === NOT_STATIC) fail(at, `${k} must be known at build time`)
      return v
    }
    if (k === "flexDirection" && flexDirectionOk) return null // <View>: it chose Row or Column (viewTag)
    let aliased = rnAliased.get(props)
    const target = RN_STYLE_RENAMES[k]
    if (target) {
      // RN: a start / end key beats left / right, whichever is written first.
      if (!aliased) rnAliased.set(props, (aliased = new Set()))
      if (target in props && !aliased.has(target)) return null
      aliased.add(target)
      return target
    }
    aliased?.delete(k) // a start / end key written after left / right replaces it
    switch (k) {
      case "transformOrigin": {
        // RN's keywords and percents → "x y" fractions (registry 20; ask R11). Native turns scale / rotate around it.
        const origin = transformOriginOf(known())
        if (typeof origin !== "string") return fail(at, origin.error)
        props.transformOrigin = origin
        return null
      }
      case "flexGrow": {
        // RN's flexGrow: n shares the free space like zn's flex: n. (Two growing children with different content
        // widths split it a little differently: RN shares only what is left after their content.)
        const v = known()
        if (typeof v !== "number" || v < 0) fail(at, "flexGrow needs a number, 0 or more")
        if (v !== 0 && !("flex" in props)) props.flex = v
        return null
      }
      case "flexShrink":
        // zn never shrinks a child below its size (RN's default, flexShrink: 0); a Text in a Row still wraps.
        if ([0, 1].includes(known() as number)) return null
        return fail(at, "flexShrink: only 0 or 1 (both dropped: zero-native doesn't shrink children, and a Text in a Row wraps)")
      case "flexBasis":
        if (([0, "auto"] as unknown[]).includes(known())) return null
        return fail(at, 'flexBasis: only 0 or "auto" (dropped); give the element a width or a flex instead')
      case "rowGap":
      case "columnGap": {
        // The gap along the element's own direction (rnFinish); the other one has no effect without wrapping.
        const v = known()
        if (typeof v !== "number" || v < 0) fail(at, `${k} needs a number of dp, 0 or more`)
        props[k === "rowGap" ? "__rowGap" : "__columnGap"] = v
        return null
      }
      case "width":
      case "height":
        if (value() === "auto") return null // zn's default: the size of the content
        return k
    }
    return k
  }

  function rnTextAlign(v: unknown, at: ts.Node): unknown {
    // left / right are start / end: the same in a left-to-right app (they flip in right-to-left, unlike RN's).
    if (v === "left" || v === "auto") return "start"
    if (v === "right") return "end"
    if (v === "justify") fail(at, 'textAlign: "justify" isn\'t supported (use "start")')
    return v
  }

  function rnRatio(v: string, at: ts.Node): number {
    const m = /^\s*(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)\s*$/.exec(v)
    if (!m || Number(m[2]) === 0) return fail(at, `aspectRatio "${v}": use a number or "width / height", like "16/9"`)
    return Number(m[1]) / Number(m[2])
  }

  /**
   * One attribute under its RN name. Returns the zn name to use for it, true when it is fully handled here (set, or
   * dropped because it changes nothing in zn), or null when it isn't an RN name.
   */
  function rnAttribute(
    tag: string,
    rn: string | null,
    name: string,
    a: ts.JsxAttribute,
    props: Record<string, unknown>,
    b: Builder,
    later: RnLater,
  ): string | true | null {
    const init = a.initializer
    const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
    const value = (): unknown =>
      init === undefined ? true : ts.isStringLiteral(init) ? init.text : expr ? fold(expr, scope) : NOT_STATIC
    const known = () => {
      const v = value()
      if (v === NOT_STATIC) fail(a, `${name} must be known at build time`)
      return v
    }
    /** {{ key: value }} → each key's expression; other shapes fail. */
    const entries = (what: string): Map<string, ts.Expression> => {
      const o = expr && unwrap(expr)
      if (!o || !ts.isObjectLiteralExpression(o)) return fail(a, `${name} needs an object: ${what}`)
      const out = new Map<string, ts.Expression>()
      for (const p of o.properties) {
        if (!ts.isPropertyAssignment(p)) return fail(p, `${name}: write each key as key: value`)
        out.set(p.name.getText(sf).replace(/^["']|["']$/g, ""), p.initializer)
      }
      return out
    }
    const setFrom = (zn: PropName, e: ts.Expression) => setProp(props, b, zn, e, a)

    // Accessibility, on any element.
    if (name === "aria-label") return "accessibilityLabel"
    if (name === "aria-hidden" || name === "accessibilityElementsHidden") return "accessibilityHidden"
    if (name === "role") {
      const v = known()
      const role = RN_ROLES[String(v)]
      if (!role) fail(a, `role "${String(v)}" has no zero-native role (use ${Object.keys(RN_ROLES).join(", ")})`)
      setStatic(props, "accessibilityRole", role, a)
      return true
    }
    if (name === "importantForAccessibility") {
      const v = known()
      if (v === "auto" || v === "yes") return true
      if (v === "no-hide-descendants") {
        setStatic(props, "accessibilityHidden", true, a)
        return true
      }
      return fail(a, `importantForAccessibility="${String(v)}" isn't supported: "no-hide-descendants" (hide this element ` +
        'and its children, the same as accessibilityHidden) works; "no" (hide only this one) has no match')
    }

    // Text and TextField.
    if (name === "allowFontScaling" && (tag === "Text" || tag === "TextField")) {
      if (known() === false) setStatic(props, "maxFontScale", 1, a)
      return true
    }
    if (name === "ellipsizeMode" && tag === "Text") {
      if (known() === "tail") return true
      return fail(a, 'ellipsizeMode: zero-native always cuts the end of the text ("tail"); other modes aren\'t supported')
    }
    if (name === "placeholderTextColor" && tag === "TextField") return "placeholderColor"

    // Image.
    if (tag === "Image" && name === "source") {
      const o = expr && unwrap(expr)
      if (o && ts.isCallExpression(o) && ts.isIdentifier(o.expression) && o.expression.text === "require") {
        fail(a, 'require(...) images: put the file in the app\'s assets/images folder and write src="asset:images/name.png"')
      }
      const v = value()
      if (v !== NOT_STATIC) {
        if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as { uri?: unknown }).uri !== "string") {
          fail(a, 'source: only {{ uri: "https://..." }} is supported; or write src="..."')
        }
        const extra = Object.keys(v as object).filter((k) => k !== "uri")
        if (extra.length > 0) fail(a, `source: only uri is supported (not ${extra.join(", ")})`)
        setStatic(props, "src", (v as { uri: string }).uri, a)
        return true
      }
      const parts = entries("source={{ uri: url }}")
      if (parts.size !== 1 || !parts.has("uri")) fail(a, "source: only {{ uri }} is supported; or write src={url}")
      setFrom("src", parts.get("uri")!)
      return true
    }
    if (tag === "Image" && name === "resizeMode") {
      const v = known()
      const scale = ({ cover: "cover", contain: "contain", stretch: "fill" } as Record<string, string>)[String(v)]
      if (!scale) fail(a, `resizeMode "${String(v)}" isn't supported (cover, contain, stretch)`)
      setStatic(props, "contentScale", scale, a)
      return true
    }

    // Switch: trackColor={{ false: off, true: on }}.
    if (tag === "Switch" && name === "trackColor" && expr && ts.isObjectLiteralExpression(unwrap(expr))) {
      for (const [k, e] of entries("trackColor={{ false: off, true: on }}")) {
        if (k === "false") setFrom("trackColor", e)
        else if (k === "true") setFrom("activeTrackColor", e)
        else fail(a, `trackColor: only false and true (not ${k})`)
      }
      return true
    }
    if (tag === "Switch" && name === "ios_backgroundColor") return true // iOS only

    // Pressable: android_ripple={{ color, borderless, radius, foreground }}.
    if (tag === "Pressable" && name === "android_ripple") {
      for (const [k, e] of entries("android_ripple={{ color, borderless, radius }}")) {
        if (k === "color") setFrom("rippleColor", e)
        else if (k === "borderless") setFrom("rippleBorderless", e)
        else if (k === "radius") setFrom("rippleRadius", e)
        else if (k !== "foreground") fail(a, `android_ripple: ${k} isn't supported (color, borderless, radius)`)
      }
      return true
    }
    if (rn === "TouchableOpacity" && name === "activeOpacity") return "pressOpacity"
    if (rn === "TouchableHighlight" && (name === "underlayColor" || name === "activeOpacity")) {
      later[name] = known()
      return true
    }

    // ActivityIndicator.
    if (rn === "ActivityIndicator") {
      if (name === "size") {
        const v = known()
        const dp = v === "small" ? 20 : v === "large" ? 36 : v
        if (typeof dp !== "number") fail(a, 'size: "small", "large" or a number of dp')
        setStatic(props, "size", dp, a)
        return true
      }
      if (name === "animating") {
        const v = value()
        if (v === NOT_STATIC) later.animating = expr!
        else if (v === false) later.animating = false
        return true
      }
      if (name === "hidesWhenStopped") {
        if (known() === false) fail(a, "hidesWhenStopped={false} isn't supported: a stopped spinner is hidden")
        return true
      }
    }

    // ScrollView / FlatList props.
    if (tag === "Scroll" || tag === "List") {
      if (SCROLL_DROPPED.has(name)) return true
      if (name === "showsVerticalScrollIndicator" || name === "showsHorizontalScrollIndicator") {
        if (known() === false) return true
        return fail(a, `${name}: zero-native draws no scroll bar, so only {false} is accepted`)
      }
      if (name === "keyboardShouldPersistTaps") {
        // In zn a tap reaches the button under it while the keyboard is open, as with RN's "handled".
        const v = known()
        if (v === "handled" || v === "always" || v === true) return true
        return fail(a, 'keyboardShouldPersistTaps: zero-native works like "handled" (taps reach the button; the ' +
          'keyboard stays). For "never", call Keyboard.dismiss() in the handler')
      }
    }
    return null
  }

  /** After the attribute loop: the RN defaults and props that need the whole element (see rnAttribute). */
  function rnFinish(tag: string, rn: string | null, props: Record<string, unknown>, b: Builder, later: RnLater, at: ts.Node) {
    // rowGap / columnGap: the gap along the element's own direction beats gap, as in RN.
    const rowGap = props.__rowGap
    const columnGap = props.__columnGap
    delete props.__rowGap
    delete props.__columnGap
    const across = tag === "Row" || tag === "Carousel" || (tag === "Scroll" && props.horizontal === true)
    const main = across ? columnGap : rowGap
    if (main !== undefined && tag !== "Stack") props.gap = main

    if (rn === "TouchableOpacity") {
      props.pressFeedback ??= "none"
      props.pressOpacity ??= 0.2 // RN's default activeOpacity
    } else if (rn === "TouchableWithoutFeedback") {
      props.pressFeedback ??= "none"
    } else if (rn === "TouchableHighlight") {
      // RN shows underlayColor behind the child and dims the child to activeOpacity (default black and 0.85): about
      // the same as an overlay of underlayColor at (1 - activeOpacity).
      props.pressFeedback ??= "highlight"
      const opacity = later.activeOpacity ?? 0.85
      if (typeof opacity !== "number" || opacity < 0 || opacity > 1) fail(at, "activeOpacity needs a number from 0 to 1")
      let argb = 0
      try {
        argb = parseColor(String(later.underlayColor ?? "#000000"))
      } catch (e) {
        fail(at, `underlayColor: ${(e as Error).message}`)
      }
      const alpha = Math.round(((argb >>> 24) / 255) * (1 - (opacity as number)) * 1000) / 1000
      props.highlightColor ??= `rgba(${(argb >>> 16) & 255}, ${(argb >>> 8) & 255}, ${argb & 255}, ${alpha})`
    } else if (rn === "ActivityIndicator" && later.animating !== undefined) {
      // A stopped spinner is hidden but keeps its space, as RN's on Android.
      if ("opacity" in props) fail(at, "ActivityIndicator: use animating or opacity, not both")
      if (later.animating === false) props.opacity = 0
      else {
        const s = `s${b.slots++}`
        props.opacity = slotRef(s, null) as never
        b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${s}@@, () => ((${text(later.animating)}) ? 1 : 0), 0);`)
      }
    }
  }

  /**
   * RN-compat sweep P0.8: a prop the element doesn't take (`<Image horizontal>`, `<Text value>`) fails the build;
   * before, it was accepted and did nothing. The list per element is its type in @zero-native/ui (tag-props.ts,
   * generated). Props with their own, clearer check (hitSlop, pull to refresh) are left to it.
   */
  function tagPropCheck(tag: string, name: string, at: ts.Node) {
    const t = TAG_PROPS[tag]
    if (!t || t.own.has(name) || (t.base && BASE_PROPS.has(name))) return
    if (name === "hitSlop" || REFRESH_PROPS.includes(name)) return
    const own = [...t.own].filter((n) => n !== "children")
    fail(at, `${name} isn't a prop of <${tag}>, so it would do nothing` +
      (own.length > 0 ? `. <${tag}>'s own props: ${own.join(", ")}` : ""))
  }

  /** A style holds style keys only (P0.8): `style={{ src }}` used to be accepted. */
  function styleKeyCheck(key: string, at: ts.Node) {
    if (!STYLE_KEYS.has(key)) fail(at, `"${key}" isn't a style key: write it on the element as a prop (${key}={...})`)
  }

  /**
   * RN-compat sweep P0.4: `position: "absolute"` and `zIndex` work only on a child of <Stack>. Anywhere else the element
   * was laid out in the flow (zIndex ignored) with no error. Checked only where the parent is known (see [parents]).
   * Registry 16 (R23): zIndex works on a child of Column, Row, Box and Pressable too (not in a Scroll, List or
   * Carousel, whose items are drawn one by one).
   */
  function stackChildCheck(props: Record<string, unknown>, at: ts.Node) {
    const parent = parents[parents.length - 1]
    if (parent === undefined || parent === "Stack") return
    const zIndexOk = parent === "Column" || parent === "Row" || parent === "Box" || parent === "Pressable"
    const what = props.position === "absolute" ? 'position: "absolute"' : "zIndex" in props && !zIndexOk ? "zIndex" : null
    if (what) {
      fail(at, `${what} works only on a child of <Stack>; here the parent is <${parent}>, which would lay it out in ` +
        `the flow. Make the parent a <Stack> (its other children overlap too), or wrap this part in a <Stack>`)
    }
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
        b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, (__znPayload) => (${handlerCode(expr!, b)})(JSON.parse(__znPayload)));`)
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

  /**
   * <OtpInput> (registry 18, guide notes §62): react-native-otp-entry's props. `theme` and `focusColor` must be known
   * at build time and become `otpTheme` ("key=value;..."); containerStyle is the node's own style, pinCodeTextStyle its
   * text props. disabled, error, placeholder and accessibilityLabel can change at runtime.
   */
  function otpInputElement(node: ts.JsxElement | ts.JsxSelfClosingElement, b: Builder, allowKey: boolean): NodeSpec {
    b.nodes++
    const props: NodeProps & Record<string, unknown> = {}
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    const theme: Record<string, string | number> = {}
    let digits = 6
    let type = "numeric"
    let keyboard: string | null = null
    let autoComplete = "sms-otp"
    let autoFocus = true
    const known = (v: unknown, at: ts.Node, what: string) => {
      if (v === NOT_STATIC) fail(at, `${what} must be known at build time (a literal, a const or a design token)`)
      return v
    }
    const argb = (v: unknown, at: ts.Node, what: string) => {
      if (typeof v !== "string") fail(at, `${what} needs a colour string`)
      try {
        return `#${(parseColor(v as string) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
      } catch (e) {
        fail(at, `${what}: ${(e as Error).message}`)
      }
    }
    const num = (v: unknown, at: ts.Node, what: string) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(at, `${what} needs a number of dp, 0 or more`)
      return v as number
    }
    /** The members of an object literal written in place: name → its value's expression. */
    const members = (expr: ts.Expression, at: ts.Node, what: string) => {
      const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr
      if (!ts.isObjectLiteralExpression(e)) fail(at, `${what} needs an object written in place: ${what}={{ ... }}`)
      return (e as ts.ObjectLiteralExpression).properties.map((p) => {
        if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          fail(p, `${what}: write each entry as name: value (no spread, no methods)`)
        }
        const pa = p as ts.PropertyAssignment
        return { name: (pa.name as ts.Identifier | ts.StringLiteral).text, expr: pa.initializer, at: pa as ts.Node }
      })
    }
    const BOX_KEYS: Record<string, string> = { width: "w", height: "h", borderRadius: "r", borderWidth: "bw", borderColor: "bc", backgroundColor: "bg" }
    const box = (prefix: string, expr: ts.Expression, at: ts.Node, what: string) => {
      const v = known(fold(expr, scope), at, `theme.${what}`)
      if (v == null) return
      if (typeof v !== "object" || Array.isArray(v)) fail(at, `theme.${what} needs a style object`)
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        if (raw === undefined) continue
        const key = BOX_KEYS[k]
        if (!key) fail(at, `theme.${what}.${k} isn't supported: a box takes ${Object.keys(BOX_KEYS).join(", ")}`)
        theme[prefix + key] = key === "bc" || key === "bg" ? argb(raw, at, `theme.${what}.${k}`) : num(raw, at, `theme.${what}.${k}`)
      }
    }
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      const init = a.initializer
      const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
      const literal = () => (!init ? true : ts.isStringLiteral(init) ? init.text : expr ? fold(expr, scope) : NOT_STATIC)
      if (name === "key") {
        if (!allowKey) fail(a, "`key` is only used on the root element of a `.map(...)` row")
      } else if (name === "ref") {
        if (!expr) fail(a, "ref needs an object made by createRef(): const r = createRef<OtpInputHandle>(), then ref={r}")
        const ev = `e${b.events++}`
        const s = `s${b.slots++}`
        ;(props as any).ref = eventRef(ev)
        props.value = slotRef(s, null) as never
        b.binds.push(`${RUNTIME}.otpRef(${b.inst}, @@E:${ev}@@, @@S:${s}@@, ${text(expr!)});`)
      } else if (name === "onTextChange" || name === "onFilled" || name === "onFocus" || name === "onBlur") {
        if (!expr) fail(a, `${name} needs a function`)
        const ev = `e${b.events++}`
        ;(props as any)[name === "onTextChange" ? "onChangeText" : name] = eventRef(ev)
        b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${handlerCode(expr!, b)});`)
      } else if (name === "numberOfDigits") {
        const v = known(literal(), a, "numberOfDigits")
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 12) fail(a, "numberOfDigits needs a whole number from 1 to 12")
        digits = v as number
      } else if (name === "type") {
        const v = known(literal(), a, "type")
        if (typeof v !== "string" || !(v in Enum.otpType)) fail(a, `type needs one of ${Object.keys(Enum.otpType).join(", ")}`)
        type = v as string
      } else if (name === "autoFocus" || name === "blurOnFilled" || name === "secureTextEntry" || name === "hideStick") {
        const v = known(literal(), a, name)
        if (typeof v !== "boolean") fail(a, `${name} needs true or false`)
        if (name === "autoFocus") autoFocus = v as boolean
        else if (name === "hideStick") theme.hs = v ? 1 : 0
        else setStatic(props, name, v, a)
      } else if (name === "focusColor") {
        theme.fc = argb(known(literal(), a, "focusColor"), a, "focusColor")
      } else if (name === "focusStickBlinkingDuration") {
        theme.sb = num(known(literal(), a, name), a, name)
      } else if (name === "disabled" || name === "error" || name === "placeholder" || name === "accessibilityLabel") {
        const prop = name === "error" ? "invalid" : name
        if (!init) setStatic(props, prop, true, a)
        else if (ts.isStringLiteral(init)) setStatic(props, prop, init.text, a)
        else if (expr) setProp(props, b, prop, expr, a)
      } else if (name === "testID") {
        if (!init || !ts.isStringLiteral(init)) fail(a, 'testID needs a string literal, e.g. testID="otp"')
        setStatic(props, "testID", (init as ts.StringLiteral).text, a)
      } else if (name === "textInputProps") {
        if (!expr) fail(a, "textInputProps needs an object: textInputProps={{ ... }}")
        for (const m of members(expr!, a, "textInputProps")) {
          if (m.name === "textContentType") continue // iOS only, as RN on Android
          if (m.name === "accessibilityLabel") setProp(props, b, "accessibilityLabel", m.expr, m.at)
          else if (m.name === "testID" || m.name === "keyboardType" || m.name === "autoComplete") {
            const v = known(fold(m.expr, scope), m.at, `textInputProps.${m.name}`)
            if (typeof v !== "string") fail(m.at, `textInputProps.${m.name} needs a string`)
            if (m.name === "testID") setStatic(props, "testID", v, m.at)
            else if (m.name === "keyboardType") keyboard = v === "numeric" ? "decimal-pad" : (v as string)
            else autoComplete = AUTOCOMPLETE_ALIASES[v as string] ?? (v as string)
          } else {
            fail(m.at, `textInputProps.${m.name} isn't supported on <OtpInput>: it takes accessibilityLabel, keyboardType, ` +
              "autoComplete, textContentType and testID (the boxes' own props cover the rest)")
          }
        }
      } else if (name === "theme") {
        if (!expr) fail(a, "theme needs an object: theme={{ ... }}")
        for (const m of members(expr!, a, "theme")) {
          if (m.name === "containerStyle" || m.name === "inputsContainerStyle") styleProps(m.expr, props, b)
          else if (m.name === "pinCodeContainerStyle") box("", m.expr, m.at, m.name)
          else if (m.name === "focusedPinCodeContainerStyle") box("f", m.expr, m.at, m.name)
          else if (m.name === "filledPinCodeContainerStyle") box("l", m.expr, m.at, m.name)
          else if (m.name === "disabledPinCodeContainerStyle") box("d", m.expr, m.at, m.name)
          else if (m.name === "errorPinCodeContainerStyle") box("e", m.expr, m.at, m.name)
          else if (m.name === "pinCodeTextStyle" || m.name === "focusStickStyle" || m.name === "placeholderTextStyle") {
            const v = known(fold(m.expr, scope), m.at, `theme.${m.name}`)
            if (v == null) continue
            if (typeof v !== "object" || Array.isArray(v)) fail(m.at, `theme.${m.name} needs a style object`)
            for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
              if (raw === undefined) continue
              const what = `theme.${m.name}.${k}`
              if (m.name === "pinCodeTextStyle") {
                if (k === "fontWeight") setStatic(props, "fontWeight", fontWeight(raw, m.at), m.at)
                else if (k === "fontSize" || k === "color" || k === "fontFamily") setStatic(props, k, raw, m.at)
                else fail(m.at, `${what} isn't supported: the digits take fontSize, fontWeight, color and fontFamily`)
              } else if (m.name === "focusStickStyle") {
                if (k === "width") theme.sw = num(raw, m.at, what)
                else if (k === "height") theme.sh = num(raw, m.at, what)
                else if (k === "backgroundColor") theme.sc = argb(raw, m.at, what)
                else fail(m.at, `${what} isn't supported: the caret takes width, height and backgroundColor`)
              } else {
                if (k === "color") theme.pc = argb(raw, m.at, what)
                else fail(m.at, `${what} isn't supported: the placeholder takes color`)
              }
            }
          } else {
            fail(m.at, `theme.${m.name} isn't supported on <OtpInput>`)
          }
        }
      } else if (name === "style") {
        fail(a, "<OtpInput> takes theme.containerStyle for its row, as react-native-otp-entry does, not style")
      } else if (name === "textProps") {
        fail(a, "textProps isn't supported on <OtpInput>: style the digits with theme.pinCodeTextStyle")
      } else {
        fail(a, `unknown prop "${name}" on <OtpInput>`)
      }
    }
    const kids = ts.isJsxElement(node) ? node.children : []
    if (kids.some((k) => !(ts.isJsxText(k) && k.text.trim() === ""))) fail(node, "<OtpInput> takes no children")
    setStatic(props, "maxLength", digits, opening)
    setStatic(props, "otpType", type, opening)
    setStatic(props, "keyboardType", keyboard ?? (type === "numeric" ? "number-pad" : "default"), opening)
    setStatic(props, "autoComplete", autoComplete, opening)
    if (autoFocus) setStatic(props, "autoFocus", true, opening)
    const encoded = Object.entries(theme).map(([k, v]) => `${k}=${v}`).join(";")
    if (encoded) setStatic(props, "otpTheme", encoded, opening)
    return el("OtpInput", props)
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
    // An absolute Svg with both sides of a pair (start + end, top + bottom) gets that size from its Stack: no aspect
    // ratio on that axis, or the viewBox shape would size it from the other one (R30: a 360 wide header drawn 792 tall).
    const abs = props.position === "absolute"
    const hasW = props.width !== undefined || (abs && props.start !== undefined && props.end !== undefined)
    const hasH = props.height !== undefined || (abs && props.top !== undefined && props.bottom !== undefined)
    if (!hasW && !hasH) {
      props.width = svg.width
      props.height = svg.height
    } else if (hasW !== hasH && props.aspectRatio === undefined) {
      props.aspectRatio = svg.width / svg.height
    }
    props.svg = svg.data
    // SVG <text> is read out by TalkBack, as a browser reads it (registry 13), unless the screen names it itself.
    if (svg.text && props.accessibilityLabel === undefined && props.accessibilityHidden === undefined) {
      props.accessibilityLabel = svg.text
    }
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
    writeSvgTypes(path, svg)
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
        if (index === undefined || id.startsWith("zn-anim-")) {
          const known = [...svg.parts.keys()].filter((k) => !k.startsWith("zn-anim-"))
          fail(pa.name, `${tag} has no part "${id}" (${known.length > 0 ? `its parts: ${known.join(", ")}` : "it has no elements with an id"})`)
        }
        const value = unwrap(pa.initializer)
        if (!ts.isObjectLiteralExpression(value)) fail(pa.initializer, `part "${id}" needs an object: { fill, stroke, opacity }`)
        const partProps: NodeProps & Record<string, unknown> = { part: index }
        for (const q of (value as ts.ObjectLiteralExpression).properties) {
          if (!ts.isPropertyAssignment(q)) fail(q, "write part values as fill: ..., opacity: ...")
          const k = (q as ts.PropertyAssignment).name.getText(sf)
          const allowed: readonly string[] = [...PART_PROPS, ...PART_MOTION, ...FILE_PART_PROPS]
          if (!allowed.includes(k)) fail(q, `a part can set ${allowed.join(", ")}, not "${k}"`)
          partProp(partProps, b, k, (q as ts.PropertyAssignment).initializer, q)
        }
        partPivot(partProps, svg, index!)
        parts.push(el("SvgPart", partProps))
      }
    }
    // The file's own animations (SMIL / CSS, docs/svg.md §15): parts made by the build. A part the screen also sets
    // keeps the screen's values; the file's pivot wins, as its motion turns around it.
    for (const [id, motion] of svg.motion) {
      const index = svg.parts.get(id)!
      const mine = parts.find((p) => (p.props as Record<string, unknown>).part === index)
      if (!mine) {
        parts.push(el("SvgPart", { part: index, ...motion } as NodeProps))
        continue
      }
      const own = mine.props as Record<string, unknown>
      if ("animate" in own) fail(node, `part "${id}" is already animated by the .svg file itself: remove its animate (paused and replay still work)`)
      for (const [k, v] of Object.entries(motion)) if (k === "pivotX" || k === "pivotY" || !(k in own)) own[k] = v
    }
    pinWidths(parts, svg)
    return svgNode(node, svg, props, parts, b)
  }

  /**
   * A strokeWidth on a group part leaves alone a child that set its own stroke-width, as SVG does (registry 13): that
   * child gets a part of its own with its width, which wins over the group's.
   */
  function pinWidths(parts: NodeSpec[], svg: CompiledSvg) {
    const widthKey = `${Prop.strokeWidth.id}=`
    const sets = (i: number) =>
      parts.some((p) => {
        const q = p.props as Record<string, unknown>
        if (q.part !== i) return false
        const anim = typeof q.animate === "string" ? q.animate : ""
        return "strokeWidth" in q || anim.startsWith("*=") || anim.split(";").some((e) => e.startsWith(widthKey))
      })
    for (const pin of svg.widthPins) {
      if (!pin.above.some(sets) || pin.below.some(sets)) continue
      const mine = parts.find((p) => (p.props as Record<string, unknown>).part === pin.shape)
      if (!mine) parts.push(el("SvgPart", { part: pin.shape, strokeWidth: pin.width } as NodeProps))
      else if (!sets(pin.shape)) (mine.props as Record<string, unknown>).strokeWidth = pin.width
    }
  }

  /** One value on an SvgPart: `animate` is checked against what a part can animate; the rest as any prop. */
  function partProp(partProps: Record<string, unknown>, b: Builder, k: string, expr: ts.Expression, at: ts.Node) {
    if (k === "animate") {
      const v = fold(expr, scope)
      if (v === NOT_STATIC) fail(at, "animate must be known at build time (a literal or a const)")
      partProps.animate = animateSpec(v, at, PART_ANIMATABLE)
      return
    }
    setProp(partProps, b, k as PropName, expr, at)
  }

  /** A part that turns or scales does it around its own centre (worked out here, in viewBox units). */
  function partPivot(partProps: Record<string, unknown>, svg: CompiledSvg, index: number) {
    const anim = typeof partProps.animate === "string" ? partProps.animate : ""
    const turns = PART_TURNS.some((k) => k in partProps || anim.startsWith("*=") || anim.split(";").some((e) => e.startsWith(`${Prop[k as PropName].id}=`)))
    const box = svg.boxes.get(index)
    if (!turns || !box) return
    partProps.pivotX = Math.round(((box[0] + box[2]) / 2) * 1e4) / 1e4
    partProps.pivotY = Math.round(((box[1] + box[3]) / 2) * 1e4) / 1e4
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
        if (!isRoot && (PART_MOTION as readonly string[]).includes(name)) {
          // zn's part values (transforms, trims, animate): not SVG attributes; this element becomes a part.
          if (inRow) fail(a, `"${name}" inside a build-time .map(...) in <Svg> isn't supported: give the element an id and use parts`)
          const expr = a.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined
          if (!expr) fail(a, `"${name}" needs a value in braces: ${name}={...}`)
          dynamic.push({ prop: name, expr: expr!, at: a })
          continue
        }
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
              "(geometry is fixed: move it with rotate, scale, translateX / translateY or trims, or choose between two shapes with a ternary)")
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
          if (child.text.trim() !== "") fail(child, "text inside <Svg> isn't supported: put a <Text> over the SVG in a <Stack> (a .svg file may use simple <text>)")
        } else if (ts.isJsxExpression(child)) {
          if (!child.expression) continue
          const e = seeThrough(child.expression)
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
              const locals = new Map(local.locals)
              if (names[0]) locals.set(names[0], item)
              if (names[1]) locals.set(names[1], i)
              n.children.push(convert(row as ts.JsxElement, { ...local, locals }, true, false))
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
      partProp(partProps, b, r.prop, r.expr, r.at)
    }
    for (const p of byId.values()) partPivot(p, svg, p.part as number)
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
        const e = seeThrough(child.expression)
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
    notInUiCheck(node, tag)
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
      const j = seeThrough(x)
      if (isJsx(j)) return `() => ${compileRoot(j as JsxNode, b.depth + 1).code}`
      // A nested `a ? <A/> : b ? <B/> : null`: the inner choice is a Fragment with its own anchor.
      if (isJsxValue(j)) return `() => ${valueTemplate(j, b.depth + 1).code}`
      return fail(x, "a branch must be JSX or null")
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
      const root = rowJsx && seeThrough(rowJsx)
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
    let contentStyle: ts.JsxAttribute | null = null
    const rnLater: RnLater = {}
    for (const attr of (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      const init = a.initializer
      const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
      if (rnAttribute("List", null, name, a, props, b, rnLater) === true) continue // FlatList's speed hints (P1.7)
      // FlatList's renderItem / keyExtractor (RN-compat sweep P1.5): the same as row / key, see below.
      if (["data", "key", "row", "onEndReached", "renderItem", "keyExtractor"].includes(name)) {
        if (!expr) fail(a, `${name} needs an expression: ${name}={...}`)
        special[name] = expr!
      } else if (name === "stickyHeaderIndices") {
        // RN's pinned rows (registry 15). Native draws them pinned; JS keeps them mounted wherever the list is.
        if (!expr) fail(a, "stickyHeaderIndices needs an array of row indices: stickyHeaderIndices={[0]}")
        special.sticky = expr!
        const v = fold(expr!, scope)
        if (v === NOT_STATIC) {
          const sl = `s${b.slots++}`
          props.stickyHeaderIndices = slotRef(sl, null) as never
          b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${sl}@@, () => (${text(expr!)} ?? []).join(","), 0);`)
        } else {
          if (!Array.isArray(v) || !v.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
            fail(a, "stickyHeaderIndices must be an array of row indices (whole numbers, 0 or more)")
          }
          props.stickyHeaderIndices = (v as number[]).join(",")
        }
      } else if (name === "onRefresh") {
        if (!expr) fail(a, "onRefresh needs a function")
        bindEvent(props, b, "onRefresh", expr!)
      } else if (name === "refreshControl") {
        refreshControl(a, props, b)
      } else if (name === "style") {
        if (!expr) fail(a, "style needs an object: style={{ ... }}")
        styleProps(expr!, props, b)
      } else if (name === "contentContainerStyle") {
        contentStyle = a // after the loop, so it can be checked against style's padding
      } else if (name === "horizontal") {
        // RN-compat sweep P0.6: it was accepted and the list still drew vertically. {false} is RN's default.
        if (fold(expr ?? ts.factory.createTrue(), scope) === false) continue
        fail(a, "<List> is vertical only. For a horizontal rail use <Scroll horizontal> with {items.map(...)} inside " +
          "(only the visible cards are drawn)")
      } else if (name in Prop) {
        if (!init) setProp(props, b, name as PropName, ts.factory.createTrue(), a)
        else if (ts.isStringLiteral(init)) setStatic(props, name as PropName, decodeEntities(init.text), a)
        else if (expr) setProp(props, b, name as PropName, expr, a)
        else fail(a, `unsupported value for "${name}"`)
      } else {
        fail(a, `unknown prop "${name}" on <List> (use data, key, row, onEndReached, style, contentContainerStyle, gap, refreshing, onRefresh, stickyHeaderIndices, inverted; or FlatList's renderItem, keyExtractor)`)
      }
    }
    rnFinish("List", null, props, b, rnLater, node)
    // RN's old chat trick (the list and each row flipped with scaleY -1): on Android the fling after the finger lifts
    // runs the wrong way (Compose measures its speed outside the flip). `inverted` does the same without a flip.
    if ((props as Record<string, unknown>).scaleY === -1 || (props as Record<string, unknown>).scale === -1) {
      fail(node, "<List> flipped with transform scaleY -1 flings the wrong way on Android: use <List inverted> " +
        "(row 0 at the bottom, as RN's inverted FlatList) and remove the flip from the list and its rows")
    }
    if (contentStyle) contentContainerStyle(contentStyle, props, b)
    // FlatList's names (P1.5). renderItem gets { item, index } as in RN; without a key function the key is RN's
    // default: item.key, else item.id, else the index.
    if (special.renderItem && special.row) fail(node, "use row or renderItem, not both")
    if (special.keyExtractor && special.key) fail(node, "use key or keyExtractor, not both")
    const renderItem = !!special.renderItem
    if (renderItem) special.row = special.renderItem
    if (special.keyExtractor) special.key = special.keyExtractor
    for (const required of renderItem ? ["data"] : ["data", "key", "row"]) {
      if (!special[required]) fail(node, `<List> needs ${required}={...}`)
    }
    const keyCode = special.key ? text(special.key) : "(__znItem, __znIndex) => (__znItem?.key ?? __znItem?.id ?? __znIndex)"

    const fn = unwrap(special.row)
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) fail(special.row, "row must be a function: row={(item) => <Row/>}")
    const rowFn = fn as ts.ArrowFunction
    if (renderItem) {
      if (rowFn.parameters.length !== 1) fail(rowFn, "renderItem takes one parameter: ({ item, index }) => ...")
      const info = rowFn.parameters[0].name
      if (ts.isObjectBindingPattern(info)) {
        for (const e of info.elements) {
          const k = (e.propertyName ?? e.name).getText(sf)
          if (k !== "item" && k !== "index") fail(e, `renderItem: only item and index are given (not ${k})`)
        }
      }
    } else {
      if (rowFn.parameters.length < 1 || rowFn.parameters.length > 2) fail(rowFn, "row takes (item) or (item, index)")
      const first = rowFn.parameters[0].name
      if (ts.isObjectBindingPattern(first) && first.elements.some((e) => ["item", "index"].includes((e.propertyName ?? e.name).getText(sf)))) {
        // RN-compat sweep P0.7: FlatList's renderItem={({ item }) => ...} habit; `row` gets the item itself.
        fail(first, "row gets the item itself, not { item, index }: write row={(item, index) => ...}, or use " +
          "renderItem={({ item, index }) => ...} as in React Native")
      }
    }
    const params = renderItem ? "__znItem, __znIndex" : rowFn.parameters.map((p) => text(p)).join(", ")
    // renderItem: the row function is called with RN's { item, index } (one small object per row built).
    const wrap = (code: string) =>
      renderItem ? `((${text(rowFn.parameters[0])}) => ${code})({ item: __znItem, index: __znIndex })` : code
    let body: ts.Expression | undefined
    if (ts.isBlock(rowFn.body)) {
      const only = rowFn.body.statements.length === 1 ? rowFn.body.statements[0] : null
      body = only && ts.isReturnStatement(only) ? only.expression : undefined
    } else {
      body = rowFn.body
    }
    if (!body) fail(rowFn, "row must return its JSX directly: row={(item) => <Row/>}")

    const branches = (e: ts.Expression): { code: string; type: string } => {
      const u = seeThrough(e)
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
    parents.push("List")
    let rows: { code: string; type: string }
    try {
      rows = branches(body!)
    } finally {
      parents.pop()
    }

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
      `${RUNTIME}.list(${b.inst}, ${index}, { data: () => (${text(special.data)}), key: ${keyCode}, ` +
        `row: (${params}) => ${wrap(rows.code)}, type: (${params}) => ${wrap(rows.type)}, ` +
        `rangeEvent: @@E:${range}@@, endEvent: ${end}, onEndReached: ${onEnd}` +
        (special.sticky ? `, sticky: () => (${text(special.sticky)})` : "") + " });",
    )
    return el("List", props)
  }

  /** An event prop bound to [handler] on this template's instance. */
  function bindEvent(props: Record<string, unknown>, b: Builder, name: keyof typeof EventKind, handler: ts.Expression) {
    const ev = `e${b.events++}`
    props[name] = eventRef(ev)
    b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, ${text(handler)});`)
  }

  /**
   * React Native's `contentContainerStyle={{ paddingBottom: 100 }}` on a <Scroll> or <List> (2026-11-05). In
   * zero-native the padding in `style` on these two already scrolls with the content, so this is the same padding under
   * RN's name. Only padding keys. Padding in both places fails: in RN they are two different paddings (outside and
   * inside the scroll), and merging them would silently change the layout.
   */
  function contentContainerStyle(a: ts.JsxAttribute, props: Record<string, unknown>, b: Builder) {
    const init = a.initializer
    if (!init || !ts.isJsxExpression(init) || !init.expression) {
      return fail(a, "contentContainerStyle needs an object: contentContainerStyle={{ paddingBottom: 100 }}")
    }
    const own: Record<string, unknown> = {}
    styleProps(init.expression, own, b)
    for (const k of Object.keys(own)) {
      if (!PADDING_KEYS.has(k)) {
        fail(a, `contentContainerStyle takes only padding keys in zero-native ("${k}" isn't supported there). ` +
          "gap goes in style, where it already spaces the content")
      }
    }
    if (Object.keys(own).length > 0 && Object.keys(props).some((k) => PADDING_KEYS.has(k))) {
      fail(a, "padding is set in both style and contentContainerStyle. On <Scroll> and <List> the padding in style " +
        "already scrolls with the content: keep it in one place, and use margin for space outside the list")
    }
    Object.assign(props, own)
  }

  /**
   * React Native's `refreshControl={<RefreshControl refreshing onRefresh colors tintColor progressBackgroundColor />}`
   * on a Scroll / List → the flat props refreshing, onRefresh, refreshColor, refreshBackground (guide notes §41).
   * `colors` (Android) gives the colour; `tintColor` (iOS) only when there is no `colors`.
   */
  function refreshControl(a: ts.JsxAttribute, props: Record<string, unknown>, b: Builder) {
    const init = a.initializer
    const e = init && ts.isJsxExpression(init) && init.expression ? seeThrough(init.expression) : undefined
    if (!e || !(ts.isJsxSelfClosingElement(e) || ts.isJsxElement(e)) || tagName(e) !== "RefreshControl") {
      return fail(a, "refreshControl takes <RefreshControl ... /> written right here " +
        "(or use the props refreshing, onRefresh, refreshColor, refreshBackground)")
    }
    if (ts.isJsxElement(e) && e.children.some((c) => !(ts.isJsxText(c) && c.text.trim() === ""))) {
      fail(e, "<RefreshControl> takes no children")
    }
    let colors: ts.Expression | undefined
    let tint: ts.Expression | undefined
    const value = (r: ts.JsxAttribute): ts.Expression => {
      const i = r.initializer
      if (!i) return ts.factory.createTrue()
      if (ts.isStringLiteral(i)) return i
      if (ts.isJsxExpression(i) && i.expression) return i.expression
      return fail(r, `unsupported value for "${r.name.getText(sf)}"`)
    }
    const set = (name: PropName, r: ts.JsxAttribute) => {
      const v = value(r)
      if (ts.isStringLiteral(v)) setStatic(props, name, decodeEntities(v.text), r)
      else setProp(props, b, name, v, r)
    }
    for (const attr of (ts.isJsxElement(e) ? e.openingElement : e).attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const r = attr as ts.JsxAttribute
      const name = r.name.getText(sf)
      if (name === "refreshing") set("refreshing", r)
      else if (name === "onRefresh") bindEvent(props, b, "onRefresh", value(r))
      else if (name === "progressBackgroundColor") set("refreshBackground", r)
      else if (name === "tintColor") tint = value(r)
      else if (name === "colors") {
        // One colour: the first of a literal array (`colors={[PRIMARY]}`), or of a build-time constant array.
        const v = unwrap(value(r))
        if (ts.isArrayLiteralExpression(v) && v.elements.length > 0 && !ts.isSpreadElement(v.elements[0])) {
          colors = v.elements[0]
        } else {
          const folded = fold(v, scope)
          if (!Array.isArray(folded) || folded.length === 0) fail(r, "colors must be an array with at least one colour: colors={[c]}")
          setStatic(props, "refreshColor", (folded as unknown[])[0], r)
        }
      } else {
        fail(r, `${name} on <RefreshControl> isn't supported (use refreshing, onRefresh, colors, tintColor, progressBackgroundColor)`)
      }
    }
    const color = colors ?? (props.refreshColor === undefined ? tint : undefined)
    if (color) {
      if (ts.isStringLiteral(color)) setStatic(props, "refreshColor", decodeEntities(color.text), color)
      else setProp(props, b, "refreshColor", color, color)
    }
  }

  /** A build-time prop value → the template. Values with React Native aliases are normalised here. */
  function setStatic(props: Record<string, unknown>, name: PropName, value: unknown, at: ts.Node) {
    if (typeof value === "number" && value < 0) {
      if (MARGIN_KEYS.has(name)) {
        fail(at, `${name}: ${value}: a negative margin isn't supported in zero-native yet. To pull an element up or ` +
          `to the side so it overlaps, use transform: [{ ${/Start|End|Horizontal/.test(name) ? "translateX" : "translateY"}: ${value} }] ` +
          "(it moves the drawing and keeps the space in the layout), or take the space out of the neighbour's padding " +
          "or the parent's gap")
      }
      if (NOT_NEGATIVE_KEYS.has(name)) fail(at, `${name}: ${value}: can't be negative (React Native treats it as 0). Use 0`)
    }
    props[name] =
      name === "fontWeight" ? fontWeight(value, at)
      : name === "backgroundImage" ? linearGradient(value, at)
      : name === "animate" ? animateSpec(value, at)
      : name === "enter" || name === "exit" ? transitionSpec(value, name, at)
      : name === "hitSlop" ? hitSlopSpec(value, at)
      : name === "textAlign" ? rnTextAlign(value, at)
      : name === "aspectRatio" && typeof value === "string" ? rnRatio(value, at)
      : name === "keyboardType" && value === "numeric" ? "decimal-pad" // RN's numeric: digits and a decimal point
      : name === "autoComplete" && typeof value === "string" && value in AUTOCOMPLETE_ALIASES ? AUTOCOMPLETE_ALIASES[value]
      : value
  }

  /**
   * RN hitSlop: a number (all four sides) or { top, bottom, left, right, start, end } in dp → "start,top,end,bottom".
   * left / right count as start / end (zn's rename for a left-to-right layout); start / end win when both are given.
   */
  function hitSlopSpec(value: unknown, at: ts.Node): string {
    const n = (v: unknown, k: string) => {
      if (v === undefined || v === null) return 0
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(at, `hitSlop.${k} must be a number of dp, 0 or more`)
      return v as number
    }
    if (typeof value === "number") {
      const all = n(value, "value")
      return `${all},${all},${all},${all}`
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail(at, "hitSlop needs a number or { top, bottom, left, right } known at build time")
    }
    const o = value as Record<string, unknown>
    for (const k of Object.keys(o)) {
      if (!["top", "bottom", "left", "right", "start", "end"].includes(k)) fail(at, `hitSlop: unknown side "${k}" (use top, bottom, left, right)`)
    }
    return [n(o.start ?? o.left, "start"), n(o.top, "top"), n(o.end ?? o.right, "end"), n(o.bottom, "bottom")].join(",")
  }

  // ---- Animation (step 3.6, ARCHITECTURE §10): build-time values, encoded for native (registry: animate / enter / exit).

  /**
   * 250 | "spring" | "bouncy" | { duration, easing? } | { spring: { damping?, stiffness? } } → "t250e0" / "s0.75,400",
   * plus the motion options (registry 13, format "timing.motion") after "~", each a letter and its value:
   * "d<ms>" delay, "r<n>" plays in all (-1 forever), "v" reverse, "g<ms>" repeat delay, "f<value>" from,
   * "k<v>:<v>:..." keyframes, "m<t>:<t>:..." keyframe times, "b<x1>:<y1>:<x2>:<y2>" cubic-bezier (easing id 4).
   * Values are numbers, or "#AARRGGBB" for colours. Timings without options stay exactly as before.
   * [prop]: the one prop this timing animates (null: every prop of the element, or an enter / exit).
   */
  function timing(v: unknown, at: ts.Node, what: string, prop: string | null = null, transition = false): string {
    const ms = (n: unknown, key = "a duration", max = 10_000) => {
      if (typeof n !== "number" || !(n >= 0 && n <= max)) fail(at, `${what}: ${key} is 0–${max} ms, got ${JSON.stringify(n)}`)
      return Math.round(n as number)
    }
    if (typeof v === "number") return `t${ms(v)}e0`
    if (v === "spring") return "s0.75,400"
    if (v === "bouncy") return "s0.45,400"
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return fail(at, `${what}: use a duration in ms (250), "spring", "bouncy", { duration, easing } or { spring: { damping, stiffness } }`)
    }
    const o = v as Record<string, unknown>
    const motionKeys = ["delay", "repeat", "reverse", "repeatDelay", "from", "keyframes", "times"]
    const allowed = transition ? ["duration", "easing", "spring", "delay"] : ["duration", "easing", "spring", ...motionKeys]
    for (const k of Object.keys(o)) {
      if (allowed.includes(k)) continue
      if (transition && motionKeys.includes(k)) fail(at, `${what}: "${k}" isn't for enter / exit (only delay is); loop with animate`)
      fail(at, `${what}: unknown key "${k}" (use ${allowed.join(", ")})`)
    }
    let base: string
    const opts: string[] = []
    if ("spring" in o) {
      const sp = (o.spring ?? {}) as Record<string, unknown>
      const damping = sp.damping ?? 0.75
      const stiffness = sp.stiffness ?? 400
      if (typeof damping !== "number" || damping <= 0 || typeof stiffness !== "number" || stiffness <= 0) {
        fail(at, `${what}: spring needs damping > 0 (1 = no bounce) and stiffness > 0`)
      }
      if ("keyframes" in o || "times" in o) fail(at, `${what}: keyframes need a duration, not a spring`)
      if ("easing" in o) fail(at, `${what}: a spring has no easing (use duration + easing, or damping / stiffness)`)
      base = `s${damping},${stiffness}`
    } else if ("duration" in o) {
      const easing = o.easing ?? "standard"
      if (Array.isArray(easing)) {
        const b = easing as unknown[]
        if (b.length !== 4 || !b.every((n) => typeof n === "number" && Number.isFinite(n))) {
          fail(at, `${what}: a cubic-bezier easing is 4 numbers [x1, y1, x2, y2]`)
        }
        const [x1, , x2] = b as number[]
        if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) fail(at, `${what}: cubic-bezier x1 and x2 must be within 0–1 (as in CSS)`)
        base = `t${ms(o.duration)}e4`
        opts.push(`b${(b as number[]).join(":")}`)
      } else {
        const e = EASINGS.indexOf(easing as string)
        if (e < 0) fail(at, `${what}: easing must be one of ${EASINGS.join(", ")}, or [x1, y1, x2, y2]`)
        base = `t${ms(o.duration)}e${e}`
      }
    } else {
      return fail(at, `${what}: use a duration in ms (250), "spring", "bouncy", { duration, easing } or { spring: { damping, stiffness } }`)
    }

    if ("delay" in o) opts.push(`d${ms(o.delay, "delay", 60_000)}`)
    const plays = "from" in o || "keyframes" in o
    if ((plays || "repeat" in o || "reverse" in o || "repeatDelay" in o || "times" in o) && prop === null) {
      fail(at, `${what}: repeat, reverse, from and keyframes belong to one prop: animate={{ rotate: { duration: 900, repeat: "forever", from: 0 } }}`)
    }
    const color = prop === "backgroundColor" || prop === "fill" || prop === "stroke"
    const value = (x: unknown, key: string): string => {
      if (color) {
        if (typeof x !== "string") fail(at, `${what}: ${key} must be colours for ${prop}`)
        try {
          return `#${(parseColor(x as string) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`
        } catch (e) {
          return fail(at, `${what}: ${key}: ${(e as Error).message}`)
        }
      }
      if (typeof x !== "number" || !Number.isFinite(x)) fail(at, `${what}: ${key} must be numbers`)
      return String(x)
    }
    if ("from" in o && "keyframes" in o) fail(at, `${what}: use from or keyframes, not both (keyframes start at their first value)`)
    if ("from" in o) opts.push(`f${value(o.from, "from")}`)
    if ("keyframes" in o) {
      const k = o.keyframes
      if (!Array.isArray(k) || k.length < 2) fail(at, `${what}: keyframes need at least 2 values`)
      opts.push(`k${(k as unknown[]).map((x) => value(x, "keyframes")).join(":")}`)
      if ("times" in o) {
        const t = o.times
        const ok = Array.isArray(t) && t.length === (k as unknown[]).length &&
          t.every((x, i) => typeof x === "number" && x >= 0 && x <= 1 && (i === 0 || x >= (t[i - 1] as number))) &&
          t[0] === 0 && t[t.length - 1] === 1
        if (!ok) fail(at, `${what}: times needs one number per keyframe, rising from 0 to 1`)
        opts.push(`m${(t as number[]).join(":")}`)
      }
    } else if ("times" in o) {
      fail(at, `${what}: times goes with keyframes`)
    }
    if ("repeat" in o) {
      const r = o.repeat
      if (!plays) fail(at, `${what}: repeat needs a start: add from (from: 0) or keyframes`)
      if (r === "forever") opts.push("r-1")
      else if (typeof r === "number" && Number.isInteger(r) && r >= 1 && r <= 10_000) opts.push(`r${r}`)
      else fail(at, `${what}: repeat is how many times it plays in all (1, 2, ...) or "forever"`)
    }
    if ("reverse" in o) {
      if (typeof o.reverse !== "boolean") fail(at, `${what}: reverse is true or false`)
      if (o.reverse && !("repeat" in o)) fail(at, `${what}: reverse needs repeat (2 or more plays): repeat: "forever", reverse: true`)
      if (o.reverse) opts.push("v")
    }
    if ("repeatDelay" in o) {
      if (!("repeat" in o)) fail(at, `${what}: repeatDelay needs repeat`)
      opts.push(`g${ms(o.repeatDelay, "repeatDelay", 60_000)}`)
    }
    return opts.length === 0 ? base : `${base}~${opts.join("~")}`
  }

  function isTiming(v: unknown): boolean {
    if (typeof v === "number" || v === "spring" || v === "bouncy") return true
    return !!v && typeof v === "object" && ("duration" in (v as object) || "spring" in (v as object))
  }

  /** animate={250} (every animatable prop of the element) or animate={{ opacity: 200, translateY: "spring" }}. */
  function animateSpec(v: unknown, at: ts.Node, animatable: string[] = ANIMATABLE): string {
    if (isTiming(v)) return `*=${timing(v, at, "animate")}`
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(at, "animate needs a timing (250, \"spring\") or { prop: timing }")
    const parts: string[] = []
    for (const [k, t] of Object.entries(v as object)) {
      if (!animatable.includes(k)) fail(at, `animate: "${k}" can't be animated (use ${animatable.join(", ")})`)
      parts.push(`${Prop[k as PropName].id}=${timing(t, at, `animate.${k}`, k)}`)
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
    const known = ["opacity", "translateX", "translateY", "scale", "duration", "easing", "spring", "timing", "delay"]
    for (const k of Object.keys(o)) {
      if (known.includes(k)) continue
      if (["repeat", "reverse", "repeatDelay", "from", "keyframes", "times"].includes(k)) {
        fail(at, `${kind}: "${k}" isn't for enter / exit (only delay is); loop with animate`)
      }
      fail(at, `${kind}: unknown key "${k}"`)
    }
    const num = (k: string, d: number) => {
      const x = o[k] ?? d
      if (typeof x !== "number") fail(at, `${kind}.${k} must be a number`)
      return x as number
    }
    // The timing keys only (the state keys opacity, translateX... are not timing).
    const own: Record<string, unknown> = {}
    for (const k of ["duration", "easing", "spring", "delay"]) if (k in o) own[k] = o[k]
    if ("timing" in o && "delay" in o) fail(at, `${kind}: with delay, give the timing as duration / easing or spring`)
    if ("delay" in own && !("duration" in own) && !("spring" in own)) {
      // A delay alone keeps the default timing.
      if (kind === "enter") own.duration = 220, own.easing = "ease-out"
      else own.duration = 160, own.easing = "ease-in"
    }
    const t =
      "timing" in o ? timing(o.timing, at, kind, null, true)
      : "spring" in own || "duration" in own ? timing(own, at, kind, null, true)
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
    transformOrder((list as unknown[]).map((e) => {
      const pairs = e && typeof e === "object" ? Object.entries(e) : []
      return pairs.length === 1 ? { key: pairs[0][0], value: pairs[0][1] } : null
    }), at)
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

  /**
   * RN-compat sweep P0.9. zero-native draws a transform in one fixed order (move, then rotate, then scale, as Compose's
   * graphicsLayer does), and keeps one value per key. React Native applies the list in its order, so a scale or rotate
   * before a move also scales or turns the move, and a key written twice adds up. Those lists fail the build. Entries
   * that do nothing (scale 1, rotate 0, move 0) are skipped; a value known only at runtime counts.
   */
  function transformOrder(entries: ({ key: string; value: unknown } | null)[], at: ts.Node) {
    const seen = new Set<string>()
    let turned: string | null = null // the first scale / rotate that does something
    let stretched: string | null = null // the first scaleX / scaleY that does something
    for (const e of entries) {
      if (!e) continue // a malformed entry: the usual checks give the error
      const { key, value } = e
      if (seen.has(key)) {
        fail(at, `transform has ${key} twice. React Native applies both (they add up); zero-native keeps one. ` +
          `Write one ${key} with the total`)
      }
      seen.add(key)
      const identity = value === (key.startsWith("scale") ? 1 : 0)
      if (identity) continue
      if ((key === "translateX" || key === "translateY") && turned) {
        fail(at, `transform: ${key} comes after ${turned}. React Native would ${turned === "rotate" ? "turn" : "scale"} ` +
          `the move too; zero-native always moves first. Put { ${key} } first in the list (with the value you want on screen)`)
      }
      if (key === "rotate" && stretched) {
        fail(at, `transform: rotate comes after ${stretched}. zero-native always rotates before it scales; put { rotate } ` +
          "first, or use scale (the same on both axes)")
      }
      if (key.startsWith("scale") || key === "rotate") turned ??= key
      if (key === "scaleX" || key === "scaleY") stretched ??= key
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
        if (IGNORED_STYLE_KEYS.has(k)) continue
        const key = rnStyleKey(k, () => v, props, at)
        if (key === null) continue
        if (!(key in Prop)) fail(at, unknownStyleKey(key))
        styleKeyCheck(key, at)
        if (v !== undefined) setStatic(props, key as PropName, v, at)
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
            transformOrder((list as ts.ArrayLiteralExpression).elements.map((item) => {
              const obj = unwrap(item)
              const pa = ts.isObjectLiteralExpression(obj) && obj.properties.length === 1 ? obj.properties[0] : undefined
              if (!pa || !ts.isPropertyAssignment(pa)) return null
              return { key: pa.name.getText(sf), value: fold(pa.initializer, scope) }
            }), p)
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
          if (IGNORED_STYLE_KEYS.has(key)) continue
          const zk = rnStyleKey(key, () => fold(p.initializer, scope), props, p)
          if (zk === null) continue
          if (!(zk in Prop)) fail(p, unknownStyleKey(zk))
          styleKeyCheck(zk, p)
          setProp(props, b, zk as PropName, p.initializer, p)
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
    if (needsRuntimeSpans(kids)) return runtimeSpans(node, kids, props, b)
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
          if (isJsxValue(child.expression)) {
            fail(child, "inside <Text>, write nested text as <Text>...</Text> directly" +
              (ts.isIdentifier(unwrap(child.expression)) ? " (a JSX const can't be used inside <Text>)" : ""))
          }
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
   * Whether a <Text>'s spans change at runtime (registry 16): a `{expression}` child that holds <Text> spans
   * (`{parts.map((p) => <Text ...>)}`, `{cond && <Text>}`), or a nested <Text> with a runtime value or an `onPress`.
   * A JSX const inside <Text> still fails (in textChildren): it is a View, not a span.
   */
  function needsRuntimeSpans(kids: ts.NodeArray<ts.JsxChild>): boolean {
    const dynamicSpan = (el: ts.JsxElement | ts.JsxSelfClosingElement): boolean => {
      for (const attr of (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) return false // spanStyle says spreads aren't supported
        const name = attr.name.getText(sf)
        if (name === "key") continue
        if (name in EventKind) return true
        const init = attr.initializer
        if (init && ts.isJsxExpression(init) && init.expression && fold(init.expression, scope) === NOT_STATIC) return true
      }
      return ts.isJsxElement(el) && needsRuntimeSpans(el.children)
    }
    for (const k of kids) {
      if (ts.isJsxExpression(k) && k.expression) {
        let jsx = isJsx(unwrap(k.expression))
        forEachDescendant(k.expression, (n) => {
          if (isJsx(n)) jsx = true
        })
        if (jsx) return true
      } else if ((ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k)) && tagName(k) === "Text" && dynamicSpan(k)) {
        return true
      }
    }
    return false
  }

  /**
   * A <Text> whose spans change at runtime (registry 16, core text-spans.ts). Its children become one JS expression:
   * text and `{expressions}` as they are, each nested <Text> as `span(style, onPress, children)` (also inside `.map`,
   * `&&` and `? :`). `runs()` flattens it, in a computed, into two slots: the spans' texts joined by U+001F and their
   * styles as JSON, the same form as build-time spans. A span's onPress comes back on onSpanPress with its index.
   * Before JS runs the text is empty.
   */
  function runtimeSpans(node: ts.Node, kids: ts.NodeArray<ts.JsxChild>, props: Record<string, unknown>, b: Builder) {
    if ("text" in props) fail(node, "use either the text prop or children, not both")
    const keys = SPAN_STYLE_KEYS
    let press = false
    const checkStatic = (v: unknown, at: ts.Node) => {
      if (v === null || v === undefined || v === false) return
      if (Array.isArray(v)) return v.forEach((x) => checkStatic(x, at))
      if (typeof v !== "object") fail(at, "style entries must be objects")
      for (const k of Object.keys(v as object)) {
        if (!keys.includes(k)) fail(at, `"${k}" isn't supported on a nested <Text> span (use ${keys.join(", ")})`)
      }
    }
    const children = (list: ts.NodeArray<ts.JsxChild>): string => {
      const out: string[] = []
      for (const c of list) {
        if (ts.isJsxText(c)) {
          const t = jsxText(c.text)
          if (t) out.push(JSON.stringify(t))
        } else if (ts.isJsxExpression(c)) {
          if (c.expression) out.push(spliced(c.expression))
        } else if (ts.isJsxFragment(c)) {
          out.push(`[${children(c.children)}]`)
        } else if ((ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && tagName(c) === "Text") {
          out.push(spanCall(c))
        } else {
          fail(c, "<Text> can only contain text, {expressions} and nested <Text> spans")
        }
      }
      return out.join(", ")
    }
    const spanCall = (el: ts.JsxElement | ts.JsxSelfClosingElement): string => {
      const style: string[] = []
      let onPress = "undefined"
      for (const attr of (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
        const a = attr as ts.JsxAttribute
        const name = a.name.getText(sf)
        if (name === "key") continue
        const init = a.initializer
        const expr = init && ts.isJsxExpression(init) ? init.expression : undefined
        const code =
          !init ? "true"
          : ts.isStringLiteral(init) ? JSON.stringify(init.text)
          : expr ? spliced(expr)
          : fail(a, `unsupported value for "${name}"`)
        if (name === "onPress") {
          press = true
          onPress = code
          continue
        }
        if (name in EventKind) fail(a, `${name} on a nested <Text> span isn't supported (only onPress)`)
        if (name === "style") {
          if (expr) {
            const v = fold(expr, scope)
            if (v !== NOT_STATIC) checkStatic(v, a)
          }
          style.push(code)
        } else if (keys.includes(name)) {
          style.push(`{ ${JSON.stringify(name)}: ${code} }`)
        } else {
          fail(a, `"${name}" isn't supported on a nested <Text> span (use ${keys.join(", ")}, or onPress)`)
        }
      }
      const inner = ts.isJsxElement(el) ? children(el.children) : ""
      return `${RUNTIME}.span([${style.join(", ")}], ${onPress}, [${inner}])`
    }
    // An expression as written, with each JSX in it (a span, or a fragment of spans) replaced by its span call.
    const spliced = (e: ts.Expression): string => {
      const jsx: ts.Node[] = []
      const visit = (n: ts.Node) => {
        if (isJsx(n)) jsx.push(n)
        else ts.forEachChild(n, visit)
      }
      visit(e)
      let out = ""
      let at = e.getStart(sf)
      for (const j of jsx) {
        const start = j.getStart(sf)
        if (start > at) out += markCopied(at, source.slice(at, start))
        if (ts.isJsxFragment(j)) out += `[${children(j.children)}]`
        else if (tagName(j as ts.JsxElement) === "Text") out += spanCall(j as ts.JsxElement)
        else fail(j, `<${tagName(j as ts.JsxElement)}> can't be inside <Text>: only nested <Text> spans`)
        at = j.getEnd()
      }
      if (e.getEnd() > at) out += markCopied(at, source.slice(at, e.getEnd()))
      return out
    }

    const code = children(kids)
    const r = `__znr${b.slots}`
    const text = `s${b.slots++}`
    const spans = `s${b.slots++}`
    props.text = slotRef(text, "") as never
    props.spans = slotRef(spans, "[]") as never
    b.binds.push(`const ${r} = ${RUNTIME}.computed(() => ${RUNTIME}.runs([${code}]));`)
    b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${text}@@, () => ${r}().text, 0);`)
    b.binds.push(`${RUNTIME}.slot(${b.inst}, @@S:${spans}@@, () => ${r}().spans, 0);`)
    if (press) {
      const ev = `e${b.events++}`
      props.onSpanPress = eventRef(ev)
      b.binds.push(`${RUNTIME}.on(${b.inst}, @@E:${ev}@@, (__znPayload) => ${RUNTIME}.pressSpan(${r}(), __znPayload));`)
    }
  }

  /**
   * A nested <Text>'s own style, for its span. Build-time values only, and only what a span can change: colour, size,
   * weight, italic, underline / line-through, letter spacing, background. Values go to native as in templates
   * (colours as ARGB numbers, enums as their numbers).
   */
  function spanStyle(node: ts.JsxElement | ts.JsxSelfClosingElement): Record<string, unknown> {
    const allowed = SPAN_STYLE_KEYS
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
    if (tagName(node) === "RefreshControl" && !userComponents.has("RefreshControl")) {
      fail(node, "<RefreshControl> goes in refreshControl={...} on a vertical <Scroll> or a <List>")
    }
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    const parts: string[] = []
    // `icon={c ? <A/> : null}`: a getter that gives the branch's function, or null. The functions are made once (the
    // arguments of a wrapper call), so the child shows the same View again until the branch really changes.
    const thunks: string[] = []
    const pick = (x: ts.Expression): string => {
      const u = seeThrough(x)
      if (isNullish(u)) return "null"
      if (isJsx(u)) {
        thunks.push(`() => ${compileRoot(u as JsxNode, depth).code}`)
        return `__zp${depth}_${thunks.length - 1}`
      }
      if (ts.isConditionalExpression(u)) return `(${text(u.condition)}) ? ${pick(u.whenTrue)} : ${pick(u.whenFalse)}`
      if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return `(${text(u.left)}) ? ${pick(u.right)} : null`
      }
      return fail(u, "a branch must be JSX or null")
    }
    for (const attr of opening.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) fail(attr, "spread props aren't supported")
      const a = attr as ts.JsxAttribute
      const name = a.name.getText(sf)
      if (name === "key") continue
      if (name === "children") fail(a, "write children between the tags: <Card>...</Card>")
      const init = a.initializer
      const jsx = init && ts.isJsxExpression(init) && init.expression && isJsxValue(init.expression) ? seeThrough(init.expression) : null
      if (!init) parts.push(`${JSON.stringify(name)}: true`)
      else if (ts.isStringLiteral(init)) parts.push(`${JSON.stringify(name)}: ${JSON.stringify(decodeEntities(init.text))}`)
      else if (jsx && isJsx(jsx)) parts.push(`${JSON.stringify(name)}: () => ${compileRoot(jsx as JsxNode, depth).code}`)
      else if (jsx) parts.push(`get ${JSON.stringify(name)}() { return ${pick(jsx)} }`)
      // A handler prop made by a call (`onPress={once(pay)}`): made once, as on an element (handlerCode).
      else if (ts.isJsxExpression(init) && init.expression && /^on[A-Z]/.test(name) && isHandlerCall(init.expression)) {
        parts.push(`${JSON.stringify(name)}: (${text(init.expression)})`)
      }
      else if (ts.isJsxExpression(init) && init.expression) parts.push(`get ${JSON.stringify(name)}() { return (${text(init.expression)}) }`)
      else fail(a, `unsupported value for "${name}"`)
    }
    if (ts.isJsxElement(node) && node.children.some((c) => !(ts.isJsxText(c) && c.text.trim() === "") && !(ts.isJsxExpression(c) && !c.expression))) {
      parts.push(`"children": () => ${compileChildren(node, node.children, depth)}`)
    }
    if (thunks.length === 0) return `{ ${parts.join(", ")} }`
    const names = thunks.map((_, i) => `__zp${depth}_${i}`)
    return `((${names.join(", ")}) => ({ ${parts.join(", ")} }))(${thunks.join(", ")})`
  }

  function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
    const t = (ts.isJsxElement(node) ? node.openingElement : node).tagName
    if (!ts.isIdentifier(t)) fail(t, "only plain component names are supported (no Foo.Bar)")
    return (t as ts.Identifier).text
  }
}

// ---- Helpers ------------------------------------------------------------------------------------------------------

/** What each `.d.svg.ts` written in this process holds, so it is written again only when it changes. */
const svgTypes = new Map<string, string>()

/**
 * Writes `logo.d.svg.ts` next to `logo.svg` (docs/svg.md §16): the file's part names as a type, so `parts`
 * autocompletes in the editor (TypeScript's allowArbitraryExtensions). Made again on every build; never committed.
 * A folder that can't be written (a read-only checkout) only loses the types.
 */
function writeSvgTypes(path: string, svg: CompiledSvg) {
  const names = [...svg.parts.keys()].filter((k) => !k.startsWith("zn-anim-")).sort()
  const file = path.replace(/\.svg$/i, ".d.svg.ts")
  const base = path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1)
  const text =
    `// Made by the zero-native build from ${base}: its part names, for \`parts\` (docs/svg.md §16). Don't edit or commit.\n` +
    `import type { SvgFile } from "@zero-native/ui"\n` +
    `declare const svg: SvgFile<${names.length > 0 ? names.map((n) => JSON.stringify(n)).join(" | ") : "never"}>\n` +
    `export default svg\n`
  if (svgTypes.get(file) === text) return
  svgTypes.set(file, text)
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return
    writeFileSync(file, text)
  } catch {
    // No types; the build still checks the part names.
  }
}

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

function isNullish(x: ts.Expression): boolean {
  const u = unwrap(x)
  return u.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(u) && u.text === "undefined")
}

/** [n] lies within [container] (both from the same file). */
function inside(n: ts.Node, container: ts.Node): boolean {
  return n.pos >= container.pos && n.end <= container.end
}

function isAssignmentOp(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/** [id] is written to: `x = ...`, `x += ...`, `x++`. */
function isAssigned(id: ts.Identifier): boolean {
  let n: ts.Node = id
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent
  const p = n.parent
  if (ts.isBinaryExpression(p) && p.left === n && isAssignmentOp(p.operatorToken.kind)) return true
  return (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
}

/** [id] reads a variable (or names a JSX tag): not a property name, a declaration's own name, a label or a type. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (ts.isQualifiedName(p) || ts.isJsxAttribute(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) ||
    ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === id) return false
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false
  // `export { x }` / `export { x as y }` reads x; y is only the exported name.
  if (ts.isExportSpecifier(p)) return p.propertyName ? p.propertyName === id : true
  for (let n: ts.Node | undefined = p; n && !ts.isSourceFile(n); n = n.parent) if (ts.isTypeNode(n)) return false
  return true
}

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void, stopAtFunctions = false) {
  const walk = (n: ts.Node) => {
    visit(n)
    if (stopAtFunctions && n !== node && ts.isFunctionLike(n)) return
    ts.forEachChild(n, walk)
  }
  ts.forEachChild(node, walk)
}

/** Built-in methods called with no arguments: not signal reads (checkOnceTraps). */
const NOT_SIGNAL_METHODS = new Set([
  "toString", "toLocaleString", "valueOf", "trim", "trimStart", "trimEnd", "toUpperCase", "toLowerCase", "toFixed",
  "toISOString", "toJSON", "getTime", "getDate", "getDay", "getMonth", "getFullYear", "getHours", "getMinutes",
  "keys", "values", "entries", "slice", "reverse", "sort", "pop", "shift", "flat", "join", "now", "random", "create",
])
/** Built-in objects: `Date.now()`, `Math.random()` are not signal reads (checkOnceTraps). */
const NOT_SIGNAL_OBJECTS = new Set(["Date", "Math", "JSON", "Object", "Number", "String", "Array", "Promise", "console", "StyleSheet"])

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
