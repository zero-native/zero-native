# Lists

Part of the zero-native spec. The summary is in `ARCHITECTURE.md` §9.3; this file has the full rules.
**Status: decided (2026-10-29)**, except the native data source (§6), which is designed now and built in v1.1.

## 1. Two list primitives
| | `<For>` | `<List>` |
|---|---|---|
| For | short lists that are part of a layout (UPI apps, a bill's line items, settings rows) | long or unbounded lists (passbook, orders, catalogue) |
| Size guideline | up to ~100 items | any size |
| Rendering | every item is a real instance (MOUNT / MOVE / REMOVE ops), inside the parent `Column` / `Row` / `Scroll` | virtualized (`LazyColumn` / `LazyVStack`): only rows on screen are composed |
| JS cost | one instance per item | one row **template**, plus row **values** for a window only |

The compiler warns when a `<For>` is fed an array that is not obviously small, and suggests `<List>`.

## 2. `<List>` authoring (built, milestone 2 step 2.4a)
```tsx
<List
  data={feed()}                        // a JS array (read a signal to make it reactive)
  key={(f) => f.id}                    // unique, stable key; required
  style={{ flex: 1, paddingHorizontal: 12 }}
  gap={8}
  row={(f) =>                          // one JSX element, or cond ? <A/> : <B/> to choose a row KIND
    f.kind === "header" ? <Text style={s.header}>{f.title}</Text>
    : <MerchantRow m={f} />}          // a component from any file is fine
  onEndReached={() => loadMore()}      // network pagination; once per row count
/>
```
- **Row kinds:** each JSX leaf of `row` is its own row template. The compiler also emits `type(item)`, which picks the
  leaf's template id **without building the row** (a user component's id comes from `Comp.__zt`, which the compiler
  sets where the component is compiled). Native gives each kind its own Compose reuse pool (`contentType`) and its own
  placeholder. Heights may differ per row: Compose measures lazy rows itself.
- **A row is an ordinary template instance** (2.4a decision, changed from "row values only"): JS mounts it only while
  it is near the visible range and removes it after it leaves a wider band. So everything that works in a screen works
  in a row: slots, taps with closures over the item, `cond && <X/>`, `.map` rails, components. A long list still costs
  only one key + type per row on the native side, plus instances for a window of ~40 rows.
- A row whose item object changes (same key, new object) is mounted again. Keep items immutable: replace the object.
- `row`'s index argument is the position when the row was mounted; it is not updated by later inserts.
- Pull to refresh: `refreshing` + `onRefresh` (or RN's `refreshControl={<RefreshControl/>}`), guide-notes §41.

## 3. The window protocol (built, 2.4a)
JS → native (normal batch ops, `core/include/zn/batch.h`):
- `LIST_SET(instance, node, keys[], types[])`: every row's key and kind (template id), once.
- `LIST_SPLICE(instance, node, index, removeCount, keys[], types[])`: what changed between the common start and the
  common end of the old and new key lists (a new payment at the top, rows added at the end, a row removed): one op.
  Compose keeps the scroll anchored to the first visible key.
- `MOUNT` (parent = the list's instance, anchor = the list node) + `LIST_ROW(instance, node, key, rowInstance)`:
  a row near the visible range; `REMOVE` when it leaves.
- No version numbers: ops come in order from one JS thread, so nothing can arrive stale.

Native → JS (asynchronous events, never waited for):
- `onRange` (payload `"first,last"`), sent when the visible range changes (at most once per frame). JS mounts rows from
  8 above to 12 below it (and the first 16 + 12 before any range arrives) and removes rows outside twice that band.
- `onEndReached`, once per row count, when the last visible row is within 5 of the end.

Rules:
- **The UI thread never calls into JS and never waits for row data.** v0 considered a synchronous JSI pull from
  Compose for each row ("Option B"). It is **rejected**: Hermes is single-threaded, so calling it from the UI thread
  corrupts memory, and putting a lock around it makes the UI thread wait during JS work and GC pauses.
- **Missing rows show the same row template as a placeholder** (a shared read-only instance holding the template's
  slot defaults), so a row never shows raw template syntax (v0 showed `{{slot:merchant}}`, `docs/v0-findings.md` §F).
  Grey-bar placeholder text (`placeholder` prop) is not built yet.
- **Duplicate keys** would crash Compose; JS logs an error and makes the key unique (`key#index`).
- **Measured (Lava, release, 10,100 rows with 2 kinds, fast flings):** p50 6 ms, p95 11 ms, p99 15 ms per frame,
  0 janky frames, 0 slow UI-thread frames; cold start 180 ms median with the list on the first screen.

## 4. The template interpreter must be fast (decided)
v0 measured three ways to draw the same 72 dp card while flinging (Lava Blaze 2 5G, 90 Hz, 11.1 ms per frame):

| How the row is drawn | Frame time | Smooth frames |
|---|---|---|
| Hand-written Kotlin card | ~4 ms | 100% |
| Generic node tree per row (11 `ZnNode`s, hash map lookups and observable reads per node) | 18–25 ms | 14–26% |
| One shared row template, values looked up per row | 2.8–4 ms | 100% |

So the **template interpreter** is as fast as hand-written Kotlin. We do **not** generate Kotlin from TSX (that would
break OTA updates: compiled code can't be replaced over the air). The interpreter rules:
- Each template is prepared **once** into flat arrays: node types, child ranges, pre-built static `Modifier`s, static
  text, slot → (node, property) table.
- Static props are constants, not state. Only slots are read per row.
- No per-row node allocation, no hash map lookups per row, no string matching. Slot values are found by index.

## 5. Memory and scale (measured in v0)
- 10,000 items **eagerly** turned into nodes: 110,000 nodes, ~1.2 million ops, a ~350 MB JSON payload → out of memory.
  Even before the crash, ART had 424 ms blocking GC pauses (38 dropped frames).
- 10,000 items with a 50-row window: Dalvik heap ~5.7–6.2 MB, no blocking GC during flings, 90 fps.
- 10,000 plain items in the Hermes heap: ~1.2 MB. Fine.
- **1,000,000 items (10 lakh) in the Hermes heap: ~350–500 MB. Not possible on a budget phone.** That needs §6.

## 6. Native data source (v1.1; interface designed now)
For data that is too big for JS memory (a merchant's multi-year ledger, a full catalogue), rows come from native
storage without passing through JS:
```tsx
const ledger = nativeSource('ledger', { query: 'byDateDesc', params: { from, to } })   // a native module capability
<List data={ledger} key={(t) => t.id} rowHeight={72} row={(t) => <TxnRow t={t} />} />
```
- The source (SQLite cursor or a memory-mapped file) is a native module. It reads row ranges **on an I/O thread**
  into the same native row cache. **Never on the UI thread**: a disk read during a fling is a dropped frame. (v0's
  "Dilemma C" proposed reading SQLite on the UI thread; that part is rejected.)
- The row template's slots bind to the source's columns. The compiler checks the row type against the source's
  declared columns; computed row expressions (formatting) run in a small native formatter set, or the source stores
  display-ready columns. [Design detail to settle in v1.1.]
- Changes (a new payment) come as keyed insert/update/delete notifications from the source; native applies them as a
  splice and keeps the scroll anchored.
- JS keeps the logic role: it sets the query and params, gets tap events with keys, and can ask the source for one
  row's full data.
- Fast flings still show placeholders for a few frames if the I/O thread is behind. Prefetch in the scroll direction
  keeps this rare.

## 7. Evidence
- `gemini-flash-individual-experiments/dish-a-virtual-list.md`, `frontier-2-zn-ui-slot-virtual-list.md`,
  `zero-jitter-virtual-list-deepdive.md`, `ten-lakh-records-architecture-proposal.md`,
  `gemini-4-argon-problem-solving-suggestions.md` (Part 1), `argon-solutions-verification.md` (§2).
- Note: those reports measured a prototype. Their numbers for "compiled `.zn.ui` templates" and "120 fps" are
  projections, not measurements.
