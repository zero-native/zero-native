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

## 2. `<List>` authoring
```tsx
<List
  data={txns}                         // a ListSource: a JS array or signal of an array (v1), or a native source (v1.1)
  key={(t) => t.id}                   // stable key, required
  rowHeight={72}                      // fixed height (recommended); or estimatedRowHeight={72}
  row={(t) => (                       // compiled ONCE into a row template; each t.* read becomes a row slot
    <Pressable onPress={() => openTxn(t.id)} style={s.row}>
      <Text style={t_.merchant} placeholder="████████">{t.merchant}</Text>
      <Text style={[t_.amount, { color: t.isCredit ? c.credit : c.text }]}>{formatInr(t.amountPaise)}</Text>
    </Pressable>
  )}
  onEndReached={() => loadMore()}     // network pagination
/>
```
- The `row` function is compiled into **one row template** (inside the screen's `.zn.ui`). It is **not** called per row
  at runtime to build nodes.
- Every expression inside `row` that reads the item (`t.merchant`, `formatInr(t.amountPaise)`) becomes a **row slot**.
  JS computes row slot values for the rows in the current window only.
- Row expressions should be pure functions of the item. They may also read list-level signals (for example
  `selectedId()`); when such a signal changes, JS recomputes the affected slots for rows in the window only.
- Taps: put a `Pressable` in the row. The event carries the row key, and the handler gets the item from JS memory.

## 3. The window protocol (decided)
JS → native (in the normal batch, ARCHITECTURE §8.3):
- `LIST_SET(listId, count, version)`: the list now has `count` rows.
- `LIST_ROWS(listId, version, startIndex, keys[], values[][])`: row slot values for a range, indexed by **slot id**
  (typed values, no strings like `"{{slot:x}}"`).
- `LIST_SPLICE(listId, version, index, removeCount, insertCount, keys[])`: rows inserted or removed (a new payment at
  the top). Native shifts its cache and **keeps the scroll position anchored to the first visible key**.

Native → JS (asynchronous event, never waited for):
- `onRange(listId, firstVisible, lastVisible, velocity)` sent when the visible range moves by more than a few rows
  (v0 used 8). JS answers with `LIST_ROWS` for the visible range plus overscan (default: one screen above, two below
  in the scroll direction; tuned by measurement).

Rules:
- **The UI thread never calls into JS and never waits for row data.** v0 considered a synchronous JSI pull from
  Compose for each row ("Option B"). It is **rejected**: Hermes is single-threaded, so calling it from the UI thread
  corrupts memory, and putting a lock around it makes the UI thread wait during JS work and GC pauses.
- **Native row cache:** plain value arrays keyed by index and key, bounded (default about 4× the window, least
  recently used dropped). Observable cells exist only for rows that are composed (ARCHITECTURE §9.3).
- **Missing rows show the same row template with placeholder values** (each slot's `placeholder`, or a neutral
  default per value type: grey bar for text, empty for images). Same template, same height: no layout jump when real
  values arrive. **Raw template syntax is never shown** (v0 showed `{{slot:merchant}}`; see `docs/v0-findings.md` §F).
- `version` lets native ignore stale `LIST_ROWS` that arrive after a `LIST_SET` / `LIST_SPLICE`.
- **Heights:** with `rowHeight`, positions are computed without measuring, and placeholders can't change height. With
  `estimatedRowHeight`, rows are measured when composed; placeholder and real row may differ (documented trade-off).

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
