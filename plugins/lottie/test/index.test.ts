import { beforeEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { compileModule } from "../../../compiler/src/compile"
import { controllerState, Lottie, lottieController, lottieProps, onLottieEvent, setRef, sourceText, type LottieViewController } from "../src/api"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("preload names the module, the version and the source", async () => {
  const p = Lottie.preload({ source: "asset:lottie/a.json" })
  const [call] = host.calls
  expect(call).toMatchObject({ module: "Lottie", method: "preload", args: { source: "asset:lottie/a.json", __v: 1 } })
  const info = { ok: true, width: 200, height: 200, durationMs: 2000, frames: 60, frameRate: 30 }
  reply({ id: call.id, ok: true, value: info })
  expect(await p).toEqual(info)
})

// A change here is a change of what native reads: raise the module version (docs/plugins.md D3).
test("props snapshot: RN's defaults, and no handlers", () => {
  const c = lottieController()
  expect(lottieProps({ source: "asset:lottie/a.json", onAnimationFinish: () => {} }, c)).toEqual({
    source: "asset:lottie/a.json",
    autoPlay: false,
    loop: true,
    speed: 1,
    progress: null,
    resizeMode: "contain",
    renderMode: "AUTOMATIC",
    mergePaths: false,
    opacityToLayers: false,
    safeMode: false,
    cache: true,
    colorFilters: [],
    mode: "auto",
    restart: 0,
    plays: 0,
    from: null,
    to: null,
  })
  expect(
    lottieProps(
      {
        source: { uri: "asset:lottie/b.lottie" },
        autoPlay: true,
        loop: false,
        speed: -2,
        progress: 0.25,
        resizeMode: "cover",
        hardwareAccelerationAndroid: true,
        enableMergePathsAndroidForKitKatAndAbove: true,
        applyOpacityToLayersAndroid: true,
        enableSafeModeAndroid: true,
        cacheComposition: false,
        colorFilters: [{ keypath: "Shape Layer 1", color: "#FF0000" }],
      },
      c,
    ),
  ).toMatchObject({
    source: "asset:lottie/b.lottie",
    autoPlay: true,
    loop: false,
    speed: -2,
    progress: 0.25,
    resizeMode: "cover",
    renderMode: "HARDWARE",
    mergePaths: true,
    opacityToLayers: true,
    safeMode: true,
    cache: false,
    colorFilters: [{ keypath: "Shape Layer 1", color: 0xffff0000 }],
  })
})

test("progress is kept between 0 and 1, and a bad speed is 1", () => {
  const c = lottieController()
  expect(lottieProps({ source: "asset:a.json", progress: 3 }, c).progress).toBe(1)
  expect(lottieProps({ source: "asset:a.json", progress: -1 }, c).progress).toBe(0)
  expect(lottieProps({ source: "asset:a.json", speed: Number.NaN }, c).speed).toBe(1)
})

test("a bad colour is left out with a warning, not a crash", () => {
  const warn = console.warn
  const heard: string[] = []
  console.warn = (m: string) => void heard.push(m)
  try {
    const p = lottieProps({ source: "asset:a.json", colorFilters: [{ keypath: "A", color: "nope" }, { keypath: "B", color: "red" }] }, lottieController())
    expect(p.colorFilters).toEqual([{ keypath: "B", color: 0xffff0000 }])
    expect(heard.length).toBe(1)
  } finally {
    console.warn = warn
  }
})

test("source: a string, RN's { uri }, or nothing", () => {
  expect(sourceText("asset:a.json")).toBe("asset:a.json")
  expect(sourceText({ uri: "asset:a.lottie" })).toBe("asset:a.lottie")
  expect(sourceText(null)).toBeNull()
  expect(sourceText(undefined)).toBeNull()
})

test("the controller: play, pause, resume, reset as RN's methods", () => {
  const c = lottieController()
  expect(controllerState(c)).toEqual({ mode: "auto", restart: 0, plays: 0, from: null, to: null })
  c.play()
  expect(controllerState(c)).toEqual({ mode: "play", restart: 0, plays: 1, from: null, to: null })
  c.pause()
  expect(controllerState(c).mode).toBe("pause")
  c.resume()
  expect(controllerState(c).mode).toBe("play")
  // Each play() and resume() raises `plays`, so a second play() after one ended still reaches native.
  expect(controllerState(c).plays).toBe(2)
  // ZeroBill's Welcome slide: reset() then play() in one tick. The restart stays raised, so native starts again from 0.
  c.reset()
  c.play()
  expect(controllerState(c)).toEqual({ mode: "play", restart: 1, plays: 3, from: null, to: null })
  // A part needs both frames, as in RN.
  c.play(10, 40)
  expect(controllerState(c)).toEqual({ mode: "play", restart: 2, plays: 4, from: 10, to: 40 })
  c.play(10)
  expect(controllerState(c)).toEqual({ mode: "play", restart: 2, plays: 5, from: null, to: null })
  c.play(-1, -1)
  expect(controllerState(c).from).toBeNull()
  // reset() keeps the part, like Lottie's cancelAnimation + progress 0.
  c.play(5, 9)
  c.reset()
  expect(controllerState(c)).toEqual({ mode: "stop", restart: 4, plays: 7, from: 5, to: 9 })
})

test("the controller's state reaches the props", () => {
  const c = lottieController()
  c.play(3, 9)
  expect(lottieProps({ source: "asset:a.json" }, c)).toMatchObject({ mode: "play", restart: 1, from: 3, to: 9 })
})

test("refs: a callback ref and a useRef object, both cleared", () => {
  const c = lottieController()
  const seen: (LottieViewController | null)[] = []
  setRef((v) => seen.push(v), c)
  setRef((v) => seen.push(v), null)
  expect(seen).toEqual([c, null])
  const r = { current: null as LottieViewController | null }
  setRef(r, c)
  expect(r.current).toBe(c)
  setRef(r, null)
  expect(r.current).toBeNull()
  expect(() => setRef(undefined, c)).not.toThrow()
})

test("view events reach RN's handlers", () => {
  const heard: unknown[][] = []
  const h = {
    source: "asset:a.json",
    onAnimationLoaded: () => heard.push(["loaded"]),
    onAnimationFailure: (e: string) => heard.push(["failure", e]),
    onAnimationFinish: (c: boolean) => heard.push(["finish", c]),
  }
  onLottieEvent(h, { name: "loaded", data: { width: 1, height: 1, durationMs: 1, frames: 1, frameRate: 30 } })
  onLottieEvent(h, { name: "failure", data: { error: "not_found" } })
  onLottieEvent(h, { name: "finish", data: { isCancelled: false } })
  onLottieEvent(h, { name: "finish", data: { isCancelled: true } })
  expect(heard).toEqual([["loaded"], ["failure", "not_found"], ["finish", false], ["finish", true]])
  expect(() => onLottieEvent({ source: null }, { name: "finish", data: { isCancelled: false } })).not.toThrow()
})

test("the component compiles to the view the plugin registers", () => {
  const path = join(import.meta.dir, "..", "src", "LottieView.tsx")
  const views: string[] = []
  const templates: unknown[] = []
  const out = compileModule(readFileSync(path, "utf8"), path, {
    reserveTemplate: () => templates.push(null) - 1,
    defineTemplate: (id, spec) => void (templates[id] = spec),
    nativeView: (name) => void views.push(name),
  })
  expect(views).toEqual(["lottie.view"])
  expect(out.components.LottieView).toBeDefined()
})
