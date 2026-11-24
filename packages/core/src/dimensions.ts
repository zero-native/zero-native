// Dimensions, useWindowDimensions and PixelRatio: React Native's names for the window's size (RN basics pack,
// docs/guide-notes.md §39). All sizes are dp, as in styles.
//
//   const { width } = Dimensions.get("window")
//   const onePx = 1 / PixelRatio.get()
//
// The values come from native (app event WINDOW, android/runtime/.../ZnWindow.kt): a first value right after the main
// script, then the measured window and each change (rotation, split screen, font size). Reads go through a signal, so
// a read inside JSX or an `effect` follows changes. They can size a layout too: width, height, margin and padding take
// a value from a signal (docs/rn-compatibility.md §0, Registry 23), e.g. `width: Dimensions.get("window").width`.
import { APP, AppEvent } from "./app-events"
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { getOwner, onCleanup, signal } from "./signals"

export interface ScaledSize {
  width: number
  height: number
  /** Pixels per dp. */
  scale: number
  /** The user's font size setting (1 is normal). */
  fontScale: number
}

interface WindowFacts {
  window: ScaledSize
  screen: ScaledSize
}

const same = (a: WindowFacts, b: WindowFacts) =>
  a.window.width === b.window.width &&
  a.window.height === b.window.height &&
  a.window.scale === b.window.scale &&
  a.window.fontScale === b.window.fontScale &&
  a.screen.width === b.screen.width &&
  a.screen.height === b.screen.height

const zero: ScaledSize = { width: 0, height: 0, scale: 1, fontScale: 1 }
const current = signal<WindowFacts>({ window: zero, screen: zero }, { equals: same })
const listeners = new Set<(sizes: { window: ScaledSize; screen: ScaledSize }) => void>()

export const Dimensions = {
  /**
   * "window": the app's window (the whole screen in normal use, smaller in split screen); "screen": the whole display.
   * Both include the status and navigation bars: zero-native draws behind them (use insets() to keep clear of them).
   */
  get(dim: "window" | "screen"): ScaledSize {
    const facts = current()
    return { ...(dim === "screen" ? facts.screen : facts.window) }
  },

  /**
   * Calls [handler] when a size changes. Returns `{ remove }`, as in React Native. Called while a screen is being
   * built, it stops by itself when the screen closes.
   */
  addEventListener(type: "change", handler: (sizes: { window: ScaledSize; screen: ScaledSize }) => void): { remove(): void } {
    if (type !== "change") throw new TypeError(`Dimensions.addEventListener: unknown event "${type}"`)
    listeners.add(handler)
    const remove = () => void listeners.delete(handler)
    if (getOwner()) onCleanup(remove)
    return { remove }
  },
}

/**
 * The window's size. A screen body runs once, so read it inside JSX or an `effect` to follow changes (not into a
 * variable at the top of the body).
 */
export function useWindowDimensions(): ScaledSize {
  return Dimensions.get("window")
}

export const PixelRatio = {
  /** Pixels per dp (2.75 on many phones). */
  get(): number {
    return current().window.scale
  },

  /** The user's font size setting: 1 is normal, 1.3 is large. */
  getFontScale(): number {
    return current().window.fontScale
  },

  /** dp → whole pixels. */
  getPixelSizeForLayoutSize(layoutSize: number): number {
    return Math.round(layoutSize * PixelRatio.get())
  },

  /** dp rounded to a whole pixel, still in dp. */
  roundToNearestPixel(layoutSize: number): number {
    const ratio = PixelRatio.get()
    return Math.round(layoutSize * ratio) / ratio
  },
}

/** App-level event WINDOW. Called by installRuntime. */
export function installDimensions(): void {
  onEvent(APP, AppEvent.Window, (payload: NativeValue) => {
    const v = JSON.parse(String(payload)) as Record<string, number>
    const scale = v.scale || 1
    const fontScale = v.fontScale || 1
    const next: WindowFacts = {
      window: { width: v.width ?? 0, height: v.height ?? 0, scale, fontScale },
      screen: { width: v.screenWidth ?? 0, height: v.screenHeight ?? 0, scale, fontScale },
    }
    if (same(current.peek(), next)) return
    current.set(next)
    for (const listener of [...listeners]) {
      try {
        listener({ window: { ...next.window }, screen: { ...next.screen } })
      } catch (err) {
        reportError("Dimensions change handler", err)
      }
    }
  })
}

export function resetDimensionsForTests(): void {
  listeners.clear()
  current.set({ window: zero, screen: zero })
}
