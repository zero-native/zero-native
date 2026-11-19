// Maps release stack traces back to TSX lines (step 4.8, docs/ota.md §3.7): `bun run ota symbolicate`.
// Pure functions; the CLI finds the source map (core.findMap) and reads the trace.
//
// What it reads, from any of: logcat, ZnJsError.details, Crashlytics (ZnJsError.asThrowable), the update server's
// telemetry. Hermes frames look like `at HomeScreen (main.js:2051:22)`; bundles built before step 4.8 have the build
// folder's full path instead of `main.js`; Crashlytics frames have no column: `at zn.js.HomeScreen(main.js:2051)`.
import { decodeSourceMap, type DecodedMap, lookup } from "@zeronative/compiler/src/sourcemap"

/** The bundle a report names: `<app>_<serial>@<sha>` (ZnJsError.bundleLabel), or null. */
export function bundleIn(text: string): { id: string; sha: string } | null {
  const m = /\b([a-z][a-z0-9-]{0,31}_\d+)@([0-9a-f]{8,64})\b/.exec(text)
  return m ? { id: m[1], sha: m[2] } : null
}

/** A position in main.js: line and column 1-based, as Hermes prints them; col null when the trace has none. */
const FRAME = /((?:[A-Za-z]:)?[^\s():]*main\.(?:js|hbc)):(\d+)(?::(\d+))?/g

/**
 * Rewrites every main.js position in [text] to `<file>:<line>:<col>` of the TSX / TS source, keeping the main.js
 * one after it: `src/HomeScreen.tsx:27:5 (main.js:2051:22)`. [name] turns the map's source names (relative to the
 * app's folder) into what to print. Positions the map doesn't cover stay as they are.
 */
export function symbolicate(text: string, map: DecodedMap | string, name: (source: string) => string = (s) => s): { text: string; mapped: number; frames: number } {
  const m = typeof map === "string" ? decodeSourceMap(JSON.parse(map)) : map
  let mapped = 0
  let frames = 0
  const out = text.replace(FRAME, (whole, _file: string, line: string, col: string | undefined) => {
    frames++
    if (col === undefined) {
      const hit = lineOnly(m, Number(line) - 1)
      if (!hit) return whole
      mapped++
      return `${name(hit.source)}:${hit.line + 1} (main.js:${line})`
    }
    const hit = lookup(m, Number(line) - 1, Number(col) - 1)
    if (!hit) return whole
    mapped++
    return `${name(hit.source)}:${hit.line + 1}:${hit.col + 1} (main.js:${line}:${col})`
  })
  return { text: out, mapped, frames }
}

/**
 * A frame without a column (Crashlytics): the source line that most points on main.js [line] map to. main.js isn't
 * minified, so a line is about one statement; its first point is not used, because Bun maps a line's leading spaces
 * to the end of the statement before it (one line too early).
 */
function lineOnly(m: DecodedMap, line: number): { source: string; line: number } | null {
  const count = new Map<string, number>()
  let best: { source: string; line: number } | null = null
  let bestCount = 0
  for (const seg of m.lines[line] ?? []) {
    if (seg.length < 4) continue
    const key = `${seg[1]}:${seg[2]}`
    const n = (count.get(key) ?? 0) + 1
    count.set(key, n)
    if (n > bestCount) [best, bestCount] = [{ source: m.sources[seg[1]], line: seg[2] }, n]
  }
  return best
}
