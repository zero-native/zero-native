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

/**
 * Colours of the boxes around text: the quote box and its bar on the start side, the code block, the rule line.
 * They can change at runtime (backgroundColor is a runtime prop); their sizes can't.
 */
export interface MarkdownColors {
  quoteBox?: string
  quoteBar?: string
  codeBox?: string
  rule?: string
}

export const DEFAULT_COLORS: Required<MarkdownColors> = {
  quoteBox: "#F3F4F6",
  quoteBar: "#D1D5DB",
  codeBox: "#F3F4F6",
  rule: "#E5E7EB",
}

/**
 * The default looks: neutral greys and a blue link. An app gives its own colours with `style` and `styles`.
 * Heading sizes go with the line heights fixed in Markdown.tsx (22/28, 19/26, 17/24, 15/22, 14/20): a bigger heading
 * font from `styles` keeps that line height.
 */
export const DEFAULTS = {
  text: { color: "#374151", fontSize: 14 },
  h1: { color: "#111827", fontSize: 22, fontWeight: 700 },
  h2: { color: "#111827", fontSize: 19, fontWeight: 700 },
  h3: { color: "#111827", fontSize: 17, fontWeight: 700 },
  h4: { color: "#111827", fontSize: 15, fontWeight: 700 },
  h5: { color: "#111827", fontSize: 14, fontWeight: 700 },
  h6: { color: "#111827", fontSize: 14, fontWeight: 700 },
  // Bold keeps the body colour (an app that makes the body green gets green bold); give `styles.strong.color` for a darker one.
  strong: { fontWeight: 700 },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through", color: "#9CA3AF" },
  u: { textDecorationLine: "underline" },
  code: { backgroundColor: "#F3F4F6", color: "#1F2937" },
  link: { color: "#1D4ED8", textDecorationLine: "underline", fontWeight: 600 },
  quote: { color: "#4B5563" },
  marker: { color: "#9CA3AF" },
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
  /** A heading's level, 1 to 6 (0 for other kinds): picks its line height. */
  level: number
  /** A numbered list item ("1."), not a bullet. */
  numbered: boolean
  /** Space before a list item's marker: `spacing.indent` per depth. */
  indent: number
  /** A list item's marker column: `spacing.numberWidth` for numbers, `spacing.markerWidth` for bullets. */
  markerWidth: number
  marker: Array<SpanStyle | null | undefined>
  markerText: string
  spans: DrawSpan[]
}

/**
 * The space around blocks, in dp. All of it is per-edge padding on one node (a runtime prop), so it can change at
 * runtime with no new template. Line heights, corner radius and the quote bar's width stay fixed (README "Limits").
 */
export interface MarkdownSpacing {
  /** Between blocks (paragraphs, lists, quotes, code). */
  blockGap?: number
  /** Between items of one list. */
  itemGap?: number
  /** Above a heading (not when it is first). */
  headingTop?: number
  /** Under a heading (the space above the next block). */
  headingBottom?: number
  /** Above and below a rule line. */
  ruleGap?: number
  /** A bullet's column: the dot and the gap before the text. */
  markerWidth?: number
  /** A number's column ("10." fits in 24). */
  numberWidth?: number
  /** Indent per list level. */
  indent?: number
  /** Quote box padding: from the bar to the text and at the end side, and at the top and bottom. */
  quotePaddingX?: number
  quotePaddingY?: number
  /** Code box padding on all sides. */
  codePadding?: number
}

/** The default spacing (second-opinions 142): chosen for reading a phone screen, not copied from RN. */
export const DEFAULT_SPACING: Required<MarkdownSpacing> = {
  blockGap: 14,
  itemGap: 10,
  headingTop: 16,
  headingBottom: 6,
  ruleGap: 12,
  markerWidth: 16,
  numberWidth: 24,
  indent: 16,
  quotePaddingX: 12,
  quotePaddingY: 8,
  codePadding: 12,
}

/** The app's spacing on top of the defaults; a key that isn't a number (or is below 0) keeps its default. */
export function spacingOf(s?: MarkdownSpacing | null): Required<MarkdownSpacing> {
  const out = { ...DEFAULT_SPACING }
  if (!s) return out
  for (const k of Object.keys(out) as Array<keyof MarkdownSpacing>) {
    const v = s[k]
    // No negative padding in zn (a build error for written values; here it would reach native at runtime).
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
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

/**
 * Space above a block (second-opinions 142): headingTop above a heading and headingBottom under it, so a heading sits
 * with its text; ruleGap on both sides of a rule line; itemGap between items of one list; blockGap between other
 * blocks. Nothing under the last one.
 */
function spaceAbove(b: Block, prev: Block | undefined, prevTop: Block | undefined, sp: Required<MarkdownSpacing>): number {
  if (!prev) return 0
  if (b.kind === "h") return sp.headingTop
  if (b.kind === "hr" || prev.kind === "hr") return sp.ruleGap
  if (prev.kind === "h") return sp.headingBottom
  // Items of one list sit close. A top item whose kind (bullet or number) differs from the list's last top item starts
  // a new list, even when nested items came between.
  if (b.kind === "li" && prev.kind === "li") {
    return b.depth === 0 && prevTop !== undefined && isNumber(b) !== isNumber(prevTop) ? sp.blockGap : sp.itemGap
  }
  return sp.blockGap
}

/**
 * Markdown text into rows to draw. `style` is the body text's look; `styles` change one element each; `spacing`
 * changes the space around blocks.
 */
export function markdownRows(
  text: string,
  style?: SpanStyle | null,
  styles: MarkdownStyles = {},
  opts?: ParseOptions,
  spacing?: MarkdownSpacing | null,
): DrawRow[] {
  const sp = spacingOf(spacing)
  const blocks = parseMarkdown(text, opts)
  // The last top-level item of the list being drawn (undefined outside a list).
  let lastTop: Block | undefined
  return blocks.map((b, i) => {
    const prevTop = lastTop
    lastTop = b.kind !== "li" ? undefined : b.depth === 0 ? b : lastTop
    const base: Array<SpanStyle | null | undefined> = [DEFAULTS.text, style]
    if (b.kind === "h") {
      const h = HEADINGS[Math.min(Math.max(b.level, 1), 6) - 1]
      base.push(DEFAULTS[h], styles[h])
    } else if (b.kind === "quote") base.push(DEFAULTS.quote, styles.quote)
    const numbered = isNumber(b)
    return {
      // Index keys: a new text is a new list of rows, and rows hold no state.
      key: String(i),
      kind: b.kind,
      top: spaceAbove(b, blocks[i - 1], prevTop, sp),
      level: b.kind === "h" ? Math.min(Math.max(b.level, 1), 6) : 0,
      numbered,
      indent: b.depth * sp.indent,
      markerWidth: numbered ? sp.numberWidth : sp.markerWidth,
      marker: [DEFAULTS.text, style, DEFAULTS.marker, styles.marker],
      markerText: b.marker,
      spans: b.runs.map((r) => runStyle(r, base, styles)),
    }
  })
}
