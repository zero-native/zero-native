// A small Markdown parser for server text (offer details, notifications). Pure JS, no library, no HTML.
// It reads the parts ZeroBill's React Native MarkDownView read, and gives plain data: blocks of runs. The <Markdown>
// component draws each block as one native <Text> with spans (registry 16).
//
// Safety: nothing here runs or loads anything. HTML tags stay as text (only <u>...</u> and <br> are read, as the RN
// view did). Images are not loaded: `![alt](url)` shows its alt text. A link is only a run with an `href`: the app
// decides what a tap does (onLinkPress).
//
// Speed: every search is bounded (a link label, a link target and a code span have a length limit; a delimiter
// that found no closer is not searched again), so long or broken text stays linear, not quadratic.

/** A piece of text with one look. The flags add up: a bold link inside italics is `{ bold, italic, href }`. */
export interface Run {
  text: string
  bold?: true
  italic?: true
  strike?: true
  underline?: true
  code?: true
  /** The link target as written (trimmed). Only set by [text](url) and <https://...>. The app checks it before opening. */
  href?: string
}

/**
 * One block: a paragraph, a heading, a list item, a quote, a code block or a line.
 * All kinds have the same fields, so a `.map` over blocks can pick a template by `kind`.
 */
export interface Block {
  kind: "p" | "h" | "li" | "quote" | "code" | "hr"
  /** Heading level 1 to 6 (0 for other kinds). */
  level: number
  /** List depth: 0 for a top item, 1 for an item under it, up to 3 (0 for other kinds). */
  depth: number
  /** A list item's marker: "•" or "1." (empty for other kinds). */
  marker: string
  runs: Run[]
}

export interface ParseOptions {
  /** Longer text is cut here before parsing (default 20000 characters). */
  maxChars?: number
  /** At most this many blocks (default 200); the rest is dropped. A `.map` of blocks is for short text. */
  maxBlocks?: number
}

type Flags = Omit<Run, "text">

const MAX_NEST = 6
const MAX_LABEL = 500
const MAX_URL = 2000
const MAX_CODE = 1000
const BULLETS = ["•", "◦", "▪", "▪"]

/** Inline Markdown (one paragraph's text) into runs. Newlines stay as newlines. */
export function parseInline(text: string): Run[] {
  const out: Run[] = []
  inline(typeof text === "string" ? text : "", {}, out, 0)
  return out
}

function push(out: Run[], text: string, f: Flags): void {
  if (text === "") return
  const last = out[out.length - 1]
  if (
    last &&
    last.bold === f.bold &&
    last.italic === f.italic &&
    last.strike === f.strike &&
    last.underline === f.underline &&
    last.code === f.code &&
    last.href === f.href
  ) {
    last.text += text
    return
  }
  const r: Run = { text }
  if (f.bold) r.bold = true
  if (f.italic) r.italic = true
  if (f.strike) r.strike = true
  if (f.underline) r.underline = true
  if (f.code) r.code = true
  if (f.href !== undefined) r.href = f.href
  out.push(r)
}

const ESCAPABLE = "\\`*_{}[]()#+-.!~>|<"
const isSpace = (c: string | undefined) => c === undefined || c === " " || c === "\t" || c === "\n"
// A letter or digit. Anything past ASCII counts too (Hindi, ₹...): `_` inside such a word stays text. No \p{L}: keep
// the regex simple for Hermes.
const isWord = (c: string | undefined) => c !== undefined && (/[A-Za-z0-9]/.test(c) || c.charCodeAt(0) > 0x7f)

/** Where a backtick run that starts at [i] ends (the index after its closer), or -1. */
function codeEnd(s: string, i: number): number {
  let n = 0
  while (s[i + n] === "`") n++
  const fence = "`".repeat(n)
  const limit = i + n + MAX_CODE
  let j = s.indexOf(fence, i + n)
  while (j !== -1 && j <= limit) {
    // The closer must be exactly n backticks long.
    let k = j
    while (s[k] === "`") k++
    if (k - j === n) return k
    j = s.indexOf(fence, k)
  }
  return -1
}

/**
 * The closer for an emphasis delimiter [d] whose text starts at [from], or -1. Skips escapes, code spans and other
 * runs of the same character, so `*a **b** c*` closes at the last `*`. A run of three closes both `*` and `**`.
 */
function findClose(s: string, from: number, d: string): number {
  const ch = d[0]
  let j = from
  while (j < s.length) {
    const c = s[j]
    if (c === "\\") {
      j += 2
      continue
    }
    if (c === "`") {
      const e = codeEnd(s, j)
      if (e !== -1) {
        j = e
        continue
      }
    }
    if (c === ch) {
      let n = 0
      while (s[j + n] === ch) n++
      if (n === d.length || n === 3) {
        // The closer is the run's last d.length characters. It has no space before it; `_` also needs no letter after
        // it (snake_case stays text).
        const at = j + n - d.length
        if (!isSpace(s[j - 1]) && !(ch === "_" && isWord(s[j + n]))) return at
      }
      j += n
      continue
    }
    j++
  }
  return -1
}

/** A link's `(url)` that starts at [i] (s[i] is "("), as [url, index after ")"], or null. */
function linkTarget(s: string, i: number): [string, number] | null {
  let depth = 0
  const end = Math.min(s.length, i + MAX_URL)
  for (let j = i; j < end; j++) {
    const c = s[j]
    if (c === "\\") {
      j++
      continue
    }
    if (c === "\n") return null
    if (c === "(") depth++
    else if (c === ")" && --depth === 0) {
      let url = s.slice(i + 1, j).trim()
      // An optional title: [a](https://x "Title"). The title is dropped.
      const t = url.match(/^(\S+)\s+["'(].*["')]$/)
      if (t) url = t[1]
      if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1)
      return [url, j + 1]
    }
  }
  return null
}

/** The index of the "]" that closes a "[" at [i], or -1. */
function bracketEnd(s: string, i: number): number {
  let depth = 0
  const end = Math.min(s.length, i + MAX_LABEL)
  for (let j = i; j < end; j++) {
    const c = s[j]
    if (c === "\\") {
      j++
      continue
    }
    if (c === "`") {
      const e = codeEnd(s, j)
      if (e !== -1) {
        j = e - 1
        continue
      }
    }
    if (c === "[") depth++
    else if (c === "]" && --depth === 0) return j
  }
  return -1
}

/** `[label](url)` at [i] (s[i] is "["), as [label, url, index after it], or null. */
function link(s: string, i: number): [string, string, number] | null {
  const close = bracketEnd(s, i)
  if (close === -1 || s[close + 1] !== "(") return null
  const target = linkTarget(s, close + 1)
  return target ? [s.slice(i + 1, close), target[0], target[1]] : null
}

function inline(s: string, f: Flags, out: Run[], nest: number): void {
  let buf = ""
  const flush = () => {
    push(out, buf, f)
    buf = ""
  }
  // A delimiter that found no closer once won't find one later in this text either: don't search again.
  const noClose = new Set<string>()
  let i = 0
  while (i < s.length) {
    const c = s[i]

    if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      buf += s[i + 1]
      i += 2
      continue
    }

    if (c === "`") {
      let n = 0
      while (s[i + n] === "`") n++
      const e = noClose.has("`" + n) ? -1 : codeEnd(s, i)
      if (e === -1) {
        noClose.add("`" + n)
        buf += s.slice(i, i + n)
        i += n
        continue
      }
      flush()
      let code = s.slice(i + n, e - n).replace(/\n/g, " ")
      // As in CommonMark: one space on both ends is dropped (so `` ` `` can hold a backtick).
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1)
      push(out, code, { ...f, code: true })
      i = e
      continue
    }

    // An image: only its alt text is shown. Nothing is loaded from server text.
    if (c === "!" && s[i + 1] === "[") {
      const l = link(s, i + 1)
      if (l) {
        buf += l[0]
        i = l[2]
        continue
      }
    }

    if (c === "[" && f.href === undefined && nest < MAX_NEST) {
      const l = link(s, i)
      if (l) {
        flush()
        // [text]() is no link: its text stays as text.
        inline(l[0] === "" ? l[1] : l[0], l[1] === "" ? f : { ...f, href: l[1] }, out, nest + 1)
        i = l[2]
        continue
      }
    }

    if (c === "<") {
      const br = s.slice(i, i + 6).match(/^<br\s*\/?>/i)
      if (br) {
        buf += "\n"
        i += br[0].length
        continue
      }
      if (nest < MAX_NEST && s.slice(i, i + 3).toLowerCase() === "<u>" && !noClose.has("<u>")) {
        const end = s.toLowerCase().indexOf("</u>", i + 3)
        if (end === -1) noClose.add("<u>")
        else {
          flush()
          inline(s.slice(i + 3, end), { ...f, underline: true }, out, nest + 1)
          i = end + 4
          continue
        }
      }
      // An autolink: <https://example.com>.
      const auto = f.href === undefined ? s.slice(i, i + MAX_URL).match(/^<(https?:\/\/[^\s<>]+)>/i) : null
      if (auto) {
        flush()
        push(out, auto[1], { ...f, href: auto[1] })
        i += auto[0].length
        continue
      }
    }

    if ((c === "*" || c === "_" || c === "~") && nest < MAX_NEST) {
      let n = 0
      while (s[i + n] === c) n++
      const d = c === "~" ? (n === 2 ? "~~" : "") : n <= 3 ? c.repeat(n) : ""
      // An opener has text right after it; `_` also needs no letter before it.
      const opens = d !== "" && !isSpace(s[i + n]) && !(c === "_" && isWord(s[i - 1]))
      if (opens && !noClose.has(d)) {
        const close = findClose(s, i + n, d)
        if (close === -1) noClose.add(d)
        else {
          flush()
          const g: Flags =
            d === "~~"
              ? { ...f, strike: true }
              : n === 3
                ? { ...f, bold: true, italic: true }
                : n === 2
                  ? { ...f, bold: true }
                  : { ...f, italic: true }
          inline(s.slice(i + n, close), g, out, nest + 1)
          i = close + n
          continue
        }
      }
      buf += s.slice(i, i + n)
      i += n
      continue
    }

    buf += c
    i++
  }
  flush()
}

// ---- Blocks --------------------------------------------------------------------------------------------------------

const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])[ \t]+(.*)$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const FENCE_END = /^(`{3,}|~{3,})$/

function block(kind: Block["kind"], runs: Run[], level = 0, depth = 0, marker = ""): Block {
  return { kind, level, depth, marker, runs }
}

/** A line's indent in columns (a tab counts as 4). */
function indentOf(line: string): number {
  let n = 0
  for (const c of line) {
    if (c === " ") n++
    else if (c === "\t") n += 4
    else break
  }
  return n
}

/** Hard breaks: a line ending in "\" or two spaces. Lines already keep their newline, so only the marker goes. */
function joinLines(lines: string[]): string {
  return lines
    .map((l, i) => (i < lines.length - 1 ? l.replace(/(\\| {2,})$/, "") : l))
    .join("\n")
    .trim()
}

/**
 * Markdown into blocks. Lines inside a paragraph keep their line breaks (as ZeroBill's RN view did; CommonMark would
 * join them with a space). A list ends at a line that is not an item and not indented under one.
 */
export function parseMarkdown(md: string, opts: ParseOptions = {}): Block[] {
  const maxChars = opts.maxChars ?? 20000
  const maxBlocks = opts.maxBlocks ?? 200
  const src = (typeof md === "string" ? md : "").slice(0, maxChars).replace(/\r\n?/g, "\n")
  const lines = src.split("\n")
  const blocks: Block[] = []
  let para: string[] = []
  let paraKind: "p" | "quote" = "p"
  // An open list item: its lines, depth, marker and indent, so lines indented under it can join it.
  let item: { lines: string[]; depth: number; marker: string; indent: number } | null = null
  // The open list: the indent each depth started at, and the last number at each depth (0: not numbered yet).
  let indents: number[] = []
  let numbers: number[] = []

  const flushPara = () => {
    if (para.length > 0) {
      const text = joinLines(para)
      if (text !== "") blocks.push(block(paraKind, parseInline(text)))
    }
    para = []
    paraKind = "p"
  }
  const flushItem = () => {
    if (item) blocks.push(block("li", parseInline(joinLines(item.lines)), 0, item.depth, item.marker))
    item = null
  }
  const endList = () => {
    flushItem()
    indents = []
    numbers = []
  }

  for (let i = 0; i < lines.length && blocks.length < maxBlocks; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === "") {
      flushPara()
      flushItem()
      // A blank line between items keeps the list (and its numbers); a paragraph after it ends the list.
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      flushPara()
      endList()
      const open = fence[1]
      const body: string[] = []
      for (i++; i < lines.length; i++) {
        const m = lines[i].trim().match(FENCE_END)
        if (m && m[1][0] === open[0] && m[1].length >= open.length) break
        body.push(lines[i])
      }
      blocks.push(block("code", body.length > 0 ? [{ text: body.join("\n"), code: true }] : []))
      continue
    }

    // "Title" then "===" or "---" on the next line: a heading (level 1 or 2).
    const setext = paraKind === "p" && para.length > 0 ? line.match(SETEXT) : null
    if (setext) {
      const runs = parseInline(joinLines(para))
      para = []
      blocks.push(block("h", runs, setext[1][0] === "=" ? 1 : 2))
      continue
    }

    if (HR.test(line)) {
      flushPara()
      endList()
      blocks.push(block("hr", []))
      continue
    }

    const h = line.match(HEADING)
    if (h) {
      flushPara()
      endList()
      const runs = parseInline((h[2] ?? "").trim())
      if (runs.length > 0) blocks.push(block("h", runs, h[1].length))
      continue
    }

    if (trimmed.startsWith(">")) {
      endList()
      if (paraKind !== "quote") flushPara()
      paraKind = "quote"
      para.push(trimmed.replace(/^>[ \t]?/, ""))
      continue
    }

    const li = line.match(ITEM)
    // Inside a paragraph only "1." starts a numbered list ("2023." on a sentence's second line is not an item).
    if (li && !(para.length > 0 && /^\d/.test(li[2]) && !/^1[.)]$/.test(li[2]))) {
      flushPara()
      flushItem()
      const indent = indentOf(line)
      while (indents.length > 0 && indent < indents[indents.length - 1]) {
        indents.pop()
        numbers.pop()
      }
      if ((indents.length === 0 || indent > indents[indents.length - 1] + 1) && indents.length < BULLETS.length) {
        indents.push(indent)
        numbers.push(0)
      }
      const depth = indents.length - 1
      let marker = BULLETS[depth]
      if (/^\d/.test(li[2])) {
        // The first number as written, then counting up (a server that writes "1." on every line gets 1, 2, 3).
        numbers[depth] = numbers[depth] === 0 ? parseInt(li[2], 10) : numbers[depth] + 1
        marker = `${numbers[depth]}.`
      } else numbers[depth] = 0
      item = { lines: [li[3]], depth, marker, indent }
      continue
    }

    // A line indented under an open item joins it (a second line of the same point).
    const open = item as { lines: string[]; indent: number } | null
    if (open && indentOf(line) > open.indent) {
      open.lines.push(trimmed)
      continue
    }

    if (paraKind === "quote") flushPara()
    endList()
    para.push(line.replace(/^[ \t]+/, ""))
  }
  flushPara()
  flushItem()
  return blocks.slice(0, maxBlocks)
}
