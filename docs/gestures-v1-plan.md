# Gestures v1: plan (agreed 2026-11-07)

Agreed by Pavan, with Gemini 4 Argon's review (briefs: `docs/cross-communication/2026-11-07-gestures-argon-brief.md`,
`2026-11-07-argon-revert-to-opus-and-pavan-conversation.md.txt`). Replaces ARCHITECTURE §10.3's `'main thread'`
expression language: no general expression language and no script on the UI thread.

## The model in one picture
```tsx
const drag = useDrag({ axis: "x", bounds: [0, "100%"], snap: [0, 1], a11yLabel: "Pay ₹499", onEnd: (e) => e.snap === 1 && pay() })

<Box gesture={drag} style={{ translateX: drag.x }} />                         // 1. native, under the finger
<Text style={{ opacity: drag.progress.map([0, 0.5], [1, 0]) }}>Slide to pay</Text>  // 2. native binding
<Text>{formatInr(Math.round(drag.progress() * 500000))}</Text>               // 3. JS signal, once per frame at most
```
1. **Under the finger: native, 0 hops.** The dragged view's position, the spring or fling when let go (Compose
   `anchoredDraggable` / `draggable`, pinch with `transformable`). Never waits for JS.
2. **Bindings: native, 0 hops, fixed types only.** `map` = a 2-point lerp with `extrapolate: "clamp" | "extend" |
   "rubber"`; `mapColor` = lerp of RGBA; an `abs` flag on the input. Targets: opacity, translate, scale, rotate,
   background colour (the props that already animate natively). Read in `graphicsLayer` / the `offset {}` lambda, so
   only the draw or placement phase runs: no recomposition during the gesture.
3. **JS: the gesture's values are signals** (`drag.x()`, `drag.y()`, `drag.progress()`, `scroll.y()`), for text,
   maths and conditions in plain TS. Native sends at most one value per frame, newest only
   (`ZnRuntime.dispatchLatest`); if JS is busy, frames in between are dropped, nothing queues.

## Rules (each one has a reason)
- **Only when JS reads it.** The compiler marks a gesture `syncToJs` only if JS reads its signal outside `.map()`.
  Otherwise native sends nothing during the gesture (keeps v0's "0 bridge events during a drag"). (Argon, guard 1)
- **Final value first.** On release / settle, native writes the exact final `(x, y, progress)` into the JS signal
  right before `onSnap` / `onEnd`, in the same dispatch, never dropped as "not newest". So "₹ 5,00,000" never stays
  at "₹ 4,98,200". (Argon, guard 2)
- **Callbacks fire once:** `onStart`, `onEnd` (position, velocity, snap index), `onSnap`, `onCross(threshold)`.
  An `onEnd` that pays must be safe to call twice anyway (guide), and `drag.snapTo(index)` springs it back (a failed or
  cancelled payment).
- **Lint:** a gesture's JS value feeding a transform (`translateX: drag.x() * 2`) is a build warning: "use `.map()`".
  Through JS the dragged view lags a frame.
- **`"100%"` in `bounds` / `snap` = the room to travel** (parent size minus own size). Also `"100%self"` (own size,
  swipe-to-dismiss) and `"100%parent"`. Native measures both sizes. `drag.progress` is 0 → 1 over the bounds.
- **Which gesture wins:** `axis` uses Compose's own direction check (a sideways row inside a vertical `List` starts
  only after the finger moves sideways more than down). Optional `activeOffsetX` / `failOffsetY` for diagonal cases.
  Pan + pinch together only inside `usePinch` (no general `simultaneousWith` / `waitFor` graph in v1).
- **Android Back edge:** a horizontal drag area gets `Modifier.systemGestureExclusion()` (Android allows ~200 dp per
  edge), so a slider near the left edge doesn't trigger Back.
- **TalkBack:** a gesture with `onEnd` + `snap` must have `a11yLabel` (build error without it); it becomes a custom
  accessibility action that does the snap.
- **Scroll source:** `scroll.y` on `Scroll` is exact. On `List`, only while the first row is visible
  (`firstVisibleItemIndex == 0`): enough for collapsing headers; said in the guide. Nested-scroll hand-off for a header
  that collapses before the list scrolls.
- **Collapsing headers:** bind `translateY` / `scale` / `opacity`, not `height` (a layout pass per frame).
- **Format:** one `gestures` table in `.zn.ui` (sources + flat `Binding(source, node, prop, kind, in0, in1, out0,
  out1, extrapolate, abs)`); nodes stay as they are. Any use of gestures = new registry version: an older APK refuses
  the bundle (no partial "ignore the section").

## Steps
1. **Compiler:** `useDrag`, `usePinch`, `scroll` sources; `.map` / `.mapColor` / `.abs()`; the `gestures` table;
   `syncToJs`; the lint and the `a11yLabel` check; registry + host API bump. Tests.
2. **Runtime (Compose):** gesture hosts, bindings in `graphicsLayer`, travel units, rubber band, Back-edge exclusion,
   TalkBack action, `snapTo`. Kotlin tests for the binding maths.
3. **JS channel:** coalesced signals, final value before `onEnd` / `onSnap`, callbacks once.
4. **Components in TS on top:** `Slider` (+ range), `SlideToConfirm`, swipe actions on `List` rows. A sample lab.
5. **Checks:** emulator, then the Lava. Frame times during a drag with JS kept busy on purpose; the loan-slider text
   live; a sideways drag in a vertical `List`; a drag at the left edge with gesture navigation; `Sheet` / `Carousel`
   next to a drag; TalkBack; 0 bridge events for a bindings-only gesture.
6. **Docs:** `docs/gestures.md`, guide notes, rn-compatibility rows, ARCHITECTURE §10.3, second-opinions.

Who: steps 1–3 by the lead (Opus); step 4 can go to a `senior-builder` after 1–3. Estimate ~2–2.5 weeks (a guess).

## Not in v1
Finger drawing (a native component), drag to reorder in a `List` (a `List` feature), multi-stop keyframes, a general
gesture graph, iOS (the model maps to SwiftUI `DragGesture` / `MagnificationGesture` and iOS 18
`onScrollGeometryChange`; checked on paper only).
