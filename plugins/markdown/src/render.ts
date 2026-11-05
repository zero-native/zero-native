// From parsed blocks to what <Markdown> draws: one row per block, each with its spans' styles worked out in JS.
// Kept apart from the TSX so tests can check it without the compiler.
import { parseInline, parseMarkdown, type Block, type ParseOptions, type Run } from "./parse"

/**
 * The style keys a span can change (core text-spans.ts, guide §18). Other keys are dropped by the runtime, so they
 * are not in this type.
 */
export interface SpanStyle {
  color?: string
  backgroundColor?: string
  fontSize?: number
  fontWeight?: "normal" | "bold" | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
  fontStyle?: "normal" | "italic"
  textDecorationLine?: "none" | "underline" | "line-through"
  letterSpacing?: number
}

/** Per-element looks. Each is added on top of the default for that element (set a key to change it). */
export interface MarkdownStyles {
  h1?: SpanStyle
  h2?: SpanStyle
  h3?: SpanStyle
  h4?: SpanStyle
  h5?: SpanStyle
  h6?: SpanStyle
  strong?: SpanStyle
  em?: SpanStyle
  del?: SpanStyle
  u?: SpanStyle
  code?: SpanStyle
  link?: SpanStyle
  quote?: SpanStyle
  /** The bullet or number of a list item. */
  marker?: SpanStyle
}

/** The default looks: neutral greys and a blue link. An app gives its own colours with `style` and `styles`. */
export const DEFAULTS = {
  text: { color: "#374151", fontSize: 14 },
  h1: { color: "#111827", fontSize: 20, fontWeight: 700 },
  h2: { color: "#111827", fontSize: 18, fontWeight: 700 },
  h3: { color: "#111827", fontSize: 16, fontWeight: 700 },
  h4: { color: "#111827", fontSize: 15, fontWeight: 700 },
  h5: { color: "#111827", fontSize: 14, fontWeight: 700 },
  h6: { color: "#4B5563", fontSize: 14, fontWeight: 600 },
  // Bold keeps the body colour (an app that makes the body green gets green bold); give `styles.strong.color` for a darker one.
  strong: { fontWeight: 700 },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through", color: "#9CA3AF" },
  u: { textDecorationLine: "underline" },
  code: { backgroundColor: "#F3F4F6", color: "#1F2937" },
  link: { color: "#1D4ED8", textDecorationLine: "underline", fontWeight: 600 },
  quote: { fontStyle: "italic", color: "#4B5563" },
  marker: { color: "#6B7280" },
} satisfies Required<MarkdownStyles> & { text: SpanStyle }

/** One span to draw: its text, its style (a list the runtime flattens, later wins) and its link target. */
export interface DrawSpan {
  text: string
  style: Array<SpanStyle | null | undefined>
  href?: string
}

/** One block to draw. `top` is the space above it, in dp (0 for the first block). */
export interface DrawRow {
  key: string
  kind: Block["kind"]
  top: number
  /** Space before a list item's marker: 16 dp per depth. */
  indent: number
  marker: Array<SpanStyle | null | undefined>
  markerText: string
  spans: DrawSpan[]
}

const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const

function runStyle(r: Run, base: Array<SpanStyle | null | undefined>, st: MarkdownStyles): DrawSpan {
  const style: Array<SpanStyle | null | undefined> = [...base]
  if (r.bold) style.push(DEFAULTS.strong, st.strong)
  if (r.italic) style.push(DEFAULTS.em, st.em)
  if (r.underline) style.push(DEFAULTS.u, st.u)
  if (r.strike) style.push(DEFAULTS.del, st.del)
  if (r.code) style.push(DEFAULTS.code, st.code)
  if (r.href !== undefined) style.push(DEFAULTS.link, st.link)
  return r.href !== undefined ? { text: r.text, style, href: r.href } : { text: r.text, style }
}

/** Spans for inline text (one <Text>): <MarkdownText> uses this. */
export function inlineSpans(text: string, style?: SpanStyle | null, styles: MarkdownStyles = {}): DrawSpan[] {
  const base = [DEFAULTS.text, style]
  return parseInline(text).map((r) => runStyle(r, base, styles))
}

const isNumber = (b: Block) => /^\d/.test(b.marker)

/** Space above a block: less between list items and right under a heading, more above a heading. */
function spaceAbove(b: Block, prev: Block | undefined): number {
  if (!prev) return 0
  // Items of one list sit close; a bullet list right after a numbered one (or the other way) is a new list.
  if (b.kind === "li" && prev.kind === "li") return b.depth === 0 && prev.depth === 0 && isNumber(b) !== isNumber(prev) ? 10 : 4
  if (b.kind === "h") return 14
  if (prev.kind === "h") return 6
  return 10
}

/** Markdown text into rows to draw. `style` is the body text's look; `styles` change one element each. */
export function markdownRows(text: string, style?: SpanStyle | null, styles: MarkdownStyles = {}, opts?: ParseOptions): DrawRow[] {
  const blocks = parseMarkdown(text, opts)
  return blocks.map((b, i) => {
    const base: Array<SpanStyle | null | undefined> = [DEFAULTS.text, style]
    if (b.kind === "h") {
      const h = HEADINGS[Math.min(Math.max(b.level, 1), 6) - 1]
      base.push(DEFAULTS[h], styles[h])
    } else if (b.kind === "quote") base.push(DEFAULTS.quote, styles.quote)
    return {
      // Index keys: a new text is a new list of rows, and rows hold no state.
      key: String(i),
      kind: b.kind,
      top: spaceAbove(b, blocks[i - 1]),
      indent: b.depth * 16,
      marker: [DEFAULTS.text, style, DEFAULTS.marker, styles.marker],
      markerText: b.marker,
      spans: b.runs.map((r) => runStyle(r, base, styles)),
    }
  })
}
