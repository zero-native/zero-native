// App fonts (registry 24, guide notes §84): the .ttf / .otf files in <app>/assets/fonts/. The build reads each file's
// weight and italic flag (OS/2 table), groups the files into families by name, and writes the table into the manifest
// (main.zn.ui.json "fonts"). Native picks a face per text from it (ZnFonts.kt). The files are bundle files like the
// app's images, so an OTA update can add or change fonts too.
//
// Names, as in React Native on Android: `fontFamily` is a file name without its extension ("Poppins-SemiBold"), or the
// family name the files share ("Poppins": Poppins-Regular, Poppins-SemiBold, Poppins-BoldItalic, ...), where
// fontWeight and fontStyle pick the face. RN's own suffixes work too: Poppins_bold, Poppins_italic, Poppins_bold_italic.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"

/** One face of a family: its file (a bundle path, "fonts/X.ttf"), weight 100–1000, italic. */
export interface FontFace {
  file: string
  weight: number
  italic: boolean
}

/** Family name → its faces. Also each file name (no extension) → that one face. */
export type FontTable = Record<string, FontFace[]>

/**
 * Names that need no file: the phone's own fonts. "System", "sans-serif" and "Roboto" are the default font; "serif"
 * and "monospace" the phone's; "sans-serif-medium" / "-light" / "-thin" / "-condensed" / "-black" the system faces
 * Android has under these names (as RN Android). An app file with the same name wins.
 */
export const SYSTEM_FONTS: ReadonlySet<string> = new Set([
  "System", "sans-serif", "Roboto", "serif", "monospace",
  "sans-serif-thin", "sans-serif-light", "sans-serif-medium", "sans-serif-black", "sans-serif-condensed",
  "sans-serif-condensed-light", "sans-serif-condensed-medium",
])

const WEIGHT_WORDS: [RegExp, number][] = [
  [/^(?:hairline|thin)$/i, 100],
  [/^(?:extra|ultra)[-_ ]?light$/i, 200],
  [/^light$/i, 300],
  [/^(?:regular|normal|book)$/i, 400],
  [/^medium$/i, 500],
  [/^(?:semi|demi)[-_ ]?bold$/i, 600],
  [/^bold$/i, 700],
  [/^(?:extra|ultra)[-_ ]?bold$/i, 800],
  [/^(?:black|heavy)$/i, 900],
]
const WEIGHT_TAIL =
  /[-_ ]?(hairline|thin|extra[-_ ]?light|ultra[-_ ]?light|light|book|regular|normal|medium|semi[-_ ]?bold|demi[-_ ]?bold|extra[-_ ]?bold|ultra[-_ ]?bold|bold|black|heavy)$/i
const ITALIC_TAIL = /[-_ ]?(?:italic|oblique)$/i

/** "Poppins-SemiBoldItalic" → family "Poppins", weight 600, italic; "Inter_bold" → "Inter", 700. */
export function splitFontName(stem: string): { family: string; weight?: number; italic: boolean } {
  let rest = stem
  let italic = false
  if (ITALIC_TAIL.test(rest) && rest.replace(ITALIC_TAIL, "") !== "") {
    rest = rest.replace(ITALIC_TAIL, "")
    italic = true
  }
  let weight: number | undefined
  const m = WEIGHT_TAIL.exec(rest)
  if (m && m.index > 0) {
    weight = WEIGHT_WORDS.find(([re]) => re.test(m[1]))?.[1]
    rest = rest.slice(0, m.index)
  }
  return { family: rest.replace(/[-_ ]+$/, "") || stem, weight, italic }
}

/**
 * Reads a TrueType / OpenType file's weight (OS/2 usWeightClass) and italic flag (OS/2 fsSelection bit 0), and
 * whether it is a variable font (has an fvar table). Throws with the reason when the file isn't a single font.
 */
export function readFontInfo(bytes: Uint8Array): { weight?: number; italic: boolean; variable: boolean } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12) throw new Error("too short to be a font")
  const tag = v.getUint32(0)
  if (tag === 0x74746366) throw new Error("a font collection (.ttc) holds several fonts: use one .ttf / .otf per face")
  // 0x00010000 TrueType, "OTTO" CFF, "true" old Apple TrueType.
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) throw new Error("not a TrueType / OpenType font")
  const count = v.getUint16(4)
  if (12 + count * 16 > bytes.length) throw new Error("its table list is cut short")
  let weight: number | undefined
  let italic = false
  let variable = false
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16
    const name = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
    const offset = v.getUint32(at + 8)
    const length = v.getUint32(at + 12)
    if (offset + length > bytes.length) throw new Error(`its ${name} table is cut short`)
    if (name === "fvar") variable = true
    if (name === "OS/2" && length >= 64) {
      const w = v.getUint16(offset + 4)
      // A few old fonts store 1–9 here.
      weight = w >= 1 && w <= 9 ? w * 100 : w >= 1 && w <= 1000 ? w : undefined
      italic = (v.getUint16(offset + 62) & 1) === 1
    }
  }
  return { weight, italic, variable }
}

/**
 * The app's font table from [dir] (<app>/assets/fonts), or undefined when the app has no fonts folder. Throws a
 * message for the author when a file can't be used (not a font, a variable font, two files for one face).
 */
export function scanFonts(dir: string): FontTable | undefined {
  if (!existsSync(dir)) return undefined
  const families = new Map<string, FontFace[]>()
  const byStem = new Map<string, FontFace>()
  const files = readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f)).sort()
  for (const f of files) {
    const where = `assets/fonts/${f}`
    let info: ReturnType<typeof readFontInfo>
    try {
      info = readFontInfo(readFileSync(join(dir, f)))
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`)
    }
    if (info.variable) {
      throw new Error(
        `${where} is a variable font: zero-native needs one file per weight (Google Fonts gives them in the static/ folder)`,
      )
    }
    const stem = f.slice(0, -extname(f).length)
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(stem)) {
      throw new Error(`${where}: use letters, digits, "-", "_" and "." in font file names (the name is the fontFamily)`)
    }
    const name = splitFontName(stem)
    const face: FontFace = { file: `fonts/${f}`, weight: info.weight ?? name.weight ?? 400, italic: info.italic || name.italic }
    byStem.set(stem, face)
    const list = families.get(name.family) ?? []
    const same = list.find((x) => x.weight === face.weight && x.italic === face.italic)
    if (same) {
      throw new Error(
        `${where} and ${"assets/" + same.file} are both ${name.family} weight ${face.weight}` +
          `${face.italic ? " italic" : ""}: keep one`,
      )
    }
    list.push(face)
    families.set(name.family, list)
  }
  const table: FontTable = {}
  for (const [family, faces] of [...families].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    table[family] = faces.sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic))
  }
  // A file name is a family of its own (RN Android), unless it already is a family name.
  for (const [stem, face] of byStem) if (!(stem in table)) table[stem] = [face]
  return table
}

/** Why [name] can't be used as a fontFamily with [table], or null when it can. */
export function fontFamilyProblem(name: string, table: FontTable | undefined): string | null {
  if (table && name in table) return null
  if (SYSTEM_FONTS.has(name)) return null
  const known = table ? Object.keys(table) : []
  const near = known.find((k) => k.toLowerCase() === name.toLowerCase())
  if (near) return `fontFamily "${name}": no such font; did you mean "${near}"? (names are case-sensitive)`
  return (
    `fontFamily "${name}": no such font. Put the .ttf / .otf files in the app's assets/fonts/ folder; the name is a ` +
    `file name without ".ttf" or the family the files share` +
    (known.length ? ` (this app has: ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", ..." : ""})` : "") +
    `. The phone's own: ${[...SYSTEM_FONTS].slice(0, 5).join(", ")}`
  )
}
