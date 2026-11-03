// Animated .svg files (docs/svg.md §15, step S.14): SMIL and CSS animations become part animations at build time.
// A corpus of 104 real loaders (fixtures/animated-svg, MIT) plus small cases for each rule.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
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

  test("95 compile into moving parts; the 9 others fail with a hint", () => {
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
    expect(reasons).toEqual({
      "svg-loaders/ball-triangle.svg": "animating the size or position of a shape with a stroke isn't supported (the stroke would scale too)",
      "svg-loaders/puff.svg": "animating the size or position of a shape with a stroke isn't supported (the stroke would scale too)",
      "svg-loaders/rings.svg": "animating stroke-width isn't supported",
      "svg-spinners/svg-css/gooey-balls-1.svg": "filters (blur, drop shadow) aren't supported",
      "svg-spinners/svg-css/gooey-balls-2.svg": "filters (blur, drop shadow) aren't supported",
      "svg-spinners/svg-css/ring-resize.svg": "animating stroke dashes isn't supported",
      "svg-spinners/svg-smil/gooey-balls-1.svg": "filters (blur, drop shadow) aren't supported",
      "svg-spinners/svg-smil/gooey-balls-2.svg": "filters (blur, drop shadow) aren't supported",
      "svg-spinners/svg-smil/ring-resize.svg": "animating stroke dashes isn't supported",
    })
    expect(ok).toBe(95)
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
    expect(err(`<rect width="1" height="1"><animate attributeName="x" values="0;1" dur="1s" begin="click"/></rect>`)).toContain('begin "click" isn\'t supported')
    expect(err(`<path d="M0 0h1"><animate attributeName="d" values="M0 0h1;M0 0h2" dur="1s"/></path>`)).toContain("morphing a path (animating d) isn't supported")
    expect(err(`<circle r="2" stroke="#000"><animate attributeName="r" values="1;2" dur="1s"/></circle>`)).toContain("a shape with a stroke")
    expect(err(`<path d="M0 0h1" stroke="#000"><animate attributeName="stroke-width" values="1;2" dur="1s"/></path>`)).toContain("animating stroke-width isn't supported")
    expect(err(`<rect width="1" height="1"><animate attributeName="x" values="0;1"/></rect>`)).toContain("an animation needs a dur")
    expect(err(`<rect width="1" height="1"><animateTransform attributeName="transform" type="skewX" values="0;10" dur="1s"/></rect>`)).toContain('type="skewX" isn\'t supported')
    expect(err(`<defs><rect id="r" width="1" height="1"><animate attributeName="x" values="0;1" dur="1s"/></rect></defs>`)).toContain("animations inside <defs>")
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
    expect(err(`<style>.a > .b{fill:red}</style>`)).toContain('CSS selector ".a > .b" isn\'t supported')
    expect(err(`<style>.a{animation:x 1s steps(4) infinite}@keyframes x{to{opacity:0}}</style><rect class="a" width="1" height="1"/>`)).toContain("steps(4) timing isn't supported")
    expect(err(`<style>.a{animation:x 1s infinite}@keyframes x{to{transform:scale(2) rotate(9deg)}}</style><rect class="a" width="1" height="1"/>`)).toContain("only translate, then rotate, then scale")
    expect(err(`<style>.a{animation:nope 1s}</style><rect class="a" width="1" height="1"/>`)).toContain('no @keyframes "nope"')
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
