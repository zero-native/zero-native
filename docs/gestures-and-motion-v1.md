# Gestures and motion v1: plan (draft 2, 2026-11-08)

Replaces `docs/gestures-v1-plan.md` (agreed 2026-11-07), which covered drag, pinch and scroll only. Written by Opus
after Pavan's goal (2026-11-08):

> "nothing less than gesture-handler + reanimated + worklets (we'll build different way but functionalities they
> unlock on react native shouldn't be gone in our framework..)"

and his rule for this work: **build the foundations, not ready-made components** ("slide to confirm is
framework-ish.. nobody asked for.. we need to just build the foundations that allows these"). Every use case below is
proved by a **lab screen in the sample app**, built only from public foundations. Labs are examples, not framework API.

**Draft 2** folds in Gemini 4 Argon's review of draft 1
(`docs/cross-communication/2026-11-08-gemini-argon-reply-to-opus-and-ideas.md`): its D1–D10 verdicts, its Compose /
Android / iOS traps, and its "five pillars" (environment and size values, 2D anchors with magnets, `follow` springs,
the full draw-phase target set, gesture-scrubbed morphs). Draft 1 is in git history (3224b2f).

Status: **built on Android (2026-11-09), phases 1–3.** What changed from this plan is in §5 "As built" and in
`docs/motion.md` (the reference). Registry 24 and the `Motion` module 1; host API stays 9. iOS: `docs/motion.md` §14.

---

## 0. The goal, the one idea, and the rules that don't change

**Goal:** anything an RN app can build with `react-native-gesture-handler` (RNGH), `react-native-reanimated`
(Reanimated, including worklets) and the libraries built on them (bottom sheets, carousels, tab views, swipeable rows,
zoom views, draggable lists, shared transitions, floating players), a zero-native app can build too. Same result for
the user; a different shape in code.

**The one idea (Argon's invariant, adopted):**
1. **Every spatial input is a native motion value:** a drag, a pinch, a scroll offset, a sheet's position, a
   carousel's page, the keyboard's height, the window size and insets, an element's measured size, a sensor, a
   plugin's source, a timeline.
2. **Every motion value can be combined** with pure maths (`derive`, compiled to a small formula) **or chained** with
   physics (`follow`, a spring that chases another value), on the UI thread.
3. **Every visual property** (translate, scale, 3D rotate, corner radius, colour, blur, opacity, ...) **and every snap
   point** can bind to any motion value or formula, with 0 frames of lag.
4. **JS reads any of them** as a signal, at most once per frame, only when it reads them: for logic and text.

Why this works without worklets: RN's native UI layer had no reactive values, frame clock or physics on the UI
thread, so Software Mansion had to put a second JS engine there. Compose and SwiftUI already have a frame clock,
velocity tracking, spring and decay solvers, draw-phase layers and layout tracking. We describe *what* follows *what*
at build time; native runs it.

**Rules kept from the 2026-11-07 plan and zero-native's core:**
1. **The finger never waits for JS.** The view under the finger, the spring or fling after release, and every visual
   that follows a gesture run on the UI thread with 0 hops to JS.
2. **No JS per frame unless the app reads the value.** If JS never reads a gesture's value, native sends nothing
   during the gesture (v0's "0 bridge events during a drag").
3. **No second JS engine, no JS on the UI thread.** We give worklet power as **data**: values, gestures, animations,
   formulas and bindings written into the template at build time, run by native code.
4. **Everything is known at build time and is OTA-safe.** A bundle carries data, never code for the UI thread. Native
   checks the data when it loads the bundle (sizes, limits, no loops, no cycles).
5. **No NaN or Infinity ever reaches a layer.** Formulas define `x / 0 = 0`; any non-finite result is dropped before
   it reaches `graphicsLayer` / `offset` (sizes are 0 before the first layout). (Argon: a phase-1 blocker.)
6. **Accessibility is not optional.** Every gesture that does something has a non-gesture way for TalkBack /
   VoiceOver. Reduced motion is respected.

---

## 1. What RN has (the inventory we must cover)

### 1.1 react-native-gesture-handler (v2, `Gesture` API)
| Area | What it gives |
|---|---|
| Gestures | `Tap` (taps count, max duration / delay / distance), `LongPress` (min duration, max distance), `Pan` (min distance, `activeOffsetX/Y`, `failOffsetX/Y`, min / max pointers, `activateAfterLongPress`), `Pinch` (scale, focal point, velocity), `Rotation` (angle, anchor), `Fling` (direction, pointers), `Native` (wrap a native scroll or button), `Manual` (your own state machine), `Hover`, `ForceTouch` (iOS) |
| Composition | `Gesture.Race` (first to start wins), `Gesture.Simultaneous` (pinch + rotate + pan together), `Gesture.Exclusive` (double tap before single tap), `simultaneousWithExternalGesture`, `requireExternalGestureToFail`, `blocksExternalGesture` |
| Events | `onBegin`, `onStart`, `onUpdate`, `onChange` (deltas), `onEnd` (success flag), `onFinalize`, raw touches (`onTouchesDown/Move/Up/Cancelled`); states UNDETERMINED → BEGAN → ACTIVE → END / FAILED / CANCELLED |
| Event data | translation, absolute and local position, velocity, pointer count, scale, focal point, rotation, anchor |
| Options | `enabled`, `hitSlop`, `shouldCancelWhenOutside`, `manualActivation` + state manager, `runOnJS` |
| Components | `Swipeable` / `ReanimatedSwipeable`, `DrawerLayout`, `RectButton` / `BorderlessButton`, gesture-aware `ScrollView` / `FlatList` |

### 1.2 Reanimated (v3 / v4) and worklets
| Area | What it gives |
|---|---|
| Values | `useSharedValue` (read / write from both threads), `useDerivedValue` (incl. `withSpring(leader.value)` to chase a value), `useAnimatedReaction`, `cancelAnimation` |
| Styles and props | `useAnimatedStyle` (any style key, per frame), `useAnimatedProps` (any native prop: SVG path `d`, a TextInput's text for counters) |
| Animations | `withTiming`, `withSpring` (damping, stiffness, mass, velocity, overshoot clamp; or duration + damping ratio), `withDecay` (velocity, deceleration, clamp, rubber band), `withDelay`, `withSequence`, `withRepeat` (reverse), `withClamp`; finish callbacks; a new animation starts from the current value and speed |
| Maths | `interpolate` (many points, clamp / extend / identity), `interpolateColor` (RGB, HSV, LAB), `Easing` (bezier, elastic, bounce, back, ...), `clamp` |
| Scroll | `useAnimatedScrollHandler` (scroll, begin / end drag, momentum), `useScrollViewOffset`, `scrollTo(ref, x, y)` from the UI thread |
| Layout | `useAnimatedRef` + `measure()` on the UI thread |
| Other sources | `useAnimatedKeyboard`, `useAnimatedSensor` (accelerometer, gyroscope, gravity, rotation), `useFrameCallback`, `useReducedMotion` |
| Layout animations | `entering` / `exiting` presets (fade, slide, zoom, bounce, flip, stretch, roll, ...) with modifiers; `Keyframe`; layout transitions (`LinearTransition`, `SequencedTransition`, `FadingTransition`, `JumpingTransition`, `CurvedTransition`); `itemLayoutAnimation` on `FlatList` |
| Shared transitions | `sharedTransitionTag` (a view moves and resizes into the next screen) |
| Reanimated 4 | CSS-style `transition` and `animation` keyframes on styles |
| Worklets | any JS function marked `'worklet'` runs on the UI thread; `runOnUI`, `runOnJS`; worklet runtimes on other threads (VisionCamera frame processors) |

### 1.3 What apps build on top (the real reason teams use them)
`@gorhom/bottom-sheet`, carousels with parallax / scale / stack effects, `react-native-tab-view`, swipeable rows,
drawers, `react-native-draggable-flatlist`, zoomable images, image viewers, story viewers, swipe cards, sliders,
slide-to-confirm, **floating draggable video nudges and mini players** (drag in 2D, pinch to resize, a magnetic
"dismiss" target, fling to a corner, move away from the keyboard, drag the full player down into the mini player),
chat heads that trail each other, collapsing headers with sticky tabs, parallax headers, 3D card stacks, chart
scrubbing, animated counters, custom pull-to-refresh, keyboard-synced input bars, tilt cards, shared element
transitions, confetti and success moments (often Lottie).

---

## 2. The building blocks

```tsx
// A floating video nudge (lab 1): 2D drag, corners from live geometry, a magnetic dismiss zone, keyboard-aware.
const pip = usePan({
  axis: "xy",
  anchors: [
    { id: "tl", x: 16, y: env.insets.top + 16 },
    { id: "br", x: derive(() => env.width() - self.width - 16), y: derive(() => env.height() - env.keyboardHeight() - self.height - 16) },
    // ... the other two corners
  ],
  magnets: [{ id: "dismiss", x: derive(() => env.width() / 2), y: derive(() => env.height() - 80), radius: 96, pull: 0.6 }],
  release: { project: true, spring: "default" },
  haptic: { magnet: "light", snap: "selection" },
  a11yLabel: "Video",
  onEnd: (e) => e.anchor === "dismiss" && closeVideo(),
})
const near = pip.magnet("dismiss")                       // 0 → 1 as it nears the zone
<Box gesture={pip} style={{ transform: [{ translateX: pip.x }, { translateY: pip.y }, { scale: near.map([0, 1], [1, 0.6]) }] }} />
```

### 2.1 Motion values (Reanimated's shared values)
- `useMotion(initial)` makes a **native-owned number**. Native holds the truth; JS sends **commands**:
  - `v.set(x)` jumps; `v.to(x, timing)` animates with the same timing forms as `animate` today (ms, `"spring"`,
    `"bouncy"`, `{ duration, easing }`, `{ spring: { damping, stiffness, mass } }`, `{ spring: { duration, dampingRatio } }`,
    `overshootClamp`);
  - `v.decay({ velocity, deceleration, clamp, rubber })`;
  - `v.sequence([...])`, `v.repeat(anim, { times, reverse })`, `{ delay }` on any step;
  - `v.stop()`. Every command returns a promise `{ finished: boolean }`.
- **Velocity hand-off:** a new command, or a finger that grabs and lets go, always starts from the current value
  **and** its current speed, never from speed 0.
- **Ordering (Argon):** each command gets a rising sequence number; when a command or a finger interrupts one in flight,
  the old promise resolves `{ finished: false }` at once, before the new one starts, so chained `.then()` never runs
  out of order.
- **Who wins (D2, Argon's verdict):** while a finger holds a gesture, the gesture owns its values. A JS command to them
  issued mid-gesture is **dropped** (resolves `{ finished: false }`), not queued: a queued command would hijack the
  user's release fling seconds later. `{ interruptGesture: true }` on a command cancels the touch at once (a payment
  session that expires mid-drag).
- **Gestures make motion values:** `pan.x`, `pan.y`, `pan.progress`, `pinch.scale`, `rotate.angle`; JS can command
  them too (`pan.snapTo("tl")`, `pan.x.to(0)` springs a failed slide back).
- **`follow(source, spring)` (Argon's pillar 3):** a value that chases another with spring physics on every frame
  (Reanimated's `useDerivedValue(() => withSpring(leader.value))`). Chains: `c = follow(b)`, `b = follow(a)`: chat heads
  trailing the dragged one, elastic parallax layers, stretchy headers, waveform bars.
- **Timeline:** `useTimeline({ duration, repeat, reverse })` is a value 0 → 1 over time with `play`, `pause`,
  `seek(p)`, `reverse()`. **One timeline drives many elements** through `map` / `derive` (D6): it can be driven by
  time, a spring, a scroll or a finger, and reversed mid-way without children getting out of step. Per-element
  `delay` stays as a helper for one-off entrances.

### 2.2 Environment and size values (Argon's pillar 1)
Read-only native motion values, usable in formulas, bindings and snap points:
- `env.width`, `env.height` (the window), `env.insets.top / bottom / start / end` (status and navigation bars),
  `env.keyboardHeight` (per frame while the keyboard slides), `env.keyboardProgress`;
- `self.width`, `self.height` (the element's laid-out size, from `onSizeChanged`), `parent.width`, `parent.height`.
This replaces Reanimated's `measure()` inside worklets and `useAnimatedKeyboard`: "the bottom-right corner, above the
keyboard" is a formula, and when the keyboard opens the floating video glides up with no JS.

### 2.3 Gestures (RNGH's recognizers)
| zero-native | RNGH | Values it makes | Notes |
|---|---|---|---|
| `usePan({ axis: "x" \| "y" \| "xy" })` | `Pan` | `x`, `y`, `progress`, velocity in `onEnd` | `minDistance`, `activeOffsetX/Y`, `failOffsetX/Y`, `pointers`, **`activateAfterLongPress(ms)`** (Argon: the #1 reason for two gestures on one element: long press then drag, for reorder and floating buttons inside a scroll), `bounds` (dp, `"100%"` travel units), `rubber` at the edges |
| `usePinch()` | `Pinch` | `scale`, `focalX`, `focalY` | `min` / `max`, springs back past the limits |
| `useRotate()` | `Rotation` | `angle` (degrees) | |
| `useFling({ direction })` | `Fling` | events only | |
| `useTap({ taps, maxDelay, maxDistance })` | `Tap` | `pressed` (0 → 1) | for composition (story tap zones); plain taps stay `Pressable` |
| `useLongPress({ minDuration, maxDistance })` | `LongPress` | `pressed`, `held` progress | hold to pause, hold to preview |
- **Release and snapping (Argon's pillar 2), as data:**
  - `anchors`: 1D points, or **2D points `{ id, x, y }`**; any coordinate can be a motion value or formula
    (`env`, `self`, `derive`).
  - `release: { project: true }`: native projects the resting point from the release velocity with the platform's
    decay curve, picks the nearest anchor, and springs there **keeping the velocity** (a flick to a corner).
  - `threshold: { distance, velocity }`, `decay: true` (no snap, slow down), `spring`.
  - **Magnets:** `magnets: [{ id, x, y, radius, pull }]`. Inside `radius` (by `hypot`), the dragged item is pulled
    toward the centre by `pull`, a haptic ticks on entry, and `pan.magnet(id)` gives a 0 → 1 value. Releasing inside a
    magnet snaps to it (a "dismiss" zone).
  - JS `onEnd` can still decide: `snapTo(id)` with velocity hand-off.
- **Composition (D3, Argon agrees):** `Gesture.simultaneous(pinch, rotate, pan)`, `Gesture.exclusive(doubleTap, tap)`
  (the single tap waits for the double-tap timeout, ~250 ms, before it fires), `Gesture.race(a, b)` (default). Inside
  one element in phase 1; cross-element refs and manual activation in phase 3.
- **With the scrolling things around it** (the hard part): `withParent: "after-edge"` (a sheet or header drag starts
  when the inner list is at its top: nested scroll), `"simultaneous"`, `"block"`; `axis` uses the platform's direction
  check, so a sideways drag in a vertical `List` starts only after the finger moves sideways more than down.
  - **Compose pointer passes (Argon, phase-1 blocker):** a child gesture inside a scrollable parent consumes on the
    `Main` pass after touch slop; a parent gesture that must take over from a scrolling child (`withParent`) reads on
    the `Initial` pass. The arbiter is designed around this, with tests for each case.
- **Android Back edge (Argon, phase-1 blocker):** Android 10+ honours `systemGestureExclusion` for at most **200 dp of
  height per edge**. So exclusion is set only for a band around the touch-down point (or for drag areas ≤ 96 dp tall:
  sliders, slide tracks, list rows), never for a whole tall card.
- **Events to JS** (each once, in order): `onBegin`, `onStart`, `onEnd({ x, y, vx, vy, anchor, cancelled })`,
  `onFinalize`, `onCross(threshold, direction)`, `onMagnet(id, entered)`. `onUpdate` exists but is coalesced
  (≤ 1 per frame) and only if written. Final values are written into the JS signals **before** `onEnd` (guard 2).
- **Manual activation** (RNGH `manualActivation`): `gesture.activate()` / `fail()` from JS. Phase 3.

### 2.4 Bindings and formulas (`useAnimatedStyle`, `interpolate`, worklets for visuals)
- `v.map([in...], [out...], { extrapolate: "clamp" | "extend" | "identity" | "rubber" })`: many points.
- `v.mapColor([in...], [colours...])`: RGBA lerp (HSV later if asked).
- **`derive(() => expr)` (D1, approved by Argon):** a pure maths expression in plain TS, compiled ahead of time into a
  flat postfix (RPN) op list:
  - numbers, motion values (incl. `env` / `self`), `+ - * / %`, comparisons, `&& || !`, `? :`;
  - `Math.min / max / abs / floor / round / sign / sqrt / pow / sin / cos / atan2 / PI`, **`hypot`**, `clamp`,
    `interpolate`, **`interpolateColor`** (as a final op, so colour formulas stay native);
  - no loops, no calls to your functions, no objects, no strings. Anything else is a build error that says "compute it
    in JS (one frame late) or use a native plugin source".
  - **Limits, checked at build and again at bundle load:** ≤ 64 ops, a stack of at most 16 numbers that never
    underflows, known value ids only, no cycles between derived values. `x / 0 = 0`; a non-finite result is dropped.
  - Cost: a fixed stack array, no allocation, ~100 ns per formula per frame (Argon's estimate; we measure it).
- **Targets**, by the phase they cost (lint says which):
  | Phase | Props | Cost |
  |---|---|---|
  | draw | opacity, scale, scaleX / Y, rotate, **rotateX / rotateY, cameraDistance, transformOrigin (pivot)**, background / border / tint colour, **corner radius and clip** (morph a full-screen view into a rounded mini player), **shadow / elevation**, **blur** (Android 12+ `RenderEffect`; no blur below 12, said in the guide), Svg part props, Lottie `progress`, Canvas command values (phase 2) | almost free: no layout, no recomposition |
  | placement | translateX / Y, `zIndex` | cheap |
  | layout | width, height, padding, margin, gap, `flex` | a layout pass per frame, applied inside `Modifier.layout {}` so it never recomposes; build **warning** "prefer scale / translate"; allowed (D4: accordions, bars that push content) |
  | text | `text: v.format({ decimals: 0..2, grouping: "en-IN" \| "standard" \| "none", prefix, suffix })` | plain number-to-text in Kotlin / Swift, no locale objects per frame (D5); richer text goes through JS |
- **Haptics as data:** `haptic: { snap, cross, magnet, end }` on a gesture; `v.haptic(at, kind)` on a value crossing a
  point. Native plays it in the same frame.

### 2.5 The JS channel (values in JS, as signals)
- A motion value read in JS outside a binding (`pan.progress()` in a `<Text>`, a `computed`, an `effect`) is marked
  `syncToJs` by the compiler. Native sends at most one update per frame, newest only; if JS is busy, frames are
  dropped, nothing queues.
- Lint: a JS-computed value feeding a transform (`translateX: pan.x() * 2`) is a build warning: "use `.map()` or
  `derive()`; through JS it lags a frame".
- `useFrame((info) => ...)`: a JS callback once per frame **on the JS thread**, coalesced, for logic (a timer, a game
  score). Visuals belong in bindings.

### 2.6 Layout animations (`entering`, `exiting`, layout transitions)
- `enter` / `exit` exist (fade, fade-up, fade-down, scale, pop, own values, delay, keyframes). Add presets: `slide-left`,
  `slide-right`, `slide-up`, `slide-down`, `zoom`, `bounce`, `flip-x`, `flip-y`, `stretch`; `spring` on any preset.
- **`animateLayout`** (Reanimated's `LinearTransition` / `Layout.springify()`): when an element's size or place changes
  (a card expands, a row above it goes, chips reflow), it and its moved siblings animate instead of jumping. Compose
  `LookaheadScope` / `animateBounds`. `animateLayout` / `"spring"` / `{ duration }`.
- **List items:** `<List itemAnimation={{ add: "fade", remove: "fade", move: "spring" }}>` (Compose `animateItem`).
- Today an element that exits keeps its space until it is gone, then the space jumps closed; with `animateLayout` on
  the parent, it closes smoothly.

### 2.7 Morphs and shared elements (Argon's pillar 5)
- **Gesture-scrubbed morph inside a screen or overlay (phase 2):** `morph({ from: boxA, to: boxB, progress })`: an
  element's bounds and corner radius go from one measured box to another as `progress` (a drag, a spring) goes 0 → 1.
  Drag the full player down: it shrinks into the corner mini player; release halfway and it springs to whichever end
  the flick says. Built from `self` / `env` values, `derive` and the draw targets.
- **Shared element transitions across screens (phase 3, D7):** `<Image sharedTag={"store-" + id} />` on both screens;
  push moves and grows it into place; Back and predictive back **scrub** the same transition with the finger. Compose
  `SharedTransitionLayout` with Navigation 3's seekable transitions. Must work with native pops
  (`ZnNav.navDisplayBack`, second-opinions 184).

### 2.8 Values from what is already native (sources without new gestures)
| Source | Gives | Use |
|---|---|---|
| `Scroll`, `List` | `scroll.y` / `x`, velocity, dragging, content size; on `List` also first visible index and offset | collapsing header, sticky tabs, header fade, parallax, scroll progress |
| `Carousel`, paged horizontal `List` | page progress and each item's offset | parallax / scale / 3D stack carousels, stretching dots |
| `Tabs` | tab progress while switching | an indicator that follows the finger |
| `Sheet` | position and progress between detents | backdrop, map or header fading as the sheet rises |
| Pull to refresh | pull distance | a custom indicator (a Lottie scrubbed by the pull) |
| `pressed` of a `Pressable` | 0 → 1 | custom press effects beyond `pressScale` |
| Sensors (phase 3) | tilt x / y | tilt cards, gyro parallax |
- **`Sheet` and predictive back (Argon):** the sheet is its own window with its own back dispatcher. Phase 2 wires
  Android 13+ predictive back inside it, so the back gesture scrubs the sheet down as it does for screens.
- **Driving scroll from a value** (Reanimated `scrollTo` on the UI thread): `scrollTo` exists from JS (registry 23).
  Phase 2: `scroll.follow(motion)` for an alphabet side bar, a tab bar synced to a vertical list, auto-scroll while
  dragging to reorder.

### 2.9 Measuring, drag and drop, reorder
- `measureInWindow()` from JS (async): an element's box on screen in dp, for coach marks, tooltips, popovers. (For
  motion, `self.*` and `env.*` are the per-frame way.)
- Drop zones: `useDropZone({ onEnter, onLeave, onDrop })`; native compares boxes each frame; JS hears enter / leave /
  drop only.
- **Drag to reorder** is a `List` feature (`reorderable`, `onReorder(from, to)`), from `activateAfterLongPress`, drop
  zones and scroll following. Phase 3.

### 2.10 The native extension point ("native worklets", D8, Argon agrees)
For what a formula can't express (custom physics, a game loop, audio levels, finger drawing, a video's position): a
Kotlin / Swift plugin registers
- a **source** (`ZnMotion.source("physics.orbit") { frame -> ... }`),
- a **driver** (a custom curve for `v.to(x, { driver: "physics.orbit" })`),
- an **animatable prop** on its native view (`r.view("video.player", animatable = listOf("position"))`).
Guardrails: frame callbacks must not allocate; every source / driver / prop has an id that a bundle lists in its
`requires`, so an APK without the plugin refuses the bundle before it runs (as native modules are today). APK only,
never OTA.

### 2.11 Accessibility and reduced motion
- A gesture with `onEnd` + anchors must have `a11yLabel` (build error without it); it becomes a TalkBack / VoiceOver
  custom action per anchor ("Slide to pay ₹499" → double tap to pay; "Move video to top left").
- `reduceMotion: "system" | "always" | "never"` per value and animation; default `"system"`: with "Remove
  animations" on, values jump to their end and loops don't run (as `animate` does today).

---

## 3. Capability map: every RN feature, its zero-native form, its phase
| RN | zero-native | Phase |
|---|---|---|
| `Gesture.Pan` (+ offsets, pointers, `activateAfterLongPress`) | `usePan` | 1 |
| `Gesture.Pinch`, `Gesture.Rotation` | `usePinch`, `useRotate` | 1 |
| `Gesture.Tap` (multi-tap), `Gesture.LongPress` | `useTap`, `useLongPress` (plain taps: `Pressable`) | 1 |
| `Gesture.Fling` | `useFling` | 1 |
| `Gesture.Simultaneous / Exclusive / Race` | `Gesture.simultaneous / exclusive / race` | 1 |
| `simultaneousWithExternalGesture` with a scroll | `withParent` | 1 |
| `requireExternalGestureToFail` across elements, `manualActivation` | gesture refs, `activate()` / `fail()` | 3 |
| `Gesture.Native`, `Gesture.Manual`, `Hover`, `ForceTouch` | not needed (our native parts are native; hover / force touch aren't phone gestures) | — |
| `useSharedValue` | `useMotion` | 1 |
| `withTiming / withSpring / withDecay / withDelay / withSequence / withRepeat / withClamp` | `v.to / decay / sequence / repeat`, `delay`, `clamp` | 1 |
| finish callbacks, `cancelAnimation`, velocity hand-off | promise `{ finished }` (ordered), `v.stop()`, always on | 1 |
| `useDerivedValue(() => withSpring(x))` | `follow(x, spring)` | 1 |
| `useAnimatedStyle` (transforms, opacity, colours) | bindings (`.map`, `.mapColor`, `derive`) | 1 |
| 3D transforms, pivot, corner radius, shadow, blur in animated styles | draw targets | 2 |
| `useDerivedValue` (maths) | `derive` | 1 |
| `interpolate`, `Extrapolation`, `interpolateColor` | `.map`, `.mapColor`, `interpolateColor` in `derive` | 1 |
| `Easing.*` | `animate`'s easings + bezier; add `elastic`, `bounce`, `back` | 1 |
| `runOnJS` | gesture and value events, `syncToJs` signals | 1 |
| `useAnimatedReaction` | `v.haptic(at)`, `onCross`, `onMagnet`, an `effect` on the signal | 1 |
| haptics on thresholds | `haptic` as data, native | 1 |
| `measure()` in worklets, window size, insets | `self.*`, `parent.*`, `env.*` values | 1 |
| `useAnimatedKeyboard` | `env.keyboardHeight`, `env.keyboardProgress` | 1 |
| snap / decay logic in `onEnd` worklets | `anchors` (1D, 2D), `project`, `magnets`, `threshold` | 1 |
| `useAnimatedProps` on text (animated counters) | `text: v.format(...)` | 2 |
| `useAnimatedProps` on SVG (trims, colours) | Svg part props as targets; path morphing stays `.svg` SMIL | 2 |
| `useAnimatedProps` on any native prop | plugin-registered animatable props | 3 |
| `useAnimatedScrollHandler`, `useScrollViewOffset` | scroll sources | 2 |
| `scrollTo` on the UI thread | `scroll.follow(motion)` | 2 |
| `useAnimatedRef` + `measure` from JS | `measureInWindow()`; drop-zone hit testing | 2 / 3 |
| `useAnimatedSensor` | sensor source | 3 |
| `useFrameCallback` | `useFrame` (JS thread) + plugin sources (UI thread) | 2 / 3 |
| `useReducedMotion`, `ReduceMotion` | `reduceMotion`, the system setting by default | 1 |
| `entering` / `exiting` presets, modifiers, `Keyframe` | `enter` / `exit` (exist) + more presets, `spring` | 2 |
| layout transitions, `Layout.springify()` | `animateLayout` | 2 |
| `itemLayoutAnimation` on `FlatList` | `List itemAnimation` | 2 |
| interactive mini-player morph (custom worklets today) | `morph` | 2 |
| `sharedTransitionTag` | `sharedTag`, scrubbed by predictive back | 3 |
| Reanimated 4 CSS transitions / animations | `animate` (exists) | done |
| worklets for visual maths | `derive` | 1 |
| worklets for custom per-frame logic | native plugin sources / drivers | 3 |
| worklet runtimes on other threads (camera frame processors) | native plugins (the scanner does QR natively) | non-goal |
| `Swipeable`, `DrawerLayout`, bottom-sheet, carousel, tab-view, draggable-flatlist, zoom views | **labs** from the pieces above; reorder is a `List` feature | labs; reorder 3 |

---

## 4. Labs (sample app): composite screens, where gestures meet
Argon's point, adopted: gesture bugs happen when two gestures meet on one screen. So instead of 22 one-feature labs,
**9 composite labs**, each mixing primitives on purpose. Each has a "keep JS busy for 200 ms" button. Labs are
examples, not framework API.
| # | Lab | What it mixes | Phase |
|---|---|---|---|
| 1 | **Floating video nudge** | 2D pan with corner anchors from `env` / `self`, `project`, a magnetic dismiss zone with haptic, pinch to resize (simultaneous), keyboard avoidance (`env.keyboardHeight`), the `overlay` layer over screen changes, chat-head trail (`follow`); phase 2 adds drag-down morph from full player to mini player (`morph`, corner radius) | 1 / 2 |
| 2 | **Payments controls** | slide to pay (bounds `"100%"`, threshold, track colour, label fade, `a11yLabel`, `snapTo` back on failure), a loan slider with live ₹ text (`syncToJs`, then `format`), a range slider, a circular dial (`atan2` in `derive`, step haptics) | 1 |
| 3 | **Feed screen** | swipe actions on List rows (`activeOffsetX`, rubber, reveal, swipe to delete with `itemAnimation`) + collapsing header with sticky tabs (scroll source) + pull to refresh + a `Sheet` with a list inside (`after-edge`) | 1 / 2 |
| 4 | **Cards and stories** | swipe cards (xy, rotate from `x`, fling out, next card scales up with `follow`), a story viewer (tap zones `exclusive` with long press to pause a timeline, progress bars, swipe down to close) | 1 |
| 5 | **Media** | inline zoom image (pinch + pan + double tap), a chart with scrubbing (crosshair by `derive`, value by `format`), a parallax / 3D carousel (item offsets, `rotateY`, `cameraDistance`) | 1 / 2 |
| 6 | **Layout motion** | expanding card and sibling reflow (`animateLayout`), list removal, new `enter` / `exit` presets, an animated counter (timeline + `format`), a coach mark (`measureInWindow`) with a pulse nudge | 2 |
| 7 | **Sheets and tabs** | tab indicator following the finger (`Tabs` progress), sheet progress driving a backdrop and a header, predictive back on the sheet, an input bar riding the keyboard, an alphabet side bar driving a list (`scroll.follow`) | 2 |
| 8 | **Screens** | shared store image between two screens, scrubbed by predictive back; drag to reorder (`List reorderable`, long press then drag, auto-scroll) and drop zones | 3 |
| 9 | **Extension** | a test plugin's source and animatable prop, a tilt card (sensor source), `useFrame` | 3 |

---

## 5. Template format, versions and OTA safety
**As built (2026-11-09; second-opinions 186):** no `motion` section. Values, formulas, gestures and element motions
are runtime objects of the `Motion` module, made by module calls that native runs before the batch that binds them.
Templates only gain slots (registry 24 props) that hold a reference. Versions: registry 24 for the props, and the
`Motion` module (version 1) in a bundle's `requires` whenever an app file imports a motion API, so an older APK refuses
the bundle; host API stays 9. The verifier runs when each object is made: formula limits (≤ 64 ops, stack ≤ 16),
known ids only, numbers checked; a source can only name sources that already exist, so cycles can't be made. A bad
call fails that call (a JS error at the line that made it), never a frame. Plugin sources and drivers are gated by
their plugin module's version. The text below is the first plan, kept for the record.

- One new **`motion` section** in `.zn.ui`: motion values (id, initial), environment / size values used, gestures
  (kind, options, node), anchors and magnets, release rules, bindings (`source → node.prop`, kind, points), formulas
  (flat RPN op lists), `follow` links, haptics, sources of existing components. Nodes stay as they are.
- **Registry 24, host API 10** (today 23 / 9). Any use of the section raises the bundle's needs: an older APK refuses
  such a bundle and keeps its own. Bundles that don't use it are unchanged. Plugin sources / drivers / props add
  their ids to `requires`.
- **Load-time verifier (native):** stack depth and op count per formula, known ids only, no cycles between derived
  values and `follow` links, bounded counts per screen. A bad section fails the bundle at load, never mid-frame.
- iOS reads the same section; the iOS session ports each phase after Android lands it.

## 6. Performance rules and budgets (checked on the Lava, Android 14, 60 Hz)
- Frame time during a drag with JS kept busy 200 ms: no dropped frames from us (target < 8 ms of our work per frame).
- 0 bridge messages during a gesture whose values JS doesn't read; ≤ 1 per frame when it does.
- Draw and placement targets are read in `graphicsLayer {}` / `offset {}`; layout targets inside `Modifier.layout {}`:
  no recomposition during a gesture.
- Formulas allocate nothing per frame; measure the real cost per op. A screen with 200 bindings must hold the budget.
- Start time and APK size unchanged for apps that don't use motion; measure both with it.

## 7. Platform mapping
| Piece | Android (Compose) | iOS (iOS session) |
|---|---|---|
| Pan, fling, bounds | `pointerInput` + `VelocityTracker`, our arbiter on the right pointer pass | **UIKit** `UIPanGestureRecognizer` (or iOS 18 `UIGestureRecognizerRepresentable`) with a delegate: **not** pure SwiftUI `DragGesture` inside a `ScrollView` / `List` (Argon: arbitration bugs; an iOS-phase blocker) |
| Pinch, rotate | `transformable` / `detectTransformGestures` | `UIPinchGestureRecognizer`, `UIRotationGestureRecognizer` |
| Tap, long press | `detectTapGestures` | UIKit tap / long-press recognizers |
| Composition, scroll hand-off | `PointerEventPass.Initial` vs `Main`, nested scroll connection | delegate `shouldRecognizeSimultaneouslyWith`, `shouldRequireFailureOf`, `gestureRecognizerShouldBegin` (`abs(dy) > abs(dx)` fails a sideways pan) |
| Motion values, drivers, `follow` | spring and decay maths on the Compose frame clock | `CADisplayLink` |
| Bindings | `graphicsLayer {}`, `Modifier.offset {}`, `Modifier.layout {}`, `RenderEffect` blur (API 31+) | `CALayer` / `UIView` properties per frame (or values read in `.visualEffect`), never a SwiftUI `body` per frame |
| Environment values | `WindowInsets` (incl. IME per frame), window metrics | keyboard frame notifications + `UIScrollView` / window insets |
| Layout animations | `LookaheadScope`, `animateBounds`, `animateContentSize`, `animateItem` | SwiftUI transitions, `matchedGeometryEffect` |
| Shared elements | `SharedTransitionLayout` + Navigation 3 seekable transitions | zoom transitions / `matchedGeometryEffect` |
| Scroll sources | `ScrollState`, `LazyListState`, nested scroll | `onScrollGeometryChange` (iOS 18) or KVO on `UIScrollView` |
| Haptics | `HapticFeedback` / `Vibrator` | `UIImpactFeedbackGenerator`, `UISelectionFeedbackGenerator` |

## 8. Phases and steps
**Phase 1: the core (~2.5 weeks, Opus).**
1. Compiler: `useMotion`, `useTimeline`, `follow`, `env` / `self` / `parent` values, gestures (pan with
   `activateAfterLongPress`, pinch, rotate, tap, long press, fling), composition, `withParent`, anchors (1D, 2D),
   `project`, magnets, thresholds, `.map` / `.mapColor`, `derive` (RPN), haptics, `a11yLabel` check, `syncToJs`,
   lints, the `motion` section, registry 24 / host API 10. JS tests.
2. Runtime: values and drivers (timing, spring, decay, sequence, repeat, delay, velocity hand-off, ordered promises,
   D2), `follow`, environment and size values, gesture hosts and the arbiter (pointer passes, nested scroll), Back-edge
   exclusion by band, anchors / projection / magnets, the formula evaluator and the load-time verifier, NaN guard,
   draw / placement targets, haptics, TalkBack actions, reduced motion. Kotlin tests for the maths and the arbiter.
3. JS channel: coalesced signals, final values first, events once, commands and their promises.
4. Labs 1 (without morph), 2, 3 (without item animation and the sheet's back), 4, 5 (without 3D).
5. Phone checks (Lava): frame times with JS busy, 0 bridge messages, sideways drag in a vertical List, a drag at the
   left edge with gesture navigation, pinch + pan together, keyboard-aware anchors, TalkBack, reduced motion.

**Phase 2: more targets, sources and layout motion (~1.5 weeks).**
3D transforms, pivot, corner radius and clip, shadow, blur; layout targets with the lint; `format` text; Svg, Lottie
and Canvas targets; Scroll / List / Carousel / Tabs / Sheet / refresh / `pressed` sources; predictive back in `Sheet`;
`scroll.follow`; `enter` / `exit` presets; `animateLayout`; `List itemAnimation`; `morph`; `measureInWindow`;
`useFrame`. Labs 1 (full), 3 (full), 5 (full), 6, 7.

**Phase 3: the rest (~1.5 weeks).**
Shared element transitions scrubbed by predictive back; drop zones and `List reorderable`; gesture refs across
elements; manual activation; sensors; the native extension point. Labs 8, 9.

**Docs with each phase:** `docs/motion.md` (new: the model, every API, do / don't / why), guide-notes sections,
`rn-compatibility.md` rows (an RNGH / Reanimated → zero-native porting table, **no aliases**, D10), `components.md`,
ARCHITECTURE §10.3 rewritten, second-opinions entries for each decision, milestones.

**Total:** ~5.5 weeks for Android (a guess; composite labs save time, the five pillars add some), then iOS per
phase. Nothing here blocks ZeroBill's store releases.

## 9. Decisions (after Argon's review; Pavan to confirm)
| # | Decision | Status |
|---|---|---|
| D1 | Formula trees (`derive`), RPN, ≤ 64 ops, stack ≤ 16, `&& || !`, `hypot`, `interpolateColor`, `x / 0 = 0`, NaN guard | Argon: approve. Opus: agree |
| D2 | The finger wins; a JS command mid-gesture is dropped (`{ finished: false }`), `interruptGesture: true` to take over | Argon's verdict (draft 1 said "queue until release"). Opus: agree, Argon's is better |
| D3 | Composition inside one element + `withParent` in phase 1, plus `activateAfterLongPress`; cross-element in phase 3 | Argon: approve with the addition. Opus: agree |
| D4 | Layout targets allowed with a warning, inside `Modifier.layout {}` | agreed |
| D5 | A bounded native number formatter | agreed |
| D6 | One timeline / motion value drives many; `delay` is a helper | agreed |
| D7 | Shared elements in phase 3, scrubbed by predictive back | agreed |
| D8 | Native extension point, allocation-free, ids in `requires`, APK only | agreed |
| D9 | dp, dp/s, degrees, `"100%"` travel room, `"100%self"`, `"100%parent"`, plus `self` / `parent` values | agreed |
| D10 | Our own short names + a porting table; no RNGH / Reanimated aliases | Argon: no aliases. Opus: agree |

## 10. Not planned (and why)
- **JS on the UI thread / a second JS runtime:** more memory and start time, two kinds of JS for authors, and code on
  the UI thread from an OTA bundle. Covered by formulas, `follow` and native plugin sources.
- **Worklet runtimes on other threads** (camera frame processors): native plugins do this (the scanner).
- **Any style key from a binding:** only the targets in §2.4; others don't follow a motion value.
- **Hover, mouse buttons, trackpad, force touch:** not phone gestures. Revisit for tablets / Chromebooks.
- **Ready-made components** (slide to confirm, swipeable row, bottom-sheet clones): labs only (Pavan).
- **Honest limits:** finger drawing and signatures (a native view or a plugin source), video itself (a Media3 plugin,
  not part of this plan; the floating-video lab uses a box), the system's picture-in-picture mode (a separate native
  feature).

## 11. How we test
- JS tests (compiler: every API, every build error and lint, the RPN output; JS channel ordering); Kotlin tests (maths,
  springs and decay, projection and magnets, the arbiter, the verifier, NaN guard); the composite labs on the Lava
  with scripted gestures (`adb shell input motionevent` sequences run on the phone in one shell, as learned
  2026-11-08); frame-time checks with JS busy; TalkBack and reduced-motion passes.
- Measure APK and bundle size and start time, before and after.
