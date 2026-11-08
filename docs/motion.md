# Gestures and motion

zero-native's version of react-native-gesture-handler + Reanimated + worklets, built our own way. The plan and its
decisions are in `docs/gestures-and-motion-v1.md` (D1–D10). This file is the reference: the model, every API, and the
do / don't / why. Android is built (registry 24); iOS ports it next (see "iOS port" at the end).

Code: `packages/core/src/motion.ts` (JS), `compiler/src/motion.ts` (derive), `android/runtime/.../ZnMotion.kt`
(values, animations), `ZnFormula.kt` (derive), `ZnGesture.kt` (gestures), `ZnMotionUi.kt` (element values, corners,
layout motion), `ZnShared.kt` (shared elements), `ZnReorder.kt` (List reorder), `ZnMotionApi.kt` (plugins, tilt).

## 1. The model in one paragraph

A **motion value** lives in native code. JS makes it (`useMotion(0)`), gives it to elements (`style={{ opacity: v }}`),
and sends it commands (`v.to(1)`). Native moves it frame by frame on the UI thread and draws every element bound to it
in the same frame, **with no JS in the loop**. A finger moves values through **gestures** (`usePan`) that are options,
not callbacks. Maths between values is **`derive(() => ...)`**, compiled at build time into a small formula native runs
each frame. JS hears only what it asks for: events (`onEnd`), and the value itself if it reads it (`v()`). So a drag
stays smooth while JS is busy.

Why not JS on the UI thread (Reanimated worklets)? A second JS runtime costs memory and start time, gives authors two
kinds of JS, and puts code from an OTA bundle on the UI thread. Formulas, springs, gestures as data and native plugin
sources cover what visuals need (plan §10).

## 2. Motion values

```tsx
const x = useMotion(0)                       // owned by the component: gone when it unmounts
<Box style={{ transform: [{ translateX: x }], opacity: x.map([0, 200], [1, 0]) }} />
await x.to(200)                              // spring (default); resolves { finished: true | false }
x.to(0, { duration: 250, easing: "standard" })
x.to(1, "bouncy"); x.to(1, 300); x.to(1, { spring: { damping: 20, stiffness: 200 } })
x.set(5); x.stop(); x.decay({ velocity: 800, clamp: [0, 300] })
x.sequence([{ to: 1, timing: 200 }, { set: 0 }, { decay: { velocity: 300 } }], { repeat: "forever", reverse: true })
x()          // read in JS (a signal: native starts sending changes); x.peek() reads without subscribing
```

- **Timings:** a number (ms tween), `"spring"`, `"bouncy"`, `{ duration, easing }` (easing: `"standard"`, `"linear"`,
  `"ease-in"`, `"ease-out"`, `"back"`, or `[x1, y1, x2, y2]`), `{ spring: { damping, stiffness, mass } }` (Reanimated's
  numbers), `{ spring: { duration, dampingRatio } }`, `overshootClamp`, or a plugin's `{ driver }` (§10).
- **Velocity hand-off:** a new command starts from where the value is, with the speed it has. Always on.
- **Promises in order:** an interrupted command resolves `{ finished: false }` before the next one resolves.
- **The finger wins (D2):** a command to a value a finger holds is dropped (`{ finished: false }`), unless
  `{ interrupt: true }`, which cancels the touch.
- **`.map(inputs, outputs, extrapolate?)`** (Reanimated's interpolate; `"clamp"` default, `"extend"`, `"identity"`) and
  **`.mapColor(inputs, colours)`** make derived values; they are made once per arguments.
- **`useTimeline({ duration, easing?, repeat?, yoyo? })`:** a 0 → 1 value with `play()` (resumes after `pause()` with
  the time left), `pause()`, `restart()`, `reverse()`, `seek(p)`. One timeline drives many elements through `.map`.
- **`follow(source, timing)`:** a value that chases another with a spring (chat heads, an elastic parallax).
- **`v.format({ decimals: 0 | 1 | 2, grouping: "en-IN" | "standard" | "none", prefix, suffix })`:** the value as
  native text, as the whole content of a `<Text>`: `<Text>{amount.format({ prefix: "₹" })}</Text>`. Indian grouping
  (12,34,567) by default; halves round away from zero; the minus goes before the prefix.
- **Reduced motion:** with "Remove animations" on, commands jump to their end and loops don't run.

## 3. Window and size values

`env.width`, `env.height`, `env.insets.top / bottom / start / end`, `env.keyboardHeight` (follows the keyboard frame by
frame), `env.keyboardTarget` (where it is going). Read them as `env.width()` inside `derive`. Inside `derive`, `self.width` / `self.height` (the element
the formula is bound on) and `parent.width` / `parent.height`. A route with `keyboard: "none"` lets a screen move things
itself with `env.keyboardHeight`.

## 4. derive: maths each frame

```tsx
const tilt = derive(() => pan.x() / 18)
const fill = derive(() => clamp((pan.x() + 28) / parent.width, 0, 1))
const bg = derive(() => interpolateColor(progress(), [0, 1], ["#FFFFFF", "#5B5BD6"]))
```

- Read a motion value with `()` inside the arrow, as in JS. Allowed: numbers, motion values, `+ - * / %`, comparisons,
  `&& || !`, `? :`, `Math.min / max / abs / floor / ceil / round / sign / sqrt / pow / sin / cos / tan / atan2 /
  hypot / exp / log`, `Math.PI`, `clamp()`, `interpolate(x, [in], [out], extrapolate?)`, `interpolateColor()` (only as
  the whole formula), `self.*`, `parent.*`. Tables are literal numbers or top-level `const` numbers of the file.
- Any other name becomes an input fixed when the arrow is reached (a number) or a motion value. A signal or your own
  function is a build or run error with a hint: compute it in JS (one frame late) or make it a motion value.
- At most 64 steps and a stack of 16 (D1): split a long formula into two `derive`s. `x / 0 = 0`; NaN never reaches a
  view (the element keeps its last good value).
- **Why compiled:** the arrow never runs. The build turns it into postfix data native evaluates with no allocation.

## 5. What a motion value can drive

| Where | Keys |
|---|---|
| `style` | `opacity`, `backgroundColor` (a motion colour), `transform` (`translateX/Y`, `scale`, `scaleX/Y`, `rotate`, `rotateX`, `rotateY`), `cameraDistance`, `blurRadius` (Android 12+), border radii (corner morphs) |
| Svg parts | `fill`, `stroke` (motion colours), `opacity`, transforms, `trimStart / trimEnd / trimOffset` |
| `<Text>` | its content as `v.format(...)` |
| `<NativeView props>` | any prop a plugin reads with `scope.motion(name)` (§10) |
| Gestures | anchors, magnets and bounds as `Coord`s (a value, `"N%"`, `"N%self"`, `"N%parent"`, dp) |

Layout keys (`width`, `margin`...) don't follow a motion value: they would lay out again each frame. Animate a
transform, or use `animateLayout` (§7).

## 6. Gestures

```tsx
const pan = usePan({
  axis: "x",
  bounds: { x: [0, "100%"] },                     // "100%": the room to travel (parent minus own size)
  anchors: [{ id: "start", x: 0 }, { id: "paid", x: "100%" }],
  release: { threshold: { velocity: 400 } },      // or project: true (where a fling would stop), decay: true
  a11yLabel: "Slide to pay ₹499",                 // required with anchors (usePan throws): one TalkBack action each
  haptic: { snap: "success" },
  onEnd: (e) => e.anchor === "paid" && pay(),
})
<Box gesture={pan} style={{ transform: [{ translateX: pan.x }] }} />
```

- **Kinds:** `usePan` (x, y, progress, touchX, touchY, magnets), `usePinch` (scale, focalX, focalY, min / max),
  `useRotate` (angle), `useTap` (taps, maxDelay, maxDistance), `useLongPress` (pressed, held), `useFling` (directions).
- **Pan options:** `initial`, `bounds`, `rubber`, `anchors` (1D or 2D), `magnets` (`{ id, x, y, radius, pull }`, a pull
  toward a dismiss zone), `release`, `cross` + `onCross` (thresholds with haptics), `minDistance`,
  `activeOffsetX / Y`, `failOffsetX / Y`, `minPointers / maxPointers`, `activateAfterLongPress`, `dropZones`.
- **Events:** `onBegin`, `onStart`, `onUpdate` (coalesced; prefer bindings), `onEnd`, `onFinalize`, `onSettle`,
  `onMagnet`, `onCross`, `onZone`. `pan.snapTo(anchor)` springs it from JS (a failed payment springs the slider back).
- **One element, many gestures:** `Gesture.simultaneous(pinch, pan)`, `Gesture.exclusive(doubleTap, tap)` (in order),
  `Gesture.race(a, b)` (first wins). Groups nest.
- **With the scroll around it:** a one-axis pan leaves the other axis to the scroll. `withParent: "after-edge"` (an
  inner list scrolls first, then this moves: a sheet with a list), `"simultaneous"`, `"block"` (takes the touch even
  from a child).
- **Across elements (phase 3):** `requireToFail: [g]` (start only after g fails; fail if g starts),
  `simultaneousWith: [g]` (neither takes the touch from the other), `manualActivation: true` with
  `Gesture.activate(g)` / `Gesture.fail(g)` (one round trip to JS: use only when the rule can't be an option).
- **Drop zones:** `usePan({ dropZones: [m1, m2] })` with `useElementMotion()` objects bound on the targets; native
  compares the finger with their boxes, `onZone` hears enter / leave, `onEnd`'s `zone` says where it was dropped.
- **Edges:** a horizontal pan asks Android to keep the back gesture away from it (the whole element if ≤ 200 dp tall,
  else a 200 dp band, Android's limit).
- **At rest on an anchor,** the gesture follows the anchor if it moves (the keyboard opens), with no JS.

## 7. Layout motion

- **`animateLayout="spring"`** (or a timing): when the element's size or place changes, it animates there (a card
  that expands, siblings that reflow). Reanimated's layout transitions.
- **`<List itemAnimation="fade" | "move">`:** rows added, removed or moved animate.
- **`enter` / `exit`:** fade, fade-up, fade-down, scale, pop, slide-left / right / up / down, zoom, bounce, flip-x,
  flip-y, stretch-x, stretch-y, or your own `{ opacity, translateX, translateY, scale, rotateX, rotateY, scaleX, scaleY,
  duration | spring, delay }`. Flips and stretches need registry 24.
- **Shared elements:** `sharedTag={"store-" + id}` on an element of two screens. Push moves it from one to the other;
  Back and the predictive back gesture play it backwards with the finger. An `<Image>` moves as it is; other elements
  move their box and cross-fade. Not inside a Sheet or Modal (they are their own windows), nor on a screen whose route
  has no transition.

## 8. Values from elements

```tsx
const m = useElementMotion()
<Scroll motion={m}> ... </Scroll>
<Box style={{ opacity: m.scrollY.map([0, 120], [0, 1]) }} />    // a header that fades in, no JS
```

| Element | Values |
|---|---|
| any | `x`, `y`, `width`, `height` (the box in the window, dp), `measure()` (async, RN's measureInWindow) |
| `<Scroll>` | `scrollY` |
| `<List>` | `index`, `offset` (first visible row, how far past it), `scrollY` / `scrollX` (exact near the top, estimated after) |
| `<Carousel>` | `page` (2.5 = half way from 2 to 3) |
| `<Pressable>` | `pressed` (0 → 1, springy) |
| `<Sheet>` | `progress` (0 closed → 1 at the tallest detent; follows drag, open, close and predictive back) |
| pull to refresh | `pull` (0 → 1 at the refresh line, up to 1.5) |

`m.follow(v)` drives the scroll from a value on the UI thread: a Scroll by dp, a List by item index (3.5 = half way
through item 3), a Carousel by page. `null` stops. Use it for an A–Z side bar, tabs synced with pages.

A tab indicator that follows the finger: put the pages in a `<Carousel motion={m}>` and bind the indicator to
`m.page`. (`<Tabs>` itself shows one child and has no swipe, so it has no progress.)

## 9. JS hears values when it asks

- `v()` inside a component or effect subscribes: native sends changes, coalesced to one message per frame at most,
  final values first. `v.peek()` never subscribes.
- `useFrame(({ t, dt }) => ...)` calls JS once per frame for logic (a timer, a score). Frames are skipped, never
  queued, when JS is busy. Visuals belong in bindings.

## 10. Native plugins (the extension point, D8)

For what a formula can't do: custom physics, an audio level, a video's position, a sensor we don't ship.

```kotlin
// In the plugin's module (Kotlin): JS made the id.
function("orbit", onMain = true) { call ->
    val h = ZnMotionApi.value(call.int("id"))
    val job = ZnMotionApi.onFrame { now -> h.value = ...; true }   // no allocation here
    h.onDispose { job.cancel() }
    call.resolve()
}
ZnMotionApi.registerDriver("myplugin.wobble") { from, to, velocity, params -> object : ZnMotionApi.Driver { ... } }
// In a NativeView: a prop JS gave as a motion value, read while drawing.
val level = scope.motion("level")   // () -> Float, or null
```

```ts
// In the plugin's package (TS): helpers that call its module, so a bundle that uses them needs the plugin.
export const orbit = () => nativeMotion((id) => MyPlugin.orbit({ id }))
export const wobble = (): MotionTiming => ({ driver: "myplugin.wobble", params: { rings: 3 } })
```

Rules: main thread; what runs each frame must not allocate; APK only (an OTA bundle can't add native code). An app
without the plugin refuses a bundle that calls its module; an unknown driver fails the command. The test plugin
`plugins/device-test` has a working example (orbit, wobble, the fake view's `level`).

`useTilt()` is the built-in sensor: `{ x, y }` from -1 to 1 (how the phone leans), smoothed, turned with the screen,
listening only while held and while the app is in front.

## 11. Drag to reorder

`<List reorderable onReorder={(from, to) => move(from, to)}>`: a long press on a row picks it up, a drag moves it
(the list scrolls near its edges), the drop calls `onReorder`. Move the row in your data there (remove at `from`,
insert at `to`). Until JS's rows change, the list shows the new order itself; if JS doesn't move it within 1 s, the row
glides back. Not with `stickyHeaderIndices`. A row's own `onLongPress` competes with the pick-up: don't use both.

## 12. Do / don't / why

- **Do** bind visuals to motion values; **don't** set signals from `onUpdate` to move things: that's a JS round trip
  per frame and it stutters when JS is busy.
- **Do** give a gesture with anchors or a tap an `a11yLabel`: TalkBack users get an action per anchor. `usePan` with
  anchors throws without it.
- **Do** use `derive` for maths; **don't** call your own functions in it (build error): it runs natively.
- **Don't** animate layout keys each frame; use transforms or `animateLayout`.
- **Do** use `pan.snapTo` to put a slider back after a failed payment; **don't** fight the finger with `v.to` during a
  drag (it is dropped by design, D2).
- **Do** test with the "keep JS busy" button in the labs: a gesture must not care.
- **Porting from RN:** see `docs/rn-compatibility.md` "Gestures and motion". No RNGH / Reanimated aliases (D10).

## 13. Versions and OTA

Everything here needs registry 24 and the `Motion` module (version 1): an app file that imports a motion API from
`@zero-native/core` makes the bundle require `Motion 1`, so an older APK refuses it and keeps its own bundle. Flip and
stretch presets raise the bundle's registry need through the `transition.depth` format. Plugin sources and drivers
are gated by their plugin's module version.

## 14. iOS port (for the iOS session)

Same JSON from JS; port in this order: values + timings (CADisplayLink), env values (keyboard frame notifications),
formulas (port ZnFormula.kt op for op: same opcodes, `x / 0 = 0`, JS Math.round), bindings (CALayer properties or
values read in a per-frame draw, never a SwiftUI body per frame), gestures (UIKit recognizers with a delegate:
`shouldRecognizeSimultaneouslyWith`, `shouldRequireFailureOf`, `gestureRecognizerShouldBegin` failing a sideways pan
on a vertical scroll; not SwiftUI `DragGesture` inside a ScrollView), element values (UIScrollView KVO, page from the
paging scroll), shared elements (zoom transitions / matchedGeometryEffect), reorder (UICollectionView drag), drop zones
(window rects), tilt (CMMotionManager gravity), plugin API (a Swift `ZnMotionApi` with the same three parts). Kotlin
tests in `ZnMotionTest.kt` list the numbers the Swift port must match.
