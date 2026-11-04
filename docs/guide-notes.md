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
- **Handlers work as in React Native:** a wrapper may pass a handler through (`onPress={props.onPress}`) or switch it
  (`onPress={busy() ? undefined : pay}`). The tap runs the handler the prop holds at that moment; with none, the tap
  does nothing. (Before 2026-11-03 the handler was read once, when the element appeared, and an undefined one threw.)
  Long press too, as in RN (registry 14): while `onLongPress` holds no handler (`onLongPress={props.onLongPress}` in a
  wrapper, with none passed), a long hold is a normal tap and gives `onPress`. (Before registry 14 it gave nothing.)
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
- Call it in a component body: the screen's, or a part shown later (a tab, a `cond && <X/>` branch). Not in a callback.
  It stops when that part goes. Only the top screen is asked.
- A screen can have several handlers: the newest is asked first, then the older ones. So a tab's "close my sheet"
  runs before the tabs' "go to the first tab" (§40).
- Make your on-screen ← button do the same thing (`if (!handler()) nav.back()`), so both behave alike.
- The last screen's back goes to the system (the app moves to the background); `useBack` isn't asked there. The one
  exception is tabs on a tab other than the first: then Back goes to the first tab (§40).

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
- Heavy native things (app icons, camera photos) go by **handle** (`zn://...`, §33), never as Base64 through JS.

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
- **Do:** read arguments with the typed helpers: `call.string("uri")`, `call.intOrNull("limit") ?: 20`. A wrong or
  missing value rejects the call with `invalid_args` and names the field. See §30.
- **A module to share across apps** goes in a plugin (§30). `ZnModules.register` stays for an app's own module.

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

**Loops, keyframes and delays (registry 11):**
```tsx
<Box animate={{ rotate: { duration: 900, easing: "linear", from: 0, repeat: "forever" } }} style={{ transform: [{ rotate: 360 }] }} />
<Box animate={{ scale: { duration: 700, keyframes: [1, 1.06, 1], repeat: "forever", repeatDelay: 1200 } }} paused={paused()} />
<Box replay={wrongTries()} animate={{ translateX: { duration: 400, keyframes: [0, -8, 8, -6, 6, 0] } }} />
{rows().map((r, i) => <Row key={r.id} enter={{ ...FADE_UP, delay: i * 40 }} />)}
```
- **Do:** give one prop a timing object with `from` (plays from it to the style value) or `keyframes`; it plays by itself when the
  element appears. `repeat` is how many plays in all (`2` = twice) or `"forever"`; `reverse` plays every second one backwards;
  `repeatDelay` waits between plays; `delay` waits before it starts. `easing` takes a cubic-bezier `[x1, y1, x2, y2]` too.
- **Do:** `paused={...}` stops an element's loops where they are; a new `replay={n}` number plays them again (a shake on a wrong OTP).
- **Know:** keep the style value as the "rest" value. With Android's "Remove animations" on, that is what shows and nothing loops.
  **Why:** some people get dizzy from motion; the rest value must make sense on its own.
- **Don't:** put loop options on the all-props form (`animate={{ duration: 900, repeat: 3 }}`): the build says to give them one prop.
- **Don't:** loop big things for long: a forever loop redraws every frame. Spinners and small pulses are fine; keep the big moment for success.
- **Why:** these are the names CSS, Compose and Reanimated use (`iteration-count`, `alternate`, `withRepeat`, `withDelay`), so they
  carry over. The clock runs natively, so a loop costs JS nothing.

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
  **Don't** trust those values: a link is outside input. `onLink` is also called for the link that started the app (`atStart: true`); refused, the user stays on the start screen.
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

## 30. Writing a plugin (P.1)
A plugin adds a native feature: a TS API plus an Android library, in one package. Copy `plugins/device-test`, the
smallest full plugin. Native views and native screens come later (`docs/plugins.md`).
```
plugins/my-plugin/
  package.json     name, "main": "src/index.ts", peerDependencies on @zero-native/core
  src/index.ts     nativeModule<MyModule>("My", { version: 1 })
  test/            JS tests with core's fake host
  android/         a Gradle library that depends on project(":runtime")
```
```kotlin
class MyPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.requireHostApi(5) // only if you need something newer than the first host API
        r.module(MyModule(r.context))
    }
}

class MyModule(context: Context) : ZnModuleBase("My", version = 1) {
    init {
        function("open") { call ->
            val uri = call.string("uri")               // rejects with invalid_args if missing or not a string
            val limit = call.intOrNull("limit") ?: 20  // optional
            call.resolve(...)
        }
    }
}
```
To add it to an app:
1. `package.json`: add the package.
2. `android/settings.gradle.kts`: `include(":plugin-my")` and set its `projectDir`.
3. The app's `build.gradle.kts`: `implementation(project(":plugin-my"))`.
4. `Application.onCreate`, first thing: `ZnPlugins.register(this, MyPlugin())`.

- **Do:** call `ZnPlugins.register` before `ZnTemplates.preload` and `ZnRuntime.start`. **Why:** the OTA check compares the
  modules registered by then with what a downloaded bundle needs. Too late fails in debug builds.
- **Don't:** do work in `register`: no disk, no network, no heavy objects. **Why:** it runs on the main thread during app
  start, and every plugin adds to that.
- **Don't:** use a module name that is taken. A plugin can't replace `Fetch` or another plugin's module.
- **Do:** read arguments first, at the top of the function. **Why:** a wrong argument only rejects the call if it is read on
  the function's own thread. On another thread, the exception is not caught there.
- **Know the type rules:** `call.string` refuses a number, `call.int` refuses `1.5` and numbers outside the int range,
  `call.long` refuses numbers JS can't hold exactly. A JS `null` counts as missing.
- **Know what ships how:** `src/` ships in OTA bundles. `android/` ships only in a new APK. So when native gains a function,
  raise the version in Kotlin and in `nativeModule(...)` together: an older app then refuses the bundle, safely.
- **Know what a failed plugin does:** a debug build stops at once and says why. A release build logs it, skips that plugin
  and still starts. Its module is then missing: calls reject with `unavailable`, and updates that need it are refused.
  **Why:** one optional feature shouldn't stop people from opening the app (`docs/second-opinions.md` entry 10).

## 31. Opening another app and getting its result (P.2)
Only Kotlin opens another app: a plugin builds the Intent, JS calls the plugin. JS can't open any app with any data.
```kotlin
// In a plugin's module. Main thread. The app's Activity needs ZnActivity.attach(this) in onCreate.
function("pay", onMain = true) { call ->
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(call.string("link"))).setPackage(call.string("app"))
    call.resolve(ZnLaunch.start("upi", call.string("id"), intent).toJson())
}
```
```ts
flowStore.write("payment", { id, status: "started" })         // 1. save first
const { launched, reason } = await Upi.pay({ id, link, app })  // 2. open the app
if (!launched) showError(reason)                               //    it didn't open: nothing can have happened

launches.onResult("upi", async (r) => {                        // 3. a result, even after a kill
  await verifyWithServer(r.id)                                 // 4. the server decides
  await launches.ack("upi", r.id)                              // 5. only now
})
```
- **Do:** give each launch your own id (a txn ref), and save your flow before you launch. **Why:** a kill can come at any
  moment, and the id tells a repeat from a new payment.
- **Do:** use a new id for each try, also a retry of the same payment: add the time to the ref. **Why:** `onResult` drops a
  record it has seen, so a retry with the same id looks like a repeat, and its result never arrives.
- **Know:** extras keep text, booleans, ints and normal doubles. Anything else arrives as text (a long keeps every digit). An
  extra that can't be read is skipped, and the result code always arrives.
- **Do:** call `ack` after you have acted on the result. **Why:** until then the result comes again at every start, so a kill
  or a rollback can't lose it.
- **Expect repeats.** Your handler must be safe to run twice for one id.
- **Do:** read `launches.pending("upi")` while a restored screen is built. It's a sync read, and it's already right: the app's
  first screen waits for Android's answer, so it never says `waiting` when a result exists.
- **Don't:** trust the result. It comes from another app, so it's outside input. It only says when to ask your server.
- **Do:** handle `lost`. It means no result came: the user swiped the app away, or Android dropped our screen while a
  see-through window was on top. Ask your server. A late result can still follow it.
- **Know why a launch is refused:** `no_app` (not installed), `no_activity`, `no_storage`, `busy` (one launch at a time),
  `unacked` (this key has a result you haven't acked: `ack` it first, usually at the start of a new payment).
- **Know:** while a launch waits, a link doesn't restart JS or bring your app forward, and `Updates.applyNow` answers `held`.
- **Why a host must attach:** Android drops a result for a launcher registered too late. `ZnActivity.attach(this)` goes
  right after `ZnNav.handleExtraActivity` in `onCreate`.

## 32. Permissions (P.2)
```ts
const { camera } = await Permissions.request(["camera"])
if (camera === "blocked") Os.openSettings()
```
- Each permission must be in a manifest (a plugin's own counts). If not, the call fails with `not_declared`.
- **Do:** list what you use in the app's `AndroidManifest.xml`. A plugin's manifest already brings its own (the scanner
  brings the camera, `@zero-native/location` both location lines), so with a plugin you add nothing.
  ```xml
  <uses-permission android:name="android.permission.CAMERA" />                <!-- "camera" -->
  <uses-permission android:name="android.permission.READ_CONTACTS" />         <!-- "contacts" -->
  <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />  <!-- "location": both lines, -->
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" /><!-- or only this one for "approximate only" -->
  <uses-permission android:name="android.permission.RECORD_AUDIO" />          <!-- "microphone" -->
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />    <!-- "notifications" -->
  ```
  **Why not built in:** the runtime lists none of these, on purpose. Google Play asks every app that lists a permission
  why it needs it, and some (location, contacts) need a form. An app gets only what it uses.
- **Know:** `location` with only the precise line fails with `not_declared` (for `ACCESS_COARSE_LOCATION`), as Android
  12+ would show no dialog at all.
- **Know the states:** `granted`; `denied` (you can ask again); `blocked` (Android won't show the dialog again).
- **Do:** ask at the moment the user needs the feature, and explain why first if it isn't obvious.
- **Don't:** ask again right after `denied`. Android turns a second "no" into `blocked`.
- **Know:** closing the dialog with no answer stays `denied`, not `blocked`. `status` shows `denied` for a permission never asked for.
- **`location`** asks for precise and approximate together, and is `granted` if the user gave either. `"location.precise"`
  in the answer says if precise was given too. **Why:** Android 12+ ignores a request for precise alone, and the user
  may pick "approximate". For fixes, prefer `@zero-native/location` (§45): it answers `{ permission, precise }`.
  (Changed 2026-11-04; before, `location` asked for precise only.)
- Errors: `busy` (a request is open), `no_activity`, `not_declared`.

## 33. Small native helpers (P.2)
```ts
const stop = detached((stop) => { setInterval(checkPayment, 3000) })  // goes on after the screen closes
await Os.haptic("success")                                            // light, medium, success, error
await Os.openUrl("https://example.com/help")
```
```tsx
<Image src="zn://app-icon/com.example.app" style={{ width: 48, height: 48 }} />
```
- **`detached`: do** use it for work that must outlive a screen on purpose, like a payment check. **Don't** use it for
  screen work: normal timers stop with their screen. It ends with `stop()` or when the JS runtime is replaced, so keep the
  state in `flowStore`, not in memory.
- **`detached`: know** code after an `await` has no owner, as everywhere, so `stop()` doesn't reach timers started there.
  Check a flag in that code.
- **`Os.openUrl`** opens only http, https, mailto and tel; anything else fails with `not_allowed`. **Why:** a bundle sent over
  OTA must not be able to open a payment link. Payment apps go through a plugin.
- **`Os`:** `info()` gives the app version and phone; `openSettings()` opens the app's page; `share({ text })` opens the share
  sheet. `no_app`: nothing on the phone can open it.
- **`zn://` handles** are short strings for native images: the pixels never enter JS. `zn://app-icon/<package>` is built.
  On Android 11+, list the package in `<queries>` or the image fails. Add `fallback`. A plugin adds its own kind with
  `ZnHandles.kind("name") { context, path -> drawable }`; that code runs off the main thread.
- **Plugins:** `r.activityEvents(listener)` hears new intents, front and back, low memory and new JS. Keep each one short.

## 34. An app outside this repo (P.3)
zero-native isn't published yet, so an app points at a local copy. The first real one worked with no change to the runtime.
Layout, in the app's repo:
```
app/src/main.ts      the app's JS entry, with routes and screens
plugins/<name>/      the app's own plugins: src/index.ts, android/
android/             settings.gradle.kts, build.gradle.kts, app/ (the host)
```
**Android.** Use a composite build, in `android/settings.gradle.kts`:
```kotlin
val zeroNativeDir = providers.gradleProperty("zeroNativeDir").getOrElse("../../zero-native")
includeBuild("$zeroNativeDir/android") {
    dependencySubstitution {
        substitute(module("dev.zeronative:runtime")).using(project(":runtime"))
    }
}
include(":app")
include(":plugin-mine")
project(":plugin-mine").projectDir = file("../plugins/mine/android")
```
The app and each plugin then ask for `implementation("dev.zeronative:runtime")`. Copy the wrapper, `gradle.properties` and the
plugin versions from this repo's `android/`: **do** keep them equal to the framework's.

**JS.** Link the packages once on each computer, then depend on them:
```bash
bun link --cwd <zero-native>/packages/core
bun link --cwd <zero-native>/packages/ui
```
```json
"dependencies": { "@zero-native/core": "link:@zero-native/core", "@zero-native/ui": "link:@zero-native/ui" },
"scripts": { "app:js": "bun run <zero-native>/tools/zn-build.ts app --name myapp --assets android/app/src/main/assets" }
```
`--name` becomes the bundle's app name; keep it the same as the OTA `app` name. **[check]** `bun run tools/zn-dev.ts <appDir>` should give
live reload, but it isn't tried from an outside app yet, and the host needs the sample's cleartext rule for `127.0.0.1`.

**Host.** Start from `android/sample`, without its test hooks:
- The `Application` calls `ZnPlugins.register(this, MyPlugin())` first, then `ZnTemplates.preload`, `ZnRuntime.start`, `ZnRuntime.evalAsset`.
  `ZnOta.configure` is optional: with no call, updates are off and the APK's bundle runs.
- The Activity is a `ComponentActivity`, `singleTop`, calling `ZnNav.handleExtraActivity`, then `ZnActivity.attach(this)`.
- Keep `noCompress += listOf("hbc", "zn.ui")`, and gitignore `src/main/assets`.

**Plugins an app owns.** The same as `docs/plugins.md`: no list to join, no change in this repo. The compiler reads the plugin's
`nativeModule` call, so the bundle's needs include it. A plugin's `<queries>` reach the app through the manifest merge.

**Do** turn on R8 name changes in your release build when you are ready for it. **Why:** the sample turns them off to keep its traces
readable, so an app is what tests them. They passed in the first outside app, launches and results included.

**Emulator.** The runtime's debug build has x86_64 too (2026-11-03). To run your app on an x86_64 emulator, add it to the app's debug
build only:
```kotlin
buildTypes { debug { ndk { abiFilters += listOf("x86_64") } } }
```
**Don't** add x86_64 to release. **Why:** release apps are for phones, which are arm64, and x86_64 would add 7–13 MB of native
libraries to the APK (the sample's debug APK: 13 MB, ML Kit included). With a phone and an emulator both on adb, set `ANDROID_SERIAL` to pick one; the phone scripts (`tools/plugin-phone.ts`,
`bun run ota:phone`) use it. **Know:** an emulator has no torch, a different dialer and no MediaTek DuraSpeed. A pass there doesn't replace
the phone for camera, SMS, phone number hint, UPI apps or timing numbers.

## 35. Native screens, native views and files (P.3b)

**A native screen** is a route drawn by a plugin. It sits in the normal back stack, so Back, transitions, safe areas and `restore`
work as for any route.

```ts
scan: { path: "/scan", native: "scanner.full" },                       // routes.ts: no `screen`
const answer = await nav.pushForResult<{ value: string }>("scan", { title: "Pay" })   // null if the user went back
onNavResult<{ value: string }>("scan", (value, ack) => { use(value); ack() })         // in main.ts: after a kill
```
```kotlin
r.screen("scanner.full") { scope -> ScannerScreen(scope) }             // scope.params, scope.finish(json), scope.cancel()
```

**Do** add `onNavResult` in `main.ts` when the answer matters after a kill. **Why:** the promise lives in JS, so a kill loses it. The
answer is on disk before JS hears it, and it stays until `ack`. With a promise waiting, only the promise hears it, so one answer never runs
twice.
**Do** expect null. Back, `nav.back()` and `nav.reset()` all give null, so an `await` never hangs.
**Don't** use `pushForResult` on a normal screen: it refuses, as a zn screen has no way to answer.
**Don't** call `finish` twice and rely on the second. Only the first counts: that is what makes a double scan safe.

**A native view** is a plugin's composable inside a screen.

```tsx
<NativeView name="device.fake-view" props={{ label: label() }} onEvent={(e) => log(e.name, e.data)} style={{ height: 60 }} />
```
```kotlin
r.view("device.fake-view") { scope -> Fake(scope) }                    // scope.props (redraws on change), scope.emit(name, data), scope.id
```

- `name` must be a string literal, `"<plugin>.<name>"`. **The build fails** if no code uses that plugin's `nativeModule`. **Why:** the module
  puts the plugin in the bundle's needs, so an app without it never runs the bundle, and the "unknown name" empty box can't reach a phone.
- Apps normally use the plugin's own wrapper component, not `NativeView`.
- `props` go as JSON text, so only a real change reaches the view. Keep them small and plain. Big data goes by handle.
- **Give it a size in `style`.** It takes no children. `style` must be known at build time, so a wrapper can't pass `props.style` through: put the wrapper
  in a sized parent. **Why:** styles fold into the template; only the props in `DynamicProps` can change.
- **Do** use Compose's `LocalLifecycleOwner` for a camera. **Why:** it stops by itself when the screen is covered or the app leaves.
- A plugin with screens or views needs `id("org.jetbrains.kotlin.plugin.compose")` and `compose = true` in its `build.gradle.kts`.

**Files.** A plugin writes to `ZnHandles.fileDir(context)` and gives JS `ZnHandles.file(context, file)`: `zn://file/<name>`. `<Image src>` shows it,
sized to the screen. Give JS the `file://` uri too: `FormData` streams that, so an upload never moves bytes through JS.

**Don't** let JS name a path. **Why:** a bundle comes over the air, so a path from JS is outside input. A handle can only name one plain file in that
folder: `ZnHandles.fileOf` refuses `..` and folders. **Know:** the folder is in the cache, so it stays after a kill, but Android can clear it when the
phone is short of space. Copy anything that must stay.

**Plugins with a result that isn't plain extras:** `ZnLaunch.readResult(key) { resultCode, data -> json }` in `register`, so it is there after a kill.

**A trap in `main.ts`:** imports run before `installRuntime()`. A file that uses `console` or a timer at its top level stops the app at start,
with `Property 'console' doesn't exist`. Keep that code inside a function.

## 36. Background tasks (P.5)

JS can run with no screen.

```ts
defineTask("sync", async (data, signal) => {      // at the top of main.ts, so it is there on a start with no screen
  await fetch(url, { signal })
})
```
```kotlin
ZnBackground.run("sync", json, timeoutMs = 30_000) { outcome -> }   // DONE, FAILED, NO_TASK, TIMED_OUT, once, on the main thread
```

- **Do** pass `signal` to `fetch`. At the limit it aborts, and the outcome is TIMED_OUT. A late answer is dropped.
- **Do** keep the process alive from the plugin: a service, or `goAsync`. **Why:** `ZnBackground` doesn't. Android can kill a process with nothing
  running at any time.
- **Don't** use `nav` in a task: there may be no Activity.
- A task that throws gives FAILED and reports to `onError`. It can't block an update: it isn't a launch, so OTA health doesn't count it.
- **Don't** do long sync work in a task. Past the time limit (2 s in release) JS is stopped. With no screen in front, that counts as the task's
  problem only: the task ends at its own limit, and the bundle is not judged. **With a screen in front it counts as a screen hang**, like any
  freeze the user sees: the top screen shows the error screen, and a new bundle that isn't healthy yet can be rolled back. **Why:** the runtime
  can't tell whose JS froze (`docs/second-opinions.md` entry 37).
- If JS is replaced while a task runs, the outcome is FAILED. Tasks that haven't started wait for the new JS.
- **Know:** some phones' ROMs (the Lava) refuse to start an app for a manifest receiver. FCM gets through, as Google Play services is allowed. Test with
  the debug `DebugWakeProvider`: `adb shell content query --uri content://dev.zeronative.sample.debugwake/task`.

## 37. Dark mode, low memory, right to left, secure screens (P.6)

```tsx
<Box style={{ backgroundColor: scheme("#FFFFFF", "#121212") }} />      // follows the phone
<Text>{colorScheme()}</Text>                                           // "light" or "dark"
onLowMemory(() => cache.clear())
Os.info().then((i) => i.rtl)
secureScreen: { path: "/pin", screen: PinScreen, secure: true },       // routes.ts
```

**Dark mode.** JS knows the scheme before the first screen is built, and hears each change.
- **Know the limit:** only props that can change at runtime can use `scheme()`: colour, background, opacity. `borderColor` can't yet: the build says so.
- **Know the limit:** the template draws before JS sets a slot. On a dark phone, a colour with `scheme()` can show its template default for one frame at
  cold start. **Do** check a cold start on a slow, dark phone before you ship a dark mode (`docs/second-opinions.md` entry 21).

**Low memory.** Android's trim level reaches `onLowMemory`. Drop what can be made again. Images need nothing from you: Coil clears its own memory cache.

**Right to left.** Set `android:supportsRtl="true"` in the app's manifest. Then the layout mirrors by itself when the phone's language reads right to left.
- **Do** use `start` / `end`, `paddingStart` / `paddingEnd`. **Don't** read `translateX` as mirrored: as in React Native, transforms are not.
- Test one app with `adb shell cmd locale set-app-locales <package> --locales ar`, and put it back with `--locales ""`.

**Secure screens.** `secure: true` blanks screenshots, recordings and the recent-apps picture while that route is on top. It ends when the route leaves,
at the start of the closing animation.
- **Do** use it for PIN and card screens. **Don't** treat it as more than that: it stops the phone's own capture, not a camera pointed at the screen.
- A window the app itself made secure stays secure.

## 38. The official plugins (P.3b–P.6)

All are opt-in. An app adds one Gradle line and one `register` call, and pays nothing for the ones it skips. Each README has the API and limits.

| Plugin | What | Adds to the APK |
|---|---|---|
| `@zero-native/scanner` | QR and barcodes: full screen `scanner.full`, view `QrScanner` | CameraX, bundled ML Kit: the biggest, about 5 MB of native code on arm64 |
| `@zero-native/media` | Pick and take photos, pick files, compress, rotate, crop by numbers | Almost nothing |
| `@zero-native/auth` | Phone number hint, OTP auto-read | Play services auth |
| `@zero-native/webview` | A web page in a screen, with a list of allowed hosts | `androidx.webkit` |
| `@zero-native/pdf` | Download and cache a PDF, a card preview, a viewer with zoom (§44) | Nothing: Android's own PdfRenderer, about 15 KB |

**Scanner.**
- **Do** give the route `safeArea: "none"`. The camera runs under the status bar.
- The first 500 ms from the camera's first frame don't count. **Why:** the phone can hand over an old picture, such as the last counter's QR. The same after each return.
- The first code wins, and a second is dropped at once, before anything async. A code stays locked while the app is in the background.
- **Do** pass colours and words as params. The plugin has no brand of its own.
- **Know:** `Permissions.status(["camera"])` says `denied`, not `blocked`, if only the scanner has asked: the scanner asks by itself.

**Media.**
- JS gets `{ handle, uri, width, height, size, mime, name }`. Show `handle`; send `uri` in `FormData`. No bytes pass through JS.
- Photos are written again from pixels: this removes location and other EXIF, and rotation is built in. So they are always JPEG, and see-through parts turn white.
- **`pickFile` keeps the bytes exact**, so a picture picked that way keeps its location. **Do** pass it through `Media.edit` if you share it.
- **Do** call `Media.onResult` while your screen is built. **Why:** after a kill, the promise is gone.
- **Do** call `Media.cleanup()` now and then. **Know:** the app's manifest may list CAMERA because of the scanner. Then `takePhoto` needs the permission too, and asks.

**Auth.**
- `Auth.phoneHint({ draft })`: `draft` is an id for one login attempt, and it must be the same after a restore. **Why:** that is how the sheet never comes back at a user who already answered it.
- Nothing rejects. Every failure is an answer with a `reason`, and every reason means "type it by hand".
- **Do** start `listenForOtp` just before you ask the server to send the SMS. **Do** call `stopListening` before a new send, or use a new `key`: the same key joins the last answer.
- **The app hash differs for each signing key:** debug, release and Play signing each have their own. **Do** read it with `Auth.appHash()` from the real build.
- **Don't** log the phone number or the OTP. The default pattern takes the first number of 4 or 6 digits: **do** pass your own if your SMS has another number first.

**WebView.**
- `allowedHosts` is required. Only those hosts load, https only. A link to any other host is refused, redirects and form POSTs too.
- **Don't** expect a pushed screen to keep the page: `NavDisplay` draws only the top screen, so the WebView is destroyed, and coming back reloads `url`. Cookies stay.
- A page can only ask to open another app: `onLinkOutside` must return true, and only schemes in `leaveSchemes` get that far. `intent:` is always refused, so a payment page that needs it won't work; `upi:` works, but gives no result.
- Messages are text only, 64 KB at most. Treat them as outside input, also from your own hosts.
- **Do** call `clearCookies()` and `clearStorage()` at logout.

**WebView debugging.** `ZnPlugins.register(this, WebViewPlugin(inspect = true))` lets Chrome on the computer inspect pages, in debug builds only.
Off by default, as in react-native-webview.
**Know:** on MediaTek phones, DuraSpeed can stop WebView pages from loading at all (`docs/second-opinions.md` entry 36). If every page stays blank
and the log says "process is bad", run `adb shell dumpsys duraspeed suppress_list`. `am force-stop` puts an app on that list; a tap on its icon takes it off.
In phone scripts, end the app with `stopApp()` (`tools/plugin-phone/helpers.ts`), not `am force-stop`.
**Know:** a page jump made by script with no tap adds no back step (Chromium's rule against history spam), so Back leaves the page. Use real links for
steps the user should be able to go back through.

## 39. React Native's small APIs, with their RN names (RN basics pack)

Import them from `@zero-native/core` (not `react-native`, `@react-native-clipboard/clipboard` or
`@react-native-community/netinfo`). The rest of the line stays as it was. The table with each one's status is in
[rn-compatibility.md](rn-compatibility.md).

```ts
Alert.alert("Cancel payment?", "The amount is not taken yet.", [{ text: "Keep" }, { text: "Cancel it", onPress: cancel }])
Clipboard.setString(utr)
await Share.share({ message: "Try this app", title: "Invite" })
await Linking.openURL("https://example.com/help")
if (Platform.OS === "android" && Platform.Version >= 33) await Permissions.request(["notifications"])
const { width } = Dimensions.get("window")
const sub = Keyboard.addListener("keyboardDidShow", (e) => lift.set(e.endCoordinates.height))
AppState.addEventListener("change", (s) => { if (s === "active") checkPayment() })
const stop = NetInfo.addEventListener((s) => offline.set(s.isConnected === false))
Vibration.vibrate(10)
ToastAndroid.show("Copied", ToastAndroid.SHORT)
const tn = new URL(link).searchParams.get("tn")
```

**Focus a TextField from code (OTP boxes, "jump to next field").**
```tsx
const code = createRef<TextFieldHandle>()   // RN: useRef<TextInput>(null)
<TextField ref={code} keyboardType="number-pad" maxLength={4} value={otp()} onChangeText={(t) => otp.set(t)} />
<Pressable onPress={() => code.current?.focus()}>...</Pressable>
```
- `ref` works only on `<TextField>`. It has `focus()`, `blur()`, `clear()` and `isFocused()`. `ref.current` is null until
  the field is built, and again after its screen closes.
- **Do** make one ref per field, in the screen body. For a list of fields, make an array of refs first.
- **Do** build OTP boxes the way react-native-otp-entry does: one hidden `TextField` (opacity 0) holds the code, and the
  boxes only draw it. A tap on a box calls `focus()`.
- **Know:** `returnKeyType="next"` already moves focus to the next field on screen, with no ref. Use a ref when "next"
  isn't the field below.
- **Know:** `clear()` acts like the user deleting the text: `onChangeText("")` follows, so a controlled `value` stays right.
- **Know:** with a hardware keyboard or a D-pad (Android's "non-touch mode"), `blur()` can make Android give focus to the
  first field on screen. With touch it doesn't. Seen on the emulator with `adb input text`.
- `onFocus` / `onBlur` fire only for real changes: not when the field first appears, and not when the phone turns.
- **Why not `useRef`:** there are no hooks. A screen body runs once, so a plain `createRef()` object does the same job.

**Rules for the rest.**
- **These run after the main script.** `Platform.Version`, `Dimensions` and `PixelRatio` get their values from native
  right after the main script runs, before any screen. **Don't** read them at the top level of a file: `Version` is 0
  there (a warning is logged). **Do** read them in screens, handlers and `startApp`.
- **`Dimensions` can't size a layout.** Width, height and margin are fixed at build time (rn-compatibility §0). RN code
  like `width: SCREEN_WIDTH - 32` must become `flex` or a `"N%"` size. **Do** use the values in logic (how many cards fit,
  is it a small phone).
- **Reads follow changes inside JSX or `effect`.** `Dimensions.get`, `useWindowDimensions`, `Keyboard.isVisible`,
  `Keyboard.metrics`, `AppState.currentState` and `useNetInfo()` fields read signals. **Don't** copy them into a variable at
  the top of a screen body if you need the new value later.
- **Listeners made in a screen body stop when the screen closes.** This covers `Keyboard`, `Dimensions`, `AppState`,
  `NetInfo` and `Linking`. `.remove()` / the returned function still work, as in RN.
- **`Alert`** is Android's own dialog, with the app's theme, as in RN. Up to 3 buttons: 1 → right; 2 → left, right;
  3 → far left, left, right. `cancelable` is false unless you set it. The alert stays open when the phone turns.
  `style: "destructive"` and `Alert.prompt` are iOS only, as in RN.
- **`Linking.openURL`** opens only http, https, mailto and tel; anything else (`upi:`, `whatsapp:`, `intent:`) rejects
  with `not_allowed`. **Why:** a bundle sent over OTA must not be able to open any app with any data. Other apps go
  through a plugin (§31). `canOpenURL` says false for those links.
- **`Linking.getInitialURL` and `addEventListener("url")`** only see links that matched a route with `deepLink: true` and
  that `onLink` allowed. The screen is already open by then. **Don't** route from them: to refuse a link, use `onLink`.
- **`Vibration`** needs `<uses-permission android:name="android.permission.VIBRATE"/>` in the app's manifest, as in RN.
  Without it nothing vibrates and one warning is logged. For a tap feel, `Os.haptic("light")` needs no permission.
- **`Share.share`:** Android 10+ doesn't show `dialogTitle` on the share sheet for text (RN has the same limit).
- **`Clipboard.getString`** gives "" when the app is not in front (Android 10+). Android 13+ shows its own "copied" bubble:
  **don't** add a second toast there.
- **`Keyboard` listeners:** only `keyboardDidShow` and `keyboardDidHide`, as RN on Android. One event per show or hide,
  sent when the keyboard starts to move. The height is dp from the bottom of the window. Routes with `keyboard:
  "resize"` (the default) already move their content: use listeners only for things drawn over the screen.
- **`NetInfo.isInternetReachable`** is Android's own check that the network reaches the internet. No extra request is made.
  A captive Wi-Fi reads `isConnected: true`, `isInternetReachable: false`.
- **`ToastAndroid`** shows zero-native's toast: above the keyboard, kept across navigation. Gravity is ignored.
- **`requestAnimationFrame`** is a timer of about 16 ms, not a real frame. It stops with its screen. **Don't** animate with
  it: use `animate`.
- **`URL` and `URLSearchParams`** follow the web standard. **Know:** a non-ASCII host name (`https://café.com`) throws a
  TypeError: there is no punycode. `atob`, `btoa`, `TextEncoder` and `TextDecoder` also work.
- **`StatusBar`** has no component: use the route option `statusBar`. Its height is `insets().top`.
- **`flowStore`** holds at most `flowStore.MAX_BYTES` (262,128 bytes of JSON) per key. A bigger write returns false and
  keeps the old value. Over 128 KB a warning is logged once per key. **Do** keep flow state small, and keep big data in
  `storage`, saved by id.

## 40. Tabs and focus (host API 8, registry 11)

A home screen with bottom tabs is **one screen** (one route). Its tabs live inside it. The tab bar is your own JSX: the
framework has no stock bar, so it looks like your app (badges, a raised Scan button, anything).

```ts
// routes.ts: the tab names, first = the default tab. deepLink: a link to /stores opens that tab.
home: { path: "/", screen: HomeScreen, tabs: ["pay", "stores", "offers", "rewards"], deepLink: true },
```
```tsx
import { useTabs, type TabsHandle } from "@zero-native/core"
import { Column, Tabs } from "@zero-native/ui"

type HomeTab = "pay" | "stores" | "offers" | "rewards"

export function HomeScreen() {
  const tabs = useTabs("home")              // names typed from routes.ts
  return (
    <Column style={{ flex: 1 }}>
      <Tabs selected={tabs.index()} style={{ flex: 1 }}>
        <Column style={{ flex: 1 }}>{tabs.seen("pay") && <PayTab tabs={tabs} />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("stores") && <StoresTab tabs={tabs} />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("offers") && <OffersTab tabs={tabs} />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("rewards") && <RewardsTab tabs={tabs} />}</Column>
      </Tabs>
      <HomeBar tabs={tabs} />                {/* your bar: tabs.selected(), tabs.select("stores") */}
    </Column>
  )
}
function StoresTab(props: { tabs: TabsHandle<HomeTab> }) {
  props.tabs.onFocus("stores", () => loadStores())   // RN: useFocusEffect in a tab screen
  ...
}
```
A full example with a ZeroBill-like bar: [TabsLab.tsx](../examples/sample/src/TabsLab.tsx).

**How it behaves.**
- **Lazy:** a tab is built the first time it is shown. `tabs.seen(name)` turns true then and stays true, so the tab is
  never built twice. `useTabs("home", { preload: true })` builds all of them at start (React Navigation's
  `lazy: false`). It costs start time; measure before you use it.
- **A tab you leave keeps its state.** Its signals and loaded data stay, and so does its scroll position. Native stops
  drawing it, so data that arrives for a hidden tab costs no frames (React Navigation's `freezeOnBlur`).
- **Back:** on a tab other than the first, Back goes to the first tab. On the first tab, Back works as usual. This also
  works when the tabs screen is the only screen (after login, `nav.reset([{ name: "home" }])`).
- **After Android kills the app**, the selected tab comes back. Only that tab is built then.
- **Links:** with `deepLink: true`, a link to `<path>/<tab>` opens that tab (for the `"/"` route: `/stores`). If the tabs
  screen is already open under other screens, the link goes back to it (the screens above close) and selects the tab,
  like React Navigation's `navigate`. `onLink` is asked first, as for every link.
- **Screens on top** (the Scan button opens the scanner, a row opens checkout) are pushed as usual. Back comes to the
  same tab, with its scroll position.

**Do / don't.**
- **Do** guard each tab with `tabs.seen(name) &&`, in the route's order, one child of `<Tabs>` per tab. **Why:** `<Tabs>`
  draws its child at `selected`; without the guard every tab is built at start.
- **Do** pass `tabs` to the tab components that switch tabs or need focus. RN's `navigation.navigate("stores")` from a
  tab becomes `props.tabs.select("stores")`.
- **Do** refresh a tab's data in `tabs.onFocus(name, fn)`: it runs when the tab is selected while its screen is on top,
  and when the screen comes back on top (back from checkout). Return a function to run when it loses focus.
- **Do** refuse links in `onLink` while a payment is open. **Why:** a tab link closes the screens above the tabs.
- **Don't** put a `NativeView` (a WebView, a camera view) in a tab that you switch away from often. **Why:** a hidden tab
  is not drawn, so its native view is made again when you come back (a WebView reloads).
- **Do** build a raised centre button (ZeroBill's Scan) as a `Stack` slot in a bar of fixed height. Put the label where
  the other tabs' labels sit (an empty 24 dp box stands in for the icon), and place the button over it with
  `position: "absolute", top: -25`. It still takes taps above the bar. **Don't** lift it with `transform: translateY`:
  that only moves the drawing, so the bar stays as tall as the button and the label ends up higher than the others.
  Example: `TabBar` in [TabsLab.tsx](../examples/sample/src/TabsLab.tsx).
- **Know:** a tab's `useBack` runs before the tabs' own "go to the first tab". Use it to close a sheet in that tab.
- **Know:** `restorableSignal` keys are per screen, and all tabs share them: prefix them with the tab name. The selected
  tab uses the key `zn.tab`.
- **Know:** `useImpressions` is still one per screen: call it in the tabs screen's body, not in a tab.
- **Know:** a hidden tab still runs its code (timers, signals): only drawing stops. Stop polling in the cleanup of
  `tabs.onFocus`.

**Focus on a plain screen: `useFocus`.** `useFocus(fn)` runs `fn` when the screen opens on top, and again each time the
screen above it closes (back from checkout: refresh the balance there). The function `fn` returns runs when the screen
loses focus. Same as React Navigation's `useFocusEffect`. It is about the stack only: for the app coming back to the
front, use `onAppState` (§29).

## 41. Pull to refresh (registry 12)

A vertical `<Scroll>` and a `<List>` refresh when the user pulls down at the top, like React Native's `RefreshControl`.
It is **controlled**: you own `refreshing`.

```tsx
const refreshing = signal(false)
async function refresh() {
  if (refreshing()) return
  refreshing.set(true)
  try { await loadStores() } finally { refreshing.set(false) }
}

<List data={stores()} key={(s) => s.id} row={(s) => <StoreRow s={s} />}
  refreshing={refreshing()} onRefresh={() => void refresh()} refreshColor={c.primary} />
```
React Native's shape works too, so a ported screen keeps its code:
```tsx
import { RefreshControl } from "@zero-native/ui"
<List ... refreshControl={<RefreshControl refreshing={refreshing()} onRefresh={onRefresh} colors={[PRIMARY]} tintColor={PRIMARY} />} />
```
The compiler turns it into the props above: `colors[0]` (or `tintColor` when there is no `colors`) becomes
`refreshColor`, `progressBackgroundColor` becomes `refreshBackground`. Any other `RefreshControl` prop is a build error.
Example: all four tabs of [TabsLab.tsx](../examples/sample/src/TabsLab.tsx) (two use each shape).

**How it behaves.**
- The pull starts when the content is at its top and the finger keeps going down. A round disc with an arc slides down
  over the content (Android's look: the content doesn't move). The arc grows with the pull and turns solid when letting
  go would refresh. The disc must come down 80 dp, and it moves half as far as the finger.
- When you let go past that point, `onRefresh` runs and the spinner shows at once. From then on it follows `refreshing`:
  it stays while `refreshing` is true, and slides away when it goes back to false.
- If `refreshing` is not set to true within 1 second of the pull, the spinner goes away by itself.
- `refreshing={true}` without a pull shows the spinner too (for a first load).
- While the spinner shows, a new pull does nothing: the list scrolls as usual.
- Pulling works only when `onRefresh` is set.
- No JS runs during the pull, only when the finger is up. A pull costs no frames.

**Do / don't.**
- **Do** set `refreshing` to true in `onRefresh`, and back to false when the data is in (also on errors: use `finally`).
  **Why:** the spinner follows it. If you never set it, the spinner goes away after 1 second, before your data arrives.
- **Do** skip a second refresh while one runs (`if (refreshing()) return`). A pull can't start one, but your own code
  (a reload on focus) can.
- **Don't** keep the `<RefreshControl>` in a variable (`const rc = <RefreshControl/>`, as RN code often does). Write it
  inside `refreshControl={...}`. **Why:** the compiler reads it there, at build time.
- **Don't** put pull to refresh on `<Scroll horizontal>`: it is a build error.
- **Know:** one colour only. RN's `colors` array (colours that take turns) uses its first colour.
- **Know:** the content doesn't move down with the pull, as on Android. On iOS it will (SwiftUI's own refresh).
- **Know:** TalkBack has no pull gesture (the same as in RN). If reloading matters, give screen reader users a button.

## 42. SVG (docs/svg.md, registry 13; built as 11-13, first planned as 10)

```tsx
import Logo from "./art/logo.svg"
import { Check, Heart } from "./icons"                         // icons.ts: export { default as Check } from "./check.svg"

<Check size={20} color={c.ink} />                              // color = currentColor inside the file
<Logo style={{ width: 160 }} />                                // height from the viewBox
<Logo size={64} parts={{ ring: { stroke: brand() }, dot: { opacity: on() ? 1 : 0.3 } }} />
<Svg viewBox="0 0 24 24" size={24}><Path d={HEART} fill={liked() ? c.like : c.muted} /></Svg>
```

The compiler reads every SVG at build time and puts compact draw data in the bundle. The phone never reads XML, and an OTA can add or change SVGs.
- **Do** use `.svg` files for icons and pictures; `Icon` stays for old code. **Why:** a `.svg` file is what designers hand over, and the build checks it.
- **Know:** an imported SVG is a build-time name, not a value. `icon={<Logo />}` works; `icon={Logo}` or `const all = { Logo }` fails the build.
- **Do** add `fill="currentColor"` where the colour should change. **Know:** Material Symbols files come with no fill (that means black), so
  `color` fails the build on them until you add it to the `<svg>`. **Why:** a `color` that silently does nothing is worse than a build error.
- **Do** give an element an `id` to change it at runtime: `parts={{ id: { fill, stroke, opacity } }}`. A part's `fill` / `stroke` repaints every
  shape inside it. A wrong id fails the build and lists the ids the file has.
- **Inline `<Svg>`:** the same names as react-native-svg. Geometry is fixed at build time: `cx={x()}` fails. Only `fill`, `stroke` and `opacity`
  may change; such an element becomes a part by itself. `.map` works over a `const` array; `cond && <X />` doesn't: use `opacity`.
- **Don't** put text in an SVG. **Do** put a zn `<Text>` over it in a `<Stack>`. **Why:** real text follows the font size and TalkBack reads it.
- **Know the limit:** no `<image>`, `<pattern>`, filters (blur, shadow), `<style>` / CSS classes, SMIL, markers, nested `<svg>`,
  `non-scaling-stroke`. The build says which and how to fix it. A mask of plain white shapes is fine (it becomes a clip).
  (Since S.14 and phase 3: plain CSS rules, SMIL and `non-scaling-stroke` work; since phase 4, in `.svg` files: patterns,
  filters, markers, nested `<svg>`, any mask and simple `<text>`; see below.)
- **Do** add `accessibilityLabel` when the SVG means something; without one TalkBack skips it. **Do** use `autoMirror` on arrows and chevrons.
- **Know:** colours inside an SVG don't follow dark mode. **Do** pass theme colours through `color` or `parts` with `scheme(...)`.
- Each distinct SVG is parsed once, the first time it is drawn, and shared by every place that shows it, list rows too.

**Moving parts (phase 2):**
```tsx
<Gauge parts={{ needle: { rotate: angle(), animate: "spring" }, arc: { trimEnd: score() / 100, animate: 600 } }} />
<Badge parts={{ tick: { trimEnd: 1, replay: paidCount(), animate: { trimEnd: { duration: 300, from: 0, delay: 450 } } } }} />
<Svg viewBox="0 0 24 24" size={36}>
  <Circle cx={12} cy={12} r={9} stroke={c.primary} fill="none" trimEnd={0.28}
    rotate={360} animate={{ rotate: { duration: 900, easing: "linear", from: 0, repeat: "forever" } }} />
</Svg>
```
- **Do** move parts with `rotate`, `scale`, `translateX` / `translateY` and the trims. A part turns and scales around its own centre.
  **Know:** move and translate values are in the SVG's viewBox units, not dp. **Why:** the same SVG at 24 dp and 96 dp moves the same way.
- **Do** "draw the line" with `trimEnd` from 0 to 1 (`trimStart` / `trimOffset` for a moving piece). **Know:** trims cut the fill too, and
  a group's shapes count as one line, in the order they are drawn.
- **Do** put `animate` in the part (static only), and `paused` / `replay` like on any element. On inline `<Svg>`, the same props go on the
  element itself and make it a part.
- **Don't** expect a downloaded animated `.svg` (SMIL `<animate>`, CSS `@keyframes`) to play: the build refuses it and says so.
  Rebuild the motion with parts + `animate`.
  **Update (S.14):** most of them now play as they are: `import Spinner from "./spinner.svg"`, then
  `<Spinner size={24} color={c.primary} paused={done()} />`. 95 of 104 loaders from two popular sets work.
  - **Do** add `fill="currentColor"` to the file's `<svg>` when `color` should tint it (most loader files have no fill).
  - **Know:** `paused` / `replay` on the SVG reach the file's own motion. Its parts are named by the build; `parts` can still
    change an element that has an `id` (colour, opacity), but not give it a second `animate`.
  - **Know the limit:** filters, moving along a path, morphing `d`, stroke width or dash animation, a growing shape with a
    stroke, and click triggers fail the build with a hint. **Why:** each of those would draw differently from the browser.
  - **Know:** with "Remove animations" on, the file shows its own still state, which is sometimes empty (a loader whose
    pieces start at opacity 0). Show a plain "Loading…" text next to it if that matters.
  - **Update (phase 3, registry 12):** 100 of 104 now play: also morphing `d` (keyframes with the same commands), stroke
    width, dash tricks (one dash with a long gap, or a fixed pattern that moves), and stroked shapes that grow (the stroke
    keeps its width, as in the browser). Still refused: filters (the "gooey" loaders), moving along a path, click triggers.
    (Phase 4: all three work now; 104 of 104 play. See below.)
    **Do** use `stroke="currentColor"` on line loaders (most come black or white), like `fill` above.

**Strokes, part names (phase 3, registry 12, docs/svg.md §16):**
```tsx
<Ring parts={{ arc: { strokeWidth: busy() ? 3 : 2, animate: 200 } }} />   // viewBox units, can change at runtime
<Route parts={{ dashes: { dashOffset: 0, animate: { dashOffset: { duration: 800, from: 8, repeat: "forever", easing: "linear" } } } }} />
```
- **Do** set `strokeWidth` / `dashOffset` in `parts` of an `.svg` file. **Know:** on inline `<Svg>`, `strokeWidth` stays the
  plain SVG attribute (fixed at build time).
- **Do** use `vector-effect="non-scaling-stroke"` in a file when a line must stay the same thickness at every size (a chart
  line in a card and full screen). The width is then dp. **Know:** dashes on such a stroke fail the build.
- **Do** let the editor help with part names: the build writes `logo.d.svg.ts` next to each imported `.svg`, so `parts`
  autocompletes and a typo is a type error. **Do** add `"allowArbitraryExtensions": true` to the app's tsconfig and
  `*.d.svg.ts` to `.gitignore`. **Know:** before the first build any name type-checks; the build still checks it.

**Effects, text and more motion (phase 4, registry 13, docs/svg.md §17):**
- **Do** use files with filters (blur, drop shadow, colour matrix), masks, patterns, markers, blend modes, `paint-order`,
  nested `<svg>`, `<switch>` and focal radial gradients as the designer exported them. **Know:** below Android 12 a filter
  is not run: the group is drawn sharp, with a plain drop shadow when the filter had one. **Why:** Android has no filter
  engine before 12; a missing shadow is better than a wrong blur. Don't put meaning in a blur alone.
- **Do** keep a blur or shadow small and off long lists when you can. **Know:** each filtered SVG draws in its own layer.
  The lab list has one in all 60 rows, so check yours there first on a low-end phone.
- **Know:** simple SVG `<text>` works now (one line, the phone's own sans, serif or mono font, no `rotate` or `<textPath>`).
  The joined text is the TalkBack label unless you set one. **Do** set `accessibilityHidden` on such an SVG when it is
  decoration (a ₹ on a coin in every list row). **Why:** TalkBack would read "₹" before each row. **Still do** use a zn `<Text>` over the SVG for anything
  people read: it follows the user's font size and language; SVG text doesn't.
- **Do** use downloaded files that move along a path (`<animateMotion>`, CSS `offset-path`), use `<set>`, `steps()`, skews,
  animated gradient stops, `points` morphs or CSS `var()` / `:nth-child()` / `@media`: they compile now. 104 of 104
  corpus loaders play.
- **Do** use `begin="click"` in a file for a small "tap to play" effect (a heart that pops). **Know:** a tap anywhere on the
  Svg starts it, and each tap starts it again; a `Pressable` around the Svg still gets the tap. **Don't** use it as the
  only way to do something: it has no TalkBack action. Use a `Pressable` with `replay` for real actions.
- **Know:** `@media (prefers-reduced-motion: reduce)` rules in a file are skipped. "Remove animations" already shows each
  file's still state.
- **Know:** a big `.svg` (8 KB of draw data or more) is read in the background after the first frame, so one further down
  the screen costs nothing on the main thread. One on the first frame is read when it is first drawn, as before.

## 43. React Native props, styles and components (RN props pack 2, registry 14-15)

More of React Native's own names, so a ported screen keeps its code. Lab: Dev → "RN props" (`/dev/rn-props`), phone
steps `bun run tools/plugin-phone.ts "rn props"`. A bundle that uses any of these asks for registry 15 (the long press
change: 14).

**Styles.**
- `shadowOffset`, `shadowOpacity`, `shadowRadius`: accepted and dropped, as RN on Android does (its shadows come from
  `elevation` and `shadowColor`). A shared iOS + Android style ports as it is. **Know:** the shadow you see is the
  `elevation` one, as in the RN app on Android today.
- Per corner: `borderTopLeftRadius`, `borderTopRightRadius`, `borderBottomLeftRadius`, `borderBottomRightRadius`, and the
  `Start` / `End` forms. A corner's own value beats `borderRadius`; `Start` / `End` beat `Left` / `Right`. **Know:**
  `Left` / `Right` are drawn as `Start` / `End` (the same in a left-to-right app).
- `borderColor` and `borderWidth` can change at runtime: `borderColor: focused() ? c.primary : c.line` (an OTP box, a
  selected chip). A colour change only redraws. A width change moves the content (borders take space, as in RN) and
  re-measures that one element, without any recompose.
- `StyleSheet.absoluteFill` / `absoluteFillObject`, and any absolute child with both `start` and `end` (or `top` and
  `bottom`): it stretches between them inside its `Stack`, as in RN. **Know:** with only one pair (`start: 16, end: 16`),
  the child is as wide as the Stack may be: right when the Stack has a set or stretched width, the usual overlay case.
- `textTransform`: `"uppercase"`, `"lowercase"`, `"capitalize"`, also for text that changes at runtime. capitalize works
  as RN's Android code does: the first letter of each word upper case, the rest lower case ("don't" is one word).

**Touch.**
- `pointerEvents`: `"none"` (the element and its children take no taps; they reach what is under it), `"box-none"` (only
  its children take taps), `"box-only"` (only the element itself), `"auto"`. It can change at runtime:
  `pointerEvents={keyboardShown() ? "none" : "auto"}`.
- **Know:** an absolute `Box` / `Column` / `Row` / `Stack` with a background or children (a layer over other things,
  like an RN "busy layer" over the screen while a payment runs) stops taps, as in RN, even without `pointerEvents`.
  **Know (different from RN):** any other element with no handlers lets taps through to what is under it (in RN it
  stops them). Inside a `Stack` that matters for a plain, not absolute, child over another one. **Do** write
  `pointerEvents="auto"` on any layer that must stop taps, to say so in the code. **Why:** a tap that reaches the Pay
  button under a busy layer can start a second payment. Better still, disable the button too.
- **Know:** inside `pointerEvents="none"`, `Pressable`s take no taps, but a `Scroll`, a `TextField` or a `Switch` there
  still does. Put those outside the "none" part.
- `hitSlop` on `Pressable`: a number, or `{ top, bottom, left, right }`, in dp. Build-time only. **Know:** it uses
  Compose's minimum touch size, so each axis reaches as far as its larger side on both sides; and a tap in the extra
  area loses to another tappable element right under the finger (RN gives it to the one on top). Over empty space, the
  usual icon button, it works as in RN.
- **Know:** every zn `Pressable` smaller than 48 dp already takes taps up to 48 dp (Compose's minimum touch size). RN
  has no such minimum. A UI test also sees that bigger box as the element's bounds.
- `testID`: UI tests (uiautomator, Espresso) find the element by this resource id, on screens, Sheets and Modals.
  Build-time only. Ours use it: `tools/plugin-phone/rnprops.ts`.

**Events.**
- `onLayout` on any element: `(e) => e.nativeEvent.layout` gives `{ x, y, width, height }` in dp, as in RN (`x`, `y` from
  the parent's top-left corner). Sent once laid out, then only on a change, never while the screen scrolls. **Know:**
  sizes are whole pixels turned into dp, so 60 dp of padding at 2.625 may read 100.19, as in RN.
- `Image`: `tintColor` (can change at runtime) draws every non-clear pixel in that colour. `onLoad` gives
  `e.nativeEvent.source` `{ width, height, uri }` (the picture's pixels), `onError` gives `e.nativeEvent.error`, and
  `onLoadEnd` comes after either. They are for `src` only: a `fallbackSrc` that loads sends nothing (RN's
  `defaultSource` sends nothing either).

**Modal.** React Native's own `<Modal>`: a full-screen window over the app, in which you draw your own content.
```tsx
<Modal visible={open()} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent
  onRequestClose={() => open.set(false)}>
  <Pressable onPress={() => open.set(false)} pressFeedback="none" justifyContent="center" alignItems="center"
    style={{ flex: 1, backgroundColor: "#00000080" }}>
    <Column style={{ width: 280, padding: 20, borderRadius: 16, backgroundColor: c.white }}>...</Column>
  </Pressable>
</Modal>
```
- Controlled by JS: shown while `visible` (shown when not written, as in RN). Back sends `onRequestClose`; it closes only
  when you set `visible` to false. `onShow` comes when it is on screen.
- `transparent`: no window background (else white). `animationType`: `"none"`, `"fade"`, `"slide"`.
- Your content stays below the status bar and above the navigation bar, unless `statusBarTranslucent` /
  `navigationBarTranslucent`. It always stays above the keyboard. **Do** set both translucent props for a dim that covers
  the whole screen (ZeroBill's dialogs do). **Why:** with only `statusBarTranslucent`, the strip behind the navigation
  bar shows the screen undimmed, as in RN.
- An `Alert` opened while it shows draws above it. A toast draws in its window, as for a `Sheet`.
- iOS-only props (`presentationStyle`, `supportedOrientations`, ...) are accepted and do nothing.
- **Do** use `Modal` for a centred dialog with your own look (a payment confirm, a "processing" layer). Use `Alert` for
  Android's own dialog, and `Sheet` for a bottom sheet with drag and detents. **Why:** `Modal` gives no drag or scrim of
  its own; you draw everything, as in RN.

**StatusBar and NavigationBar.**
```tsx
<StatusBar barStyle={onGreenHeader() ? "light-content" : "dark-content"} backgroundColor={onGreenHeader() ? c.success : undefined} />
```
- Put it anywhere in a screen (also in its Modal or Sheet). While that screen is on top, `barStyle` sets the icons and
  `hidden` hides the bar. Several merge, the newest winning, as in RN. All of it can change at runtime.
- `backgroundColor` is drawn behind the bar, for that screen. **Why:** Android 15+ draws every app edge to edge and
  ignores the old bar colours (RN's `backgroundColor` does nothing there). zn draws the colour itself, so it works on
  every Android version. A full-bleed header (route `safeArea: { top: false }`) covers it.
- `<NavigationBar barStyle backgroundColor />`: the same for the navigation bar. It is zn's own; RN has none.
- No element: the route's `statusBar` option and the screen's own background decide, as before. The screen background
  behind the bars now follows a background that changes at runtime.
- **Don't** render `StatusBar` only while focused, as RN apps do with React Navigation (`isFocused && <StatusBar/>`).
  **Why:** in zn it already belongs to its screen; the trick only adds work.
- **Know:** `translucent` is accepted and does nothing: each route's `safeArea` decides whether a screen draws under the
  bar. `StatusBar.setBarStyle(...)` and `StatusBar.currentHeight` are not built: render a `<StatusBar>`, and read
  `insets().top`.

**Sticky list rows.** `stickyHeaderIndices` on `<List>`, as on RN's FlatList:
```tsx
<List data={rows()} key={(r) => r.id} row={(r) => (r.header ? <SectionHeader r={r} /> : <TxnRow r={r} />)}
  stickyHeaderIndices={headerIndexes()} />
```
- Those rows (by index in `data`) stay pinned at the top while their part of the list scrolls; the next one pushes the
  last up. The indices can change at runtime. Pull to refresh, `onEndReached` and impressions are unchanged; a pinned
  row isn't counted in the range that decides which rows JS mounts.
- A pinned row stays mounted wherever the list is, so it never shows as a placeholder.
- **Know:** only on `List`, not on `Scroll`.

## 44. PDFs (`@zero-native/pdf`)

`Pdf.download` puts a PDF in the cache folder and gives a `zn://file` handle. `<PdfPreview>` shows one page on a card;
`<PdfView>` shows every page with scroll and zoom. Drawing is Android's own PdfRenderer. The README has the API and limits.

- **Do** download with `Pdf.download` (or `pdfFile`), not `fetch`. **Why:** `fetch` brings the whole body into JS; the
  plugin streams it to disk and checks it opens before it gives a handle.
- **Do** pass a `key` (a receipt id) when your URL can change for the same file, like a signed link. **Know:** the file is
  named from `url` + `key`, not the headers.
- **Do** call `Pdf.cleanup({ olderThanMs: 0 })` at logout when two users could get the same URL. **Why:** the headers
  (a login token) are not part of the name, so the second user would get the first user's cached file.
- **Do** show Retry on `state() === "failed"`. **Know:** nothing rejects. Every failure is a `reason`. `not_pdf` is usually
  an error or login page sent with status 200.
- **Know:** the app's headers go only to the first host. A redirect to another host (a CDN) gets none. A signed CDN link
  works, but a CDN that needs your token doesn't.
- **Do** put the view in a Box or Column with a size. **Don't** put `PdfView` in a `Scroll`. **Why:** it scrolls and zooms
  by itself, and two scrolls fight for the finger.
- **Do** use `<PdfPreview>` for a card (fit "width": from the top, cut by the box). It has no touch, so a `Pressable`
  around it gets the tap. **Why:** it draws only what the box shows, so a card costs a few MB at most, even for a long receipt.
- **Don't** show many PDF views at once (a list of 20 receipts with previews). **Why:** each view has its own memory budget,
  up to 48 MB. Show a picture or text in a list, and the PDF when it is opened.
- **Know:** after a kill, the view opens its file again, at page 1 and 1×. Keep the handle in a `restorableSignal`, or
  call `pdfFile` again (a cached file comes back at once).
- **Know:** a PDF that crashes pdfium kills the app, and no code can catch that. **Do** show PDFs only from servers you trust.
- **Know:** a password PDF is `reason: "password"`. There is no way to type the password.

## 45. Location (`@zero-native/location`)

The phone's location from Android's own `LocationManager`; Play services only for Google's "Turn on location" dialog. API
and limits: `plugins/location/README.md`.

- **Do** ask for the permission only from a tap: `Location.requestPermission()`. `getCurrentPosition` and `status` never show
  a dialog. **Why:** a dialog the moment a tab opens is the top reason users press "Don't allow", and two of those make it
  `blocked` for good.
- **Do** check the answer, not a thrown error: every call answers `{ position, reason }` and none rejects. `blocked` →
  `Os.openSettings()` (the app's page). `off` → `Location.turnOn()` (below). After a settings screen, read again on
  `onAppState("active")`.
- **Do** use `Location.requestPermission()`, not core's `Permissions.request(["location"])`. **Why:** that short name is the
  precise permission alone. Android's docs say 12+ may ignore such a request (on the Lava, Android 14, it still showed a
  dialog). The plugin asks for both, as Android wants, and reads "approximate only" as granted.
- **Do** use `"balanced"` (the default) for "near me" lists. It answers from the network provider in 1–3 s indoors.
  **Know:** `"high"` waits for a fix within 25 m until the timeout; indoors that is often the whole timeout.
- **Know:** without a new fix you get `lastKnown`, of any age. **Do** look at `ageMs` before you use it, and say so on
  screen ("Showing stores near your last location"). **Don't** turn it into a silent default.
- **Know:** the user can pick "Approximate". Then `precise` is false and fixes are blurred to about 2 km. Android also sends
  such an app a new fix at most every 10 minutes, so you get the cached rough one at once (up to 10 minutes old). Plan the
  screen for it (a wider radius), and don't ask again and again for precise.
- **Do** answer `off` with `Location.turnOn()` from a tap: Google's dialog, and "Turn on" switches location on at once.
  **Do** fall back to `Location.openSettings()` on `unavailable` (no Play services). **Don't** call `turnOn` again
  right after `declined`: the user just said no.
- **Know:** a hidden app gets no fix. A one-shot answers `background` (or the best fix so far) and a watch pauses until
  the app comes back. **Don't** expect location in a background task.
- **Do** stop a watch you no longer need. A watch started in a screen stops with the screen; one started in a store or
  `detached` runs until you stop it.
- **Know:** the Geocoder needs the internet on most phones and can take seconds. `postalCode` is a string. **Do** cache
  its answers by rounded coordinates.
- **Don't** log coordinates or addresses. The plugin never does.
