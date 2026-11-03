// Animated .svg files (docs/svg.md §15, step S.14): SMIL and CSS animations become part animations at build time.
// A corpus of 104 real loaders (fixtures/animated-svg, MIT) plus small cases for each rule.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type NodeSpec, writeTemplateFile } from "@zero-native/template"
import { compileModule } from "../src/compile"
import { compileSvgFile, compileSvgTree } from "../src/svg"
import { parseSvgXml } from "../src/svg-xml"

const svg = (body: string, attrs = 'viewBox="0 0 24 24"') =>
  compileSvgTree(parseSvgXml(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`, "t.svg"))
const motion = (body: string, attrs?: string) => [...svg(body, attrs).motion.values()]
const err = (body: string) => {
  try {
    svg(body)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

/** The animate string per prop name, for reading tests: "95=t1000e3~..." → { rotate: "t1000e3~..." }. */
const IDS: Record<string, string> = { 44: "opacity", 95: "rotate", 91: "scaleX", 92: "scaleY", 93: "translateX", 94: "translateY", 182: "fill", 183: "stroke" }
const byProp = (animate: unknown) =>
  Object.fromEntries(String(animate).split(";").map((e) => {
    const [id, t] = e.split("=")
    return [IDS[id!] ?? id, t]
  }))

/** Checks one timing string is what ZnTiming.parse reads: keyframes, times rising 0 → 1, one easing per segment. */
function wellFormed(t: string) {
  const [base, ...opts] = t.split("~")
  expect(base).toMatch(/^t\d+e[345]$/)
  const o = Object.fromEntries(opts.map((x) => [x[0], x.slice(1)]))
  const k = o.k!.split(":")
  const m = o.m!.split(":").map(Number)
  expect(k.length).toBeGreaterThanOrEqual(2)
  expect(m.length).toBe(k.length)
  expect(m[0]).toBe(0)
  expect(m[m.length - 1]).toBe(1)
  const ms = Number(base!.slice(1, base!.indexOf("e")))
  for (let i = 1; i < m.length; i++) expect(Math.round(m[i]! * ms)).toBeGreaterThan(Math.round(m[i - 1]! * ms))
  if (o.z !== undefined) expect(o.z.split(":").length).toBe(k.length - 1)
}

describe("the corpus: 104 real animated SVGs", () => {
  const root = join(import.meta.dir, "fixtures", "animated-svg")
  const files: string[] = []
  for (const set of ["svg-spinners/svg-smil", "svg-spinners/svg-css", "svg-loaders"]) {
    for (const f of readdirSync(join(root, set))) if (f.endsWith(".svg")) files.push(`${set}/${f}`)
  }

  test("all 104 compile into moving parts (the 4 gooey ones since registry 13's filters)", () => {
    const failed: Record<string, string> = {}
    let ok = 0
    for (const f of files) {
      try {
        const out = compileSvgFile(join(root, f))
        expect(out.motion.size).toBeGreaterThan(0)
        for (const p of out.motion.values()) for (const t of String(p.animate).split(";")) wellFormed(t.split("=")[1]!)
        ok++
      } catch (e) {
        failed[f] = (e as Error).message
      }
    }
    expect(files.length).toBe(104)
    const reasons = Object.fromEntries(Object.entries(failed).map(([f, m]) => [f, m.replace(/^.*?\.svg:\d+:\d+: /, "").split(":")[0]]))
    expect(reasons).toEqual({})
    expect(ok).toBe(104)
  })

  test("the SMIL and CSS versions of a spinner make the same motion", () => {
    // svg-spinners ships each spinner twice; for a plain turn the two must agree.
    const smil = [...compileSvgFile(join(root, "svg-spinners/svg-smil/90-ring.svg")).motion.values()]
    const css = [...compileSvgFile(join(root, "svg-spinners/svg-css/90-ring.svg")).motion.values()]
    expect(smil).toEqual([{ animate: "95=t750e3~k0:360~m0:1~r-1", pivotX: 12, pivotY: 12 }])
    expect(css).toEqual(smil)
  })
})

describe("SMIL", () => {
  test("animateTransform rotate turns around its centre; keySplines give each segment its easing", () => {
    const [m] = motion(
      `<path d="M2 2h4v4z"><animateTransform attributeName="transform" type="rotate" values="0 12 12;180 12 12;360 12 12" ` +
        `keyTimes="0;0.25;1" calcMode="spline" keySplines=".5,0,.5,1;0,0,.58,1" dur="2s" repeatCount="indefinite"/></path>`,
    )
    expect(m!.pivotX).toBe(12)
    expect(m!.pivotY).toBe(12)
    expect(byProp(m!.animate)).toEqual({ rotate: "t2000e3~z4,0.5,0,0.5,1:4,0,0,0.58,1~k0:180:360~m0:0.25:1~r-1" })
  })

  test("a begin chain becomes one repeating cycle: each piece waits for its turn", () => {
    // a: 0–500 ms, b: 500–1000 ms, then a again: a period of 1 s for both, b 500 ms later, each holding (freeze).
    const ms = motion(
      `<rect id="a" width="4" height="4"><animate id="A" attributeName="opacity" values="1;0" dur="0.5s" begin="0;B.end" fill="freeze"/></rect>` +
        `<rect id="b" x="8" width="4" height="4"><animate id="B" attributeName="opacity" values="1;0" dur="0.5s" begin="A.end" fill="freeze"/></rect>`,
    )
    expect(byProp(ms[0]!.animate)).toEqual({ opacity: "t1000e3~k1:0:0~m0:0.5:1~r-1" })
    expect(byProp(ms[1]!.animate)).toEqual({ opacity: "t1000e3~d500~k1:0:0~m0:0.5:1~r-1" })
  })

  test("calcMode discrete holds each value and jumps (step easing 5)", () => {
    const [m] = motion(`<rect width="4" height="4"><animate attributeName="opacity" values="1;0.5;0" calcMode="discrete" dur="0.9s" repeatCount="indefinite"/></rect>`)
    expect(byProp(m!.animate)).toEqual({ opacity: "t900e3~z5:5:3~k1:0.5:0:0~m0:0.333333:0.666667:1~r-1" })
  })

  test("a circle growing from r=0 is drawn at its largest size and scaled around its centre", () => {
    const out = svg(`<circle cx="12" cy="12" r="0"><animate attributeName="r" values="0;10" dur="1s" repeatCount="indefinite"/></circle>`)
    expect(out.data).toContain("A10 10") // baked at r=10
    const [m] = [...out.motion.values()]
    // Rest value (animations off): r=0, so scale 0.
    expect(m).toMatchObject({ scaleX: 0, scaleY: 0, pivotX: 12, pivotY: 12 })
    expect(byProp(m!.animate)).toEqual({ scaleX: "t1000e3~k0:1~m0:1~r-1", scaleY: "t1000e3~k0:1~m0:1~r-1" })
  })

  test("a bar growing from its middle (y and height together) is a scaleY and a move", () => {
    const [m] = motion(`<rect x="1" y="6" width="2" height="12"><animate attributeName="y" values="6;1;6" dur="0.6s" repeatCount="indefinite"/>` +
      `<animate attributeName="height" values="12;22;12" dur="0.6s" repeatCount="indefinite"/></rect>`)
    expect(m).toMatchObject({ pivotX: 2, pivotY: 12 })
    // The centre stays at y 12 (6 + 12/2 = 1 + 22/2), so there is no move.
    expect(byProp(m!.animate)).toEqual({ scaleY: "t600e3~k1:1.8333:1~m0:0.5:1~r-1", translateY: "t600e3~k0:0:0~m0:0.5:1~r-1" })
  })

  test("two animations of one attribute merge: the one that started last sets the value", () => {
    // Fades in at 0 (0.25 s), out at 1 s (0.1 s); the chain repeats every 1.3 s.
    const [m] = motion(`<path d="M0 0h4v4z" opacity="0"><animate id="in" begin="0;out.end+0.2s" attributeName="opacity" dur="0.25s" values="0;1" fill="freeze"/>` +
      `<animate id="out" begin="in.begin+1s" attributeName="opacity" dur="0.1s" values="1;0" fill="freeze"/></path>`)
    expect(m!.opacity).toBe(0)
    expect(byProp(m!.animate)).toEqual({ opacity: "t1300e3~k0:1:1:0:0~m0:0.192308:0.769231:0.846154:1~r-1" })
  })

  test("fill-opacity on a stroked shape fades only the fill: the fill colour's alpha", () => {
    const [m] = motion(`<circle cx="12" cy="12" r="5" fill="#fff" stroke="#fff" fill-opacity="1"><animate attributeName="fill-opacity" values="1;0" dur="1s" repeatCount="indefinite"/></circle>`)
    expect(m!.fill).toBe("#FFFFFF")
    expect(byProp(m!.animate)).toEqual({ fill: "t1000e3~k#FFFFFFFF:#00FFFFFF~m0:1~r-1" })
  })

  test("in a flipped group (matrix(1 0 0 -1 0 80)) a growing bar grows upwards", () => {
    const [m] = motion(`<g transform="matrix(1 0 0 -1 0 80)"><rect width="10" height="20"><animate attributeName="height" values="20;40" dur="1s" repeatCount="indefinite"/></rect></g>`, 'viewBox="0 0 10 80"')
    expect(m).toMatchObject({ pivotX: 5, pivotY: 70 })
    expect(byProp(m!.animate)).toEqual({ scaleY: "t1000e3~k1:2~m0:1~r-1", translateY: "t1000e3~k0:-10~m0:1~r-1" })
  })

  test("what SMIL can't do here fails with a hint", () => {
    expect(err(`<rect width="1" height="1"><animate attributeName="x" values="0;1" dur="1s" begin="mouseover"/></rect>`)).toContain('begin "mouseover" isn\'t supported')
    expect(err(`<rect width="1" height="1"><animate attributeName="x" values="0;1" dur="1s" begin="0s;click"/></rect>`)).toContain("starts both on a tap and at a time")
    expect(err(`<path d="M0 0h1"><animate attributeName="d" values="M0 0h1;M0 0h1v1" dur="1s"/></path>`)).toContain("the paths of this morph don't match")
    expect(err(`<rect width="1" height="1"><animate attributeName="d" values="M0 0h1;M0 0h2" dur="1s"/></rect>`)).toContain("animating d works on a <path> only")
    expect(err(`<path d="M0 0h10" stroke="#000" stroke-dasharray="1 1"><animate attributeName="stroke-dasharray" values="1 1;2 2" dur="1s"/></path>`))
      .toContain("animating stroke-dasharray works for one dash")
    expect(err(`<g transform="scale(1 2)"><circle r="2" stroke="#000"><animate attributeName="r" values="1;2" dur="1s"/></circle></g>`)).toContain("inside a stretched group")
    expect(err(`<rect width="1" height="1"><animate attributeName="x" values="0;1"/></rect>`)).toContain("an animation needs a dur")
    expect(err(`<rect width="1" height="1"><animateTransform attributeName="transform" type="matrix" values="0;10" dur="1s"/></rect>`)).toContain('type="matrix" isn\'t supported')
    expect(err(`<circle r="1"><animateMotion dur="1s"/></circle>`)).toContain("<animateMotion> needs a path")
    expect(err(`<g transform="scale(2 1)"><circle r="1"><animateMotion path="M0 0h9" rotate="auto" dur="1s"/></circle></g>`)).toContain("a motion that turns the element, inside a stretched")
    expect(err(`<line x2="1"><set attributeName="x1" to="2"/></line>`)).toContain('animating "x1" on <line>')
    expect(err(`<defs><rect id="r" width="1" height="1"><animate attributeName="x" values="0;1" dur="1s"/></rect></defs>`)).toContain("animations inside <defs>")
  })
})

describe("strokes, dashes and morphs (registry 12, docs/svg.md §16)", () => {
  const P = { ...IDS, 184: "trimStart", 185: "trimEnd", 192: "strokeWidth", 193: "dashOffset", 196: "morphAt" }
  const props = (animate: unknown) =>
    Object.fromEntries(String(animate).split(";").map((e) => [P[e.split("=")[0]!] ?? e.split("=")[0], e.split("=")[1]]))

  test("a stroked circle that grows scales its outline; its stroke keeps its width", () => {
    const [m] = motion(`<circle cx="12" cy="12" r="2" fill="none" stroke="#000" stroke-width="2"><animate attributeName="r" values="2;8" dur="1s" repeatCount="indefinite"/></circle>`)
    expect(m).toMatchObject({ scaleOutline: true, pivotX: 12, pivotY: 12 })
    expect(props(m!.animate)).toEqual({ scaleX: "t1000e3~k1:4~m0:1~r-1", scaleY: "t1000e3~k1:4~m0:1~r-1" })
  })

  test("a stroked circle that only moves needs no outline scale", () => {
    const [m] = motion(`<circle cx="5" cy="5" r="2" stroke="#000"><animate attributeName="cx" values="5;15" dur="1s" repeatCount="indefinite"/></circle>`)
    expect(m!.scaleOutline).toBeUndefined()
    expect(props(m!.animate)).toEqual({ translateX: "t1000e3~k0:10~m0:1~r-1" })
  })

  test("stroke-width starts from the inherited width, in viewBox units (scaled with the group)", () => {
    const [m] = motion(`<g transform="scale(2)" stroke-width="1.5"><path d="M0 0h4" stroke="#000"><animate attributeName="stroke-width" values="1.5;0" dur="1s" repeatCount="indefinite"/></path></g>`)
    expect(m!.strokeWidth).toBe(3)
    expect(props(m!.animate)).toEqual({ strokeWidth: "t1000e3~k3:0~m0:1~r-1" })
  })

  test("a width that starts at 0 is baked at its largest, so the shape keeps a stroke to change", () => {
    const out = svg(`<path d="M0 0h4" stroke="#000" stroke-width="0"><animate attributeName="stroke-width" values="0;2" dur="1s" repeatCount="indefinite"/></path>`)
    expect(out.data).toContain(" #FF000000 1 0 1 2 0 0 4 0 0 ") // stroke width 2 in the draw data
    expect([...out.motion.values()][0]!.strokeWidth).toBe(0)
  })

  test("one dash with a long gap becomes trims; the shape is drawn solid (pathLength units)", () => {
    const out = svg(`<path d="M0 0h50" stroke="#000" pathLength="100" stroke-dasharray="100 100"><animate attributeName="stroke-dashoffset" values="100;0" dur="1s" fill="freeze"/></path>`)
    const [m] = [...out.motion.values()]
    expect(props(m!.animate)).toEqual({ trimStart: "t1000e3~k0:0~m0:1", trimEnd: "t1000e3~k0:1~m0:1" })
    expect(out.data).toContain(" 0 0 4 0 0 ") // no dashes left: count 0, offset 0
  })

  test("the dash's end stops at the line's end (SVG doesn't wrap dashes): the segment is split where it gets there", () => {
    // A circle of length 2π·10 ≈ 62.83; the dash's end goes from 31.4 to 94.2 and reaches the end half way.
    const [m] = motion(`<circle cx="12" cy="12" r="10" fill="none" stroke="#000" stroke-dasharray="31.4159 100"><animate attributeName="stroke-dashoffset" values="0;-62.8319" dur="1s" repeatCount="indefinite"/></circle>`)
    // (The circle is 4 Bézier arcs, 0.01 % longer than a true circle, as the phone measures it too.)
    const p = props(m!.animate)
    const keys = (t: string) => t.split("~").find((x) => x[0] === "k")!.slice(1).split(":").map(Number)
    expect(p.trimStart).toMatch(/~m0:0\.5:1~r-1$/)
    expect(p.trimEnd).toMatch(/~m0:0\.5:1~r-1$/)
    keys(p.trimStart!).forEach((v, i) => expect(v).toBeCloseTo([0, 0.5, 1][i]!, 3))
    keys(p.trimEnd!).forEach((v, i) => expect(v).toBeCloseTo([0.5, 1, 1][i]!, 3))
  })

  test("a fixed dash pattern whose offset moves keeps its dashes and moves them with dashOffset", () => {
    const out = svg(`<path d="M0 0h10" stroke="#000" stroke-dasharray="2 1"><animate attributeName="stroke-dashoffset" values="0;3" dur="1s" repeatCount="indefinite"/></path>`)
    const [m] = [...out.motion.values()]
    expect(m!.dashOffset).toBe(0)
    expect(props(m!.animate)).toEqual({ dashOffset: "t1000e3~k0:3~m0:1~r-1" })
    expect(out.data).toContain(" 2 2 1 0 ") // two dash lengths, offset 0
  })

  test("a morph: every keyframe in M / C / Z form, and where it is in them", () => {
    const [m] = motion(`<path d="M0 0L9 0"><animate attributeName="d" values="M0 0L9 0;M0 0L9 9" dur="1s" repeatCount="indefinite"/></path>`)
    expect(m!.morph).toBe("MC|0 0 3 0 6 0 9 0|0 0 3 3 6 6 9 9")
    expect(m!.morphAt).toBeUndefined() // -1 (its own path) is the default
    expect(props(m!.animate)).toEqual({ morphAt: "t1000e3~k0:1~m0:1~r-1" })
  })

  test("a morph in CSS (d: path()) and one under a transform, in viewBox space", () => {
    const [c] = motion(`<style>.m{animation:m 1s linear infinite}@keyframes m{to{d:path("M0 0L9 9")}}</style><path class="m" d="M0 0L9 0"/>`)
    expect(c!.morph).toBe("MC|0 0 3 0 6 0 9 0|0 0 3 3 6 6 9 9")
    const [t] = motion(`<g transform="translate(1 2)"><path d="M0 0L3 0"><animate attributeName="d" values="M0 0L3 0;M0 0L3 3" dur="1s"/></path></g>`)
    // One play, no fill="freeze": SMIL goes back to the path's own d at the end, so that is the last keyframe.
    expect(t!.morph).toBe("MC|1 2 2 2 3 2 4 2|1 2 2 3 3 4 4 5|1 2 2 2 3 2 4 2")
  })

  test("vector-effect=non-scaling-stroke: the width is written negative (dp on screen), not scaled", () => {
    const out = svg(`<g transform="scale(3)"><path d="M0 0h4" stroke="#000" stroke-width="2" vector-effect="non-scaling-stroke"/></g>`)
    expect(out.data).toContain(" #FF000000 1 0 1 -2 0 0 4 0 0 ")
  })
})

describe("CSS", () => {
  test("a class rule with the animation shorthand, a delay longhand and transform-origin: center", () => {
    const ms = motion(`<style>.s{transform-origin:center;animation:spin .75s infinite linear}.d{animation-delay:-.25s}` +
      `@keyframes spin{100%{transform:rotate(360deg)}}</style><path class="s" d="M2 2h4v4z"/><path class="s d" d="M8 2h4v4z"/>`)
    expect(ms[0]).toEqual({ animate: "95=t750e3~k0:360~m0:1~r-1", pivotX: 12, pivotY: 12 })
    // A negative delay starts a third of the way in: the loop is turned round to start at 120°.
    expect(byProp(ms[1]!.animate)).toEqual({ rotate: "t750e3~z3:5:3~k120:360:0:120~m0:0.666667:0.668:1~r-1" })
  })

  test("keyframe timing functions, missing ends from the element, alternate", () => {
    const [m] = motion(`<style>.b{animation:bounce 1s ease-in-out infinite alternate}` +
      `@keyframes bounce{50%{animation-timing-function:cubic-bezier(0.33,0,.66,.33);transform:translateY(-6px)}}</style><circle class="b" cx="4" cy="12" r="3"/>`)
    expect(byProp(m!.animate)).toEqual({ translateY: "t1000e3~z4,0.42,0,0.58,1:4,0.33,0,0.66,0.33~k0:-6:0~m0:0.5:1~r-1~v" })
  })

  test("static CSS is written into the elements (no animation needed)", () => {
    const out = svg(`<style>.r{fill:#f00}#b{stroke:#00f;stroke-width:2}</style><rect class="r" width="4" height="4"/><path id="b" d="M0 0h4" fill="none"/>`)
    expect(out.motion.size).toBe(0)
    expect(out.data).toContain("#FFFF0000")
    expect(out.data).toContain("#FF0000FF")
  })

  test("what CSS can't do here fails with a hint", () => {
    expect(err(`<style>.a::before{fill:red}</style>`)).toContain('CSS selector ".a::before" isn\'t supported')
    expect(err(`<style>@media (min-width: 10px){.a{fill:red}}</style>`)).toContain("@media (min-width: 10px) isn't supported")
    expect(err(`<style>.a{fill:var(--nope)}</style><rect class="a" width="1" height="1"/>`)).toContain("var(--nope) has no value here")
    expect(err(`<style>.a{animation:x 1s infinite;animation-timing-function:linear(0, 1)}@keyframes x{to{opacity:0}}</style><rect class="a" width="1" height="1"/>`)).toContain('can\'t read the timing function "linear(0, 1)"')
    expect(err(`<style>.a{offset-path:path("M0 0h9")}</style><rect class="a" width="1" height="1"/>`)).toContain("offset-path without an animated offset-distance")
    expect(err(`<style>.a{animation:x 1s infinite}@keyframes x{to{transform:scale(2) rotate(9deg)}}</style><rect class="a" width="1" height="1"/>`)).toContain("only translate, then rotate, then skew, then scale")
    expect(err(`<style>.a{animation:nope 1s}</style><rect class="a" width="1" height="1"/>`)).toContain('no @keyframes "nope"')
  })
})

describe("registry 13: set, steps(), skews, points, motion paths, groups that turn", () => {
  const P = { ...IDS, 196: "morphAt", 198: "motionAt", 199: "skewX", 250: "skewY" }
  const props = (animate: unknown) =>
    Object.fromEntries(String(animate).split(";").map((e) => [P[e.split("=")[0]!] ?? e.split("=")[0], e.split("=")[1]]))

  test("<set> with no dur: the element's own value until its begin, then the new one for good", () => {
    const [m] = motion(`<rect width="4" height="4" opacity="0"><set attributeName="opacity" to="1" begin="0.5s"/></rect>`)
    expect(m!.opacity).toBe(0)
    expect(props(m!.animate)).toEqual({ opacity: "t501e3~z5:3~k0:1:1~m0:0.998004:1" })
  })

  test("steps(n) becomes holds and jumps at CSS's levels, also played backwards", () => {
    const css = (timing: string, extra = "") =>
      motion(`<style>.a{animation:x 1s ${timing} infinite ${extra}}@keyframes x{from{opacity:1}to{opacity:0}}</style><rect class="a" width="1" height="1"/>`)
    expect(props(css("steps(4)")[0]!.animate)).toEqual({ opacity: "t1000e3~z5:5:5:5~k1:0.75:0.5:0.25:0~m0:0.25:0.5:0.75:1~r-1" })
    // jump-start: 0.5 right away, 0 at the half.
    expect(props(css("steps(2, jump-start)")[0]!.animate)).toEqual({ opacity: "t1000e3~z5:5:5~k1:0.5:0:0~m0:0.001:0.5:1~r-1" })
    // Backwards: 0.5 right away (a 1 ms jump), then 1 from the half on.
    expect(props(css("steps(2)", "reverse")[0]!.animate)).toEqual({ opacity: "t1000e3~z5:3:5:3~k0:0.5:0.5:1:1~m0:0.001:0.5:0.501:1~r-1" })
  })

  test("skewX (SMIL) and skewY (CSS) are part channels around the origin", () => {
    const [s] = motion(`<rect width="4" height="4"><animateTransform attributeName="transform" type="skewX" values="0;30" dur="1s" repeatCount="indefinite"/></rect>`)
    expect(s).toMatchObject({ pivotX: 0, pivotY: 0 })
    expect(props(s!.animate)).toEqual({ skewX: "t1000e3~k0:30~m0:1~r-1" })
    const [c] = motion(`<style>.a{animation:x 1s infinite linear}@keyframes x{to{transform:rotate(90deg) skewY(20deg)}}</style><rect class="a" width="4" height="4"/>`)
    expect(props(c!.animate)).toEqual({ rotate: "t1000e3~k0:90~m0:1~r-1", skewY: "t1000e3~k0:20~m0:1~r-1" })
  })

  test("a polygon's points morph like a path", () => {
    const [m] = motion(`<polygon points="0,0 4,0 4,4"><animate attributeName="points" values="0,0 4,0 4,4;0,0 8,0 8,8" dur="1s" repeatCount="indefinite"/></polygon>`)
    expect(m!.morph).toBe("MCCZ|0 0 1.333 0 2.667 0 4 0 4 1.333 4 2.667 4 4|0 0 2.667 0 5.333 0 8 0 8 2.667 8 5.333 8 8")
  })

  test("animateMotion: the path in viewBox units, the origin it moves, and how it turns", () => {
    const one = (body: string) => motion(body)[0]!
    const auto = one(`<circle r="1"><animateMotion path="M0 0 L10 0" dur="1s" repeatCount="indefinite" rotate="auto"/></circle>`)
    expect(auto.motionPath).toBe("0 0 0 1;MC;0 0 3.333 0 6.667 0 10 0")
    expect(props(auto.animate)).toEqual({ motionAt: "t1000e3~k0:1~m0:1~r-1" })
    // Under translate + scale the path is mapped; the origin moves with the group.
    expect(one(`<g transform="translate(5 5) scale(2)"><circle r="1"><animateMotion path="M0 0 L10 0" dur="1s" repeatCount="indefinite"/></circle></g>`).motionPath)
      .toBe("5 5 0 0;MC;5 5 11.667 5 18.333 5 25 5")
    // A mirrored group turns the other way.
    expect(one(`<g transform="matrix(-1 0 0 1 20 0)"><circle r="1"><animateMotion path="M0 0 L10 0" dur="1s" repeatCount="indefinite" rotate="45"/></circle></g>`).motionPath)
      .toBe("20 0 -45 0;MC;20 0 16.667 0 13.333 0 10 0")
    const kp = one(`<circle r="1"><animateMotion path="M0 0 L10 0" keyPoints="0;0.5;1" keyTimes="0;0.8;1" calcMode="linear" dur="1s" repeatCount="indefinite"/></circle>`)
    expect(props(kp.animate)).toEqual({ motionAt: "t1000e3~k0:0.5:1~m0:0.8:1~r-1" })
    // A line through values with calcMode="linear": each piece takes the same time.
    const v = one(`<circle r="1"><animateMotion values="0,0;10,0;10,30" calcMode="linear" dur="1s" repeatCount="indefinite"/></circle>`)
    expect(props(v.animate)).toEqual({ motionAt: "t1000e3~k0:0.25:1~m0:0.5:1~r-1" })
    // <mpath>, a begin, no freeze: not moved (-1) before and after.
    const mp = one(`<path id="p" d="M0 0h10" fill="none"/><circle r="1"><animateMotion dur="1s" begin="1s"><mpath href="#p"/></animateMotion></circle>`)
    expect(props(mp.animate)).toEqual({ motionAt: "t2001e3~z5:3:5~k-1:0:1:-1~m0:0.49975:0.9995:1" })
  })

  test("CSS offset-path: turns with the path by default; at rest at its offset-distance", () => {
    const [m] = motion(`<style>.m{offset-path:path("M0 0 L10 0");animation:mv 1s linear infinite}@keyframes mv{from{offset-distance:0%}to{offset-distance:100%}}</style><circle class="m" r="1"/>`)
    expect(m).toEqual({ motionPath: "0 0 0 1;MC;0 0 3.333 0 6.667 0 10 0", motionAt: 0, animate: "198=t1000e3~k0:1~m0:1~r-1" })
  })

  test("an animated gradient stop is a part after the ops; each copy of the gradient links to it", () => {
    const grad = (stop: string) =>
      svg(`<defs><linearGradient id="g">${stop}<stop offset="1" stop-color="#0f0"/></linearGradient></defs>` +
        `<rect width="4" height="4" fill="url(#g)"/><rect x="5" width="4" height="4" fill="url(#g)"/>`)
    const c = grad(`<stop offset="0" stop-color="#f00"><animate attributeName="stop-color" values="#f00;#00f" dur="1s" repeatCount="indefinite"/></stop>`)
    // Two rects, two bounding boxes: two gradients, both with stop 0 on part 2 (the ops are parts 0 and 1).
    expect(c.data).toContain(" SL 0 0 2 SL 1 0 2 S ")
    expect([...c.motion.values()]).toEqual([{ fill: "#FF0000", animate: "182=t1000e3~k#FFFF0000:#FF0000FF~m0:1~r-1" }])
    // stop-opacity (here from style) becomes the colour's alpha.
    const o = grad(`<stop offset="0" stop-color="#f00" style="stop-opacity:.5"><animate attributeName="stop-opacity" values="0.5;1" dur="1s" repeatCount="indefinite"/></stop>`)
    expect([...o.motion.values()]).toEqual([{ fill: "rgba(255, 0, 0, 0.502)", animate: "182=t1000e3~k#80FF0000:#FFFF0000~m0:1~r-1" }])
    expect(err(`<defs><linearGradient id="g"><stop offset="0"><animate attributeName="offset" values="0;1" dur="1s"/></stop></linearGradient></defs>`))
      .toContain('animating "offset" on a <stop> isn\'t supported')
  })

  test('begin="click": the animation waits for a tap (~w); chains to it count from the tap', () => {
    const [m] = motion(`<rect width="4" height="4"><animate attributeName="opacity" values="1;0;1" dur="1s" begin="click"/></rect>`)
    expect(props(m!.animate)).toEqual({ opacity: "t1000e3~k1:0:1~m0:0.5:1~w" })
    const ms = motion(`<rect width="4" height="4"><animate id="a" attributeName="opacity" values="1;0" dur="0.5s" begin="r.click" fill="freeze"/></rect>` +
      `<rect id="r" x="5" width="4" height="4"><animate attributeName="opacity" values="1;0" dur="0.5s" begin="a.end+0.2s" fill="freeze"/></rect>`)
    expect(props(ms[1]!.animate)).toEqual({ opacity: "t500e3~d700~k1:0~m0:1~w" })
  })

  test("CSS: @media for reduced motion, more selectors, var(), d: path()", () => {
    // line-md's form: the animation sits in "@media not (prefers-reduced-motion)"; a "reduce" block is skipped.
    const [md] = motion(`<style>@media not (prefers-reduced-motion){.a{animation:f 1s linear infinite}}@media (prefers-reduced-motion: reduce){.a{animation:none}}` +
      `@keyframes f{to{opacity:0}}</style><path class="a" d="M0 0h4" stroke="#000"/>`)
    expect(props(md!.animate)).toEqual({ opacity: "t1000e3~k1:0~m0:1~r-1" })
    const count = (css: string, body: string) => motion(`<style>${css}{animation:f 1s infinite}@keyframes f{to{opacity:0}}</style>${body}`).length
    const r = `<rect width="1" height="1"/>`
    expect(count("g > .a", `<g><rect class="a" width="1" height="1"/><g><rect class="a" width="1" height="1"/></g></g><rect class="a" width="1" height="1"/>`)).toBe(2)
    expect(count("rect:nth-child(2n+1)", `<g>${r}${r}${r}</g>`)).toBe(2)
    expect(count("rect:last-child", `<g>${r}${r}${r}</g>`)).toBe(1)
    expect(count(".a + rect", `<rect class="a" width="1" height="1"/>${r}${r}`)).toBe(1)
    expect(count(".a ~ rect", `<rect class="a" width="1" height="1"/>${r}${r}`)).toBe(2)
    expect(count(`[data-k="v"]`, `<rect data-k="v" width="1" height="1"/>${r}`)).toBe(1)
    expect(count("rect:not(.a)", `<rect class="a" width="1" height="1"/>${r}`)).toBe(1)
    const [v] = motion(`<style>:root{--c:#00f;--d:2s}.a{fill:var(--c);animation:f var(--d) linear infinite}@keyframes f{to{fill:var(--to, #0f0)}}</style><rect class="a" width="1" height="1"/>`)
    expect(v).toEqual({ fill: "#0000FF", animate: "182=t2000e3~k#FF0000FF:#FF00FF00~m0:1~r-1" })
    expect(svg(`<g style="--w: 3"><path d="M0 0h4" stroke="#000" style="stroke-width: var(--w)"/></g>`).data).toContain(" #FF000000 1 0 1 3 ")
    expect(svg(`<style>.p{d:path('M0 0L5 5');stroke:#000}</style><path class="p"/>`).data).toContain("M0 0L5 5;")
  })

  test("a transform inside a rotated or stretched group keeps that group's space (frame)", () => {
    const [r] = motion(`<g transform="rotate(30)"><rect width="4" height="2"><animateTransform attributeName="transform" type="scale" values="1 1;2 1" dur="1s" repeatCount="indefinite"/></rect></g>`)
    expect(r).toMatchObject({ frame: "0.866025 0.5 -0.5 0.866025 0 0", pivotX: 0, pivotY: 0 })
    const [s] = motion(`<g transform="scale(2 1)"><rect width="4" height="2"><animateTransform attributeName="transform" type="rotate" values="0 2 1;90 2 1" dur="1s" repeatCount="indefinite"/></rect></g>`)
    // The pivot is in the element's own units: frame · rotate around (2, 1) · frame⁻¹.
    expect(s).toMatchObject({ frame: "2 0 0 1 0 0", pivotX: 2, pivotY: 1 })
  })
})

describe("in TSX", () => {
  const dir = mkdtempSync(join(tmpdir(), "zn-svg-anim-"))
  writeFileSync(join(dir, "spin.svg"), '<svg viewBox="0 0 24 24"><path id="arc" d="M12 2a10 10 0 0 1 10 10" fill="none" stroke="currentColor"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path><circle cx="12" cy="12" r="2"><animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite"/></circle></svg>')
  const compile = (src: string) => {
    const templates: NodeSpec[] = []
    const ctx = {
      reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
      defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
    }
    return { ...compileModule(src, join(dir, "Screen.tsx"), ctx, new Map(), new Map()), templates }
  }
  const props = (n: NodeSpec) => n.props as Record<string, any>

  test("the build writes the file's part names next to it (spin.d.svg.ts), without the parts it made itself", () => {
    compile(`import Spinner from "./spin.svg"\nexport function F() { return <Spinner size={24} /> }`)
    const types = readFileSync(join(dir, "spin.d.svg.ts"), "utf8")
    expect(types).toContain(`declare const svg: SvgFile<"arc">`)
    expect(types).not.toContain("zn-anim")
  })

  test("an .svg part's strokeWidth and dashOffset can change at runtime and animate", () => {
    const { templates } = compile(`import Spinner from "./spin.svg"\nexport function F() { return <Spinner parts={{ arc: { strokeWidth: w(), dashOffset: 2 } }} /> }`)
    const arc = templates[0]!.children.find((c) => props(c).part === 0)!
    expect(props(arc).dashOffset).toBe(2)
    expect(typeof props(arc).strokeWidth).toBe("object") // a slot
  })

  test("a group part's strokeWidth leaves a child's own stroke-width alone (the build pins it)", () => {
    writeFileSync(join(dir, "lines.svg"), '<svg viewBox="0 0 24 24"><g id="all" stroke="#000" stroke-width="2"><path d="M0 0h9"/><path d="M0 5h9" stroke-width="5"/></g></svg>')
    const { templates } = compile(`import Lines from "./lines.svg"\nexport function F() { return <Lines parts={{ all: { strokeWidth: 4 } }} /> }`)
    const parts = templates[0]!.children.map((c) => props(c))
    // Ops: the group 0, the paths 1 and 2. Path 2 set its own width: it keeps 5.
    expect(parts).toEqual([{ part: 0, strokeWidth: 4 }, { part: 2, strokeWidth: 5 }])
  })

  test("<Spinner /> plays by itself: the build adds the parts; paused / replay on it reach them", () => {
    const { templates, code } = compile(`import Spinner from "./spin.svg"\nexport function F() { return <Spinner size={24} color="#3D26ED" paused={busy()} /> }`)
    const n = templates[0]!
    expect(n.children.map((c) => props(c).part)).toEqual([0, 1])
    expect(props(n.children[0]!)).toEqual({ part: 0, animate: "95=t1000e3~k0:360~m0:1~r-1", pivotX: 12, pivotY: 12 })
    expect(byProp(props(n.children[1]!).animate)).toEqual({ opacity: "t1000e3~k1:0.2:1~m0:0.5:1~r-1" })
    expect(props(n).paused).toEqual({ $slot: "s0", default: null })
    expect(code).toContain("() => (busy())")
    expect(writeTemplateFile(templates).registry).toBe(11)
  })

  test("the screen's own part values merge with the file's motion; a second animate is an error", () => {
    const { templates } = compile(`import Spinner from "./spin.svg"\nexport function F() { return <Spinner parts={{ arc: { stroke: "#f00", paused: stop() } }} /> }`)
    const arc = templates[0]!.children.find((c) => props(c).part === 0)!
    expect(props(arc)).toMatchObject({ stroke: "#f00", animate: "95=t1000e3~k0:360~m0:1~r-1", pivotX: 12 })
    expect(() => compile(`import Spinner from "./spin.svg"\nexport function F() { return <Spinner parts={{ arc: { animate: 300 } }} /> }`))
      .toThrow('part "arc" is already animated by the .svg file itself')
    // Parts the build named itself aren't offered to the screen.
    expect(() => compile(`import Spinner from "./spin.svg"\nexport function F() { return <Spinner parts={{ "zn-anim-0": { opacity: 1 } }} /> }`))
      .toThrow("its parts: arc")
  })
})
