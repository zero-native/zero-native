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

---

## Open items to write up when built
- `<List>` rails, carousel, impressions (steps 2.4b–d). See
  `docs/cross-communication/2026-10-29-feeds-and-lists-proposal.md`.
- Sheets (2.5), native calls / `fetch` (2.6), flows and payments (2.7–2.8): the "effects" rules are the most important
  thing to teach well. (Sheets, native calls and FlowStore with the payment pattern are now written up in sections
  12, 13 and 16; the flow engine is parked.)
