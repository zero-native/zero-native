// Gestures and motion (docs/gestures-and-motion-v1.md, guide: docs/motion.md). Native side: android/runtime/.../
// ZnMotion.kt (values, animations), ZnFormula.kt (derive), ZnGesture.kt (gestures).
//
//   const pan = usePan({ axis: "x", bounds: { x: [0, "100%"] }, anchors: [{ id: "start", x: 0 }, { id: "paid", x: "100%" }],
//                        a11yLabel: "Slide to pay", onEnd: (e) => e.anchor === "paid" && pay() })
//   <Box gesture={pan} style={{ transform: [{ translateX: pan.x }] }} />
//   <Text style={{ opacity: pan.progress.map([0, 0.5], [1, 0]) }}>Slide to pay</Text>
//
// A motion value is a number native owns and moves on the UI thread: a finger, an animation, a formula. Put one in a
// style (translateX: pan.x) and native draws it every frame with no JS. Call it (pan.x()) and JS reads it as a signal,
// at most once per frame, and only from the first read on. JS never runs on the UI thread: formulas are compiled to
// data at build time (`derive`), and gestures are options, not callbacks per frame.
import { callNative, onNativeEvent } from "./calls"
import { getOwner, onCleanup, runEventHandler, runWithOwner, signal, type Owner, type Signal } from "./signals"
import { parseColor } from "./color"
import { reportError } from "./errors"

// ---- Types --------------------------------------------------------------------------------------------------------------

/** The `Motion` module's version this file needs (ZnMotion.kt). */
const MOTION_V = 1

/** A curve, as in `animate`: a named one, or a CSS cubic-bezier [x1, y1, x2, y2]. "back" overshoots a little. */
export type MotionEasing = "standard" | "ease-out" | "ease-in" | "linear" | "back" | readonly [number, number, number, number]

/**
 * How a value moves: a duration in ms (a tween), "spring" or "bouncy" (as `animate`), `{ duration, easing }`,
 * `{ spring: { damping, stiffness, mass } }` (Reanimated's numbers), or `{ spring: { duration, dampingRatio } }`.
 * `overshootClamp` stops a spring the first time it reaches the target.
 */
export type MotionTiming =
  | number
  | "spring"
  | "bouncy"
  | { duration: number; easing?: MotionEasing }
  | { spring: { damping?: number; stiffness?: number; mass?: number } | { duration: number; dampingRatio?: number }; overshootClamp?: boolean }

export interface CommandOptions {
  /** Wait this many ms first. */
  delay?: number
  /**
   * A finger holds this value: by default the command is dropped (its promise says finished: false), so a release
   * fling isn't taken over later. true cancels the touch and runs the command (a session ended mid-drag).
   */
  interruptGesture?: boolean
}

export interface DecayOptions extends CommandOptions {
  /** Start speed (units per second). Default: the speed it has now (after a fling, the finger's). */
  velocity?: number
  /** Speed kept per ms, as Reanimated (default 0.998). Lower stops sooner. */
  deceleration?: number
  /** Stops at these limits. */
  clamp?: readonly [number, number]
}

/** One step of a sequence. */
export type MotionStep =
  | { to: number; timing?: MotionTiming; delay?: number }
  | { decay: Omit<DecayOptions, "interruptGesture" | "delay">; delay?: number }
  | { set: number; delay?: number }

export interface Finished {
  /** False when something stopped it first: another command, a finger, stop(), or the screen closing. */
  finished: boolean
}

/** Outside the input range: hold the end values (default), keep the end slopes, or give the input back. */
export type Extrapolate = "clamp" | "extend" | "identity"

/** Anything a style can follow: a motion value, a mapping of one, a formula, a window value. */
export interface MotionSource {
  /** The value now, as a signal: JS hears changes at most once per frame, from the first read on. */
  (): number
  readonly __znMotion: number
  /** Piecewise straight lines through the points (Reanimated's interpolate). */
  map(input: readonly number[], output: readonly number[], options?: { extrapolate?: Extrapolate }): MotionSource
  /** Colours mixed along the input (Reanimated's interpolateColor, RGB). */
  mapColor(input: readonly number[], colors: readonly string[]): MotionColor
  /** The last value JS heard, without subscribing (and without asking native to send changes). */
  peek(): number
}

/** A colour that follows a motion value (for backgroundColor). */
export interface MotionColor {
  readonly __znMotion: number
  readonly __znColor: true
}

/** A motion value you can move (useMotion, and a gesture's x, y, scale, angle). */
export interface MotionValue extends MotionSource {
  /** Jumps there (stops any animation). */
  set(value: number, options?: { interruptGesture?: boolean }): void
  /** Moves there, from where it is and at the speed it has. */
  to(value: number, timing?: MotionTiming, options?: CommandOptions): Promise<Finished>
  /** Slows down to a stop (after a fling). */
  decay(options?: DecayOptions): Promise<Finished>
  /** Steps one after another; `repeat` (a count or "forever") and `reverse` (back and forth). */
  sequence(steps: readonly MotionStep[], options?: CommandOptions & { repeat?: number | "forever"; reverse?: boolean }): Promise<Finished>
  /** Stops it where it is. */
  stop(): void
}

// ---- Ids, lifetimes, native calls ---------------------------------------------------------------------------------------

// 1-15 are the window values (env); JS's own ids start above.
let nextId = 100
const REF = "\u0000m"

/** A call that needs no answer (creation, disposal): sent at once, so it reaches native before the batch using it. */
function send(method: string, args: Record<string, unknown>): void {
  globalThis.__zn_call("Motion", method, JSON.stringify({ ...args, __v: MOTION_V }), 0)
}

function ask<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return callNative<T>("Motion", method, { ...args, __v: 1 }) // MOTION_V (a literal: the build reads it)
}

interface Entry {
  id: number
  mirror: Signal<number>
  watched: boolean
  disposed: boolean
  /** Things made from it (map, mapColor): they go with it. */
  kids: number[]
  /** map() / mapColor() results by their arguments, so a style read again doesn't make new ones. */
  memo: Map<string, unknown>
}

const entries = new Map<number, Entry>()

function entry(id: number, initial: number): Entry {
  const e: Entry = { id, mirror: signal(initial), watched: false, disposed: false, kids: [], memo: new Map() }
  entries.set(id, e)
  return e
}

function disposeIds(ids: number[]): void {
  const all: number[] = []
  const walk = (id: number) => {
    const e = entries.get(id)
    if (!e || e.disposed) return
    e.disposed = true
    entries.delete(id)
    all.push(id)
    e.kids.forEach(walk)
  }
  ids.forEach(walk)
  if (all.length > 0) send("dispose", { ids: all })
}

/** Ties [ids] to the current owner (a component, a screen): disposed with it. Without an owner they live on. */
function owned(ids: number[]): void {
  if (getOwner()) onCleanup(() => disposeIds(ids))
}

function isSource(v: unknown): v is { __znMotion: number } {
  return (typeof v === "function" || typeof v === "object") && v !== null && typeof (v as { __znMotion?: unknown }).__znMotion === "number"
}

/** What a slot sends for a motion source (view.ts toNative): native reads it frame by frame. Undefined for others. */
export function motionSlotValue(v: unknown): string | number | undefined {
  if (v === null || (typeof v !== "function" && typeof v !== "object")) return undefined
  const m = (v as { __znMotion?: unknown }).__znMotion
  if (typeof m === "number") return REF + m
  const g = (v as { __znGesture?: unknown }).__znGesture
  if (typeof g === "number") return g
  if ((v as { __znSelf?: unknown }).__znSelf !== undefined) {
    throw new Error("self.width / self.height / parent.* work only inside derive(() => ...)")
  }
  return undefined
}

// ---- Sources ------------------------------------------------------------------------------------------------------------

function makeSource(e: Entry): MotionSource {
  const read = (() => {
    if (!e.watched && !e.disposed) {
      e.watched = true
      send("watch", { id: e.id, on: true })
    }
    return e.mirror()
  }) as MotionSource
  Object.defineProperty(read, "__znMotion", { value: e.id })
  read.peek = () => e.mirror.peek()
  read.map = (input, output, options) => {
    const ex = options?.extrapolate === "extend" ? 1 : options?.extrapolate === "identity" ? 2 : 0
    checkPoints(input, output.length, "map")
    const key = `m${JSON.stringify(input)}${JSON.stringify(output)}${ex}`
    const hit = e.memo.get(key) as MotionSource | undefined
    if (hit && entries.has(hit.__znMotion)) return hit
    const id = nextId++
    send("map", { id, src: e.id, in: input, out: output, ex })
    const kid = entry(id, interpolate(e.mirror.peek(), input, output, options?.extrapolate))
    e.kids.push(id)
    const s = makeSource(kid)
    e.memo.set(key, s)
    return s
  }
  read.mapColor = (input, colors) => {
    checkPoints(input, colors.length, "mapColor")
    const key = `c${JSON.stringify(input)}${JSON.stringify(colors)}`
    const hit = e.memo.get(key) as MotionColor | undefined
    if (hit && entries.has(hit.__znMotion)) return hit
    const id = nextId++
    send("mapColor", { id, src: e.id, in: input, out: colors.map((c) => parseColor(c)) })
    entry(id, 0)
    e.kids.push(id)
    const c: MotionColor = { __znMotion: id, __znColor: true }
    e.memo.set(key, c)
    return c
  }
  return read
}

function checkPoints(input: readonly number[], outputs: number, what: string): void {
  if (input.length < 2 || input.length !== outputs) throw new Error(`${what}: give 2 or more input points and as many outputs`)
  for (let i = 1; i < input.length; i++) {
    if (!(input[i] >= input[i - 1])) throw new Error(`${what}: input points must go up (${input.join(", ")})`)
  }
}

/** Reanimated's interpolate, in JS (for a mirror's first value and for tests). */
export function interpolate(x: number, input: readonly number[], output: readonly number[], extrapolate: Extrapolate = "clamp"): number {
  const n = input.length
  if (n === 0) return x
  if (n === 1) return output[0]
  if (x <= input[0] || x >= input[n - 1]) {
    const low = x <= input[0]
    if (extrapolate === "clamp") return low ? output[0] : output[n - 1]
    if (extrapolate === "identity") return x
    const i = low ? 0 : n - 2
    return seg(x, input[i], input[i + 1], output[i], output[i + 1])
  }
  let i = 0
  while (i < n - 2 && x > input[i + 1]) i++
  return seg(x, input[i], input[i + 1], output[i], output[i + 1])
}

function seg(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

// ---- Values and commands ------------------------------------------------------------------------------------------------

const EASINGS: Record<string, number> = { standard: 0, "ease-out": 1, "ease-in": 2, linear: 3 }

/** A timing as ZnTimingSpec.parse reads it. */
export function timingJson(t: MotionTiming | undefined): Record<string, unknown> | undefined {
  if (t === undefined || t === "spring") return { r: 0.75, k: 400 }
  if (t === "bouncy") return { r: 0.45, k: 400 }
  if (typeof t === "number") return { t: Math.max(0, Math.round(t)), e: 0 }
  if ("duration" in t && !("spring" in t)) {
    const e = t.easing ?? "standard"
    if (e === "back") return { t: Math.round(t.duration), e: 4, b: [0.34, 1.56, 0.64, 1] }
    if (typeof e === "string") return { t: Math.round(t.duration), e: EASINGS[e] ?? 0 }
    return { t: Math.round(t.duration), e: 4, b: [...e] }
  }
  const s = (t as { spring: Record<string, number | undefined> }).spring
  const clamp = (t as { overshootClamp?: boolean }).overshootClamp === true
  if (typeof s.duration === "number") {
    // A perceptual duration: one cycle of the undamped spring takes about that long.
    const w = (2 * Math.PI) / Math.max(0.05, s.duration / 1000)
    return { r: s.dampingRatio ?? 0.5, k: w * w, c: clamp }
  }
  // Reanimated's defaults: damping 10, stiffness 100, mass 1 (a ratio of 0.5).
  const damping = s.damping ?? 10
  const stiffness = s.stiffness ?? 100
  const mass = s.mass && s.mass > 0 ? s.mass : 1
  return { r: damping / (2 * Math.sqrt(stiffness * mass)), k: stiffness / mass, c: clamp }
}

function stepJson(s: MotionStep): Record<string, unknown> {
  if ("set" in s) return { set: s.set, delay: s.delay ?? 0 }
  if ("decay" in s) return { decay: decayJson(s.decay), delay: s.delay ?? 0 }
  return { to: s.to, t: timingJson(s.timing), delay: s.delay ?? 0 }
}

function decayJson(o: DecayOptions = {}): Record<string, unknown> {
  const d = o.deceleration ?? 0.998
  const out: Record<string, unknown> = { f: (-1000 * Math.log(d > 0.9 && d < 1 ? d : 0.998)) / 4.2 }
  if (o.velocity !== undefined) out.v = o.velocity
  if (o.clamp) {
    out.lo = o.clamp[0]
    out.hi = o.clamp[1]
  }
  return out
}

function makeValue(e: Entry): MotionValue {
  const v = makeSource(e) as MotionValue
  const run = (steps: Record<string, unknown>[], o: { interruptGesture?: boolean; repeat?: number | "forever"; reverse?: boolean } = {}) => {
    if (e.disposed) return Promise.resolve({ finished: false })
    const repeat = o.repeat === "forever" ? -1 : Math.max(1, Math.floor(o.repeat ?? 1))
    return ask<Finished>("animate", { id: e.id, steps, repeat, reverse: o.reverse === true, interrupt: o.interruptGesture === true })
  }
  v.set = (value, options) => {
    if (e.disposed) return
    e.mirror.set(value)
    send("set", { id: e.id, v: value, interrupt: options?.interruptGesture === true })
  }
  v.to = (value, timing, options) => run([{ to: value, t: timingJson(timing), delay: options?.delay ?? 0 }], options)
  v.decay = (options) => run([{ decay: decayJson(options), delay: options?.delay ?? 0 }], options)
  v.sequence = (steps, options) => run(steps.map(stepJson), options)
  v.stop = () => {
    if (!e.disposed) send("stop", { id: e.id })
  }
  return v
}

/**
 * A number native owns and moves on the UI thread (Reanimated's useSharedValue). Bind it in a style; move it with
 * `to`, `decay`, `sequence`; read it in JS by calling it. Lives as long as the component that made it.
 */
export function useMotion(initial = 0): MotionValue {
  const id = nextId++
  send("value", { id, v: Number.isFinite(initial) ? initial : 0 })
  const e = entry(id, initial)
  owned([id])
  return makeValue(e)
}

/**
 * A value 0 → 1 over [duration] ms that many elements follow through `map` (one clock, so nothing gets out of step).
 * `play()`, `reverse()`, `seek(p)`, `pause()`; `repeat` and `yoyo` loop it.
 */
export function useTimeline(options: { duration: number; easing?: MotionEasing; repeat?: number | "forever"; yoyo?: boolean }) {
  const v = useMotion(0)
  const timing: MotionTiming = { duration: options.duration, easing: options.easing ?? "linear" }
  return Object.assign(v, {
    play: () => v.sequence([{ to: 1, timing }], { repeat: options.repeat, reverse: options.yoyo }),
    reverse: () => v.to(0, { duration: options.duration * Math.max(0, v.peek()), easing: options.easing ?? "linear" }),
    seek: (p: number) => v.set(Math.min(1, Math.max(0, p))),
    pause: () => v.stop(),
  })
}

/**
 * Chases [source] with a spring (Reanimated's useDerivedValue(() => withSpring(x))): chat heads that trail each
 * other, an elastic parallax. Keeps its speed when the source moves again.
 */
export function follow(source: MotionSource, timing: MotionTiming = "spring"): MotionSource {
  const id = nextId++
  send("follow", { id, src: source.__znMotion, t: timingJson(timing) })
  const e = entry(id, entries.get(source.__znMotion)?.mirror.peek() ?? 0)
  owned([id])
  return makeSource(e)
}

// ---- derive -------------------------------------------------------------------------------------------------------------

/**
 * A formula of motion values that native runs every frame (Reanimated's useDerivedValue / a worklet for visuals):
 * `derive(() => Math.abs(pan.x) / 120)`. The build compiles the arrow to data (compiler motion.ts): numbers, motion
 * values, + - * / %, comparisons, && || !, ? :, Math.min / max / abs / floor / ceil / round / sign / sqrt / pow / sin /
 * cos / tan / atan2 / hypot / exp / log, Math.PI, clamp(), interpolate(), interpolateColor() (last), and `self` /
 * `parent` sizes. Anything else (a call to your function, a loop) is a build error.
 */
export function derive(_fn: () => number): MotionSource {
  throw new Error("derive(() => ...) is compiled by the zero-native build; it can't run as plain JS")
}

/** For derive formulas only: clamp(x, min, max). Runs in JS too (tests). */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, Math.min(lo, hi)), Math.max(lo, hi))
}

/** For derive formulas: interpolateColor(x, [inputs], [colours]); must be the formula's last step. */
export function interpolateColor(_x: number, _input: readonly number[], _colors: readonly string[]): never {
  throw new Error("interpolateColor works only inside derive(() => ...)")
}

const formulaMemo = new Map<string, MotionSource | MotionColor>()

/** What the compiler turns derive(() => ...) into. [inputs]: motion sources or numbers, read where the arrow was. */
export function __deriveFormula(code: (string | number)[], inputs: unknown[], tables: unknown[] | undefined, color: boolean): MotionSource {
  const srcs = inputs.map((v, i) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0
    if (isSource(v)) return { m: v.__znMotion }
    throw new Error(`derive: input ${i} is not a number or a motion value (got ${typeof v}); compute it before, or make it a motion value`)
  })
  const key = JSON.stringify([code, srcs, tables ?? null])
  const hit = formulaMemo.get(key)
  if (hit && entries.has(hit.__znMotion)) return hit as MotionSource
  const id = nextId++
  const t = (tables ?? []).map((tb) => {
    const [ins, outs, ex, isColor] = tb as [number[], (number | string)[], number, number?]
    return isColor ? [ins, outs.map((c) => parseColor(String(c))), ex, 1] : [ins, outs, ex, 0]
  })
  send("formula", { id, code, srcs, tables: t })
  const e = entry(id, 0)
  // Lives as long as the owner it was made under, and leaves the memo with it.
  owned([id])
  if (getOwner()) onCleanup(() => formulaMemo.delete(key))
  const out = color ? ({ __znMotion: id, __znColor: true } as MotionColor) : makeSource(e)
  formulaMemo.set(key, out)
  return out as MotionSource
}

// The compiler's derive(() => ...) becomes derive.__f(...) (compiler motion.ts): no extra import in app files.
;(derive as unknown as { __f: typeof __deriveFormula }).__f = __deriveFormula

/** `self.width` / `parent.height` inside derive: the size of the element the formula is bound on (dp). */
export const self = { width: { __znSelf: "sw" }, height: { __znSelf: "sh" } } as unknown as { readonly width: number; readonly height: number }
export const parent = { width: { __znSelf: "pw" }, height: { __znSelf: "ph" } } as unknown as { readonly width: number; readonly height: number }

// ---- Window values (env) ------------------------------------------------------------------------------------------------

function envSource(id: number): MotionSource {
  const e = entries.get(id) ?? entry(id, 0)
  return makeSource(e)
}

/**
 * The window, as motion values (dp), for formulas, bindings and snap points (pillar 1): it keeps up with rotation,
 * split screen, and the keyboard frame by frame.
 */
export const env = {
  width: lazy(1),
  height: lazy(2),
  insets: { top: lazy(3), bottom: lazy(4), start: lazy(5), end: lazy(6) },
  /** The keyboard's height now (moves every frame while it opens or closes). */
  keyboardHeight: lazy(7),
  /** Where the keyboard is going: its full height while opening, 0 while closing. */
  keyboardTarget: lazy(8),
}

/** Made on first use, so a bundle that never touches env sends nothing. */
function lazy(id: number): MotionSource {
  let s: MotionSource | null = null
  const get = () => (s ??= envSource(id))
  const proxy = (() => get()()) as MotionSource
  Object.defineProperty(proxy, "__znMotion", { value: id })
  proxy.map = (a, b, c) => get().map(a, b, c)
  proxy.mapColor = (a, b) => get().mapColor(a, b)
  proxy.peek = () => get().peek()
  return proxy
}

// ---- Values from native -------------------------------------------------------------------------------------------------

let listening = false

/** Starts hearing values and gesture events (once, at the first motion object). */
function listen(): void {
  if (listening) return
  listening = true
  // Not tied to a screen: values and gestures of every screen come through this one listener.
  onNativeEventDetached("values", (payload: Record<string, number>) => {
    for (const k in payload) entries.get(Number(k))?.mirror.set(payload[k])
  })
  onNativeEventDetached("gesture", (payload: GestureEvent & { g: number; t: string }) => {
    const h = handlers.get(payload.g)
    if (!h) return
    const fn = h.on[payload.t]
    if (fn) runEventHandler(h.owner, () => fn(payload))
  })
}

function onNativeEventDetached(event: string, fn: (payload: any) => void): void {
  // Outside any owner, so a screen closing doesn't stop it.
  runWithOwner(null, () => onNativeEvent("Motion", event, (p) => {
    try {
      fn(p)
    } catch (err) {
      reportError(`motion ${event}`, err)
    }
  }))
}

// ---- Gestures -----------------------------------------------------------------------------------------------------------

/** A coordinate: dp, "N%" (the room to travel: parent size minus own size), "N%self", "N%parent", or a motion value. */
export type Coord = number | `${number}%` | `${number}%self` | `${number}%parent` | MotionSource

export interface GestureEvent {
  /** Where it was (dp) when the finger lifted, or the tap point. */
  x?: number
  y?: number
  /** Speed at release (dp/s). */
  vx?: number
  vy?: number
  /** The anchor (or magnet) it is going to, if any. */
  anchor?: string
  /** Where it is going (dp). */
  toX?: number
  toY?: number
  /** Something else took the touch (a scroll, interruptGesture), or the system cancelled it. */
  cancelled?: boolean
  /** It came from TalkBack / VoiceOver, not a finger. */
  accessibility?: boolean
  scale?: number
  angle?: number
  direction?: "left" | "right" | "up" | "down"
}

interface CommonOptions {
  /** Haptics, played natively in the same frame: "light" | "medium" | "heavy" | "selection" | "success" | "error". */
  haptic?: { start?: HapticName; snap?: HapticName; magnet?: HapticName; cross?: HapticName; longPress?: HapticName }
  /**
   * Who wins with the scrolling things around it. "after-edge": an inner list scrolls first, this moves when it is at
   * its top (a sheet with a list); "simultaneous": both move; "block": this takes the touch even from a child.
   */
  withParent?: "after-edge" | "simultaneous" | "block"
  /** Read by TalkBack / VoiceOver; required for a gesture that does something (anchors, a tap). */
  a11yLabel?: string
  onBegin?: () => void
  onStart?: (e: GestureEvent) => void
  /** Each frame while it moves (coalesced); prefer bindings for visuals. */
  onUpdate?: (e: GestureEvent) => void
  onEnd?: (e: GestureEvent) => void
  onFinalize?: () => void
}

export type HapticName = "light" | "medium" | "heavy" | "selection" | "success" | "error" | "none"

export interface Anchor {
  id: string
  x?: Coord
  y?: Coord
}

export interface Magnet {
  id: string
  x: Coord
  y: Coord
  /** dp. Default 80. */
  radius?: number
  /** 0–1: how hard it pulls at the centre. Default 0.5. */
  pull?: number
}

export interface PanOptions extends CommonOptions {
  /** Which way it moves: "x", "y" or "xy" (default). On one axis a drag the other way goes to the scroll around it. */
  axis?: "x" | "y" | "xy"
  /** Where it starts (dp). */
  initial?: { x?: number; y?: number }
  bounds?: { x?: readonly [Coord, Coord]; y?: readonly [Coord, Coord] }
  /** Rubber band past the bounds (default true). */
  rubber?: boolean
  /** Snap points: { id, x, y } (one axis uses its own). Plain numbers get ids "0", "1"... */
  anchors?: readonly (Anchor | number | Coord)[]
  /** Magnetic zones (a dismiss target). Releasing inside one snaps there. */
  magnets?: readonly Magnet[]
  release?: {
    /** Pick the anchor nearest to where a fling would stop (a flick to a corner). Default false. */
    project?: boolean
    /** One axis: a flick faster than `velocity` (dp/s, default 400) goes to the next anchor its way; a move shorter than `distance` goes back. */
    threshold?: { velocity?: number; distance?: number }
    /** No anchors: slow down instead of stopping (scroll-like). */
    decay?: boolean
    deceleration?: number
    /** The spring to anchors. Default "spring". */
    spring?: MotionTiming
  }
  /** Values on the main axis that call onCross (and the `cross` haptic) when passed. */
  cross?: readonly number[]
  onCross?: (e: { at: number; forward: boolean }) => void
  onMagnet?: (e: { id: string; inside: boolean }) => void
  /** After the spring to an anchor ends. */
  onSettle?: (e: { anchor: string | null }) => void
  minDistance?: number
  activeOffsetX?: readonly [number, number]
  activeOffsetY?: readonly [number, number]
  failOffsetX?: readonly [number, number]
  failOffsetY?: readonly [number, number]
  minPointers?: number
  maxPointers?: number
  /** Long press first, then drag (reorder, a floating button in a scroll). ms. */
  activateAfterLongPress?: number
}

/** A gesture to put on an element: `<Box gesture={pan}>`. */
export interface Gesture {
  readonly __znGesture: number
}

export interface PanGesture extends Gesture {
  readonly x: MotionValue
  readonly y: MotionValue
  /** 0 → 1 between the bounds of its axis (x for "x" and "xy"). */
  readonly progress: MotionSource
  /** 0 far away → 1 at the centre of magnet [id]. */
  magnet(id: string): MotionSource
  /** Springs to an anchor or magnet (a failed payment springs the slider back). */
  snapTo(anchor: string, timing?: MotionTiming): Promise<Finished>
}

interface Handlers {
  owner: Owner | null
  on: Record<string, ((e: any) => void) | undefined>
}

const handlers = new Map<number, Handlers>()

function coordJson(c: Coord | undefined): unknown {
  if (c === undefined) return undefined
  if (typeof c === "number" || typeof c === "string") return c
  if (isSource(c)) return { m: c.__znMotion }
  throw new Error("a coordinate is a number, \"N%\", \"N%self\", \"N%parent\" or a motion value")
}

function makeGesture(kind: string, o: CommonOptions & Record<string, unknown>, values: Record<string, number>, extra: Record<string, unknown>, on: Record<string, ((e: any) => void) | undefined>): number {
  listen()
  const id = nextId++
  const ev = Object.entries(on).filter(([, f]) => f).map(([k]) => k)
  send("gesture", {
    id,
    kind,
    values,
    ev,
    withParent: o.withParent,
    a11yLabel: o.a11yLabel,
    haptic: o.haptic,
    ...extra,
  })
  handlers.set(id, { owner: getOwner(), on })
  const ids = [id, ...Object.values(values).filter((v) => typeof v === "number" && Number.isInteger(v))]
  if (getOwner()) onCleanup(() => {
    handlers.delete(id)
    disposeIds(ids)
  })
  return id
}

function valueFor(id: number, initial: number): MotionValue {
  return makeValue(entry(id, initial))
}

/** Drag in one or two axes (RNGH Pan + Reanimated's drag logic), with snap points, magnets, rubber edges and decay. */
export function usePan(o: PanOptions = {}): PanGesture {
  const xi = o.initial?.x ?? 0
  const yi = o.initial?.y ?? 0
  const ids = { x: nextId++, y: nextId++, progress: nextId++ }
  const anchors = (o.anchors ?? []).map((a, i) => {
    if (typeof a === "object" && a !== null && "id" in a && !isSource(a)) return { id: (a as Anchor).id, x: coordJson((a as Anchor).x), y: coordJson((a as Anchor).y) }
    const c = coordJson(a as Coord)
    return o.axis === "y" ? { id: String(i), y: c } : { id: String(i), x: c }
  })
  const magnetIds = new Map<string, number>()
  const magnets = (o.magnets ?? []).map((m) => {
    const src = nextId++
    magnetIds.set(m.id, src)
    return { id: m.id, x: coordJson(m.x), y: coordJson(m.y), radius: m.radius ?? 80, pull: m.pull ?? 0.5, src }
  })
  if (anchors.length > 0 && !o.a11yLabel) {
    throw new Error("usePan with anchors needs a11yLabel: TalkBack users move it with an action per anchor")
  }
  const values: Record<string, number> = { x: ids.x, "x.v": xi, y: ids.y, "y.v": yi, progress: ids.progress }
  const id = makeGesture("pan", o as never, values, {
    axis: o.axis ?? "xy",
    bounds: o.bounds ? { x: o.bounds.x?.map(coordJson), y: o.bounds.y?.map(coordJson) } : undefined,
    rubber: o.rubber ?? true,
    anchors,
    magnets,
    release: o.release ? { ...o.release, spring: timingJson(o.release.spring) } : undefined,
    cross: o.cross,
    minDistance: o.minDistance,
    activeOffsetX: o.activeOffsetX,
    activeOffsetY: o.activeOffsetY,
    failOffsetX: o.failOffsetX,
    failOffsetY: o.failOffsetY,
    minPointers: o.minPointers,
    maxPointers: o.maxPointers,
    activateAfterLongPress: o.activateAfterLongPress,
  }, {
    begin: o.onBegin, start: o.onStart, update: o.onUpdate, end: o.onEnd, finalize: o.onFinalize,
    cross: o.onCross, magnet: o.onMagnet, settle: o.onSettle,
  })
  for (const m of magnetIds.values()) entry(m, 0)
  const progress = makeSource(entry(ids.progress, 0))
  return {
    __znGesture: id,
    x: valueFor(ids.x, xi),
    y: valueFor(ids.y, yi),
    progress,
    magnet: (name: string) => {
      const m = magnetIds.get(name)
      if (m === undefined) throw new Error(`usePan has no magnet "${name}"`)
      return makeSource(entries.get(m) ?? entry(m, 0))
    },
    snapTo: (anchor, timing) => ask<Finished>("snapTo", { id, anchor, t: timingJson(timing) }),
  }
}

export interface PinchOptions extends CommonOptions {
  /** Scale it starts at (default 1), and limits it springs back inside on release. */
  initial?: number
  min?: number
  max?: number
}

/** Two-finger pinch (RNGH Pinch): `scale`, and the focal point between the fingers (dp, in the element). */
export function usePinch(o: PinchOptions = {}): Gesture & { scale: MotionValue; focalX: MotionSource; focalY: MotionSource } {
  const ids = { scale: nextId++, focalX: nextId++, focalY: nextId++ }
  const id = makeGesture("pinch", o as never, { scale: ids.scale, "scale.v": o.initial ?? 1, focalX: ids.focalX, focalY: ids.focalY }, { min: o.min, max: o.max },
    { begin: o.onBegin, start: o.onStart, update: o.onUpdate, end: o.onEnd, finalize: o.onFinalize })
  return { __znGesture: id, scale: valueFor(ids.scale, o.initial ?? 1), focalX: makeSource(entry(ids.focalX, 0)), focalY: makeSource(entry(ids.focalY, 0)) }
}

/** Two-finger turn (RNGH Rotation): `angle` in degrees. */
export function useRotate(o: CommonOptions & { initial?: number } = {}): Gesture & { angle: MotionValue } {
  const a = nextId++
  const id = makeGesture("rotate", o as never, { angle: a, "angle.v": o.initial ?? 0 }, {},
    { begin: o.onBegin, start: o.onStart, update: o.onUpdate, end: o.onEnd, finalize: o.onFinalize })
  return { __znGesture: id, angle: valueFor(a, o.initial ?? 0) }
}

export interface TapOptions extends CommonOptions {
  /** 2 for a double tap. */
  taps?: number
  maxDuration?: number
  /** ms allowed between taps. */
  maxDelay?: number
  /** dp the finger may move. */
  maxDistance?: number
}

/** Taps (RNGH Tap), for combining (double tap to like, story tap zones). Plain buttons stay <Pressable>. `pressed` 0 → 1. */
export function useTap(o: TapOptions = {}): Gesture & { pressed: MotionSource } {
  const p = nextId++
  const id = makeGesture("tap", o as never, { pressed: p }, { taps: o.taps, maxDuration: o.maxDuration, maxDelay: o.maxDelay, maxDistance: o.maxDistance },
    { begin: o.onBegin, end: o.onEnd, finalize: o.onFinalize })
  return { __znGesture: id, pressed: makeSource(entry(p, 0)) }
}

/** Hold (RNGH LongPress): `pressed` while down, `held` 0 → 1 over minDuration; onStart when it fires. */
export function useLongPress(o: CommonOptions & { minDuration?: number; maxDistance?: number } = {}): Gesture & { pressed: MotionSource; held: MotionSource } {
  const p = nextId++
  const h = nextId++
  const id = makeGesture("longPress", o as never, { pressed: p, held: h }, { minDuration: o.minDuration, maxDistance: o.maxDistance },
    { begin: o.onBegin, start: o.onStart, end: o.onEnd, finalize: o.onFinalize })
  return { __znGesture: id, pressed: makeSource(entry(p, 0)), held: makeSource(entry(h, 0)) }
}

/** A quick swipe (RNGH Fling) in one of [directions]; onEnd says which. */
export function useFling(o: CommonOptions & { directions?: readonly ("left" | "right" | "up" | "down")[]; minVelocity?: number } = {}): Gesture {
  const id = makeGesture("fling", o as never, {}, { directions: o.directions, minVelocity: o.minVelocity },
    { end: o.onEnd, finalize: o.onFinalize })
  return { __znGesture: id }
}

function group(mode: string, gs: Gesture[]): Gesture {
  if (gs.length === 0) throw new Error(`Gesture.${mode}() needs gestures`)
  listen()
  const id = nextId++
  send("gestureGroup", { id, mode, of: gs.map((g) => g.__znGesture) })
  if (getOwner()) onCleanup(() => send("dispose", { ids: [id] }))
  return { __znGesture: id }
}

/** Combining gestures on one element (RNGH Gesture.Simultaneous / Exclusive / Race). */
export const Gesture = {
  /** All may run at once (pinch + rotate + pan on a photo). */
  simultaneous: (...gs: Gesture[]) => group("simultaneous", gs),
  /** In order: one starts only when every one before it has failed (double tap before single tap). */
  exclusive: (...gs: Gesture[]) => group("exclusive", gs),
  /** The first to start wins; the others fail. */
  race: (...gs: Gesture[]) => group("race", gs),
}
