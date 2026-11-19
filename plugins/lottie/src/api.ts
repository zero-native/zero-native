// The lottie plugin's JS side, without the component (LottieView.tsx). Native side: android/.../LottieView.kt.
// Names follow lottie-react-native 7.x, so ported code keeps its props. No side effects: nativeModule() only creates a handle.
import { nativeModule, parseColor, signal, type MotionSource, type Signal } from "@zeronative/core"

/**
 * Where the animation is: `"asset:lottie/x.json"` or `"asset:lottie/x.lottie"`, a file in the app's `assets/` folder (it
 * ships in the bundle, so an OTA update can change it). React Native's `{ uri }` shape works with the same text. No
 * network URLs and no `require(...)`.
 */
export type LottieSource = string | { uri: string }

/**
 * Why there is no animation. not_found: no such file in the running bundle. bad_source: not an `asset:` path. broken: the
 * file is not a Lottie animation (or a `.lottie` with no animation in it). failed: anything else.
 */
export type LottieReason = "not_found" | "bad_source" | "broken" | "failed"

/** What a loaded animation is. Sizes in the file's own units (After Effects pixels). */
export interface LottieInfo {
  width: number
  height: number
  durationMs: number
  /** Frames from start to end, and per second. */
  frames: number
  frameRate: number
}

export type LottiePreload = ({ ok: true } & LottieInfo) | { ok: false; reason: LottieReason }

export interface LottieNativeModule {
  /**
   * Reads and parses a file now, off the main thread, so a view that shows it later draws at once (they share one cache,
   * 20 animations). Never rejects: a bad file is `{ ok: false, reason }`.
   */
  preload(args: { source: string }): Promise<LottiePreload>
}

export const Lottie = nativeModule<LottieNativeModule>("Lottie", { version: 1 })

/**
 * lottie-react-native's imperative methods. You get one through `ref`, as in RN:
 * `ref={(v) => (anim = v)}` or `const anim = useRef<LottieView | null>(null)` + `ref={anim}`.
 */
export interface LottieViewController {
  /** Plays. With both frames: that part, from the first (a first frame bigger than the second plays it backwards). With none: the whole animation, on from where it is, or from the start if it is at the end. */
  play(startFrame?: number, endFrame?: number): void
  /** Stops and goes back to the start. A play that was running ends with `onAnimationFinish(true)`. */
  reset(): void
  /** Stops where it is. No event. */
  pause(): void
  /** Plays on from where it stopped. */
  resume(): void
}

/** What the controller sends native. auto: nothing called yet, so `autoPlay` decides. */
export interface ControllerState {
  mode: "auto" | "play" | "pause" | "stop"
  /** Raised by reset() and by play(start, end): native goes to the start again. */
  restart: number
  /**
   * Raised by every play() and resume(), so a second play() after one ended still reaches native (the rest of the
   * state would be the same). Native plays again from the start if it is at the end.
   */
  plays: number
  from: number | null
  to: number | null
}

interface ControllerParts extends LottieViewController {
  state: Signal<ControllerState>
}

export function lottieController(): LottieViewController {
  const state = signal<ControllerState>({ mode: "auto", restart: 0, plays: 0, from: null, to: null })
  const c: ControllerParts = {
    state,
    play(startFrame, endFrame) {
      const s = state()
      // As in RN: a part only when both frames are given (RN's -1 means "not given").
      const part = typeof startFrame === "number" && typeof endFrame === "number" && startFrame >= 0 && endFrame >= 0
      state.set(
        part
          ? { mode: "play", restart: s.restart + 1, plays: s.plays + 1, from: startFrame!, to: endFrame! }
          : { ...s, mode: "play", plays: s.plays + 1, from: null, to: null },
      )
    },
    reset() {
      const s = state()
      state.set({ ...s, mode: "stop", restart: s.restart + 1 })
    },
    pause() {
      state.set({ ...state(), mode: "pause" })
    },
    resume() {
      const s = state()
      state.set({ ...s, mode: "play", plays: s.plays + 1 })
    },
  }
  return c
}

export function controllerState(c: LottieViewController): ControllerState {
  return (c as ControllerParts).state()
}

/** A callback ref or a `useRef` object, as in RN. */
export type LottieRef = ((view: LottieViewController | null) => void) | { current: LottieViewController | null }

export interface LottieViewProps {
  /** `"asset:lottie/x.json"` (or `.lottie`), or `{ uri: "asset:..." }`. null shows nothing. */
  source: LottieSource | null | undefined
  /** Default false (as in RN): plays once it is loaded. */
  autoPlay?: boolean
  /** Default true (as in RN). */
  loop?: boolean
  /** Default 1. Below 0 plays backwards. */
  speed?: number
  /**
   * 0 to 1. Default 0. A new value jumps there (a play goes on from there).
   * A motion value (registry 24, `useMotion`, a gesture's progress, a scroll value mapped to 0..1) drives the frame
   * natively each frame, with no JS: a pull-to-refresh or a like button that follows the finger. While it drives,
   * autoPlay and play() do nothing.
   */
  progress?: number | MotionSource
  /** Default "contain": all of it in the box. cover: fills the box, cut at the sides. center: its own size, in the middle. */
  resizeMode?: "contain" | "cover" | "center"
  /** Default "AUTOMATIC". */
  renderMode?: "AUTOMATIC" | "HARDWARE" | "SOFTWARE"
  /** true is renderMode "HARDWARE". */
  hardwareAccelerationAndroid?: boolean
  enableMergePathsAndroidForKitKatAndAbove?: boolean
  applyOpacityToLayersAndroid?: boolean
  /** A drawing error shows an empty frame instead of crashing the app. */
  enableSafeModeAndroid?: boolean
  /** Default true. false: parse the file again for this view. */
  cacheComposition?: boolean
  /** Paints layers one colour. `keypath`: a layer name, or "Layer.Group" (everything under it is painted). */
  colorFilters?: { keypath: string; color: string }[]
  /** Called when a play ends: false at the end (never while `loop`), true when reset() stopped it. */
  onAnimationFinish?: (isCancelled: boolean) => void
  /** The file couldn't be shown. `error` is a LottieReason. */
  onAnimationFailure?: (error: string) => void
  onAnimationLoaded?: () => void
  /** Gets the controller: play(), pause(), resume(), reset(). */
  ref?: LottieRef
  /** Accepted for ported code, not used: zn has no test ids. */
  testID?: string
  /**
   * Not supported: the view fills its parent. Put the size on a `View` around it:
   * `<View style={{ width: 140, height: 140 }}><LottieView ... /></View>`. Why: a component can't pass layout through at
   * build time (guide notes §57).
   */
  style?: never
}

/** What native reads. Handlers and the ref stay in JS. A change here is a change of what native reads: raise the version. */
export function lottieProps(p: LottieViewProps, c: LottieViewController): Record<string, unknown> {
  const s = controllerState(c)
  return {
    source: sourceText(p.source),
    autoPlay: p.autoPlay ?? false,
    loop: p.loop ?? true,
    speed: finite(p.speed, 1),
    // A motion value goes as it is: <NativeView> sends it as a reference native reads each frame (viewPropsJson).
    progress: isMotion(p.progress) ? p.progress : p.progress === undefined ? null : Math.min(1, Math.max(0, finite(p.progress, 0))),
    resizeMode: p.resizeMode ?? "contain",
    renderMode: p.hardwareAccelerationAndroid ? "HARDWARE" : (p.renderMode ?? "AUTOMATIC"),
    mergePaths: p.enableMergePathsAndroidForKitKatAndAbove ?? false,
    opacityToLayers: p.applyOpacityToLayersAndroid ?? false,
    safeMode: p.enableSafeModeAndroid ?? false,
    cache: p.cacheComposition ?? true,
    colorFilters: colorFilters(p.colorFilters),
    mode: s.mode,
    restart: s.restart,
    plays: s.plays,
    from: s.from,
    to: s.to,
  }
}

/** A motion value (core motion.ts): a function with its native id. */
function isMotion(v: unknown): v is MotionSource {
  return typeof v === "function" && typeof (v as { __znMotion?: unknown }).__znMotion === "number"
}

function finite(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt
}

export function sourceText(s: LottieSource | null | undefined): string | null {
  if (s == null) return null
  if (typeof s === "string") return s
  return typeof s.uri === "string" ? s.uri : null
}

/** Colours parsed here, as React Native does (processColor): native gets ARGB numbers. A bad colour is left out, with a warning. */
function colorFilters(list: LottieViewProps["colorFilters"]): { keypath: string; color: number }[] {
  const out: { keypath: string; color: number }[] = []
  for (const f of list ?? []) {
    try {
      out.push({ keypath: f.keypath, color: parseColor(f.color) })
    } catch (e) {
      console.warn(`LottieView colorFilters: ${String((e as Error).message ?? e)}; this filter is left out`)
    }
  }
  return out
}

/** One event from the view. Kept out of the component so a test can call it. */
export function onLottieEvent(h: LottieViewProps, e: { name: string; data: any }): void {
  const d = e.data
  switch (e.name) {
    case "loaded":
      return h.onAnimationLoaded?.()
    case "failure":
      return h.onAnimationFailure?.(d.error)
    case "finish":
      return h.onAnimationFinish?.(d.isCancelled === true)
  }
}

/** Gives the ref the controller now, and null when the view goes (call from onCleanup). */
export function setRef(ref: LottieRef | undefined, c: LottieViewController | null): void {
  if (typeof ref === "function") ref(c)
  else if (ref && typeof ref === "object") ref.current = c
}
