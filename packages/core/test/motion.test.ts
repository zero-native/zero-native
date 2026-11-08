// Motion values and gestures (core motion.ts): what JS sends the Motion module, and what it does with native's answers.
import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { createRoot } from "../src/signals"
import {
  __deriveFormula,
  derive,
  env,
  follow,
  Gesture,
  interpolate,
  motionSlotValue,
  timingJson,
  useMotion,
  usePan,
  useTap,
  useZoom,
  useElementMotion,
  useFrame,
  nativeMotion,
  useTilt,
  viewPropsJson,
} from "../src/motion"
import { renderRoot, slot, str, view } from "../src/view"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const moduleEvent = (event: string, payload: unknown) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Motion", event, payload }))
const motionCalls = () => host.calls.filter((c) => c.module === "Motion" && c.method !== "__listeners")

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("useMotion makes a native value, owned by the component", () => {
  let dispose = () => {}
  const v = createRoot((d) => {
    dispose = d
    return useMotion(12)
  })
  expect(motionCalls()[0]).toMatchObject({ method: "value", args: { id: v.__znMotion, v: 12, __v: 1 } })
  expect(v.peek()).toBe(12)
  dispose()
  expect(motionCalls().at(-1)).toMatchObject({ method: "dispose", args: { ids: [v.__znMotion] } })
})

test("a slot sends a motion value as a reference, and a gesture as its id", () => {
  const v = useMotion(0)
  expect(motionSlotValue(v)).toBe("\u0000m" + v.__znMotion)
  expect(motionSlotValue(v.map([0, 1], [0, 100]))).toMatch(/^\u0000m\d+$/)
  const tap = useTap({ onEnd: () => {} })
  expect(motionSlotValue(tap)).toBe(tap.__znGesture)
  expect(motionSlotValue(5)).toBeUndefined()
  expect(motionSlotValue("x")).toBeUndefined()
})

test("map is made once per arguments (a style read again sends nothing new)", () => {
  const v = useMotion(0)
  const a = v.map([0, 100], [1, 0])
  const b = v.map([0, 100], [1, 0])
  expect(a).toBe(b)
  expect(motionCalls().filter((c) => c.method === "map")).toHaveLength(1)
  expect(() => v.map([1, 0], [0, 1])).toThrow(/go up/)
})

test("commands: to answers finished; the timing is sent as native reads it", async () => {
  const v = useMotion(0)
  const p = v.to(100, { spring: { damping: 20, stiffness: 100 } })
  const c = motionCalls().at(-1)!
  expect(c).toMatchObject({ method: "animate", args: { id: v.__znMotion, repeat: 1, reverse: false, interrupt: false } })
  expect(c.args.steps[0]).toEqual({ to: 100, t: { r: 1, k: 100, c: false }, delay: 0 })
  reply({ id: c.id, ok: true, value: { finished: false } })
  expect(await p).toEqual({ finished: false })
})

test("timings: presets, tweens with easing, duration springs", () => {
  expect(timingJson("spring")).toEqual({ r: 0.75, k: 400 })
  expect(timingJson(250)).toEqual({ t: 250, e: 0 })
  expect(timingJson({ duration: 300, easing: "linear" })).toEqual({ t: 300, e: 3 })
  expect(timingJson({ duration: 300, easing: [0.2, 0, 0, 1] })).toEqual({ t: 300, e: 4, b: [0.2, 0, 0, 1] })
  const d = timingJson({ spring: { duration: 500, dampingRatio: 0.8 } })!
  expect(d.r).toBe(0.8)
  expect(Math.round(d.k as number)).toBe(158) // (2π / 0.5 s)²
})

test("sequence, repeat forever, reverse, decay", () => {
  const v = useMotion(0)
  void v.sequence([{ to: 1, timing: 200 }, { set: 0 }, { decay: { velocity: 300, clamp: [0, 50] } }], { repeat: "forever", reverse: true })
  const c = motionCalls().at(-1)!
  expect(c.args.repeat).toBe(-1)
  expect(c.args.reverse).toBe(true)
  expect(c.args.steps[2].decay).toMatchObject({ v: 300, lo: 0, hi: 50 })
})

test("reading a value asks native to send it, then follows native's values", () => {
  const v = useMotion(3)
  expect(v()).toBe(3)
  expect(motionCalls().at(-1)).toMatchObject({ method: "watch", args: { id: v.__znMotion, on: true } })
  // Gesture or values events come through one listener (listen() starts with the first gesture).
  usePan({ axis: "x" })
  moduleEvent("values", { [v.__znMotion]: 42 })
  expect(v()).toBe(42)
})

test("useZoom: one zoom gesture plus its native double tap, grouped; zoomTo / reset ask native", () => {
  const zoom = useZoom({ max: 5, doubleTap: 3, aspect: 4 / 3, a11yLabel: "Photo", onEnd: () => {} })
  const calls = motionCalls()
  const z = calls.find((c) => c.method === "gesture" && c.args.kind === "zoom")!
  expect(z.args).toMatchObject({ min: 1, max: 5, doubleTap: 3, aspect: 4 / 3, rubber: true, ev: ["end"], a11yLabel: "Photo" })
  expect(z.args.values).toMatchObject({ scale: zoom.scale.__znMotion, "scale.v": 1, x: zoom.x.__znMotion, y: zoom.y.__znMotion })
  const tap = calls.find((c) => c.method === "gesture" && c.args.kind === "tap")!
  expect(tap.args).toMatchObject({ taps: 2, zoom: z.args.id })
  const g = calls.find((c) => c.method === "gestureGroup")!
  expect(g.args).toMatchObject({ id: zoom.__znGesture, mode: "simultaneous", of: [z.args.id, tap.args.id] })
  void zoom.zoomTo(2, { x: 10, y: 20 })
  expect(motionCalls().at(-1)).toMatchObject({ method: "zoomTo", args: { id: z.args.id, s: 2, x: 10, y: 20 } })
  void zoom.reset()
  expect(motionCalls().at(-1)).toMatchObject({ method: "zoomTo", args: { id: z.args.id, s: 1 } })
  // No double tap: the zoom gesture alone.
  const solo = useZoom({ doubleTap: false })
  const last = motionCalls().filter((c) => c.method === "gesture").at(-1)!
  expect(last.args).toMatchObject({ kind: "zoom", doubleTap: 0, id: solo.__znGesture })
})

test("usePan: options, values, anchors need a11yLabel, events reach their handlers", () => {
  expect(() => usePan({ axis: "x", anchors: [0, "100%"] })).toThrow(/a11yLabel/)
  const ends: unknown[] = []
  const pan = usePan({
    axis: "x",
    initial: { x: 5 },
    bounds: { x: [0, "100%"] },
    anchors: [{ id: "start", x: 0 }, { id: "paid", x: "100%" }],
    magnets: [{ id: "bin", x: 100, y: 200 }],
    a11yLabel: "Slide to pay",
    onEnd: (e) => ends.push(e),
  })
  const g = motionCalls().find((c) => c.method === "gesture" && c.args.id === pan.__znGesture)!
  expect(g.args).toMatchObject({
    kind: "pan",
    axis: "x",
    bounds: { x: [0, "100%"] },
    anchors: [{ id: "start", x: 0 }, { id: "paid", x: "100%" }],
    ev: ["end"],
    a11yLabel: "Slide to pay",
  })
  expect(g.args.values.x).toBe(pan.x.__znMotion)
  expect(g.args.values["x.v"]).toBe(5)
  expect(pan.x.peek()).toBe(5)
  expect(pan.magnet("bin").__znMotion).toBe(g.args.magnets[0].src)
  moduleEvent("gesture", { g: pan.__znGesture, t: "end", anchor: "paid", x: 300 })
  expect(ends).toEqual([{ g: pan.__znGesture, t: "end", anchor: "paid", x: 300 }])
})

test("Gesture.exclusive groups gestures", () => {
  const a = useTap({ taps: 2 })
  const b = useTap()
  const grp = Gesture.exclusive(a, b)
  expect(motionCalls().at(-1)).toMatchObject({ method: "gestureGroup", args: { id: grp.__znGesture, mode: "exclusive", of: [a.__znGesture, b.__znGesture] } })
})

test("derive's compiled form sends a formula once per inputs; numbers stay numbers", () => {
  const v = useMotion(0)
  const f1 = __deriveFormula(["$0", 2, "*", "$1", "+"], [v, 10], [], false)
  const f2 = __deriveFormula(["$0", 2, "*", "$1", "+"], [v, 10], [], false)
  expect(f1).toBe(f2)
  const c = motionCalls().filter((x) => x.method === "formula")
  expect(c).toHaveLength(1)
  expect(c[0].args.srcs).toEqual([{ m: v.__znMotion }, 10])
  expect(() => __deriveFormula(["$0"], ["text"], [], false)).toThrow(/not a number or a motion value/)
  expect(() => derive(() => 1)).toThrow(/compiled/)
})

test("follow and env", () => {
  const v = useMotion(7)
  const f = follow(v, "bouncy")
  expect(motionCalls().at(-1)).toMatchObject({ method: "follow", args: { id: f.__znMotion, src: v.__znMotion, t: { r: 0.45, k: 400 } } })
  expect(env.width.__znMotion).toBe(1)
  expect(env.keyboardHeight.__znMotion).toBe(7)
})

test("interpolate matches Reanimated's clamp / extend / identity", () => {
  expect(interpolate(50, [0, 100], [0, 1])).toBe(0.5)
  expect(interpolate(150, [0, 100], [0, 1])).toBe(1)
  expect(interpolate(150, [0, 100], [0, 1], "extend")).toBe(1.5)
  expect(interpolate(150, [0, 100], [0, 1], "identity")).toBe(150)
  expect(interpolate(75, [0, 50, 100], [0, 10, 0])).toBe(5)
})

test("format sends a text reference with only the options given", () => {
  const v = useMotion(0)
  const t = v.format({ prefix: "₹", decimals: 0 })
  expect(t.__znLabel).toBe(`\u0000f${v.__znMotion}|{"d":0,"p":"₹"}`)
  expect(motionSlotValue(t)).toBe(t.__znLabel)
})

test("text around v.format() becomes its prefix and suffix, not raw characters on screen", () => {
  const v = useMotion(0)
  const shown = (parts: () => string) => {
    host.ops.length = 0
    renderRoot(0x80000001, () => view(0, (i) => slot(i, 0, parts)), {})
    // The root is native's: its first values arrive as patches.
    return host.ops.find((o) => o[0] === "patch")![3] as string
  }
  const t = v.format({ decimals: 2 })
  // <Text>x {v.format(...)}</Text> compiles to "x " + str(...)
  expect(shown(() => "x " + str(t))).toBe(`\u0000f${v.__znMotion}|{"d":2,"p":"x ","s":""}`)
  expect(shown(() => str(v.format({ prefix: "₹" })) + " saved")).toBe(`\u0000f${v.__znMotion}|{"p":"₹","s":" saved"}`)
  // Alone, it is sent as it is.
  expect(shown(() => str(t))).toBe(t.__znLabel)
  expect(shown(() => "plain text")).toBe("plain text")
})

test("useElementMotion makes its values, is sent as its id, and measure() reads the box", async () => {
  const m = useElementMotion()
  const c = motionCalls().at(-1)!
  expect(c.method).toBe("element")
  expect(Object.keys(c.args.values)).toEqual(["x", "y", "width", "height", "scrollX", "scrollY", "index", "offset", "page", "pressed", "progress", "pull"])
  expect(motionSlotValue(m)).toBe(m.__znElement)
  expect(m.scrollY.__znMotion).toBe(c.args.values.scrollY)
  const p = m.measure()
  const r = motionCalls().at(-1)!
  expect(r.method).toBe("read")
  const ids = c.args.values
  reply({ id: r.id, ok: true, value: { [ids.x]: 10, [ids.y]: 20, [ids.width]: 30, [ids.height]: 40 } })
  expect(await p).toEqual({ x: 10, y: 20, width: 30, height: 40 })
})

test("useFrame turns frames on for the first callback and off after the last", () => {
  const seen: number[] = []
  const stop = useFrame((f) => seen.push(f.dt))
  expect(motionCalls().at(-1)).toMatchObject({ method: "frames", args: { on: true } })
  moduleEvent("frame", { t: 16, dt: 16 })
  expect(seen).toEqual([16])
  stop()
  expect(motionCalls().at(-1)).toMatchObject({ method: "frames", args: { on: false } })
})

test("element follow sends the source, and null stops it", () => {
  const m = useElementMotion()
  const v = useMotion(0)
  m.follow(v)
  expect(motionCalls().at(-1)).toMatchObject({ method: "elementFollow", args: { id: m.__znElement, src: v.__znMotion } })
  m.follow(null)
  expect(motionCalls().at(-1)!.args).toEqual({ id: m.__znElement, __v: 1 })
})

test("links between elements, manual activation, drop zones", () => {
  const list = useTap({ taps: 2 })
  const zone = useElementMotion()
  const zones: unknown[] = []
  const pan = usePan({ requireToFail: [list], simultaneousWith: [list], manualActivation: true, dropZones: [zone], onZone: (e) => zones.push(e.zone) })
  const g = motionCalls().find((c) => c.method === "gesture" && c.args.id === pan.__znGesture)!
  expect(g.args).toMatchObject({ fails: [list.__znGesture], with: [list.__znGesture], manual: true, zones: [zone.__znElement] })
  expect(g.args.ev).toContain("zone")
  Gesture.activate(pan)
  expect(motionCalls().at(-1)).toMatchObject({ method: "gestureState", args: { id: pan.__znGesture, s: "activate" } })
  moduleEvent("gesture", { g: pan.__znGesture, t: "zone", zone: 0 })
  expect(zones).toEqual([0])
})

test("plugin values, drivers, tilt, and motion values in native view props", () => {
  const seen: number[] = []
  const v = nativeMotion((id) => seen.push(id), 3)
  expect(seen).toEqual([v.__znMotion])
  expect(motionCalls().find((c) => c.method === "value" && c.args.id === v.__znMotion)!.args.v).toBe(3)
  expect(timingJson({ driver: "physics.orbit", params: { g: 2 } })).toEqual({ d: "physics.orbit", p: { g: 2 } })
  const t = useTilt()
  expect(motionCalls().at(-1)).toMatchObject({ method: "tilt", args: { x: t.x.__znMotion, y: t.y.__znMotion, on: true } })
  expect(JSON.parse(viewPropsJson({ position: v, url: "a" }))).toEqual({ position: motionSlotValue(v), url: "a" })
})
