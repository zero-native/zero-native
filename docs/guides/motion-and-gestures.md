# Motion & Gestures

`zero-native` separates animation into two clean layers — and **neither runs JavaScript per frame**:

1. **Declarative transitions (`animate`, `enter`, `exit`)** — works on **Android and iOS**. JS sends only the new target value; native animates smoothly with springs or tweens.
2. **UI-thread motion values, `derive()`, gestures & shared elements** — runs at 60/120 fps on the UI thread with zero recompositions. *(Available on Android today; iOS port in progress.)*

---

## 1. State-Driven Animation (`animate`)

Animate changes to `opacity`, `backgroundColor`, and `transform` (`scale`, `scaleX`, `scaleY`, `translateX`, `translateY`, `rotate`) with a single prop:

```tsx
<Box
  style={{
    opacity: visible() ? 1 : 0,
    transform: [{ translateY: visible() ? 0 : 12 }],
    backgroundColor: active() ? "#2563EB" : "#E5E7EB",
  }}
  animate={{ opacity: 200, translateY: "spring", backgroundColor: 250 }}
/>
```

### Timing options
- `250` — 250 ms tween
- `"spring"` / `"bouncy"` — preset physics springs
- `{ duration: 300, easing: "ease-out" }` — named easing (`"standard"`, `"ease-out"`, `"ease-in"`, `"linear"`) or cubic-bezier `[x1, y1, x2, y2]`
- `{ spring: { damping: 0.7, stiffness: 300 } }` — custom spring
- **Autonomous loops & keyframes:** Pass `from`, `keyframes`, `times`, `repeat` (`number | "forever"`), `reverse`, `delay`, `repeatDelay`, plus `paused={bool}` and `replay={counter}` (e.g., increment `replay` to shake an input on a wrong PIN).

---

## 2. Enter & Exit Transitions (`enter` / `exit`)

Put `enter` and `exit` on the root of any conditional branch (`&&`, `? :`) or `.map` row. When an element leaves, native keeps it on screen until its exit animation completes:

```tsx
{showBanner() && (
  <Row style={s.banner} enter="fade-up" exit="fade">
    <Text>Payment confirmed!</Text>
  </Row>
)}
```

- **Presets:** `"fade"`, `"fade-up"`, `"fade-down"`, `"scale"`, `"pop"`, `"slide-left"`, `"slide-right"`, `"slide-up"`, `"slide-down"`, `"zoom"`, `"bounce"`, `"flip-x"`, `"flip-y"`, `"stretch-x"`, `"stretch-y"`.
- **Custom object:** `{ opacity: 0, translateY: 16, scale: 0.95, duration: 220, delay: 40 }` (great for staggered list entrances).

---

## 3. UI-Thread Motion Values & Gestures

> **Platform note:** UI-thread motion values (`useMotion`), `derive()`, gestures (`usePan`, `usePinch`, etc.), `animateLayout`, and `sharedTag` are implemented on **Android** today. On iOS the `Motion` module is currently a stub — do not ship a bundle that uses UI-thread motion to iOS yet.

Motion values live natively on the UI thread and are read in the draw phase (`graphicsLayer`), so dragging or scrubbing recomposes **nothing**. `usePan` creates its own `pan.x` and `pan.y` motion values:

```tsx
import { usePan, derive, clamp } from "@zeronative/core"
import { Box } from "@zeronative/ui"

export function DraggableCard() {
  const pan = usePan({
    axis: "x",
    bounds: { x: [-120, 120] },
    onEnd: () => pan.x.to(0, "spring"),
  })

  // Compiled at build time into a tiny native postfix formula — zero JS per frame!
  // Inside derive(), read motion values as functions: pan.x()
  const opacity = derive(() => clamp(1 - Math.abs(pan.x()) / 160, 0.3, 1))
  const rotate = derive(() => pan.x() * 0.08)

  return (
    <Box
      gesture={pan}
      style={{
        opacity,
        transform: [{ translateX: pan.x }, { rotate }],
      }}
    />
  )
}
```

### What `useMotion` & gestures support
- **Standalone motion values:** `const v = useMotion(0)`
- **Imperative native animations:** `v.set(n)`, `v.to(value, timing?)` (spring or tween), `v.decay(opts?)`, `v.sequence(steps, opts?)`, `v.stop()`, `pan.snapTo(anchorId, timing?)`.
- **Chaining & timelines:** `follow(source, timing?)`, `useTimeline(...)`, and window/environment sources via `env.*`.
- **Interpolation helpers:** `v.map(inRange, outRange)`, `v.mapColor(inRange, colors)`, `interpolate(...)`, `interpolateColor(...)` (must be the entire `derive` formula), `clamp(...)`.
- **`derive(() => ...)`:** Write ordinary math reading motion values as functions (`x()`). The compiler turns it into a bounded postfix formula (≤ 64 ops) evaluated natively every frame with zero allocations — no `'worklet'` directive, no second JS runtime, and no OTA code running on the UI thread.
- **Drivable properties:** `opacity`, `backgroundColor`, `transform` (`translateX/Y`, `scale/X/Y`, `rotate/X/Y`), `borderRadius` (and per-corner radii), `blurRadius`, `cameraDistance`, `width`, `height`, SVG part motion/trims, Canvas commands, and Lottie progress.

---

## 4. Gestures & Element Sources

Create native gesture recognizers from `@zeronative/core` and attach them with `gesture={...}`:

- `usePan(options)` — `axis`, `bounds: { x?: [min, max], y?: [min, max] }`, `anchors` (include `a11yLabel` on anchors for TalkBack accessibility), `magnets`, `release`, `dropZones`, `onBegin` / `onEnd` / `onSettle`.
- `usePinch(options)`, `useRotate(options)`, `useZoom(options)` (photo pinch-to-zoom + pan).
- `useTap(options)`, `useLongPress(options)`, `useFling(options)`.
- **Composition:** `Gesture.simultaneous(a, b)`, `Gesture.exclusive(a, b)`, `Gesture.race(a, b)`.
- **Element & sensor sources:**
  - `useElementMotion()` (`motion={m}`) — read scroll offset (`scrollY`/`scrollX`), `Carousel` page, `Pressable` press progress, or element bounds natively to build collapsing headers and parallax effects with zero JS.
  - `useTilt()` — device gyroscope/tilt values.

---

## 5. Layout Animation & Shared Elements

- **Layout transitions (`animateLayout`):** Add `animateLayout="spring"` or `animateLayout={250}` to smoothly animate size and position changes when siblings expand, collapse, or reorder.
- **List item animations & reorder:** `<List itemAnimation="fade" reorderable onReorder={(from, to) => ...} />`.
- **Shared elements (`sharedTag`):** Put the same unique `sharedTag={"store-" + id}` on an element on two screens. On push, it flies and scales seamlessly into place; on Back (including Android predictive back), it scrubs backwards with the user's finger.
