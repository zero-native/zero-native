// Nested <Text> spans that change at runtime (registry 16; compile.ts `runtimeSpans`). Authors don't call these: the
// compiler turns a <Text> whose spans come from data (`{parts.map((p) => <Text style={...}>{p.text}</Text>)}`), use a
// condition, have a runtime style or an `onPress` into one `runs([...])` call. Native gets two slots, as for spans
// fixed at build time: the spans' texts joined by U+001F, and their styles as JSON (one entry per span). A span with a
// press handler is marked `"p": 1`; native sends its index back on the Text's onSpanPress event.
import { parseColor } from "./color"
import { reportError } from "./errors"

/** A nested <Text> in a runtime span list: its style, its press handler, its children (text, spans, arrays). */
export interface Span {
  readonly __znSpan: true
  readonly style: unknown
  readonly onPress: unknown
  readonly children: readonly unknown[]
}

/** What one <Text> sends: [text] and [spans] go to native, [press] answers onSpanPress (by span index). */
export interface Runs {
  text: string
  spans: string
  press: ReadonlyArray<(() => void) | null>
}

/** A nested <Text>: called by compiled code. */
export function span(style: unknown, onPress: unknown, children: readonly unknown[]): Span {
  return { __znSpan: true, style, onPress, children }
}

// The registry's enum numbers (packages/template/src/registry.ts Enum; a test compares them).
export const SPAN_FONT_STYLE: Record<string, number> = { normal: 0, italic: 1 }
export const SPAN_DECORATION: Record<string, number> = { none: 0, underline: 1, "line-through": 2 }

type Style = Record<string, number>

/**
 * The span keys native reads (ZnTemplate.kt parseSpans), as native values: colours as ARGB, weights and enums as
 * numbers. Other keys are left out: a span can only change these (the outer <Text> has the rest).
 */
function spanKey(out: Style, key: string, v: unknown): void {
  if (v === undefined || v === null) return
  switch (key) {
    case "color":
    case "backgroundColor":
      out[key] = typeof v === "number" ? v : parseColor(String(v))
      return
    case "fontSize":
    case "letterSpacing":
      if (typeof v === "number") out[key] = v
      return
    case "fontWeight": {
      const n = v === "normal" ? 400 : v === "bold" ? 700 : Number(v)
      if (Number.isFinite(n)) out[key] = Math.min(900, Math.max(100, Math.round(n / 100) * 100))
      return
    }
    case "fontStyle":
      if (String(v) in SPAN_FONT_STYLE) out[key] = SPAN_FONT_STYLE[String(v)]
      return
    case "textDecorationLine":
      if (String(v) in SPAN_DECORATION) out[key] = SPAN_DECORATION[String(v)]
      return
  }
}

/** RN style: an object, an array of them (nested), or falsy entries; later entries win. */
function addStyle(out: Style, style: unknown): void {
  if (!style || typeof style !== "object") return
  if (Array.isArray(style)) {
    for (const s of style) addStyle(out, s)
    return
  }
  for (const [k, v] of Object.entries(style)) spanKey(out, k, v)
}

function isSpan(v: unknown): v is Span {
  return typeof v === "object" && v !== null && (v as Span).__znSpan === true
}

/** Flattens a <Text>'s children (text, numbers, spans, arrays from `.map`) into runs of one style each. */
export function runs(children: readonly unknown[]): Runs {
  const texts: string[] = []
  const styles: Array<Style & { p?: 1 }> = []
  const press: Array<(() => void) | null> = []
  let lastStyle: Style | null = null
  let lastPress: unknown = undefined
  const add = (t: string, style: Style, onPress: unknown) => {
    if (t === "") return
    // Runs next to each other with the same span merge, as nested spans written in place do (compile.ts).
    if (style === lastStyle && onPress === lastPress && texts.length > 0) {
      texts[texts.length - 1] += t
      return
    }
    lastStyle = style
    lastPress = onPress
    texts.push(t)
    const fn = typeof onPress === "function" ? (onPress as () => void) : null
    styles.push(fn ? { ...style, p: 1 } : style)
    press.push(fn)
  }
  const walk = (list: readonly unknown[], style: Style, onPress: unknown) => {
    for (const c of list) {
      // As in React Native: null, undefined and booleans show nothing.
      if (c === null || c === undefined || typeof c === "boolean") continue
      if (Array.isArray(c)) walk(c, style, onPress)
      else if (isSpan(c)) {
        const inner: Style = { ...style }
        addStyle(inner, c.style)
        walk(c.children, inner, c.onPress ?? onPress)
      } else add(String(c), style, onPress)
    }
  }
  walk(children, {}, undefined)
  return { text: texts.join("\u001f"), spans: JSON.stringify(styles), press }
}

/** onSpanPress: runs the handler of span [index] as it was when the text was last built. */
export function pressSpan(r: Runs, index: unknown): void {
  const fn = typeof index === "number" ? r.press[index] : null
  if (!fn) return
  try {
    fn()
  } catch (e) {
    reportError("span onPress", e)
  }
}
