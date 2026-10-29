# Guide notes: how app authors should use zero-native

Raw material for the public docs (user guide, best practices, sample projects). **Add to this file every time we build
something an app author will touch.** Each topic says what to do, what not to do, and why, in words an outsider (a
React Native or Flutter developer) understands. Code here must match what is built; mark unbuilt parts **(planned)**.

Last updated: 2026-10-29 (milestone 2, steps 2.1–2.4a).

---

## 1. The mental model (say this first in the docs)
- You write screens in TSX, but **there is no React**. A component function runs **once** when its screen or part
  appears. It never re-renders. Values that change are **signals**; the compiler turns every JSX expression that
  reads a signal into a small native update (only that text, colour, ... changes).
- Native (Jetpack Compose today, SwiftUI later) draws everything. JS only sends small value changes.
- So: **no hooks, no dependency arrays, no memo, no keys for re-render reasons.** If you think "how do I stop this
  re-rendering", the answer is: it doesn't.

**Don't:** destructure props (`function A({ title })`). Props are live getters; destructuring reads them once and
the value never updates. Use `props.title`.
**Don't:** put work at module top level (fetching, big loops, building data). Startup runs every module; keep tops of
files to declarations (startup rule 1, `docs/startup-and-performance.md`).

## 2. Signals
```ts
const amount = signal("0")          // read: amount(), write: amount.set("5") or amount.set(prev => prev + "5")
const paise = computed(() => toPaise(amount()))
```
- `set()` with an equal value does nothing (no update is sent). For objects, pass `{ equals }`.
- Keep signals small and specific: one per thing that changes on its own. A signal holding a big object makes every
  reader update when any field changes.

## 3. Styling
- React Native `style` names, as objects, arrays or `StyleSheet.create`. The framework applies them in **one fixed
  order** (margin → size → transform → shadow → background → border → clip → press feedback → padding). You never
  order modifiers; for unusual layering nest a `Box`.
- Unsupported keys are **build errors**, never silently ignored (e.g. `flexDirection`: use `Row` / `Column`).
- Static styles cost nothing at runtime: they are folded into the template at build time. Design tokens (`c.*`) in a
  side-effect-free `.ts` file are folded too.
- **Only some style values may change at runtime** (registry v4): `color`, `backgroundColor`, `opacity`, image `src`,
  `disabled`, and per-edge padding (`paddingTop/Bottom/Start/End`). Everything else must be a build-time value; the
  compiler says so with file:line. Prefer two styles chosen by a ternary inside the object
  (`backgroundColor: on ? c.a : c.b`) over toggling layout.
- `fontWeight`: 100–900 in steps of 100, `"normal"` (400) or `"bold"` (700). Anything else is a build error.
- Colour and opacity changes only redraw; padding changes only re-measure; text changes recompose one `Text`.
  Cheap by design: animate-looking UI (a blinking cursor, a highlighted tab) is fine.

## 4. Control flow in JSX
- Plain JS: `{cond && <X/>}`, `{cond ? <A/> : <B/>}`, `{items.map(i => <Row key={i.id}/>)}`. Rows need a `key`.
- `.map` is for **short** lists that are part of a layout (up to ~100 items). Long or growing lists use `<List>`
  (planned, step 2.4).

## 5. Taps and presses
- Taps only on `Pressable` (or `Button`). Layout nodes take no `onPress`. This gives every tappable thing the right
  accessibility role and press feedback.
- `onPressIn`, `onPressOut(cancelled)`, `onPress`, `onLongPress`. `onPress` fires only for a completed tap.
- **Press-and-hold repeat is native:** `onPressRepeat` + `repeatDelay` / `repeatInterval` (keypad backspace,
  steppers). **Don't** build it with `setInterval` in JS: that is exactly the "zombie timer" bug class (the timer
  keeps deleting after the finger lifts).
- `haptic` adds a press tick that respects the user's system setting.
- **Guard actions that must happen once** (pay, submit) against double taps: the second tap can arrive before the
  screen changes. A simple `let done = false` flag in the screen body is enough.

## 6. Routes and navigation
```ts
// routes.ts — the only place routes are declared
export const routes = defineRoutes({
  home:    { path: "/", screen: HomeScreen },
  amount:  { path: "/pay/:merchantId", screen: AmountScreen, deepLink: true },
  receipt: { path: "/receipt/:ztc", screen: ReceiptScreen, transition: "modal", safeArea: { top: false }, statusBar: "light" },
})
declare module "@zero-native/core" { interface Register { routes: typeof routes } }   // typed nav.push
```
- One `"/"` route: where the app starts. Order in the file = route number at runtime; don't reorder routes in an app
  that has OTA bundles in the field (planned rule, milestone 3).
- `nav.push(name, params)`, `nav.back()`, `nav.replace(...)`, `nav.reset([...])`. Names and params are type-checked.
  Every `:param` in a path must be a **string** prop of the screen (type error otherwise).
- Params must be plain JSON (strings, numbers, booleans, small objects). Pass ids, not whole objects: a screen should
  load what it needs by id (it may be opened from a deep link or restored after the app was killed).
- Transitions are native, per route: `push` (default), `modal`, `fade`, `none`. JS never animates a page change.
- **Deep links are opt-in per route** (`deepLink: true`). A link is an outside entry point: only allow it for screens
  that are safe to open directly with just the path params. Cold start from a link opens `"/"` underneath, so back
  doesn't leave the app.

## 7. Back handling
```ts
useBack(() => {
  if (amount() === "0") return false     // go back as usual
  confirmDiscard.set(true)               // show your own "Discard?" UI
  return true                            // handled: stay
})
```
- Same meaning as React Native's `BackHandler`: return `true` when you handled it.
- Call it in the screen's body (not later, not in a callback). Only the top screen is asked.
- Make your on-screen ← button do the same thing (`if (!handler()) nav.back()`), so both behave alike.
- The last screen's back goes to the system (the app moves to the background); `useBack` isn't asked there yet.

## 8. Lifetimes: timers and cleanup
- A timer (`setTimeout` / `setInterval`) created in a screen body, a component body, or a tap handler of one is
  **stopped automatically when that screen closes**. You don't need `clearInterval` on unmount.
- Timers created at module top level live forever: avoid them.
- Prefer native behaviour over JS timers whenever it exists (key repeat; carousels and animations (planned)).

## 9. Safe areas, status bar, full-bleed screens
- **Don't** add status-bar or navigation-bar padding yourself. Each screen is kept clear of the system bars natively,
  per route (`safeArea`, default `"all"`). There is no `SafeAreaView`.
- For a coloured header behind the status bar: `safeArea: { top: false }` on the route, then pad the header with
  `insets()`: `style={{ backgroundColor: c.brand, paddingTop: insets().top + 24 }}`.
- `statusBar: "light"` for dark headers (white icons). The bottom bar's icons follow your screen background
  automatically.
- Give the screen root a `backgroundColor`: it is used behind the bars.

## 10. Images and icons
- `Image src` takes `https://...` or `asset:...`. Give images a fixed size (or aspect ratio): unsized images make rows
  jump when they load. A rounded image clips to its corners automatically.
- Icons are SVG path data in a `.ts` file (`"minX minY w h|d"`), folded into the template: no icon font, no SVG
  library. Fill paths only for now.
- Heavy native things (app icons, camera photos) go by **handle** (`zn://...`, planned), never as Base64 through JS.

## 11. Long lists and feeds: `<List>`, rails, `<Carousel>`, impressions (built)
```tsx
<List data={feed()} key={(f) => f.id} style={{ flex: 1 }} gap={8}
  onEndReached={() => loadMore()}
  row={(f) => f.kind === "header" ? <SectionHeader f={f} /> : <MerchantRow m={f} />} />
```
- Use it for anything long or growing (passbooks, catalogues, feeds). Only rows near the screen exist; the rest are
  placeholders of the right kind until they are near. 10,000 rows flung at 6 ms/frame median on a ₹10k phone.
- **Row kinds:** write `cond ? <A/> : <B/>` in `row` to mix kinds (headers, banners, product rails, cards). Each kind
  is reused only for rows of the same kind, which keeps scrolling cheap. Don't build one giant row with `&&` switches
  for every kind.
- **Keys:** unique and stable (an id from your data, never the index). Duplicates are logged as errors.
- **Items are immutable:** to change a row, replace its object (`items.map(i => i.id === id ? { ...i, liked: true } : i)`).
  A changed object re-creates just that row; mutating an object in place shows nothing.
- `data={feed()}`: read the signal inside the prop so the list follows changes. Inserting at the top keeps the
  user's scroll position (they don't get pushed down).
- **Rails (horizontal product lists) inside a row:** `<Scroll horizontal style={{ gap: 12, paddingHorizontal: 16 }}>`
  with `{offers.map(o => <ProductCard key={o.id} o={o} />)}` inside. Only the visible cards are drawn and scrolling a
  rail never involves JS. Its padding scrolls with the cards (like RN's `contentContainerStyle`), so the first card
  starts inset and slides under the screen edge. Rails are for short lists (up to a few dozen cards); the whole rail's
  cards exist while its row is near the screen.
- Cards in a lazy rail don't stretch to the tallest card (they are measured one by one). If cards must line up, give
  them a fixed height.
- **Carousels (banners):** `<Carousel itemWidth={300} autoAdvance={4500} dots style={{ gap: 12, paddingHorizontal: 16 }}>`
  with `{banners.map(b => <BannerCard key={b.id} b={b} />)}` inside. Paging, snap, peek, auto-advance and dots are
  native. Auto-advance pauses after the user touches it (`pauseAfterTouch`, default 3000 ms) and stops by itself
  when the carousel is off screen, another screen is on top, or the app is in the background.
  **Don't** build a carousel with `setInterval` + `scrollTo` (the RN way): that's a JS timer and a re-render per
  page, even off screen. `onPageChange` is optional; bind it only if you need the index.
- **Impressions (analytics "seen" events):**
  ```tsx
  useImpressions((keys) => analytics.track("IMPRESSION", keys))            // once, in the screen body
  <Pressable impressionKey={offer.id} onPress={...}>                        // on each card / row you track
  ```
  Native measures visibility from layout (no `onScroll`, no `measureInWindow`, no JS while scrolling). A key counts
  when ≥ 35 % of it is visible (`{ threshold: 0.5 }` to change; `{ minMs: 500 }` to require a dwell time), only while
  the screen is on top and the app is in front, once per visit of the screen (`{ once: "session" }` for once per app
  session). Keys arrive in batches (about every 500 ms, and when the screen leaves or the app pauses).
  **Don't** track impressions with scroll handlers and measuring in JS: that is exactly what made the RN Offers tab lag.
  Clicks stay plain `onPress`.
- Measured (Lava, release): a 260-row offers feed with a banner carousel, product rails, real product photos and
  impressions on flings at 6–7 ms median, 11–13 ms p95 per frame, 0–2 janky frames in ~420.

## 12. Bottom sheets: `<Sheet>` (built, step 2.5)
```tsx
const pickerOpen = signal(false)
<Pressable onPress={() => pickerOpen.set(true)}>…</Pressable>
<Sheet visible={pickerOpen()} onDismiss={() => pickerOpen.set(false)} style={{ paddingHorizontal: 20, gap: 12 }}>
  …content…
</Sheet>
```
- **You own `visible`.** The user closing it (drag down, fling, tap outside, back) only *asks*: `onDismiss` fires and
  you set `visible` to false. If you don't (a form with unsaved input, a payment in progress), it springs back up.
  This is the opposite of most RN sheet libraries, where the sheet closes itself and your state goes stale.
- Put it anywhere in the screen; it takes no space there and draws over the whole screen (scrim over the status bar,
  content above the navigation bar). Back closes the sheet before the screen.
- Dragging, flinging and snapping are native: no JS runs during the gesture. A scrolling list inside the sheet
  scrolls first; at its top, pulling down moves the sheet.
- `detents="content"` (default: as tall as its content), `"half"`, `"full"`, or several (`"half,full"`: opens at the
  first, the user can drag between them; `onDetentChange` tells you). `dismissible={false}` for sheets the user must
  answer.
- Style the sheet's content with `style` (padding, gap); its background is white unless you set `backgroundColor`.
  Don't set `borderRadius` on it (the top corners are rounded for you).
- Close the sheet **before** navigating (`pickerOpen.set(false); nav.push(...)`), as in the sample.

## 13. Calling native code (transport built; module system proposed in `docs/native-modules.md`)
- Today: `callNative(module, method, args)` → Promise, for modules registered natively with `ZnModules.register(...)`.
  Always async: the JS thread never waits for native.
- Planned: typed `nativeModule<T>("Name")` declared in TS with generated Kotlin/Swift interfaces, events with
  `Module.on(...)` that unsubscribe when the screen closes.

## 14. Gradients, colours and text
- `backgroundImage: "linear-gradient(135deg, #047857 0%, #0F172A 100%)"` (React Native's CSS form; `to bottom` /
  `to right` work too). Parsed at build time, drawn with the background: no gradient library, no extra view. Use it
  for card backgrounds and image overlays (`linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 100%)` over
  an `Image` in a `Stack`). Build-time only for now.
- Colours: `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb()`, `rgba()`, `transparent`. Named colours (`"red"`) are not
  supported: use tokens.
- JSX text decodes HTML entities like React (`&amp;`, `&#8377;`), so copied web/RN markup shows correctly.

## 15. Performance habits (the short list for the docs)
- Read signals only inside JSX or `computed`; reading them in plain code captures a value once.
- Keep lists of more than ~100 items in `<List>`, not `.map`.
- Fixed sizes for images and list rows wherever possible.
- Measure on a low-end phone in a **release** build; debug builds are several times slower.

---

## Open items to write up when built
- `<List>` rails, carousel, impressions (steps 2.4b–d). See
  `docs/cross-communication/2026-10-29-feeds-and-lists-proposal.md`.
- Sheets (2.5), native calls / `fetch` (2.6), flows and payments (2.7–2.8): the "effects" rules are the most important
  thing to teach well.
