// App fonts (registry 24, compiler/src/fonts.ts): the font table from assets/fonts, fontFamily in templates and
// spans, and the build's name check.
import { describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"
import { fontFamilyProblem, readFontInfo, scanFonts, splitFontName } from "../src/fonts"
import { znBuild } from "../src/plugin"

const SAMPLE_FONTS = join(import.meta.dir, "../../examples/sample/assets/fonts")

/** A minimal sfnt with an OS/2 table (weight, fsSelection) and optionally an fvar table. */
function fakeFont(weight: number, italic = false, variable = false): Uint8Array {
  const tables: [string, Uint8Array][] = []
  const os2 = new Uint8Array(96)
  new DataView(os2.buffer).setUint16(4, weight)
  new DataView(os2.buffer).setUint16(62, italic ? 1 : 0x40)
  tables.push(["OS/2", os2])
  if (variable) tables.push(["fvar", new Uint8Array(16)])
  const head = 12 + tables.length * 16
  const size = head + tables.reduce((n, [, t]) => n + t.length, 0)
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x00010000)
  v.setUint16(4, tables.length)
  let at = head
  tables.forEach(([tag, t], i) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = tag.charCodeAt(k)
    v.setUint32(12 + i * 16 + 8, at)
    v.setUint32(12 + i * 16 + 12, t.length)
    out.set(t, at)
    at += t.length
  })
  return out
}

function compile(src: string) {
  const templates: NodeSpec[] = []
  const fonts: string[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
    fontFamily: (name: string, where: string) => void fonts.push(`${name} ${where}`),
  }
  const out = compileModule(src, "test.tsx", ctx)
  return { ...out, templates, fonts }
}

describe("font file names", () => {
  test("weight and italic words come off the family name", () => {
    expect(splitFontName("Poppins-SemiBoldItalic")).toEqual({ family: "Poppins", weight: 600, italic: true })
    expect(splitFontName("Poppins-Regular")).toEqual({ family: "Poppins", weight: 400, italic: false })
    expect(splitFontName("Inter_bold_italic")).toEqual({ family: "Inter", weight: 700, italic: true })
    expect(splitFontName("Inter_italic")).toEqual({ family: "Inter", weight: undefined, italic: true })
    expect(splitFontName("PlusJakartaSans-ExtraBold")).toEqual({ family: "PlusJakartaSans", weight: 800, italic: false })
    expect(splitFontName("Mukta-ExtraLight")).toEqual({ family: "Mukta", weight: 200, italic: false })
    expect(splitFontName("SpaceMono")).toEqual({ family: "SpaceMono", weight: undefined, italic: false })
    expect(splitFontName("Bold")).toEqual({ family: "Bold", weight: undefined, italic: false })
    expect(splitFontName("lato-black")).toEqual({ family: "lato", weight: 900, italic: false })
  })
})

describe("reading a font file", () => {
  test("OS/2 weight and italic", () => {
    expect(readFontInfo(fakeFont(600))).toEqual({ weight: 600, italic: false, variable: false })
    expect(readFontInfo(fakeFont(400, true))).toEqual({ weight: 400, italic: true, variable: false })
    expect(readFontInfo(fakeFont(7)).weight).toBe(700) // old 1-9 scale
    expect(readFontInfo(fakeFont(400, false, true)).variable).toBe(true)
  })
  test("not a font, or a collection, is refused", () => {
    expect(() => readFontInfo(new TextEncoder().encode("hello, this is text"))).toThrow("not a TrueType / OpenType font")
    const ttc = fakeFont(400)
    ttc.set([0x74, 0x74, 0x63, 0x66], 0)
    expect(() => readFontInfo(ttc)).toThrow("font collection")
  })
  test("the sample's real fonts", () => {
    const table = scanFonts(SAMPLE_FONTS)!
    expect(table.Inconsolata.map((f) => [f.file, f.weight])).toEqual([
      ["fonts/Inconsolata-Regular.ttf", 400], ["fonts/Inconsolata-Medium.ttf", 500], ["fonts/Inconsolata-SemiBold.ttf", 600],
    ])
    expect(table["Inconsolata-SemiBold"]).toEqual([{ file: "fonts/Inconsolata-SemiBold.ttf", weight: 600, italic: false }])
    expect(table["lato-black"][0].weight).toBe(900)
    expect(table.lato[0].file).toBe("fonts/lato-black.ttf")
  })
})

describe("the font table (scanFonts)", () => {
  const dir = () => {
    const d = join(mkdtempSync(join(tmpdir(), "zn-fonts-")), "fonts")
    mkdirSync(d)
    return d
  }
  test("no folder: no table", () => {
    expect(scanFonts(join(tmpdir(), "zn-no-such-folder-xyz"))).toBeUndefined()
  })
  test("files group into families; the file's own OS/2 weight wins over its name", () => {
    const d = dir()
    writeFileSync(join(d, "Brand-Regular.ttf"), fakeFont(400))
    writeFileSync(join(d, "Brand-Bold.ttf"), fakeFont(700))
    writeFileSync(join(d, "Brand-BoldItalic.otf"), fakeFont(700, true))
    writeFileSync(join(d, "Brand-Heavy.ttf"), fakeFont(850)) // name says 900, the file says 850
    writeFileSync(join(d, "notes.txt"), "not a font")
    const t = scanFonts(d)!
    expect(t.Brand).toEqual([
      { file: "fonts/Brand-Regular.ttf", weight: 400, italic: false },
      { file: "fonts/Brand-Bold.ttf", weight: 700, italic: false },
      { file: "fonts/Brand-BoldItalic.otf", weight: 700, italic: true },
      { file: "fonts/Brand-Heavy.ttf", weight: 850, italic: false },
    ])
    expect(t["Brand-Bold"]).toEqual([{ file: "fonts/Brand-Bold.ttf", weight: 700, italic: false }])
    expect(Object.keys(t)).not.toContain("notes")
  })
  test("two files for one face, a variable font, a bad file: build errors", () => {
    let d = dir()
    writeFileSync(join(d, "Brand-Bold.ttf"), fakeFont(700))
    writeFileSync(join(d, "Brand_bold.ttf"), fakeFont(700))
    expect(() => scanFonts(d)).toThrow("are both Brand weight 700: keep one")
    d = dir()
    writeFileSync(join(d, "Inter[wght].ttf"), fakeFont(400, false, true))
    expect(() => scanFonts(d)).toThrow("is a variable font")
    d = dir()
    writeFileSync(join(d, "Broken.ttf"), "<html>not found</html>")
    expect(() => scanFonts(d)).toThrow("assets/fonts/Broken.ttf: not a TrueType / OpenType font")
  })
  test("a real font copied in works", () => {
    const d = dir()
    copyFileSync(join(SAMPLE_FONTS, "SpaceMono-Regular.ttf"), join(d, "SpaceMono-Regular.ttf"))
    expect(scanFonts(d)).toEqual({
      SpaceMono: [{ file: "fonts/SpaceMono-Regular.ttf", weight: 400, italic: false }],
      "SpaceMono-Regular": [{ file: "fonts/SpaceMono-Regular.ttf", weight: 400, italic: false }],
    })
  })
})

describe("fontFamily names", () => {
  const table = { Inter: [{ file: "fonts/Inter-Regular.ttf", weight: 400, italic: false }] }
  test("app fonts and the phone's fonts are fine", () => {
    for (const n of ["Inter", "System", "sans-serif", "serif", "monospace", "Roboto", "sans-serif-medium"]) {
      expect(fontFamilyProblem(n, table)).toBeNull()
    }
  })
  test("an unknown name says what the app has; a wrong case says the right one", () => {
    expect(fontFamilyProblem("Poppins", table)).toContain("(this app has: Inter)")
    expect(fontFamilyProblem("Poppins", undefined)).toContain("Put the .ttf / .otf files in the app's assets/fonts/ folder")
    expect(fontFamilyProblem("inter", table)).toContain('did you mean "Inter"?')
  })
})

describe("fontFamily in templates", () => {
  test("style, prop and spans; each name is reported with its place", () => {
    const { templates, fonts } = compile(`
      import { Text } from "@zero-native/ui"
      export function F() {
        return (
          <Text style={{ fontFamily: "Inter", fontWeight: "600" }}>
            {"a "}
            <Text style={{ fontFamily: "Inter-Bold" }}>b</Text>
          </Text>
        )
      }`)
    const p = templates[0].props as Record<string, unknown>
    expect(p.fontFamily).toBe("Inter")
    expect(p.fontWeight).toBe(600)
    expect(JSON.parse(p.spans as string)[1]).toEqual({ fontFamily: "Inter-Bold" })
    expect(fonts).toEqual(["Inter test.tsx:5:24", "Inter-Bold test.tsx:7:19"])
  })
  test("on a TextField", () => {
    const { templates } = compile(`
      import { TextField } from "@zero-native/ui"
      export function F() { return <TextField style={{ fontFamily: "Inter" }} /> }`)
    expect((templates[0].props as Record<string, unknown>).fontFamily).toBe("Inter")
  })
  test("from a signal: a build error", () => {
    expect(() => compile(`
      import { Text } from "@zero-native/ui"
      import { signal } from "@zero-native/core"
      export function F() { const f = signal("Inter"); return <Text style={{ fontFamily: f() }}>x</Text> }`))
      .toThrow('"fontFamily" must be known at build time')
  })
  test("not a string: a build error", () => {
    expect(() => compile(`
      import { Text } from "@zero-native/ui"
      export function F() { return <Text style={{ fontFamily: 3 }}>x</Text> }`)).toThrow("fontFamily needs a font name")
  })
})

describe("the app build checks names", () => {
  const build = async (body: string, fonts?: Record<string, { file: string; weight: number; italic: boolean }[]>) => {
    const dir = mkdtempSync(join(tmpdir(), "zn-fontbuild-"))
    const file = join(dir, "screen.tsx")
    writeFileSync(file, `import { Text } from "@zero-native/ui"\nexport function S() { return ${body} }\n`)
    const zn = znBuild({ fonts })
    const out = await Bun.build({ entrypoints: [file], plugins: [zn.plugin], packages: "external", target: "browser" })
    return zn.outputs(await out.outputs[0]!.text())
  }
  const inter = { Inter: [{ file: "fonts/Inter-Regular.ttf", weight: 400, italic: false }] }
  test("a known name builds, and the table goes into the manifest", async () => {
    const out = await build(`<Text style={{ fontFamily: "Inter" }}>x</Text>`, inter)
    expect(out.manifest.fonts).toEqual(inter)
    expect(out.requires.registry).toBe(24)
  })
  test("an unknown name fails with where it is", async () => {
    expect(build(`<Text style={{ fontFamily: "Poppins" }}>x</Text>`, inter)).rejects.toThrow(/screen\.tsx:2:\d+: fontFamily "Poppins": no such font/)
  })
  test("no fonts folder: no fonts in the manifest; system names still build", async () => {
    const out = await build(`<Text style={{ fontFamily: "serif" }}>x</Text>`)
    expect(out.manifest.fonts).toBeUndefined()
  })
})
