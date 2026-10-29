// Source positions for `zn dev` error screens (ARCHITECTURE §17): a JS stack position in the Hermes bytecode's
// main.js → Bun's bundle source map → the compiler's output for one .tsx file → the line in that .tsx file.
//
// Two small pieces, no dependencies:
//   - LineMap: what compileModule produces. Code copied from the TSX (statements, handlers, expressions) maps
//     exactly; code the compiler generated (view / slot / mount calls) maps to the JSX element it came from.
//   - decodeSourceMap / lookup: reads a standard v3 source map (Bun's) and finds the original position.
// Lines and columns are 0-based inside this file; callers add 1 for display.

export interface Pos {
  line: number
  col: number
}

interface Segment {
  genCol: number
  src: Pos
  /** Copied text: the column moves with the generated column. Generated text: always points at `src`. */
  copied: boolean
}

/** Generated position → TSX position for one compiled file. */
export class LineMap {
  /** Segments per generated line, sorted by column. */
  private readonly lines: Segment[][] = []

  add(genLine: number, genCol: number, src: Pos, copied: boolean): void {
    ;(this.lines[genLine] ??= []).push({ genCol, src, copied })
  }

  lookup(genLine: number, genCol: number): Pos | null {
    for (let line = genLine; line >= 0; line--) {
      const segs = this.lines[line]
      if (!segs || segs.length === 0) continue
      if (line === genLine) {
        let best: Segment | null = null
        for (const s of segs) if (s.genCol <= genCol) best = s
        if (best) return best.copied ? { line: best.src.line, col: best.src.col + (genCol - best.genCol) } : best.src
        continue
      }
      // A line with no segment of its own continues the last segment of an earlier line.
      const last = segs[segs.length - 1]
      return last.copied ? { line: last.src.line + (genLine - line), col: genCol } : last.src
    }
    return null
  }
}

/**
 * Builds the output of a compiled file and its LineMap. `pieces` are, in order: source ranges copied as they are,
 * or generated text. Generated text may contain copied snippets marked by [markCopied].
 */
export function assemble(
  source: string,
  pieces: Array<{ copyFrom: number; text: string } | { generatedAt: number; text: string }>,
): { code: string; map: LineMap } {
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const posOf = (offset: number): Pos => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo, col: offset - lineStarts[lo] }
  }

  const map = new LineMap()
  let code = ""
  let line = 0
  let col = 0
  const emit = (text: string, srcOffset: number | null, at: Pos) => {
    if (text.length === 0) return
    if (srcOffset !== null) {
      // Copied: map the start, and the start of every following line (same column as in the source).
      map.add(line, col, posOf(srcOffset), true)
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) map.add(line + 1, 0, posOf(srcOffset + i + 1), true)
        advance(text.charCodeAt(i))
      }
    } else {
      map.add(line, col, at, false)
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) map.add(line + 1, 0, at, false)
        advance(text.charCodeAt(i))
      }
    }
    code += text
  }
  const advance = (ch: number) => {
    if (ch === 10) {
      line++
      col = 0
    } else {
      col++
    }
  }

  for (const p of pieces) {
    if ("copyFrom" in p) {
      emit(p.text, p.copyFrom, { line: 0, col: 0 })
      continue
    }
    const at = posOf(p.generatedAt)
    // Split generated text on copied-snippet markers: \u0001<offset>\u0002<text>\u0003
    let i = 0
    while (i < p.text.length) {
      const start = p.text.indexOf("\u0001", i)
      if (start < 0) {
        emit(p.text.slice(i), null, at)
        break
      }
      emit(p.text.slice(i, start), null, at)
      const sep = p.text.indexOf("\u0002", start)
      const end = p.text.indexOf("\u0003", sep)
      emit(p.text.slice(sep + 1, end), Number(p.text.slice(start + 1, sep)), at)
      i = end + 1
    }
  }
  return { code, map }
}

/** Marks text copied from the source at [offset], inside generated code (removed again by [assemble]). */
export function markCopied(offset: number, text: string): string {
  return `\u0001${offset}\u0002${text}\u0003`
}

// ---- Standard v3 source maps (Bun's bundle map) -------------------------------------------------------------------

export interface RawSourceMap {
  sources: string[]
  mappings: string
}

/** Per generated line: [genCol, sourceIndex, srcLine, srcCol] entries, sorted by genCol. */
export type DecodedMap = { sources: string[]; lines: Array<Array<[number, number, number, number]>> }

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]))

export function decodeSourceMap(raw: RawSourceMap): DecodedMap {
  const lines: DecodedMap["lines"] = []
  let src = 0
  let srcLine = 0
  let srcCol = 0
  for (const lineText of raw.mappings.split(";")) {
    const entries: Array<[number, number, number, number]> = []
    let genCol = 0
    for (const seg of lineText.split(",")) {
      if (seg.length === 0) continue
      const values: number[] = []
      let value = 0
      let shift = 0
      for (const ch of seg) {
        const digit = B64_VALUE.get(ch)!
        value += (digit & 31) << shift
        if (digit & 32) {
          shift += 5
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1)
          value = 0
          shift = 0
        }
      }
      genCol += values[0]
      if (values.length >= 4) {
        src += values[1]
        srcLine += values[2]
        srcCol += values[3]
        entries.push([genCol, src, srcLine, srcCol])
      }
    }
    lines.push(entries)
  }
  return { sources: raw.sources, lines }
}

/** The original (source, line, col) for a generated position, or null when it maps to nothing. */
export function lookup(map: DecodedMap, line: number, col: number): { source: string; line: number; col: number } | null {
  const entries = map.lines[line]
  if (!entries || entries.length === 0) return null
  let best = entries[0]
  for (const e of entries) if (e[0] <= col) best = e
  return { source: map.sources[best[1]], line: best[2], col: best[3] + Math.max(0, col - best[0]) }
}
