// SVG at build time (docs/svg.md): the XML reader, path data, the supported subset and its build errors, the draw data,
// and .svg imports / inline <Svg> in TSX.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type NodeSpec, writeTemplateFile } from "@zeronative/template"
import { compileModule } from "../src/compile"
import { svgReexports } from "../src/plugin"
import { compileSvgFile, compileSvgTree, parseSvgColor } from "../src/svg"
import { type PathCmd, writePath } from "../src/svg-data"
import { arcToCubics, parsePathData, parseTransform, pathBBox, transformPath } from "../src/svg-path"
import { parseSvgXml } from "../src/svg-xml"

const svg = (body: string, attrs = 'viewBox="0 0 24 24"') =>
  compileSvgTree(parseSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`, "t.svg"))
const data = (body: string, attrs?: string) => svg(body, attrs).data
const err = (body: string, attrs?: string) => {
  try {
    svg(body, attrs)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

/** The draw data split into ops: "S ..." / "G ..." / "g" / defs, with each path kept whole. */
function ops(d: string): string[] {
  const out: string[] = []
  const tokens = d.split(/(?<=;)\s|\s(?=(?:S|G|g|LG|RG|K|KP)\b)/)
  for (const t of tokens) if (t.trim() !== "") out.push(t.trim())
  return out
}

describe("XML reader", () => {
  test("elements, attributes, entities, comments, CDATA and positions", () => {
    const root = parseSvgXml(
      `<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY x "y"> ]>\n<!-- hi -->\n<svg a="1 &amp; 2">\n  <g b='&#65;&#x42;'/><![CDATA[ ]]>\n</svg>`,
      "f.svg",
    )
    expect(root.tag).toBe("svg")
    expect(root.attrs.get("a")!.value).toBe("1 & 2")
    expect(root.at).toBe("f.svg:4:1")
    expect(root.children[0]!.attrs.get("b")!.value).toBe("AB")
    expect(root.children[0]!.at).toBe("f.svg:5:3")
  })
  test("errors say where", () => {
    const e = (s: string) => {
      try {
        parseSvgXml(s, "f.svg")
      } catch (x) {
        return (x as Error).message
      }
      return "no error"
    }
    expect(e("<svg><g></svg>")).toContain("closes <g>")
    expect(e('<svg a="1" a="2"/>')).toBe('f.svg:1:12: attribute "a" is written twice')
    expect(e("<svg a=1/>")).toContain("needs quotes")
    expect(e("<svg>&nope;</svg>")).toContain("unknown XML entity")
    expect(e("<svg/><svg/>")).toContain("a second root element")
    expect(e("<svg>")).toContain("has no closing")
  })
})

describe("path data", () => {
  test("all commands become absolute; Q and A are kept; S / T / H / V are made explicit", () => {
    expect(parsePathData("m1 2l3 4h5v6z")).toEqual([["M", 1, 2], ["L", 4, 6], ["L", 9, 6], ["L", 9, 12], ["Z"]])
    expect(parsePathData("M0 0C1 1 2 1 3 0S5-1 6 0")).toEqual([["M", 0, 0], ["C", 1, 1, 2, 1, 3, 0], ["C", 4, -1, 5, -1, 6, 0]])
    expect(parsePathData("M0 0q1 1 2 0t2 0")).toEqual([["M", 0, 0], ["Q", 1, 1, 2, 0], ["Q", 3, -1, 4, 0]])
    expect(parsePathData("M0 0a5 5 0 0110 0")).toEqual([["M", 0, 0], ["A", 5, 5, 0, 0, 1, 10, 0]])
    // Implicit repeats, compact numbers, exponents.
    expect(parsePathData("M1 1 2 2l.5.5-1e1 0")).toEqual([["M", 1, 1], ["L", 2, 2], ["L", 2.5, 2.5], ["L", -7.5, 2.5]])
    // After z the point is the subpath start.
    expect(parsePathData("M5 5l1 0zl0 1")).toEqual([["M", 5, 5], ["L", 6, 5], ["Z"], ["L", 5, 6]])
  })
  test("bad path data fails", () => {
    expect(() => parsePathData("L1 1")).toThrow("must start with M")
    expect(() => parsePathData("M1 1 X")).toThrow('unknown command "X"')
    expect(() => parsePathData("M0 0a1 1 0 2 0 1 1")).toThrow("arc flag")
  })
  test("an arc as cubics ends exactly at its end point; a half circle has its exact box", () => {
    const c = arcToCubics(0, 0, 5, 5, 0, 0, 1, 10, 0)
    expect(c.length).toBe(2)
    expect(c[1]!.slice(-2)).toEqual([10, 0])
    const box = pathBBox([["M", 0, 0], ["A", 5, 5, 0, 0, 1, 10, 0]])!
    expect(box[0]).toBeCloseTo(0)
    expect(box[1]).toBeCloseTo(-5) // sweep 1 from (0,0) to (10,0) goes over the top (y up is negative)
    expect(box[2]).toBeCloseTo(10)
    expect(box[3]).toBeCloseTo(0)
  })
  test("transforms: an arc stays an arc under move / even scale / turn, becomes cubics under a skew", () => {
    const p: PathCmd[] = [["M", 0, 0], ["A", 5, 5, 0, 0, 1, 10, 0]]
    expect(transformPath(p, [2, 0, 0, 2, 1, 1])[1]).toEqual(["A", 10, 10, 0, 0, 1, 21, 1])
    expect(transformPath(p, parseTransform("skewX(30)")).every((c) => c[0] !== "A")).toBe(true)
    expect(transformPath(p, parseTransform("scale(-1 1)")).every((c) => c[0] !== "A")).toBe(true) // mirror
  })
  test("transform lists", () => {
    expect(parseTransform("translate(10)")).toEqual([1, 0, 0, 1, 10, 0])
    expect(parseTransform("translate(1,2) scale(2)")).toEqual([2, 0, 0, 2, 1, 2])
    const r = parseTransform("rotate(90 10 10)")
    expect(r.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 1, -1, 0, 20, 0])
    expect(() => parseTransform("rotate(1 2)")).toThrow("has 2 numbers")
    expect(() => parseTransform("perspective(1)")).toThrow("can't read transform")
  })
  test("written paths are short and read back to the same points (no drift over many relative steps)", () => {
    expect(writePath(parsePathData("M10 10L20 10L20 20L10 20Z"), 2)).toBe("M10 10H20V20H10z")
    expect(writePath(parsePathData("M0 0C1 1 2 1 3 0S5-1 6 0"), 2)).toBe("M0 0C1 1 2 1 3 0S5-1 6 0")
    expect(writePath([["M", 0.5, -0.25]], 2)).toBe("M.5-.25")
    // 500 steps of 0.333 rounded to 1 decimal: the end must still be where the absolute path ends.
    const long: PathCmd[] = [["M", 0, 0]]
    for (let k = 1; k <= 500; k++) long.push(["L", k * 0.333, k % 2])
    const back = parsePathData(writePath(long, 1))
    const last = back[back.length - 1] as [string, number, number]
    expect(last[1]).toBeCloseTo(166.5, 6)
  })
  test("an M after z is always written absolute (Android 9 and older read a relative m from the wrong point)", () => {
    // Two squares; the second starts at 8,2 (start of the first + 6,0 in SVG terms). Relative "m6 0" would be shorter.
    expect(writePath(parsePathData("M2 2h4v4h-4zm6 0h4v4h-4z"), 2)).toBe("M2 2H6V6H2zM8 2h4V6H8z")
    // Without a z before it, a relative m stays allowed (every reader agrees on the point then).
    expect(writePath(parsePathData("M20 20h4m2 0h4"), 2)).toBe("M20 20h4m2 0h4")
  })
})

describe("colours", () => {
  test("hex, rgb(), rgba(), names, transparent", () => {
    expect(parseSvgColor("#fff")).toBe(0xffffffff)
    expect(parseSvgColor("#0f08")).toBe(0x8800ff00)
    expect(parseSvgColor("#102030")).toBe(0xff102030)
    expect(parseSvgColor("#10203040")).toBe(0x40102030)
    expect(parseSvgColor("rgb(255, 0, 0)")).toBe(0xffff0000)
    expect(parseSvgColor("rgba(0,0,255,0.5)")).toBe(0x800000ff)
    expect(parseSvgColor("rgb(100% 0% 0% / 50%)")).toBe(0x80ff0000)
    expect(parseSvgColor("White")).toBe(0xffffffff)
    expect(parseSvgColor("transparent")).toBe(0)
    expect(parseSvgColor("hsl(0, 0%, 0%)")).toBeNull()
  })
})

describe("the supported subset", () => {
  test("a Material icon: currentColor, viewBox 24, 2 decimals", () => {
    const out = svg('<path fill="currentColor" d="m9.55 15.15l8.475-8.475q.3-.3.7-.3"/>')
    expect(out.usesCurrentColor).toBe(true)
    expect(out.width).toBe(24)
    expect(out.data).toBe("Z1 0 0 24 24 4 S c 1 - 1 0 1 0 M9.55 15.15l8.47-8.47q.3-.3.7-.3;")
  })
  test("header: viewBox, size attributes, preserveAspectRatio", () => {
    const out = svg("<rect width='1' height='1'/>", 'viewBox="0 0 100 50" width="200" height="100" preserveAspectRatio="xMaxYMin slice"')
    expect(out.width).toBe(200)
    expect(out.height).toBe(100)
    expect(out.data.startsWith("Z1 0 0 100 50 11 ")).toBe(true)
    expect(svg("<rect width='1' height='1'/>", 'viewBox="0 0 1 1" preserveAspectRatio="none"').data.startsWith("Z1 0 0 1 1 18 ")).toBe(true)
    expect(svg("<rect width='1' height='1'/>", 'width="30" height="20"').data.startsWith("Z1 0 0 30 20 4 ")).toBe(true)
    expect(err("", "")).toContain("needs a viewBox")
    expect(err("", 'viewBox="0 0 0 5"')).toContain("positive width and height")
  })
  test("basic shapes", () => {
    expect(data('<rect x="1" y="2" width="3" height="4" fill="#f00"/>')).toContain("S #FFFF0000 1 - 1 0 1 0 M1 2H4V6H1z;")
    expect(data('<rect width="10" height="10" rx="2"/>')).toContain("M2 0H8a2 2 0 0 1 2 2V8a2 2 0 0 1-2 2H2A2 2 0 0 1 0 8V2A2 2 0 0 1 2 0z;")
    expect(data('<circle cx="12" cy="12" r="10"/>')).toContain("M22 12A10 10 0 0 1 2 12a10 10 0 0 1 20 0z;")
    expect(data('<line x1="0" y1="0" x2="10" y2="10" stroke="#000"/>')).toContain("S - 1 #FF000000 1 0 1 1 0 0 4 0 0 0 M0 0L10 10;")
    expect(data('<polygon points="0,0 10,0 10,10"/>')).toContain("M0 0H10V10z;")
    // Nothing to draw.
    expect(data('<rect width="0" height="5"/><circle r="0"/>')).toBe("Z1 0 0 24 24 4")
  })
  test("inheritance, style=\"...\" over attributes, none", () => {
    expect(data('<g fill="#00f"><path d="M0 0h1v1z"/></g>')).toContain("S #FF0000FF")
    expect(data('<path fill="#00f" style="fill: #f00" d="M0 0h1v1z"/>')).toContain("S #FFFF0000")
    expect(data('<g fill="none" stroke="#000"><path d="M0 0h1"/></g>')).toContain("S - 1 #FF000000 1")
    expect(data('<path fill="none" d="M0 0h1"/>')).toBe("Z1 0 0 24 24 4") // draws nothing: dropped
  })
  test("strokes: width, cap, join, miter, dashes (odd lists repeat), offset", () => {
    const d = data('<path fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="8" stroke-dasharray="4 2 1" stroke-dashoffset="3" d="M0 0h10"/>')
    expect(d).toContain("S - 1 #FF000000 1 0 1 2 1 2 8 6 4 2 1 4 2 1 3 0 M0 0H10;")
    expect(data('<path fill="none" stroke="#000" stroke-width="0" d="M0 0h10"/>')).toBe("Z1 0 0 24 24 4")
  })
  test("opacity: folded into one paint, a layer only for fill + stroke; group opacity moves to an only child", () => {
    expect(data('<path opacity=".5" d="M0 0h1v1z"/>')).toContain("S #FF000000 0.5 - 1 0 1 0")
    expect(data('<path opacity=".5" stroke="#f00" d="M0 0h1v1z"/>')).toContain("S #FF000000 1 #FFFF0000 1 0 0.5")
    expect(data('<g opacity=".5"><path d="M0 0h1v1z"/></g>')).toContain("S #FF000000 0.5 - 1 0 1 0")
    expect(data('<g opacity=".5"><path d="M0 0h1v1z"/><path d="M2 2h1v1z"/></g>')).toMatch(/^Z1 0 0 24 24 4 G 0.5 -1 S .* g$/)
    expect(data('<path fill-opacity="50%" d="M0 0h1v1z"/>')).toContain("S #FF000000 0.5")
  })
  test("transforms are applied to the coordinates; a stroke under a non-uniform scale keeps a matrix", () => {
    expect(data('<g transform="translate(5 5)"><path d="M0 0h1v1z"/></g>')).toContain("M5 5H6V6z;")
    expect(data('<path transform="scale(2)" stroke="#000" stroke-width="1" fill="none" d="M0 0h1"/>')).toContain("S - 1 #FF000000 1 0 1 2 ")
    expect(data('<path transform="scale(2 1)" stroke="#000" fill="none" d="M0 0h1"/>')).toContain(" 1 2 0 0 1 0 0 M0 0H1;")
    expect(data('<path transform="scale(2 1)" d="M0 0h1v1z"/>')).toContain(" 0 M0 0H2V1z;")
  })
  test("linear gradient in object units becomes a matrix over the shape's box; stops get their opacity", () => {
    const d = data(
      '<defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="100%" stop-color="#000" stop-opacity=".5"/></linearGradient></defs>' +
        '<rect x="2" y="4" width="10" height="20" fill="url(#g)"/>',
    )
    expect(d).toContain("LG 0 0 0 1 0 1 10 0 0 20 2 4 2 0 #FFFFFFFF 1 #80000000")
    expect(d).toContain("S @0 1")
  })
  test("radial gradient: object units, href inheritance, one stop is a solid colour; gradients are shared", () => {
    const d = data(
      '<defs><radialGradient id="a" cx="0.38" cy="0.32" r="0.78"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#082F49"/></radialGradient>' +
        '<radialGradient id="b" href="#a" spreadMethod="reflect"/><linearGradient id="one"><stop stop-color="red"/></linearGradient></defs>' +
        '<circle cx="10" cy="10" r="10" fill="url(#b)"/><rect width="20" height="20" fill="url(#b)"/><rect width="1" height="1" fill="url(#one)"/>',
    )
    expect(d).toContain("RG 0.38 0.32 0.78 1 1 20 0 0 20 0 0 2 0 #FFFFFFFF 1 #FF082F49")
    expect(d.match(/RG /g)!.length).toBe(1) // the circle's box and the rect's box are the same: one gradient
    expect(d).toContain("S #FFFF0000 1")
    // Registry 13: a focal point is drawn ("RF").
    expect(data('<defs><radialGradient id="a" fx="0.2"><stop/><stop offset="1"/></radialGradient></defs><rect width="1" height="1" fill="url(#a)"/>'))
      .toContain("RF 0.5 0.5 0.5 0.2 0.5 ")
  })
  test("userSpaceOnUse gradients with % and gradientTransform", () => {
    const d = data(
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="50%" gradientTransform="rotate(90)"><stop/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
        '<rect width="24" height="24" fill="url(#g)"/>',
    )
    expect(d).toContain("LG 0 0 12 0 0 1 0 1 -1 0 0 0 2")
  })
  test("clip paths on groups and shapes; the Figma white mask becomes a clip", () => {
    const d = data('<clipPath id="c"><rect width="5" height="5"/></clipPath><g clip-path="url(#c)"><path d="M0 0h9v9z"/><path d="M1 1h1"/></g>')
    expect(d).toContain("K KP 0 M0 0H5V5H0z;")
    expect(d).toContain("G 1 0 S")
    expect(data('<clipPath id="c"><circle r="3"/><rect width="1" height="1" clip-rule="evenodd"/></clipPath><path clip-path="url(#c)" d="M0 0h9v9z"/>'))
      .toContain("K KP 0 M3 0A3 3 0 0 1-3 0 3 3 0 0 1 3 0z; KP 1 M0 0H1V1H0z; G 1 0 S")
    const m = data('<mask id="m" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><path d="M0 0h24v24H0z" fill="white"/></mask><g mask="url(#m)"><path d="M0 0h9v9z"/></g>')
    expect(m).toContain("K KP 0 M0 0H24V24H0z; G 1 0 S")
    // Registry 13: any other mask is a real mask ("MK").
    expect(data('<mask id="m"><path d="M0 0h1v1z" fill="#888"/></mask><g mask="url(#m)"><path d="M0 0h9v9z"/></g>')).toContain("MK 0 0 ")
    // Registry 13: an objectBoundingBox clip on a group uses the group's box.
    expect(data('<clipPath id="c" clipPathUnits="objectBoundingBox"><rect width="1" height="1"/></clipPath><g clip-path="url(#c)"><path d="M0 0h1v1z"/></g>'))
      .toContain("K KP 0 M0 0H1V1H0z; G 1 0 S")
  })
  test("use and symbol are expanded; the use's id names the part", () => {
    const out = svg('<defs><path id="p" d="M0 0h1v1z"/></defs><use id="u" href="#p" x="5"/><use xlink:href="#p" y="2"/>')
    expect(out.data).toContain("M5 0H6V1z;")
    expect(out.data).toContain("M0 2H1V3z;")
    expect(out.parts.get("u")).toBe(0)
    expect(out.parts.has("p")).toBe(false)
  })
  test("color inside the SVG fixes currentColor at build time", () => {
    const out = svg('<g color="#0f0"><path fill="currentColor" d="M0 0h1v1z"/></g>')
    expect(out.usesCurrentColor).toBe(false)
    expect(out.data).toContain("S #FF00FF00")
  })
  test("parts: every element with an id keeps its own op, in pre-order", () => {
    const out = svg('<g id="ring"><path id="a" d="M0 0h1v1z"/><g><path d="M2 2h1v1z"/></g></g><path id="dot" fill="none" d="M0 0"/>')
    expect([...out.parts]).toEqual([["ring", 0], ["a", 1], ["dot", 3]])
    expect(ops(out.data).filter((o) => /^[SGg]\b/.test(o)).length).toBe(5) // G S S g S
  })
  test("editor data, metadata and ignored hints don't fail the build", () => {
    expect(err(
      '<title>Group 12</title><metadata><rdf:RDF><cc:Work/></rdf:RDF></metadata><sodipodi:namedview/>' +
        '<path data-name="x" shape-rendering="geometricPrecision" inkscape:label="y" style="isolation:isolate;mix-blend-mode:normal" d="M0 0h1v1z"/>',
      'viewBox="0 0 24 24" version="1.1" artist="a" source="b" xml:space="preserve" enable-background="new"',
    )).toBe("no error")
  })
})

describe("the registry 13 corpus: 78 real files (fixtures/svg-features)", () => {
  test("75 compile; the 3 refused on purpose fail with their hint", () => {
    const root = join(import.meta.dir, "fixtures", "svg-features")
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(join(root, d), { withFileTypes: true })) {
        if (f.isDirectory()) walk(`${d}/${f.name}`)
        else if (f.name.endsWith(".svg")) files.push(`${d}/${f.name}`.slice(1))
      }
    }
    walk("")
    const failed: Record<string, string> = {}
    for (const f of files) {
      try {
        expect(compileSvgFile(join(root, f)).data).toStartWith("Z1 ")
      } catch (e) {
        failed[f] = (e as Error).message.replace(/^.*?\.svg:\d+:\d+: /, "").split(" isn't")[0]!
      }
    }
    expect(files.length).toBe(78)
    expect(failed).toEqual({
      "resvg/filters/feComposite/operator=arithmetic.svg": "feComposite arithmetic with k1..k4 = 0.1 0.2 0.3 0.4",
      "resvg/text/text/dx-and-dy-with-multiple-values.svg": "dx with several values (one per character)",
      "resvg/text/text/rotate.svg": "rotate on <text>",
    })
  })
})

describe("refused features fail the build with file:line:col and a hint", () => {
  const cases: Array<[string, string]> = [
    ['<text x="1"><textPath href="#p">Hi</textPath></text>', "<textPath> isn't supported"],
    ['<image href="a.png"/>', "<image> isn't supported"],
    ['<filter id="f"><feTurbulence/></filter><rect width="1" height="1" filter="url(#f)"/>', "<feTurbulence> isn't supported"],
    ["<style>@media (min-width: 1px) { .a{fill:red} }</style>", "@media (min-width: 1px) isn't supported"],
    ['<animate attributeName="x" dur="1s"/>', "animating the <svg> itself isn't supported"],
    ['<foreignObject/>', "<foreignObject> isn't supported"],
    ['<path vector-effect="non-scaling-size" stroke="red" d="M0 0L1 1"/>', `vector-effect="non-scaling-size" isn't supported (only non-scaling-stroke)`],
    ['<path paint-order="bogus" d="M0 0"/>', "paint-order must be normal or a list of fill, stroke, markers"],
    ['<path style="mix-blend-mode:bogus" d="M0 0"/>', 'mix-blend-mode "bogus" isn\'t supported'],
    ['<path foo="1" d="M0 0"/>', 'attribute "foo" isn\'t supported on <path>'],
    ['<blink/>', "<blink> isn't supported"],
    ['<path fill="url(#nope)" d="M0 0h1v1z"/>', 'no element with id "nope"'],
    ['<path fill="url(a.svg#x)" d="M0 0h1v1z"/>', "only local references"],
    ['<g id="a"/><g id="a"/>', 'id "a" is used twice'],
    ['<path fill="hsl(1,2%,3%)" d="M0 0h1v1z"/>', 'can\'t read colour "hsl(1,2%,3%)"'],
    ['<rect width="1em" height="1"/>', "use a plain number"],
    ['<path d="M0 0 Q"/>', "expected a number"],
    ['<path stroke="#000" stroke-linecap="pointy" d="M0 0h1"/>', "stroke-linecap must be one of butt, round, square"],
    ['<path style="font:12px x;foo:1" d="M0 0"/>', 'style property "foo" isn\'t supported'],
    ['<defs><linearGradient id="g"><stop stop-color="currentColor"/><stop/></linearGradient></defs><rect width="1" height="1" fill="url(#g)"/>', "currentColor in a gradient stop"],
  ]
  for (const [body, hint] of cases) {
    test(hint, () => {
      const msg = err(body)
      expect(msg).toContain(hint)
      expect(msg).toMatch(/^t\.svg:1:\d+: /)
    })
  }
})

// ---- TSX -------------------------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "zn-svg-"))
writeFileSync(join(dir, "check.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16l8-8"/></svg>')
writeFileSync(
  join(dir, "logo.svg"),
  '<svg viewBox="0 0 100 50"><g id="ring"><circle cx="25" cy="25" r="20" fill="#047857"/></g><rect id="dot" x="60" width="10" height="10"/></svg>',
)
writeFileSync(join(dir, "bad.svg"), '<svg viewBox="0 0 10 10">\n  <textPath>no</textPath>\n</svg>')

function compile(src: string, statics: Record<string, unknown> = {}, svgs = new Map<string, string>()) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, join(dir, "Screen.tsx"), ctx, new Map(Object.entries(statics)), svgs)
  return { ...out, templates }
}
const tsxErr = (src: string) => {
  try {
    compile(src)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}
const props = (n: NodeSpec) => n.props as Record<string, any>

describe(".svg imports", () => {
  test("<Check /> is one Svg node with the draw data and its own size; the import is gone from the JS", () => {
    const { templates, code } = compile(`import Check from "./check.svg"\nexport function F() { return <Check /> }`)
    expect(templates[0]!.type).toBe("Svg")
    expect(props(templates[0]!).svg).toStartWith("Z1 0 0 24 24 4 S c")
    expect(props(templates[0]!).width).toBe(24)
    expect(props(templates[0]!).height).toBe(24)
    expect(code).not.toContain("check.svg")
  })
  test("size, style width only (height from the aspect ratio), color at runtime", () => {
    const a = compile(`import Logo from "./logo.svg"\nexport function F() { return <Logo size={48} /> }`).templates[0]!
    expect([props(a).width, props(a).height]).toEqual([48, 48])
    const b = compile(`import Logo from "./logo.svg"\nexport function F() { return <Logo style={{ width: 200 }} /> }`).templates[0]!
    expect(props(b).width).toBe(200)
    expect(props(b).aspectRatio).toBe(2)
    const { templates, code } = compile(`import Check from "./check.svg"\nexport function F() { return <Check size={20} color={on() ? "#000" : "#fff"} /> }`)
    expect(props(templates[0]!).color).toEqual({ $slot: "s0", default: null })
    expect(code).toContain("__zn.slot(__i0, 0, () => (on() ? \"#000\" : \"#fff\"), 1);")
  })
  test("parts: static and runtime values become SvgPart children with the element's index", () => {
    const { templates, code } = compile(
      `import Logo from "./logo.svg"\nexport function F() { return <Logo parts={{ ring: { fill: brand() }, dot: { opacity: 0.4, stroke: "#fff" } }} /> }`,
    )
    const [ring, dot] = templates[0]!.children
    expect(ring!.type).toBe("SvgPart")
    expect(props(ring!).part).toBe(0)
    expect(props(ring!).fill).toEqual({ $slot: "s0", default: null })
    expect(props(dot!).part).toBe(2)
    expect(props(dot!).opacity).toBe(0.4)
    expect(props(dot!).stroke).toBe("#fff")
    expect(code).toContain("() => (brand()), 1)")
    // The registry accepts it: fill / stroke can change at runtime since v11.
    expect(writeTemplateFile(templates).registry).toBe(13)
  })
  test("part motion: transforms turn around the part's centre, trims, animate with loops (registry 13)", () => {
    const { templates, code } = compile(`import Logo from "./logo.svg"
export function F() { return <Logo parts={{
  ring: { rotate: 360, animate: { rotate: { duration: 1000, easing: "linear", from: 0, repeat: "forever" } } },
  dot: { trimEnd: progress(), translateX: 4, paused: stopped() },
}} /> }`)
    const [ring, dot] = templates[0]!.children
    // The ring's circle is centred on (25, 25) in viewBox units.
    expect(props(ring!)).toMatchObject({ part: 0, rotate: 360, pivotX: 25, pivotY: 25 })
    expect(props(ring!).animate).toBe("95=t1000e3~f0~r-1")
    // Moving alone needs no pivot.
    expect(props(dot!)).toMatchObject({ part: 2, translateX: 4 })
    expect(props(dot!).pivotX).toBeUndefined()
    expect(props(dot!).trimEnd).toEqual({ $slot: "s0", default: null })
    expect(props(dot!).paused).toEqual({ $slot: "s1", default: null })
    expect(code).toContain("() => (progress()), 0)")
    expect(writeTemplateFile(templates).registry).toBe(13)
    // A scale animated on the dot (a 10 × 10 box at x 60): its centre.
    const s = compile(`import Logo from "./logo.svg"\nexport function F() { return <Logo parts={{ dot: { animate: { scale: { duration: 400, keyframes: [1, 1.2, 1] } } } }} /> }`)
    expect(props(s.templates[0]!.children[0]!)).toMatchObject({ pivotX: 65, pivotY: 5 })
  })
  test("part motion build errors", () => {
    const e = (parts: string) => tsxErr(`import Logo from "./logo.svg"\nexport function F() { return <Logo parts={{ ${parts} }} /> }`)
    expect(e(`ring: { animate: { width: 400 } }`)).toContain('animate: "width" can\'t be animated')
    expect(e(`ring: { animate: pick() }`)).toContain("animate must be known at build time")
    expect(e(`ring: { rotate: 10, animate: { rotate: { duration: 300, repeat: 0 } } }`)).toContain("repeat")
    expect(e(`ring: { rotate: 10, animate: { rotate: { duration: 300, reverse: true } } }`)).toContain("reverse needs repeat")
    expect(e(`ring: { trimEnd: 0.5 }`)).toBe("no error")
  })
  test("node indexes count the parts: a branch after the SVG mounts at the right place", () => {
    const { templates, code } = compile(
      `import Logo from "./logo.svg"\nexport function F() { return <Column><Logo parts={{ ring: { fill: "#000" } }} />{on() && <Text>x</Text>}</Column> }`,
    )
    // Column 0, Svg 1, SvgPart 2, Anchor 3.
    expect(templates[0]!.children.map((c) => c.type)).toEqual(["Svg", "Anchor"])
    expect(code).toContain("__zn.when(__i0, 3,")
  })
  test("build errors: unknown part, color without currentColor, SVG used as a value, children, bad file", () => {
    expect(tsxErr(`import Logo from "./logo.svg"\nexport function F() { return <Logo parts={{ rim: { fill: "#000" } }} /> }`))
      .toContain('Logo has no part "rim" (its parts: ring, dot)')
    expect(tsxErr(`import Logo from "./logo.svg"\nexport function F() { return <Logo color="#000" /> }`)).toContain("this SVG has none")
    expect(tsxErr(`import Logo from "./logo.svg"\nconst x = Logo\nexport function F() { return <Box /> }`)).toContain("not as a value")
    expect(tsxErr(`import Logo from "./logo.svg"\nexport function F() { return <Logo parts={{ ring: { width: 4 } }} /> }`)).toContain("a part can set fill, stroke, opacity")
    expect(tsxErr(`import Logo from "./logo.svg"\nexport function F() { return <Logo foo={1} /> }`)).toContain('unknown prop "foo" on <Logo>')
    expect(tsxErr(`import { x } from "./logo.svg"\nexport function F() { return <Box /> }`)).toContain("default import")
    const bad = tsxErr(`import Bad from "./bad.svg"\nexport function F() { return <Bad /> }`)
    expect(bad).toContain("bad.svg:2:3: <textPath> isn't supported")
    expect(bad).toContain("(used at ")
  })
  test("as a JSX prop it is fine", () => {
    const { code } = compile(`import Check from "./check.svg"\nexport function F() { return <Card icon={<Check size={16} />} /> }\nfunction Card(p: any) { return <Box>{p.icon}</Box> }`)
    expect(code).toContain('"icon": () => __zn.view(')
  })
  test("names re-exported by a .ts file (icons.ts) are SVG files too", () => {
    mkdirSync(join(dir, "icons"), { recursive: true })
    writeFileSync(join(dir, "icons", "index.ts"), 'export { default as Check } from "../check.svg"\nexport { Logo } from "./more"\n')
    writeFileSync(join(dir, "icons", "more.ts"), 'export { default as Logo } from "../logo.svg"\n')
    const src = `import { Check, Logo as L } from "./icons"\nexport function F() { return <Row><Check /><L size={10} /></Row> }`
    const found = svgReexports(src, join(dir, "Screen.tsx"))
    expect([...found.keys()]).toEqual(["Check", "L"])
    const { templates, code } = compile(src, {}, found)
    expect(templates[0]!.children.map((c) => c.type)).toEqual(["Svg", "Svg"])
    expect(code).not.toContain("./icons")
  })
})

describe("inline <Svg>", () => {
  test("the subtree is one node; react-native-svg names and camelCase props", () => {
    const { templates } = compile(`export function F() { return (
      <Svg width={120} height={120} viewBox="0 0 200 200">
        <Defs><RadialGradient id="s" cx="0.5" cy="0.5" r="0.5"><Stop offset="0" stopColor="#fff" stopOpacity={0.4} /><Stop offset="1" stopColor="#000" /></RadialGradient></Defs>
        <Circle cx="100" cy="100" r="96" fill="url(#s)" />
        <Path d="M0 0h10" stroke="#f00" strokeWidth={4} strokeLinecap="round" fill="none" />
      </Svg>) }`)
    const n = templates[0]!
    expect(n.type).toBe("Svg")
    expect(n.children.length).toBe(0)
    expect([props(n).width, props(n).height]).toEqual([120, 120])
    expect(props(n).svg).toContain("RG 0.5 0.5 0.5 0 1 192 0 0 192 4 4 2 0 #66FFFFFF 1 #FF000000")
    expect(props(n).svg).toContain("S - 1 #FFFF0000 1 0 1 4 1 0 4 0 0 0 M0 0H10;")
  })
  test("R30: an absolute Svg sized by start + end (or top + bottom) gets no aspect ratio on that axis", () => {
    const shape = `<Polygon points="0,0 100,0 100,146 0,220" fill="#0a0" />`
    // The receipt header: start + end give the width, height 220; "none" stretches the viewBox to 360 x 220.
    const a = compile(`export function F() { return <Stack><Svg style={{ position: "absolute", top: 0, start: 0, end: 0, height: 220 }} viewBox="0 0 100 220" preserveAspectRatio="none">${shape}</Svg></Stack> }`).templates[0]!.children[0]!
    expect(props(a).height).toBe(220)
    expect(props(a).width).toBeUndefined()
    expect(props(a).aspectRatio).toBeUndefined()
    // Full fill: the Stack's size on both axes.
    const b = compile(`export function F() { return <Stack><Svg style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }} viewBox="0 0 100 220">${shape}</Svg></Stack> }`).templates[0]!.children[0]!
    expect([props(b).width, props(b).height, props(b).aspectRatio]).toEqual([undefined, undefined, undefined])
    // One side only: the viewBox shape still gives the other side, as before.
    const c = compile(`export function F() { return <Svg style={{ height: 220 }} viewBox="0 0 100 220">${shape}</Svg> }`).templates[0]!
    expect(props(c).aspectRatio).toBeCloseTo(100 / 220)
    const d = compile(`export function F() { return <Stack><Svg style={{ position: "absolute", top: 0, start: 0, end: 0 }} viewBox="0 0 100 220">${shape}</Svg></Stack> }`).templates[0]!.children[0]!
    expect(props(d).aspectRatio).toBeCloseTo(100 / 220)
  })
  test("a runtime fill makes the element a part by itself", () => {
    const { templates, code } = compile(`const HEART = "M0 0h10v10z"\nexport function F() { return (
      <Svg viewBox="0 0 10 10" size={24}><Path d={HEART} fill={liked() ? "#f00" : "#999"} /></Svg>) }`)
    const n = templates[0]!
    expect(props(n).svg).toContain("S #00000000 1")
    expect(props(n.children[0]!).part).toBe(0)
    expect(props(n.children[0]!).fill).toEqual({ $slot: "s0", default: null })
    expect(code).toContain('() => (liked() ? "#f00" : "#999"), 1)')
  })
  test("motion props on an element make it a part: rotate around its centre, trims, animate", () => {
    const { templates, code } = compile(`export function F() { return (
      <Svg viewBox="0 0 24 24" size={24}>
        <Circle cx={12} cy={12} r={10} stroke="#047857" fill="none" rotate={spin()} />
        <Path d="M2 12h20" stroke="#000" trimEnd={0.5} animate={{ trimEnd: { duration: 800, from: 0 } }} />
      </Svg>) }`)
    const [circle, line] = templates[0]!.children
    expect(props(circle!)).toMatchObject({ part: 0, rotate: { $slot: "s0", default: null }, pivotX: 12, pivotY: 12 })
    expect(props(line!)).toMatchObject({ part: 1, trimEnd: 0.5, animate: "185=t800e0~f0" })
    expect(props(line!).pivotX).toBeUndefined()
    expect(code).toContain("() => (spin()), 0)")
    // They are zn values, not SVG attributes: the draw data has none of them.
    expect(props(templates[0]!).svg).not.toContain("rotate")
  })
  test("motion props inside a .map row in <Svg> fail with a hint", () => {
    expect(tsxErr(`const D = [1, 2]\nexport function F() { return <Svg viewBox="0 0 10 10">{D.map((d, i) => <Circle key={i} cx={d} r={1} rotate={45} />)}</Svg> }`))
      .toContain("give the element an id and use parts")
  })
  test(".map over a build-time array is expanded", () => {
    const { templates } = compile(`const DOTS = [{ x: 1 }, { x: 5 }]\nexport function F() { return (
      <Svg viewBox="0 0 10 10">{DOTS.map((d, i) => <Circle key={i} cx={d.x} cy={i} r={1} />)}</Svg>) }`)
    expect(props(templates[0]!).svg).toContain("M2 0A1 1 0 0 1 0 0 1 1 0 0 1 2 0z;")
    expect(props(templates[0]!).svg).toContain("M6 1A1 1 0 0 1 4 1 1 1 0 0 1 6 1z;")
  })
  test("build errors inside <Svg>", () => {
    const e = (body: string) => tsxErr(`export function F() { return <Svg viewBox="0 0 10 10">${body}</Svg> }`)
    expect(e(`<Circle cx={x()} r={1} />`)).toContain('SVG "cx" must be known at build time')
    expect(e(`{on() && <Circle r={1} />}`)).toContain("set its opacity")
    expect(e(`<Text>hi</Text>`)).toContain("put a <Text> over the SVG")
    expect(e(`<Box />`)).toContain("<Box> can't be inside <Svg>")
    expect(e(`{list().map((d) => <Circle r={1} />)}`)).toContain("array known at build time")
    expect(e(`<Svg />`)).toContain("a nested <Svg>")
    expect(e(`hello`)).toContain("text inside <Svg>")
    expect(tsxErr(`import { Path } from "@zeronative/ui"\nexport function F() { return <Column><Path d="M0 0" /></Column> }`))
      .toContain("<Path> is an SVG element: it only works inside <Svg>")
    expect(e(`<Circle r={1} />`)).toBe("no error")
  })
  test("an inline SVG error points at the TSX line", () => {
    expect(tsxErr(`export function F() { return (\n  <Svg viewBox="0 0 10 10">\n    <Path d="M0 0" paintOrder="bogus" />\n  </Svg>) }`))
      .toMatch(/Screen\.tsx:3:20: paint-order must be normal/)
  })
})
