// Writes the sample's Lottie files into assets/lottie (our own drawings, so no licence question): pulse.json, check.json,
// dots.lottie, and broken.json for the error case. Run: bun run examples/sample/make-lottie.ts
import { zipSync, strToU8 } from "fflate"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const out = join(import.meta.dir, "assets", "lottie")
mkdirSync(out, { recursive: true })

const PRIMARY = [0.239, 0.149, 0.929, 1] // #3D26ED, the sample's c.primary
const GREEN = [0.082, 0.502, 0.239, 1] // #15803D
const WHITE = [1, 1, 1, 1]
const ease = (n: number) => ({ i: { x: Array(n).fill(0.4), y: Array(n).fill(1) }, o: { x: Array(n).fill(0.6), y: Array(n).fill(0) } })
const still = (k: unknown) => ({ a: 0, k })
const keys = (n: number, frames: [number, number[]][]) => ({
  a: 1,
  k: frames.map(([t, s], i) => (i < frames.length - 1 ? { t, s, ...ease(n) } : { t, s })),
})
const transform = (o: object = {}) => ({ ty: "tr", p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100), ...o })
const layerKs = (o: object = {}) => ({ o: still(100), r: still(0), p: still([100, 100, 0]), a: still([0, 0, 0]), s: still([100, 100, 100]), ...o })
const layer = (ind: number, nm: string, op: number, ks: object, it: object[]) => ({
  ddd: 0, ind, ty: 4, nm, sr: 1, ks, ao: 0, ip: 0, op, st: 0, bm: 0,
  shapes: [{ ty: "gr", nm: `${nm} group`, it: [...it, transform()] }],
})
const circle = (size: number) => ({ ty: "el", nm: "circle", d: 1, p: still([0, 0]), s: still([size, size]) })
const fill = (c: number[]) => ({ ty: "fl", nm: "fill", c: still(c), o: still(100), r: 1 })
const anim = (nm: string, op: number, layers: object[]) => ({ v: "5.7.4", fr: 30, ip: 0, op, w: 200, h: 200, nm, ddd: 0, assets: [], layers })

// 1. pulse: a dot with a ring that grows and fades. Loops (2 s).
const pulse = anim("pulse", 60, [
  layer(1, "Dot", 60, layerKs(), [circle(56), fill(PRIMARY)]),
  layer(2, "Ring", 60, layerKs({ o: keys(1, [[0, [70]], [60, [0]]]), s: keys(3, [[0, [35, 35, 100]], [60, [100, 100, 100]]]) }), [circle(180), fill(PRIMARY)]),
])

// 2. check: a green circle pops in, then a white tick is drawn. Plays once (1.5 s), for onAnimationFinish.
const tick = { ty: "sh", nm: "tick", ks: still({ i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]], v: [[-34, 2], [-10, 26], [36, -22]], c: false }) }
const trim = { ty: "tm", nm: "draw", s: still(0), e: keys(1, [[14, [0]], [34, [100]]]), o: still(0), m: 1 }
const stroke = { ty: "st", nm: "stroke", c: still(WHITE), o: still(100), w: still(14), lc: 2, lj: 2 }
const check = anim("check", 45, [
  layer(1, "Tick", 45, layerKs(), [tick, trim, stroke]),
  layer(2, "Circle", 45, layerKs({ s: keys(3, [[0, [0, 0, 100]], [10, [112, 112, 100]], [16, [100, 100, 100]]]) }), [circle(160), fill(GREEN)]),
])

// 3. dots: three dots that grow and brighten in turn. Loops (1.2 s). Shipped as a .lottie (a zip), like ZeroBill's files.
const dot = (ind: number, x: number, delay: number) =>
  layer(ind, `Dot ${ind}`, 36, layerKs({
    p: still([x, 100, 0]),
    o: keys(1, [[delay, [35]], [delay + 9, [100]], [delay + 18, [35]], [36, [35]]]),
    s: keys(3, [[delay, [70, 70, 100]], [delay + 9, [110, 110, 100]], [delay + 18, [70, 70, 100]], [36, [70, 70, 100]]]),
  }), [circle(36), fill(PRIMARY)])
const dots = anim("dots", 36, [dot(1, 50, 0), dot(2, 100, 6), dot(3, 150, 12)])

writeFileSync(`${out}/pulse.json`, JSON.stringify(pulse))
writeFileSync(`${out}/check.json`, JSON.stringify(check))
const manifest = { version: "1", generator: "zero-native sample", author: "zero-native", animations: [{ id: "dots" }] }
const zip = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), "animations/dots.json": strToU8(JSON.stringify(dots)) }, { level: 9, mtime: new Date("2026-11-05T00:00:00Z") })
writeFileSync(`${out}/dots.lottie`, zip)
// A file that is not an animation, for the "broken" case.
writeFileSync(`${out}/broken.json`, JSON.stringify({ hello: "not a Lottie file" }))
console.log("wrote", out)
