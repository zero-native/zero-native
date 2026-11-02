# Guide notes: how app authors should use zero-native

Raw material for the public docs (user guide, best practices, sample projects). **Add to this file every time we build
something an app author will touch.** Each topic says what to do, what not to do, and why, in words an outsider (a
React Native or Flutter developer) understands. Code here must match what is built; mark unbuilt parts **(planned)**.

Last updated: 2026-10-30 (milestone 3, steps 3.7–3.8).

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

## 13. Native modules: calling your own Kotlin (Swift later) code (built: foundations)
```ts
// device.ts — declare once
export interface DeviceModule {
  info(): Promise<{ model: string }>
  slowEcho(args: { text: string; ms: number }, options?: CallOptions): Promise<string>
  events: { tick: number }
}
export const Device = nativeModule<DeviceModule>("Device", { version: 1 })
```
```kotlin
// DeviceModule.kt — implement, then ZnModules.register(DeviceModule()) in your Application
class DeviceModule : ZnModuleBase("Device", version = 1) {
    init { function("info") { it.resolve(JSONObject().put("model", Build.MODEL)) } }
    override fun onListenerCount(event: String, count: Int) { /* start the source at 1, stop it at 0 */ }
}
```
- **Always async.** Every call returns a Promise; JS never waits for native, so a slow module can't freeze the UI.
  Native runs functions on a background pool; mark UI work (starting activities) `onMain = true`.
- **One args object** per method, plain JSON. Large things (images, files) go by handle (`zn://...`), never as base64.
- **Errors have codes:** `catch (e) { if (e.code === "unavailable") ... }` (`NativeError`: `unavailable`,
  `cancelled`, `invalid_args`, `failed`, or the module's own).
- **Cancel** with an `AbortController`: `Device.slowEcho(args, { signal: ac.signal })`, `ac.abort()`. Calls a screen
  starts are dropped automatically when the screen closes: don't worry about "setState after unmount".
- **Events:** `Device.on("tick", handler)` in a screen body: unsubscribed when the screen closes. Native knows how many
  listeners there are, so start GPS / sensors / receivers only while someone listens (`onListenerCount`), and use
  `emit(..., latestOnly = true)` for fast streams so a busy JS thread gets the newest value, not a backlog.
- **Versions:** when you add a method, raise the Kotlin `version` and the JS `nativeModule(..., { version })`
  together. An OTA bundle that needs a newer module than the installed app gets `unavailable` instead of crashing.
- **Don't:** block in a function on the main thread; answer twice; keep working after `call.isCancelled`.

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

## 16. Saving data and payments (FlowStore built, step 2.7; app storage comes later)
Android often kills the app while the user is inside the UPI app. When they come back, the app starts fresh. The
payment must not be forgotten, and it must never be sent twice. The flow engine that would do this for you is parked
(ARCHITECTURE §12), so apps follow this pattern by hand.

**The save-then-verify pattern** (one record per payment, in `flowStore`):
1. Before calling `/pay`: write `{ orderId, step: "paying" }`. If `write` returns `false`, stop and show an error.
2. When `/pay` answers: write `{ orderId, paymentId, step: "in-upi" }`, **then** open the UPI app (only if the
   write returned `true`).
3. When the UPI app returns: don't trust its result. Call `/verify` and show what the backend says.
4. On a final answer (success / failed): show it, then `remove` the record.
5. On app start: `read` the record.
   - `ok`, step `in-upi`: open the status screen and call `/verify`. **Never open the UPI app or call `/pay` again.**
   - `ok`, step `paying` (killed before `/pay` answered): the UPI app never opened, so no money moved. Remove the
     record and let the user try again.
   - `broken`: show "checking your last payment" and ask the backend for the user's latest payment.

```ts
// Sketch: `api` is your backend client, `Os` the built-in module (step 2.6b).
const KEY = "pending-payment"
if (!flowStore.write(KEY, { orderId, step: "paying" })) return showError("Could not start the payment")
const { paymentId, upiLink } = await api.pay(orderId)
// If this write fails, don't open the UPI app: the record would still say "paying", and a restart would wrongly
// conclude that no money moved.
if (!flowStore.write(KEY, { orderId, paymentId, step: "in-upi" })) return showError("Could not start the payment")
await Os.launchActivity({ action: "android.intent.action.VIEW", uri: upiLink }).catch(() => {})
const status = await api.verify(paymentId) // the backend decides, not the UPI app
if (status !== "pending") flowStore.remove(KEY)
```

- **Do:** keep normal app data (settings, last tab, caches) in app storage (planned, MMKV-like). Losing the last write
  there is fine.
- **Don't:** use `flowStore` as a settings store. Each key is its own file of at least 64 KB; keep it to a few
  records.
- **Don't:** keep secrets (tokens, PINs) in either store. They are plain files (private to the app, not backed up).
- **Don't:** retry `/pay` or reopen the UPI app after a restart "to be safe". If you are not sure what happened,
  ask the backend.
- **Why:** a payment must never be lost or sent twice when the app is killed. FlowStore keeps two copies with a
  checksum and switches over last, so a kill at any moment leaves the old value or the new one, never half
  (tested: 200 / 200 kills mid-write). A write takes about 5 µs, so saving before every step is free.

## 17. Live reload and the error screen: `zn dev` (built, step 3.1)
Run `bun run dev` at the repo root with the phone connected (USB or wireless debugging), then open the app's **debug**
build. Save a file: the phone shows the change in well under a second and stays on the same screens.
- **Do:** keep anything you want to survive a reload in FlowStore or (later) storage. A reload starts JS fresh:
  signals, timers and in-memory stores start again, and the screens are opened again with the same params.
- **Do:** read the error screen's first line in **your** file (`src/...tsx:line`); the lines under it are usually the
  framework calling your code.
- **Don't:** test performance or startup with `zn dev` running: debug build, extra line-number info in the bytecode,
  and one reload at app start. Use a release build (`docs/startup-and-performance.md`).
- **Don't:** rely on a handler error stopping the app. The runtime catches errors in handlers, timers, effects and
  listeners so one bad handler can't break the screen; in debug builds they show on the error screen, in release
  they are only logged. Fix them, don't ignore them.
- **Why:** building on the computer and sending bytecode is much faster than RN's Metro (no JS parsing on the
  phone), and a fresh runtime can't keep stale closures or listeners alive, which is where RN Fast Refresh breaks.

## 18. Children, JSX props, fragments and text spans (built, step 3.2)
```tsx
function Card(props: { header: Children; children?: Children }) {
  return <Column style={s.card}>{props.header}{props.children}</Column>
}
<Card header={<Text>Who</Text>}><TextField ... /><TextField ... /></Card>
```
- **Do:** pass content into layout components (cards, sections, screen frames) as children or JSX props, and show it
  with `{props.children}` / `{props.header}`. Type them as `Children` from `@zero-native/ui`.
- **Do:** return `<>...</>` when a component is just a few siblings; they join the parent's layout (its gap, its
  alignment) with no extra box.
- **Do:** style part of a sentence with nested `<Text>`: `Pay <Text fontWeight="bold">₹400</Text> now`. It is one
  native text, so it wraps and ellipsizes as one.
- **Don't:** read, count or `.map` children: they are a recipe the component places, not data. Pass data as props.
- **Don't:** change a span's style at runtime yet (colour from a signal, etc.) or put `onPress` on a span: build
  error. Use separate `<Text>` elements in a `<Row>` for that for now.
- **Why:** the parent's JSX keeps its own template and its own variables; the child only says where it goes. That
  keeps one template per piece of UI, with no copying of props through layers.

## 19. Text input and the keyboard (built, step 3.3)
```tsx
<TextField value={amount()} onChangeText={(t) => amount.set(format(t))} keyboardType="number-pad" placeholder="₹0" />
```
- **Do:** make fields controlled (`value` + `onChangeText`) and set the value **synchronously** in the handler. To
  format, set the formatted text; to reject a key, don't set anything: the field goes back to `value`.
- **Do:** pick the keyboard: `number-pad` (digits only), `decimal-pad`, `phone-pad`, `email-address`, `url`; and
  `returnKeyType` for the action key (`next`, `done`, `search`, ...). `onSubmitEditing` fires on that key.
- **Do:** put forms in a `<Scroll>` with the main button outside it, at the bottom. The default route option
  `keyboard: "resize"` keeps that button above the keyboard, and the focused field scrolls into view.
- **Do:** call `Keyboard.dismiss()` before you navigate away or open a sheet after a form.
- **Don't:** set the value later (after an `await`): the field shows your old value first, then jumps.
- **Don't:** collect a real UPI PIN. The UPI PIN is only ever typed in the bank's / NPCI's own screen. Even a
  `secureTextEntry` field is readable by accessibility services on Android (the Lava's UI dump showed the digits).
- **Why:** the native field owns the text while typing, so typing never waits for JS; each change and JS's answer to
  it are numbered (as in React Native), so an answer to an old keystroke never overwrites newer typing.

## 20. Network calls: `fetch` (built, step 3.4)
```ts
const res = await fetch(`${API}/offers?page=${page}`, { headers: { Authorization: `Bearer ${token}` } })
if (!res.ok) throw new Error(`offers: HTTP ${res.status}`)
const offers = await res.json()
```
- **Do:** check `res.ok` / `res.status` before `res.json()`. HTTP errors (404, 500) are not exceptions; a 204 has no
  body to parse.
- **Do:** catch `FetchError` and look at `e.code` (`offline`, `timeout`, `dns`, `tls`, ...) to show the right message
  ("You're offline" vs "Server is slow, try again").
- **Do:** set `Content-Type: application/json` when you send `JSON.stringify(...)`.
- **Do:** set app-wide limits once at startup if 30 s / 10 MB don't suit you: `setFetchDefaults({ timeout: 20_000 })`.
  Per request, `timeout` / `maxBodySize` win.
- **Do:** pass `signal: useAbortSignal()` for data only this screen needs (search, a list page): the request stops
  when the screen closes.
- **Do:** for payments and other money calls, save first, then call, then verify after a restart (§16). Send an
  `Idempotency-Key` header if the server supports one.
- **Don't:** retry POSTs in a loop. `fetch` never retries them (not even OkHttp's hidden retry); a retry of a payment
  call must be a decision of the app and the server.
- **Don't:** set `Accept-Encoding`, `Host`, `Content-Length` and other transport headers (they are dropped), or put
  non-ASCII text in a header (encode it).
- **Don't:** download big files with `fetch` (10 MB limit by default, all in memory). A native download comes later.
- **Why:** the defaults are made for flaky mobile networks: a 30 s limit on the whole request (RN has none), stale
  connections closed when the network changes, clear error codes, and no duplicate POSTs. Details: `docs/fetch.md`.

## 21. Saving data: `storage`, `SecureStore`, `flowStore` (built, step 3.5)
```ts
if (!storage.getBoolean("onboarded")) nav.replace("welcome")
const lang = persistedSignal("lang", "en")          // lang.set("kn") saves at once
await SecureStore.set("refreshToken", token)
```
- **Do:** use `storage` for preferences, drafts and cached data. It is synchronous: read it while building a screen,
  no `await`, no loading state.
- **Do:** use `persistedSignal` for a setting the UI shows (language, theme, last tab): one line, always in sync.
- **Do:** give each signed-in user their own store (`createStorage(\`user.${id}\`)`) and `clear()` it on sign-out.
- **Do:** put tokens and keys in `SecureStore`, and treat `null` as "sign in again" (a secret can become unreadable).
- **Do:** use `ZnStorage.store(context)` when Kotlin code (a widget, a push handler) needs the same data: same stores,
  same types. Each key should have one writer: a push handler and JS both doing "read, add 1, write" can lose an
  update. JS `onChange` doesn't fire for Kotlin writes: send a module event, or re-read when the screen shows.
- **Don't:** use storage from a service with its own `android:process`: it throws (two processes would damage the
  file).
- **Do:** call `storage.flush()` after a write that must survive a power cut (the user's chosen language, a
  "signed in" flag). Every write already survives the app being killed.
- **Don't:** keep anything you can't rebuild only in `storage`: a power cut right after a write can make a store open
  empty (`docs/storage.md` §4). Money state goes in `flowStore` and on the server.
- **Don't:** store big blobs (images, long lists) in `storage`: every store is kept in memory while open. Files and a
  native database come later.
- **Don't:** read a key with a different type than you saved (`getString` on a number): it throws.
- **Why:** MMKV reads and writes are memory operations (~1 µs read, ~4 µs write on the Lava), so making them async
  would only add `await`s and loading states. Secrets need the Keystore, which is a system service: those are async.

## 22. Animation (built, step 3.6)
```tsx
<Box animate={{ opacity: 200, translateY: "spring" }}
     style={{ opacity: open() ? 1 : 0, transform: [{ translateY: open() ? 0 : 24 }] }} />
{toast() && <Box enter="fade-up" exit="fade-down">...</Box>}
```
- **Do:** animate by changing values as usual and adding `animate` to the element: a number is a tween in ms
  (`animate={250}` covers all its animatable props), `"spring"` / `"bouncy"` springs, or
  `{ duration, easing }` / `{ spring: { damping, stiffness } }`. Animatable: opacity, background colour, scale,
  translateX / Y, rotate (degrees; a number when it changes at runtime).
- **Do:** put `enter` / `exit` on the root element of a `&&` or `? :` branch, or of a `.map` row. Presets: `fade`,
  `fade-up`, `fade-down`, `scale`, `pop`; or `{ opacity, translateX, translateY, scale, duration }`.
- **Do:** to swap two elements in place (`a ? <A/> : <B/>`), put them in a `<Stack>` with absolute positions: while
  one leaves and the other arrives, both are on screen.
- **Do:** rely on `Pressable`'s press feedback: a ripple from the touch point by default (Android), clipped to its
  shape. Options (all build-time):
  | Prop | Use |
  |---|---|
  | `rippleColor`, `rippleOpacity` | white on dark buttons; a brand-tinted ripple (`rippleColor={c.primary} rippleOpacity={0.3}`) |
  | `rippleBorderless`, `rippleRadius` | icon buttons: a round ripple around the icon, not clipped (`rippleRadius={24}`) |
  | `pressFeedback="highlight"`, `highlightColor` | a flat overlay instead of a ripple (give the colour its own alpha) |
  | `pressOpacity` | dims while pressed (iOS feel), e.g. `pressOpacity={0.5} pressFeedback="none"` |
  | `pressScale` | keys and cards that "give" (`0.94`–`0.97`) |
  | `pressFeedback="none"` | no feedback |
  Try them all on the sample's "Press feedback" dev screen.
- **Don't:** animate with `setInterval` + signals. Every frame would go through JS; `animate` runs natively.
- **Don't:** expect `exit` on a `<List>` row (rows also leave when they scroll away) or when the whole screen closes
  (the screen transition covers it).
- **Don't:** rely on layout animating: width, height, padding and position changes jump. The element keeps its space
  while it exits, then the space closes at once. Leave room for the leaving element (a row of chips that is already
  full gets squeezed while one more fades out, and things below it can jump).
- **Why:** JS sends only target values; the spring / tween runs on the UI thread and is read in the draw phase, so an
  animation never recomposes or re-lays out anything and keeps going even while JS is busy.

---

## 23. What an OTA update can change (bundle loading built, step 4.1; downloads come in 4.5)
- **An update can change:** your screens and logic (bytecode), layouts and styles (templates), routes, and your own
  images. **It can't change:** Kotlin / Swift code, native modules, the framework's native side, or the Hermes
  engine. Those need a store release.
- **Do:** keep your images in the app's `assets/` folder next to `src/` (the sample: `examples/sample/assets/`) and
  use them as `asset:images/x.png`. The build copies them into the bundle, so an update can change or add images.
- **Don't:** put images straight into the Android project's `src/main/assets`. They work, but only a store release
  can change them; an update that refers to a new image there shows an empty box.
- **Do:** expect the same source to give the same bundle, byte for byte. If a rebuild of unchanged source gives a
  new bundle SHA, something is wrong (tell us): it would ship an update nobody made.
- **Why:** the app runs exactly one bundle per process, either the one in the APK or a downloaded one. Bytecode,
  templates and images always come from the same bundle, and a newer APK always wins over an older download.
- **Needs a store release (step 4.9 list):** a new native module or a new version of one (a bundle that needs it is
  ignored by older apps: they keep their bundle, nothing breaks), new Android permissions or manifest entries (push
  setup, deep-link hosts, the launcher icon and name), a newer Hermes or framework native side, and fixing a crash in
  Kotlin code (the watchdog can block a bundle, not fix native code). Plan these as: APK first, then the bundles that
  use it, once most users have that APK.

---

## 24. Small Components, Toast & Accessibility (Steps 3.7 & 3.8)
- **`<Switch>` and `<Checkbox>` are strictly controlled:**
  - **Do:** update your signal inside `onValueChange`:
    ```tsx
    <Switch value={enabled()} onValueChange={next => enabled.set(next)} />
    ```
  - **Don't:** expect native to change the shown value or animate ahead of JS. If `onValueChange` is ignored or does
    not set the value, **nothing moves and no animation starts** (Rule 10). Native never guesses user state.
  - **Why:** ARCHITECTURE §9.7 (JS owns all reactive state). Tightly controlled components eliminate desync bugs and
    flickering list rows.
- **`<Spinner>`, `<Progress>`, and `<Shimmer>` are draw-phase only:**
  - **Do:** use `<Shimmer>` placeholders for loading skeletons; all shimmers across the screen move in lockstep via a
    shared monotonic clock (`SystemClock.uptimeMillis() % period`).
  - **Why:** zero recompositions per frame (verified with `ZnDebug`). Reading animated values only inside draw phase
    preserves 90 fps flings in heavy feeds.
- **`<Image>` fallback and loading shimmer:**
  - **Do:** pass `fallbackSrc` and `loading="shimmer"`. The fallback shows **only on error**, never while loading; a new
    `src` resets to loading. Keep the fallback in the app (`asset:images/...`), not on the network: a fallback URL can
    fail for the same reason as `src` (no network).
  - **Don't:** expect a retry of `src` after the fallback shows. Each image is requested once per `src`.
  - **Why:** list row reuse would otherwise show stale errors or stale fallback images, and retrying a broken `src`
    swapped it with the fallback forever (found in review: ~47 requests a second for one broken offer image).
- **`toast(message, options)`:**
  - **Do:** use `toast("Saved")` for transient non-blocking feedback. Calls use `owned: false`, so they survive
    subsequent screen closure (`toast("Saved"); nav.back()`).
  - **Do:** call it from inside a `<Sheet>` too ("UPI ID copied"): it shows on top of the sheet.
  - **Don't:** use toast for errors that need an action (use dialogs, sheets, or inline error text).
  - **Why:** toasts disappear automatically and cannot capture user input.
- **Accessibility:**
  - **Do:** use `accessibilityLabel` on icon-only `Pressable`s so TalkBack users understand the button's action.
  - **Do:** use `accessibilityRole="none"` if you need a touchable area that shouldn't announce "Button" in TalkBack.
  - **Do:** use `maxFontScale` on compact text (e.g. `maxFontScale={1.2}`) to prevent text clipping while respecting
    system accessibility scaling.
  - **Don't:** add a second semantics block on a Pressable; use the single semantics props on the node.
  - **Why:** TalkBack announces elements once without duplicate readings or conflicting semantics trees.

- **Do:** register your own native modules first in `Application.onCreate`, before `ZnTemplates.preload` and
  `ZnRuntime.evalAsset`. **Why:** the app decides which bundle to run when those start, and a downloaded bundle
  that needs your module is checked against the modules registered by then (debug builds stop with an error if
  you register later).
- **Do:** write native module names as plain strings: `nativeModule("Device", { version: 2 })`. **Why:** the
  build reads them to list what the bundle needs; a name in a variable is a build error. Raise `version` (on both
  sides) when JS starts using a new native method, so older apps don't get a bundle that calls it.

---

## 25. Formatting numbers, money and dates (`Intl`, works since 2026-10-30)
- **Do:** make each formatter once, at module level, and reuse it:
  ```ts
  const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
  rupees.format(125000) // "₹1,25,000"
  ```
- **Don't:** call `amount.toLocaleString("en-IN")` or `new Intl.NumberFormat(...)` in a list row or on every change.
- **Why:** each `toLocaleString` call builds a new formatter through Java: **~2 ms** per call on the Lava. A reused
  formatter takes **0.004 ms**. Fifty rows formatted the slow way is ~100 ms of jank. (Step 3.9 makes
  `toLocaleString` cache its formatters, so this trap goes away; reusing a formatter stays the clearest code.)
- What works (checked on the Lava): Indian grouping (`1,25,000`), `₹` currency, compact lakh (`12L`), `30 Oct 2026`,
  `2:35 pm`, the phone's time zone. Dates show in the phone's time zone; pass `timeZone: "Asia/Kolkata"` for
  receipts that must always show Indian time.

---

## 26. When your code breaks (step 3.9)
What users see, and what you can do:
| What fails | What happens |
|---|---|
| A screen throws while it is built | It stays on the stack and shows the error screen: **Try again** builds it again, **Go back** works (on the first screen: Try again only) |
| A part of a screen throws (a child component, an `&&` block, a list row) | Only that part stays empty; the rest of the screen works |
| A tap handler, timer, effect or listener throws | Nothing changes on screen; it is reported |
| An `async` function or a Promise rejects and nothing catches it | Reported (after ~100 ms for TypeError / ReferenceError / RangeError, ~2 s for others) |
| JS runs too long (an endless loop) | Stopped after the time limit (2 s; 3 s in debug builds); the top screen shows "stopped responding" with Try again. Anything over 200 ms is logged as "slow JS" |
| The app's JS fails at start | Every screen shows "The app couldn't start" with **Restart app** |
Every one of these is logged, shown on the red screen in debug builds, and passed to your error handlers.

- **Do:** send errors somewhere you can see them. In JS: `onError((error, info) => ...)` (`info.kind`, `info.where`,
  `info.screen`). In Kotlin, for Crashlytics: `ZnRuntime.onJsError = { e -> ... }` (`e.kind`, `e.where`, `e.screen`,
  and `e.bundle`, the running OTA bundle). Both get every case in the table above; `kind` says which (screen,
  part, async, handler; Kotlin also hang, start, renderer). Keep handlers short; an error inside one is only logged.
- **Do:** set the error screen's words in your users' language: `ZnErrorScreen.texts = ZnErrorScreen.Texts(...)`,
  and your colours with `ZnErrorScreen.colors`, in Application.onCreate.
- **Do:** add the lines that bring screens back after Android kills the app in the background, in your Activity:
  `ZnNav.start(bundle, link, savedInstanceState)` in `onCreate`, `ZnNav.saveState(outState)` in
  `onSaveInstanceState`, and `ZnNav.openLink(link)` in `onNewIntent` (not `start`: `start` means a new Activity).
- **Do:** use `android:launchMode="singleTop"` if your app opens another app for a result (a payment app, a document
  picker), and start `onCreate` with `super.onCreate(...)`, then `if (ZnNav.handleExtraActivity(this, savedInstanceState)) { finish(); return }`.
  **Why:** `singleTask` closes the other app when the user taps your icon, so a payment looks cancelled. With `singleTop`
  a link can make a second Activity while the other app is on top; without this line it would restart your JS.
- **Do:** pass `onLink` to `startApp(routes, { onLink })` if a link must not interrupt something: return false to
  refuse it, for example while a payment is open. It gets `{ route, params, url }`; `params` has path and query values.
  **Don't** trust those values: a link is outside input. `onLink` isn't called for the link that started the app.
  Mark screens that must never reopen on their own with `restore: false` in `routes.ts` (a "payment done" screen).
  Screens come back with their route params; their signals start fresh, except `restorableSignal` (§26.1). Keep what
  must survive a normal close too in `storage` or `flowStore`.
- **What to expect when the user swipes the app away from recents:** the next open starts fresh on the start screen,
  on every phone. Some phones (the Lava) keep the process alive after the swipe; zero-native then starts a new JS
  runtime itself, the same as a new launch (module-level JS state is gone too, as on a real restart). A rotation or
  dark-mode change keeps the screens and their state.
- **Don't:** rely on the error screen for flows that move money. A payment screen that fails to build must not leave
  the payment unknown: keep the save-then-verify pattern (§16), which works whatever the UI does.
- **Don't:** do heavy work in one go on the JS thread (parsing a huge file, a long loop). Taps wait while it runs
  (scrolling and animations don't), over 200 ms it is logged as "slow JS", and past the time limit it is stopped.
  Split it up, or do it in a native module. What to do with big data: §27. Change the limit with `ZnRuntime.jsTimeLimitMs` (0 = none), for example
  while pausing in a debugger.
- **Why:** one broken screen should never take the whole app down (React Native's default), and Back must always
  work. The framework reports and shows the fallback; anything more (restarting after repeated hangs, reporting) is
  the app's choice.

### 26.1 Values that survive Android killing the app: `restorableSignal`
**What it does.** Users leave the app mid-task (to check the balance in the UPI app, to copy an OTP). Low-end phones
often kill the app meanwhile. When the user comes back, the screen opens again (above), and a `restorableSignal`
gets back the value it had:
```ts
const amount = restorableSignal("amount", "0")   // like signal("0"); "amount" names it on this screen
const tab = restorableSignal("tab", "upi")
```
- **Do:** use it for what the user typed or picked on this screen and would be annoyed to lose: the amount on a
  keypad, a half-filled form, the selected tab, a search box. Call it in the screen's components (also in a part
  shown later); each key once per screen.
- **Do:** keep values small and plain: strings, numbers, booleans, arrays, plain objects (at most 4,000 chars as
  JSON each). A bigger or non-JSON value isn't kept (one warning in the log). A `Date` comes back as a string.
- **Don't:** use it for things that must last past the app being closed normally (a swipe from recents, a phone
  restart): that is `persistedSignal` / `storage`. And never for payment state: `flowStore` (§16) is the source of
  truth there; `restorableSignal` is only for comfort.
- **Don't:** put secrets in it (an OTP, a PIN, a card number): Android writes saved state to disk while the app is
  killed.
- **What to expect:** values come back only into the same bundle that saved them. If an OTA update was installed in
  between, the screen opens fresh (the new code might read the old value wrong). A value comes back once: a part
  hidden and shown again later starts from its initial value, like `signal`.
- **Why:** a user who typed ₹2,450 and went to check the balance should come back to ₹2,450, not 0. Android keeps
  the saved state only for this kind of "the system killed it" return; nothing is kept on a fresh launch.

---

## 27. Long JS work: the time limit, "slow JS" and big downloads (step 3.9)
**How it works.** JS runs on its own thread. While one piece of JS runs (a tap handler, a timer, a native answer,
building a screen, and the `await` / `.then` callbacks that follow it in the same turn), the UI still scrolls,
animates and goes back, but **taps wait**. So:
- **Over 200 ms:** logged as `slow JS: <what> ran for N ms` (debug and release). Users start to feel taps lag.
  Fix it before it ships.
- **Over the time limit** (2 s release, 3 s debug; `ZnRuntime.jsTimeLimitMs`): stopped. The top screen shows
  "stopped responding" with Try again, and it is reported as a hang. This is a bug catcher for endless loops and
  stuck code, not a speed target: correct code never gets near it.

**Measured on the Lava (release):** `JSON.parse` of 0.4 MB takes ~10 ms, 3.7 MB 37 ms, 15 MB ~190 ms. Walking the
parsed rows is a few ms. So parsing a big download is not the problem; doing heavy work on every row in one go
is (and memory: 15 MB of JSON becomes many times that as JS objects). On a phone 4× slower than the Lava, 15 MB
still parses in under 1 s.

**When you have a lot of data:**
1. **Don't send it.** The best fix is on the server: pages (`?after=…&limit=50`), only the fields the screen shows,
   a summary instead of every row. A phone on a 3G-like network takes far longer to download 15 MB than to parse it.
2. **Show it with `<List>`**, never `.map` over thousands of rows (docs/lists.md): rows are built only near the
   screen.
3. **Split heavy work into turns.** Process a few hundred rows, then let taps run, then go on:
   ```ts
   const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
   for (let i = 0; i < rows.length; i += 500) {
     rows.slice(i, i + 500).forEach(addToIndex)
     await nextTurn() // a new JS task: taps run here, and the time limit starts again
   }
   ```
   **Use `setTimeout`, not `await Promise.resolve()` or `queueMicrotask`:** those callbacks run in the **same** task
   (before any tap), so they neither let taps through nor restart the time limit.
4. **Ask for less at once:** JSON Lines from the server (one record per line) lets you parse and process line by line
   across turns, as in 3.
5. **Very large or binary data: keep it out of JS.** Write a native module that downloads, parses and stores it
   (SQLite, files, `storage`) on a background thread and returns only what the screen needs (counts, one page). JS
   has no worker threads in zero-native (one runtime per app), so native is the place for bulk work.
   **Photos, video, camera frames, PDFs: never as bytes through JS.** A native module keeps the object and gives JS a
   short handle (`zn://file/kyc/front-01.jpg`, ARCHITECTURE §15.4); `<Image src>` and uploads take the handle. A
   4K photo is ~12 MB of pixels; copying it into JS and back costs far more than any JSON, and memory too.
6. **Only if you really must** (for example a slow, correct import on very old phones): raise
   `ZnRuntime.jsTimeLimitMs` for the whole app. Prefer 1–5, which fix the cause.

- **Don't:** treat "slow JS" lines as noise. Each one is a moment when the user's taps waited.
- **Why:** keeping each piece of JS short is what keeps taps instant. The 200 ms warning shows problems in
  development; the time limit makes sure a bug can't leave the app looking frozen forever.

---

## 28. Releasing an OTA update (step 4.3; phones download them from step 4.5)
```
bun run ota keygen                                   once: a key pair; put the public key in the app
bun run ota build                                    builds and releases a bundle (#N); never publishes
bun run ota publish --channel staging --bundle N     staging phones get it; test it there
bun run ota stable --bundle N                        after testing on staging
bun run ota publish --channel production --bundle N --rollout 10     asks you to type PRODUCTION #N
bun run ota rollout --channel production --percent 100
bun run ota publish --channel production --bundle M --rollout 100    rollback: point back at an older bundle
bun run ota kill --channel production --reason "..."                  everyone back to the APK's own bundle
bun run ota serve                                    the reference update server over the local store (port 8790)
```
- **Do:** keep the private key outside the repo (`~/.zero-native/keys/`, the default) and make a **backup** key
  too (`keygen --name backup`), kept offline. The app trusts both; if the main key is lost or leaks, the backup
  key still signs, and the next store release can carry a new pair.
- **Do:** commit before `bun run ota build` for anything going to production: bundles built from uncommitted
  changes can only go to staging.
- **Do:** start production with a small rollout and raise it; `status` shows what each channel serves. Roll
  **back** at 100 %: the rollout applies to rollbacks too, and a phone outside it keeps the bad bundle.
- **Do:** turn updates on in Application.onCreate, before `ZnTemplates.preload`:
  `ZnOta.configure(this, ZnOta.Config(server = "https://updates.example.com", channel = "production",
  publicKeys = listOf(MAIN_KEY, BACKUP_KEY)))`. Checks run by themselves when the app comes on screen; a new bundle
  runs from the next cold start (or now, with `Updates.applyNow()`, below). Show progress or check on demand with `Updates.status()`, `Updates.check()`,
  `Updates.onStatus()` (see the sample's `/dev/updates` screen).
- **Don't:** check on a timer or in a background job: checks follow the UI on purpose (no data or battery spent when
  nobody opens the app).
- **Do:** apply an installed update at a calm moment with `Updates.applyNow()`: the user back on the home screen,
  after login, or after they tapped "Update now" on a banner you show when `status().pendingRestart` is true. The JS
  restarts in place on the new bundle in well under a second, behind a cover; the open screens open again by route
  and params.
  ```tsx
  const s = await Updates.status()
  if (s.pendingRestart && nav.current()?.name === "home") await Updates.applyNow() // settles only if nothing was applied
  ```
- **Do:** hold updates while something must not be cut: `const release = Updates.holdApply()` when a payment or a
  long form starts, `release()` when it ends. Called while a screen builds, it also ends when that screen closes.
  While any hold is open, `applyNow()` answers `{ applied: false, reason: "held" }`.
- **Don't:** call `applyNow()` in the middle of a flow, or right after starting a payment: every screen's JS state
  starts fresh (signals, timers, running `fetch` calls are dropped). Keep what must survive in storage or FlowStore,
  and read it back when the screen builds, like after Android restored the app.
- **Don't:** count on code after `await Updates.applyNow()` running: when it applies, that JS is gone.
- **Why:** customers open the app once or twice a month, so "next cold start" alone brings fixes weeks late (ZeroBill's
  RN OTA learned this). Applying in place at moments the app picks is fast; holds keep it away from money moments.
- **Do:** serve the store with `bun run ota serve` (or your own backend speaking the same `POST /v1/check`,
  docs/ota.md §3.4). The zips are plain immutable files, so a CDN can serve them; the check must stay a server.
- **Don't:** delete or edit files in the store by hand. Every record is written once; the phone keeps the highest
  seq it accepted, so a deleted or rewritten pointer can leave phones ignoring the channel.
- **Why:** the same rules as ZeroBill's RN OTA v2, which came from real incidents: staging first, then stable, then a
  typed confirmation; one bundle = one serial = one SHA; rollback and the kill switch are just signed pointers.

### When an update is bad: the safety nets (step 4.7, docs/ota.md §3.6)
- **What happens by itself:** a new bundle is on trial until it is *healthy* (its first screens up 4 s in the
  foreground). If it shows an error screen, hangs, or never shows its first screen (10 s) during the trial, the phone
  blocks it and goes back to the last healthy bundle at once, in place. If it crashes the app during the trial, it is
  blocked and the next start runs the last healthy one (one crash on Android 11+; two in 24 h on older phones or after
  an ANR). After the trial it is still watched: three crashes in 24 h block the phone's last healthy bundle, even if
  each was on return from another app. A blocked bundle never runs on that phone again: ship
  the fix as a **new** bundle (`bun run ota build`), don't publish the same one again. Once a bundle was healthy on a
  phone, its later error screens are only reported (you still see them in `onReport` and `ota status`), never blocked:
  fix those with a new bundle too.
- **Do:** call `Updates.markHealthy()` once the first screen has really loaded (its data is on screen), if that can
  take longer than 4 s, or set `ZnOta.Config(healthyAfterMs = 0)` and always call it. Mark it after the data
  arrived, not when the request started.
  ```ts
  const offers = await fetchOffers()
  feed.set(offers)
  void Updates.markHealthy() // this bundle works on this phone
  ```
- **Don't:** call `markHealthy()` at the top of `main.ts`: it turns the safety net off for that bundle.
- **Do:** send the reports somewhere you read: `ZnOta.Config(onReport = { r -> ... })` gets every outcome on the main
  thread (`kind`, `bundle`, `detail`, `serious`). Log serious ones to Crashlytics (`recordException`), the rest as
  breadcrumbs. They also reach the update server; `bun run ota status` shows what phones reported per bundle.
- **Don't:** keep a debugger paused, or `debug.zn.js_delay_ms` above 10 s, on a downloaded bundle: the first-screen
  rule rolls it back. Test such things on the APK's own bundle (never judged), or set `firstScreenTimeoutMs = 0`.
- **Why:** a bad update is worse than a missing one: customers can't fix it themselves and won't come back for weeks.
  The trial window is short so a good bundle quickly stops being judged (later errors are only reported), and going
  back to the last *healthy* bundle keeps the fixes users already had (the RN app went back to the APK's bundle).

### Saved data across updates and rollbacks (step 4.9)
- **What happens:** `storage`, `SecureStore`, `flowStore` and files are never touched by an update. So a new bundle
  reads what the old one wrote, and after a rollback (a safety net, `ota publish` of an older bundle, the kill switch)
  an **older** bundle reads what the newer one wrote.
- **Do:** change saved formats only by adding: new keys or new optional fields. Read with a default for anything
  missing. If a format must really change, write it under a new key (`cart.v2`) and keep the old key readable until
  every bundle that reads it is gone.
  ```ts
  const prefs = JSON.parse(storage.getString("prefs") ?? "{}") as { lang?: string; sound?: boolean }
  const sound = prefs.sound ?? true // an older bundle wrote no `sound`
  ```
- **Don't:** rename or delete a key, change a field's type, or make a field required in an update. The bundle before
  it (still on many phones, and where a rollback goes) can't read it, and a screen that throws while it builds on the
  first launch rolls the update back on every phone.
- **Do:** keep payment flow state (`flowStore`) readable by the bundle before and after. A cold start can run a new
  bundle while a payment saved by the old one is still open: that screen must still open and finish it.
- **Why:** an update is never alone on the phone: the APK's own bundle, the last good one and the new one all read the
  same storage, in any order.

### When the phone is full (step 4.9)
- **What happens:** before a download the phone needs room for the zip, ~4× its size unzipped, and 50 MB kept free for
  the user. Without it nothing is written (outcome `no_space`) and the next check tries again; the app runs on with
  what it has. If the phone fills up during the download, the half-written files are removed at once.
- **Do:** keep bundles small (images compressed, no unused assets): every MB counts on low-end phones.
- **Why:** an update must never be the reason a user can't take a photo or receive an OTP.

### Finding the TSX line of a release crash (step 4.8, docs/ota.md §3.7)
- **Do:** wire Crashlytics once in your `Application`:
  ```kotlin
  ZnRuntime.onJsError = { e ->
      FirebaseCrashlytics.getInstance().log(e.details)           // the full JS stack, with columns
      FirebaseCrashlytics.getInstance().recordException(e.asThrowable())
  }
  ZnBundles.watchRunning { FirebaseCrashlytics.getInstance().setCustomKey("zn_bundle", it) }
  ```
  Every report then names the bundle (`sample_8@1a2b3c4d5e6f`), native crashes too.
- **Don't:** send `e.details` anywhere private data can't go. `onJsError` gets the raw error text. Only what goes to your
  update server is masked first (phone numbers, VPAs, URL query strings, bearer tokens). **Why:** an error message can
  hold whatever your code put in it. Keep private values out of your own `throw new Error(...)` too.
- **Do:** set `ZnOta.Config(redact = { ... })` if your app has private data the built-in masks can't know the shape of,
  such as your own customer ids. It runs after them, on the update server's copy only.
- **Do:** run `bun run ota keep-map` from the same commit every time you build an APK for release. The APK's own bundle
  is not released with `ota build`, so without this its traces can't be mapped. Released bundles keep their maps by
  themselves.
- **Do:** paste a trace (from logcat, Crashlytics or your backend) into `bun run ota symbolicate`, or give a file. It
  finds the bundle label in the text; else add `--bundle <id or SHA>`. `--from-telemetry` shows the last stacks phones
  sent with a rollback or an error screen.
- **Don't:** build the APK's bundle from uncommitted changes and keep-map later from a clean checkout: one changed
  byte gives another SHA, and the map won't be found. Same source gives the same bytes on any machine and folder.
- **Don't:** strip the line positions to save bytes (hermesc `-g0`): release traces would lose the main.js lines.
- **Why:** release bytecode only knows main.js lines. The map is the only way back to your TSX, and the bundle label
  (with its SHA, since the APK's bundle is `_0` in every APK) tells which map to use.

---

## Open items to write up when built
- `<List>` rails, carousel, impressions (steps 2.4b–d). See
  `docs/cross-communication/2026-10-29-feeds-and-lists-proposal.md`.
- Sheets (2.5), native calls / `fetch` (2.6), flows and payments (2.7–2.8): the "effects" rules are the most important
  thing to teach well. (Sheets, native calls and FlowStore with the payment pattern are now written up in sections
  12, 13 and 16; the flow engine is parked.)

## 29. Knowing when the user comes back (H.7)
```tsx
import { appState, onAppState } from "@zero-native/core"

onAppState((state) => {
  if (state === "active") checkPaymentStatus()
})
```
- **Do:** use `onAppState` to act when the user returns from another app, even if that app sent no result (they may have
  left it with the Home button). Set inside a screen, it stops by itself when the screen closes. Elsewhere, call the
  function it returns.
- **Don't:** expect a call when the app starts: it hears changes only. Read `appState()` for the state now.
- **Don't:** rely on seeing `"background"` first. Act on `"active"`.
- **Know:** `"background"` means the user can't touch the app, not that it is out of sight. A see-through payment window
  or a permission dialog counts. **Why:** Android pauses the app for these without stopping it, and the user still came
  back. JS keeps running in the background; don't use this to stop timers that must go on.
- **Don't:** do heavy work on every `"active"`. It also fires after a permission dialog.
- Needs host API 5: a bundle built with this core won't run on an app with an older native side.
