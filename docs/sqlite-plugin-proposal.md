# SQL plugin proposal (`@zero-native/sqlite`, no code yet)

**Status (2026-11-04): proposal, agreed in direction. Nothing is built.** Pavan's idea. Build it in parallel or later.
**It does not block the ZeroBill pilot**: the pilot (login, scan, UPI) needs no database. Labels used below:
**[framework]** = this repo; **[ZeroBill]** = the app.

**Direction Pavan agreed on:** one official plugin on Android's own SQLite, with live queries ("watch") from day 1.
A Drizzle ORM adapter comes later, and it is optional.

**Pavan's decisions (2026-11-04)** (they answer §9, and the sections below follow them):
1. **Lowest Android version stays Android 7 (minSdk 24).** Write SQL for SQLite 3.9 (§1.3).
2. **Names: expo-style** `run` / `getAll` / `getFirst` (§2.2). Pavan left it to the framework author.
3. **100,000 rows in a table must work well.** The cap is on one *answer* sent to JS, not on the table. Tables of
   100,000+ rows, with counts, sums and filters done in SQL, are a goal of v1. See §7.4 and the 100,000-row tests in
   DB.6 and DB.7.
4. **Developers are expected to write safe (add-only) migrations, but an app may opt in to unsafe ones** and sync its
   data again from the server, as ZeroBill does today. The OTA release tool warns; it doesn't refuse. See §3.5.

**Added by Claude to the study (2026-11-04):** §3.5 (unsafe and reset migrations, with a schema "epoch" so an OTA
rollback stays safe), the 100,000-row goal in §7.4, a full disk handled like FlowStore's (§7.4), and the `onReset`
hook an app uses to sync again.

**How claims are marked:**
- **[checked: source]** = I read it in that file or on that web page on 2026-11-04.
- **[reasoned]** = my reasoning from known behaviour. Not tested here. A build step below tests it.
- **[estimate]** = a rough number, to be measured.

**Why SQL at all.** ZeroBill's Flutter app dropped drift because the bundled SQLite `.so` made the app bigger, and
moved everything to Hive (Pavan). zn's `storage` (MMKV-like) saves a whole value at once: a list of 5,000 receipts in
one key means "read all, change one, write all" on the JS thread. One key per row avoids that, but then there is no
order, no filter and no count without reading every key [reasoned; `packages/core/src/storage.ts` has only
`get` / `set` / `keys`]. Long lists (receipts, transactions, offers) need a real table with an index.

---

## 1. Which SQLite

### 1.1 Three options

| | Android's own SQLite (`android.database.sqlite`) | A bundled SQLite (`.so` in the APK) | Room |
|---|---|---|---|
| Size added | **0 bytes native.** Only the plugin's Kotlin (small, [estimate] 20–40 KB of dex) | requery's `sqlite-android` README: armeabi-v7a ~1.2 MB, arm64-v8a ~1.7 MB, x86 ~1.7 MB, x86_64 ~1.8 MB per ABI [checked: https://github.com/requery/sqlite-android] | Room runtime + generated code (dex). Uses Android's SQLite by default, so 0 native bytes [reasoned] |
| SQLite version | the phone's own: **3.9 on Android 7**, newer on newer phones (§1.2) | the same new version on every phone (requery ships 3.50.4) [checked: same README] | the phone's own |
| Update hook, extensions | none in the public API (§2.6) [checked] | yes, full C API | none (Room uses triggers) |
| Fits OTA | yes: SQL text lives in the JS bundle | yes | **no**: Room's queries are Kotlin code made at compile time, so an OTA bundle can't add a query [reasoned] |
| iOS later | iOS has a public system SQLite too [reasoned] | same `.so` idea | Android only |

**Choice: Android's own SQLite.** It adds no native size, which was the whole reason ZeroBill left drift. Room is
out because its queries can't change over the air. A bundled SQLite stays a later option for an app that really
needs new SQL features (then 1.2–1.7 MB per ABI; an App Bundle ships one ABI per phone).

**"Not a public NDK library": what it means.** Since Android 7 (API 24) an app can't load a platform library that is
not in the public NDK list; `dlopen` and `System.loadLibrary` fail [checked:
https://developer.android.com/about/versions/nougat/android-7.0-changes, "NDK Apps Linking to Platform Libraries"].
The system `libsqlite.so` is not on that list [reasoned: it is not in the NDK's stable API list]. So:
- **Our C++ core can't call SQLite directly.** The plugin talks to SQLite through the Kotlin / Java classes
  (`SQLiteDatabase`, `SQLiteStatement`, `Cursor`). Every call goes JS → C++ → JNI → Kotlin → SQLite and back.
- We get only what those classes expose. No `sqlite3_update_hook`, no custom C functions, no extensions.
- The JS side can't be synchronous like `storage` (which is C++ only). That is fine: SQL can be slow, so it must be
  async anyway (§2.4).

### 1.2 SQLite version per Android API level (from API 24 up)

From the official package page [checked: https://developer.android.com/reference/android/database/sqlite/package-summary].
The page says: a release that is not in its table uses the version of the next lower listed release; SQLite can also
be upgraded within an API level (it happened in API 34); patch levels are not listed; **some phone makers ship a
different version.**

| Android | API | SQLite |
|---|---|---|
| 7.0, 7.1 | 24, 25 | **3.9** (25 is not listed, so it uses 24's) |
| 8.0 | 26 | 3.18 |
| 8.1 | 27 | 3.19 |
| 9, 10 | 28, 29 | 3.22 (29 not listed) |
| 11 | 30 | 3.28 |
| 12, 12L, 13 | 31, 32, 33 | 3.32 |
| 14 | 34 | 3.39, later 3.42 (upgraded within API 34) |
| 15 | 35 | 3.44 |
| 16 | 36 | 3.44 (36 not listed, so 35's) |
| 16 QPR2 | 36.1 | 3.50 |
| next | 37 | 3.50 |

zn's `minSdk` is 24 [checked: `android/runtime/build.gradle.kts:14`], so the oldest phone we support has SQLite 3.9.

### 1.3 Features missing on old phones

| Feature | First SQLite | First API with it (by the table) | Source for the SQLite version |
|---|---|---|---|
| UPSERT (`ON CONFLICT ... DO UPDATE`) | 3.24.0 | **30** | [checked: https://www.sqlite.org/releaselog/3_24_0.html] |
| Window functions (`OVER (...)`) | 3.25.0 | **30** | [checked: https://www.sqlite.org/releaselog/3_25_0.html] |
| `ALTER TABLE ... RENAME COLUMN` | 3.25.0 | **30** | [checked: same page] |
| Generated columns | 3.31.0 | **31** | [checked: https://www.sqlite.org/releaselog/3_31_0.html] |
| `RETURNING` | 3.35.0 | **34** | [checked: https://www.sqlite.org/changes.html] |
| `ALTER TABLE ... DROP COLUMN` | 3.35.0 | **34** | [checked: same page] |
| `STRICT` tables | 3.37.0 | **34** | [checked: same page] |
| JSON functions built in by default, `->` / `->>` | 3.38.0 | **34** for sure | [checked: https://www.sqlite.org/json1.html] |

**JSON before 3.38:** the JSON functions were an opt-in compile option (`SQLITE_ENABLE_JSON1`) [checked: json1.html].
Whether Android turned it on before API 34 is **not verified**. One developer reports "no such function" for
`json_extract` on an Android phone with SQLite 3.19.4 [checked:
https://forums.expo.dev/t/sqlite-json1-functions-on-android/7676]. Treat JSON functions as missing below API 34.

So a ZeroBill-like app (minSdk 24, many Android 8–10 phones) **can rely on none of these**.

**The rule for app authors: write SQL for SQLite 3.9.**
- **Do:** `INSERT OR IGNORE` then `UPDATE`, in one `batch`, instead of UPSERT.
- **Don't:** use `INSERT OR REPLACE` as an UPSERT on a table that other tables point to. REPLACE deletes the old row
  and inserts a new one: delete triggers run and `ON DELETE CASCADE` deletes child rows [reasoned].
- **Do:** read the new row id from `run(...)`'s `lastInsertRowId` instead of `RETURNING`.
- **Do:** keep JSON as `TEXT` and parse it in JS. Filter and sort on real columns, never inside JSON.
- **Do:** write computed values yourself (no generated columns). Rank and running totals: in JS, on one page of rows.
- **Do:** page with plain `<` / `=` comparisons (§2.5), not row values `(a, b) < (?, ?)` (newer than 3.9 [reasoned]).
- **Know:** `db.sqliteVersion` tells you the phone's version. Using newer SQL behind a version check is allowed, but
  both paths must then be tested. Better: don't.
- **Why:** a query that works on your test phone fails with "syntax error" on an Android 8 phone. That shows up only
  in production.
- **How the plugin helps:** a check in dev builds and in the migration checker (§3.4) warns on the words above
  (`DO UPDATE`, `RETURNING`, `OVER (`, `GENERATED`, `STRICT`, `json_`, `->>`, `DROP COLUMN`, `RENAME COLUMN`), and the
  test suite runs on an API 24 emulator (§8, DB.8).

---

## 2. The JS API

Package `@zero-native/sqlite`, native module `Sqlite` version 1. Names follow **expo-sqlite**, the most used RN
SQLite library (2.63 M downloads in the week to 2026-11-03, against 680 K for op-sqlite and 130 K for WatermelonDB
[checked: https://api.npmjs.org/downloads/point/last-week/expo-sqlite and the same URL for
`@op-engineering/op-sqlite`, `@nozbe/watermelondb`]), **without the `Async` suffix**, because in zn every native call
is async and no other API has the suffix (`SecureStore.get`, `Updates.check`). Pavan's brief said `execute` and
`query`: here they are `run` and `getAll` / `getFirst` (§5 has the reason).

### 2.1 Open a database

```ts
import { openDatabase, sql } from "@zero-native/sqlite"
import { migrations } from "./db/migrations"

const db = await openDatabase("zerobill", {
  migrations,                 // §3: run at open, in one transaction
  kind: "cache",              // "cache": the plugin may delete and rebuild it (§3.3); default "data": never
})
db.sqliteVersion              // "3.22.0" on an Android 9 phone
```

- Name: 1–64 characters from `A-Z a-z 0-9 . _ -`, the same rule as `createStorage` [checked:
  `packages/core/src/storage.ts`, `ID`]. Per-user databases: `openDatabase(\`user.${id}\`)`, and
  `deleteDatabase(\`user.${id}\`)` on sign-out.
- The same name gives the same handle; a second `openDatabase` waits for the first and shares it.
- Open never blocks the first screen. **Don't** `await` it before `startApp`: show the screen, then fill it (§3.3 says
  why: the OTA first-screen rule).

### 2.2 `run`, `getAll`, `getFirst`: bound values only

```ts
interface Database {
  readonly name: string
  readonly sqliteVersion: string
  /** INSERT / UPDATE / DELETE / CREATE ...: one statement. */
  run(sql: string | SqlQuery, params?: SqlValue[]): Promise<RunResult>
  /** Rows as objects. Rejects with "too_many_rows" past the cap (§7.4). */
  getAll<T = Row>(sql: string | SqlQuery, params?: SqlValue[], options?: QueryOptions): Promise<T[]>
  /** The first row, or null. */
  getFirst<T = Row>(sql: string | SqlQuery, params?: SqlValue[]): Promise<T | null>
  /** Rows as arrays in column order (for Drizzle, §4, and for speed). */
  getValues(sql: string | SqlQuery, params?: SqlValue[], options?: QueryOptions): Promise<SqlValue[][]>
  batch(statements: BatchStatement[]): Promise<RunResult[]>                 // §2.3
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>         // §2.3
  watch<T = Row>(spec: WatchSpec): LiveQuery<T>                             // §2.6
  close(): Promise<void>
}
type SqlValue = string | number | boolean | null   // boolean is saved as 1 / 0
interface RunResult { changes: number; lastInsertRowId: number }  // expo-sqlite's field names
interface QueryOptions { maxRows?: number; signal?: AbortSignal }
interface SqlQuery { sql: string; params: SqlValue[] }

// The `sql` tag turns every ${value} into a bound value. It never pastes text into the SQL.
await db.run(sql`UPDATE receipts SET status = ${status} WHERE id = ${id}`)
const r = await db.getFirst<Receipt>("SELECT * FROM receipts WHERE id = ?", [id])
```

- **One statement per call.** The plugin refuses SQL with more text after the first `;` (`invalid_sql`). No
  multi-statement `exec` for app code: only migrations run several statements. **Why:** expo-sqlite's `execAsync`
  runs a whole string with no escaping and its own docs warn it allows SQL injection [checked:
  https://docs.expo.dev/versions/latest/sdk/sqlite/].
- **No transaction control by hand:** `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ATTACH`, `PRAGMA` in `run` are
  refused (`invalid_sql`). Use `batch` / `transaction`. **Why:** one writer connection is shared by all code; a
  forgotten `COMMIT` would hold every write of the app [reasoned].
- **Values:** `undefined`, objects, arrays → `invalid_args`. Whole numbers above 2^53 can't be held exactly in JS: the
  plugin rejects them as params, and a column value that big comes back as `unsafe_integer`. Keep server ids as
  `TEXT`; money in paise fits easily [reasoned]. **No BLOBs in v1** (`blob_not_supported`): keep files as files and
  store their `zn://file` handle (ARCHITECTURE §15.4).
- **How strings stay out of SQL** (Pavan's "bound values only"): (1) the API takes values separately; (2) the `sql`
  tag; (3) later a compiler warning when the first argument is not a string literal, a `const`, or a `sql` tag (like
  the literal check for `nativeModule` names [checked: `docs/ota.md` §3.2]); (4) in dev builds, a warning when one
  call site sends more than 50 different SQL texts (a sign of values pasted in). (4) also protects speed: Android's
  statement cache has a fixed maximum per connection (`setMaxSqlCacheSize` and `MAX_SQL_CACHE_SIZE`, API 11 [checked:
  https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase]; the value 100 is [reasoned]).
- **Typed binding in Kotlin.** `rawQuery(sql, String[])` binds every value as text. The plugin binds with types
  instead (`bindLong`, `bindDouble`, `bindString`, `bindNull`) through `rawQueryWithFactory` and the `SQLiteQuery`
  it hands to the cursor factory. This is how androidx.sqlite does it [checked:
  `androidx/sqlite/sqlite-framework/.../FrameworkSQLiteDatabase.android.kt` on github.com/androidx/androidx]. Writes
  use `compileStatement` + `executeInsert` / `executeUpdateDelete` (they give the row id and the change count on
  API 24) [reasoned; `getLastInsertRowId` / `getLastChangedRowCount` exist only from API 35, checked on the
  SQLiteDatabase page].
- **Error codes** (`NativeError.code`, the existing pattern [checked: `packages/core/src/calls.ts`]): `invalid_sql`
  (syntax, unknown column: the message has SQLite's text), `constraint` (UNIQUE / NOT NULL / FOREIGN KEY),
  `too_many_rows`, `row_too_big`, `disk_full`, `busy`, `corrupt`, `closed`, `invalid_args`, `unsafe_integer`,
  `blob_not_supported`, `transaction_timeout`, `migration_*` (§3).

### 2.3 Transactions and batch inserts

```ts
// batch: one native call, one transaction, all or nothing. No JS runs in the middle.
await db.batch([
  { sql: "INSERT OR IGNORE INTO receipts (id, store_id, amount_paise, created_at) VALUES (?, ?, ?, ?)", params: [...] },
  { sql: "UPDATE receipts SET status = ? WHERE id = ?", params: [...] },
  { sql: "UPDATE sync_state SET cursor = ? WHERE name = 'receipts'", params: [nextCursor] },
])
// The same statement for many rows: prepared once, bound per row (fast path for sync).
await db.batch([{ sql: "INSERT OR IGNORE INTO receipts (...) VALUES (?, ?, ?, ?)", rows: page.map(toParams) }])

// transaction: when JS must decide between steps. Exclusive: other calls wait until it ends.
const id = await db.transaction(async (tx) => {
  const open = await tx.getFirst<{ n: number }>("SELECT count(*) AS n FROM drafts WHERE store_id = ?", [storeId])
  if (open!.n > 0) return null
  return (await tx.run("INSERT INTO drafts (store_id) VALUES (?)", [storeId])).lastInsertRowId
})
```

- **`batch` is the default for writes.** It is atomic, fast (one thread hop, one commit), and it can't deadlock. Sync
  code saves the page of rows **and** the sync cursor in the same batch, so a kill can't save one without the other
  (§7.3).
- **`transaction` is exclusive** (unlike expo-sqlite's `withTransactionAsync`, whose docs warn that "any query that
  runs while the transaction is active will be included in the transaction" [checked: expo docs above]). Native holds
  every call that is not from `tx` in its queue until the body ends. The body throws → `ROLLBACK`. The body returns →
  `COMMIT`.
- **Deadlock guard:** if the body awaits a plain `db.*` call, that call waits for the transaction, which waits for
  the body. So: no call from `tx` for 5 s → native rolls back, the body's next `tx` call and the outer Promise reject
  with `transaction_timeout`. Dev builds also throw at once when a plain `db.*` call is made while a body is running
  in the same JS task [reasoned].
- **A JS restart in place** (`Updates.applyNow`, an OTA rollback) kills the body. The plugin hears
  `onRuntimeReplaced` [checked: `android/runtime/src/main/java/dev/zeronative/runtime/ZnActivity.kt:27`, fired from
  `ZnRuntime.kt:310`] and rolls back an open transaction. Note: the new JS may already call `openDatabase` before that
  event; its call waits in the queue behind the rollback, which is correct [reasoned].
- **Writes are not tied to the screen.** `callNative` drops a screen's calls when the screen closes [checked:
  `calls.ts`, `owned`]. A write must still finish, so `run`, `batch` and `transaction` use `owned: false`. Reads
  (`getAll`, `watch`) stay owned: a closed screen cancels them.

### 2.4 Async, off the JS thread

The plugin uses zn's existing native call path: `nativeModule<SqliteModule>("Sqlite", { version: 1 })` →
`callNative` → `__zn_call` → `ZnModules` → the module → the answer as app event 7 [checked: `packages/core/src/calls.ts`
header, `android/runtime/.../ZnModules.kt`]. `ZnModules` runs calls on a shared 2-thread pool [checked:
`ZnModules.kt:145`, `docs/native-modules.md` §2]. SQLite needs strict order, so the module hands each call to **one
serial thread per database** (`zn-sqlite-<name>`), the "own serial thread" choice that `docs/native-modules.md` §3.2
already allows [checked]. The JS thread and the UI thread never wait.

- **Order:** calls run in the order JS made them. A `getAll` sent after a `run` sees that write [reasoned: one
  thread, one queue].
- **Cancel:** an `AbortSignal` on a read that is still queued removes it; a running read gets Android's
  `CancellationSignal` (`rawQueryWithFactory` takes one) [reasoned]. Writes can't be cancelled once started.
- **Wire format:** native answers `{ columns: [...], rows: [[...], ...] }` (each column name once), and JS builds the
  objects. **Why:** for 8 columns the JSON is roughly half the size of an array of objects, and `JSON.parse` on the JS
  thread is the main cost of a big result [estimate; measured in DB.7]. A binary answer (`resolveBytes`, app event 9
  [checked: `calls.ts`]) is a later speed-up if DB.7 shows JSON is the bottleneck.
- **Kotlin side for native code** (a push handler that saves a receipt): `ZnSqlite.database(context, "zerobill")`
  gives the same serial thread, the same rules and the same change events, so a JS `watch` updates when Kotlin
  writes. Main process only, like `ZnStorage` [checked: `docs/storage.md` §7].

### 2.5 Paging for `<List>` windows

`<List>` keeps a JS array and mounts only ~40 rows near the screen; `onEndReached` fires once per row count, 5 rows
from the end [checked: `docs/lists.md` §2–3]. So a page of SQL rows maps straight onto it:

```ts
const feed = db.watch<Receipt>({
  tables: ["receipts"],
  sql: "SELECT id, store_name, amount_paise, created_at, status FROM receipts ORDER BY created_at DESC, id DESC LIMIT ?",
  params: () => [limit()],            // a function that reads signals: the query runs again when they change
})
<List data={feed.rows()} key={(r) => r.id} row={(r) => <ReceiptRow r={r} />}
      onEndReached={() => limit.set(Math.min(limit() + 50, 1000))} />
```

- **Up to the cap (1,000 rows), grow the `LIMIT`.** One query, always live, the list keeps its scroll position
  (`LIST_SPLICE` keeps the first visible key [checked: `docs/lists.md` §3]).
- **Older than that: keyset pages** ("start after the last row I have", not `OFFSET`, which reads and throws away
  every skipped row [reasoned]). Written for SQLite 3.9:
  `WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT 50`, with an index on
  `(created_at, id)`. A helper `pages(db, spec)` gives `{ rows, loadMore, hasMore }` for this. Pages older than the
  live window are plain reads (not live).
- **Later (v1.1): rows that never pass through JS.** `docs/lists.md` §6 already designs a native data source that
  reads SQLite cursors on an I/O thread into the row cache [checked]. This plugin is its natural source. Not needed
  for ZeroBill's lists (hundreds to a few thousand rows).

### 2.6 `watch`: live queries

```ts
interface WatchSpec {
  tables: string[]                      // the tables the query reads; required
  sql: string | SqlQuery
  params?: SqlValue[] | (() => SqlValue[])
  maxRows?: number
}
interface LiveQuery<T> {
  rows: () => T[]                       // a signal read: [] until the first answer
  loading: () => boolean
  error: () => NativeError | null
  refresh(): void
  stop(): void                          // also called when the screen (owner) closes
}
```

**How changes are detected.** `SQLiteDatabase` has **no update hook and no change callback** in its public API
[checked: https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase; the closest,
`getLastChangedRowCount`, is a count, API 35 only]. `setCustomScalarFunction` could let SQL call Kotlin, but only
from API 30 and only with strings [checked: same page, "Added in API level 30"]. So three ways are left:

| Way | Catches | Problem |
|---|---|---|
| (a) The app says which tables each write touches (`run(sql, params, { tables })`) | what the app remembers to say | wrong the day someone forgets; triggers and `ON DELETE CASCADE` change other tables silently |
| (b) The plugin reads the table name out of the SQL text | simple `INSERT INTO x` | fragile: `WITH`, triggers, cascades |
| (c) **Temporary triggers, like Room** | every write through the plugin, including triggers and cascades | one tiny extra write per changed row |

**Choice: (c), Room's proven method.** Room's `TriggerBasedInvalidationTracker` creates, for each watched table,
`CREATE TEMP TRIGGER ... AFTER INSERT|UPDATE|DELETE ON <table> BEGIN UPDATE <log> SET invalidated = 1 ... END`, and
after each write transaction it reads which tables were marked [checked:
`room3/room3-runtime/src/commonMain/kotlin/androidx/room3/InvalidationTracker.kt`, github.com/androidx/androidx, the
class comment and `startTrackingTable`]. Ours:
1. When the first watcher of a table appears, the writer thread creates `temp.zn_changed(tbl TEXT PRIMARY KEY)` (once)
   and three temp triggers on that table: `INSERT OR IGNORE INTO temp.zn_changed VALUES ('receipts')`. When the
   last watcher goes, the triggers are dropped. Unwatched tables cost nothing.
2. Every write call (`run`, `batch`, `transaction`, Kotlin writes) ends on the writer thread with: read
   `temp.zn_changed`, clear it, `COMMIT`. A rollback undoes the marks too, so a failed write sends nothing.
3. After the commit, native sends one module event `changed { db, tables }` (app event 8, the existing path
   [checked: `calls.ts`]). One event per commit, so a batch of 10,000 rows is one event.
4. JS marks the watchers whose `tables` overlap. Each one runs its query again at most once at a time; a change
   during a run means one more run after it. Several commits in one JS turn give one run.
5. **No new value when nothing changed:** JS sends the hash of its last answer; native answers `{ same: true }` if
   the new rows hash the same. No JSON, no signal update, no list work [reasoned].

- **Temp triggers belong to one connection.** They work because all writes go through the plugin's writer
  connection. Android sends writes to its primary connection; readers may use other connections in WAL mode, and they
  don't need the triggers [reasoned; Room relies on the same thing on Android's SQLite]. DB.5 tests it directly.
- **Writes the plugin doesn't see** (another library opening the same file) are not caught. Rule: only the plugin
  opens its files. `db.notifyChanged(["receipts"])` exists for the rare case.
- **`tables` must be right.** Dev builds run `EXPLAIN QUERY PLAN` once per watch and warn if the plan names a table
  that is not in `tables` [reasoned; the plan text names tables, check aliases in DB.5].
- Like op-sqlite, the whole query runs again on a change [checked: op-sqlite reactive queries page,
  https://op-engineering.github.io/op-sqlite/docs/reactive_queries]. Keep watched queries small (a page, a count).

---

## 3. Migrations and OTA

### 3.1 Versioned migrations in the JS bundle

```ts
// src/db/migrations.ts: append only. Never edit or remove a shipped entry.
export const migrations: Migration[] = [
  { id: 1, name: "receipts", sql: [
      `CREATE TABLE receipts (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, store_name TEXT NOT NULL,
         amount_paise INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT)`,
      `CREATE INDEX receipts_by_time ON receipts (created_at, id)`,
      `CREATE TABLE sync_state (name TEXT PRIMARY KEY, cursor TEXT)`,
  ] },
  { id: 2, name: "receipt_gst", sql: [`ALTER TABLE receipts ADD COLUMN gst_no TEXT`] },
]
```

**At open, on the writer thread, in one `BEGIN IMMEDIATE` transaction:**
1. Create `zn_migrations(id INTEGER PRIMARY KEY, name TEXT, sha TEXT, applied_at INTEGER, bundle TEXT)` if missing.
2. For each migration the database already has: the bundle's entry with that id must have the same SHA-256 of its
   SQL. Different → `migration_changed` (§3.3).
3. Ids the database has but the bundle doesn't know → **allowed** ("database ahead of the bundle", §3.2). Logged.
4. Run the missing ones in id order. Each statement goes through the add-only check (§3.4) first.
5. Write their rows (with the running bundle id, for support) and set `PRAGMA user_version` to the highest id (so the
   `sqlite3` tool shows it).
6. `COMMIT`. Any error → `ROLLBACK`: the database stays exactly as it was, and `openDatabase` rejects with the
   failing id and SQLite's message.

`PRAGMA user_version` alone is not enough: it is one number [checked: https://www.sqlite.org/pragma.html], and it
can't tell "the database is ahead" from "this migration was changed". Hence the table. This matches what Drizzle's
migrator records (a hash per migration) [checked: `drizzle-orm/src/sqlite-proxy/migrator.ts` on GitHub].

### 3.2 An OTA adds a migration, then a rollback brings back an older bundle

What `docs/ota.md` says [checked: §3.1, §3.5, §3.6]: a downloaded bundle is on trial until healthy (screens up 4 s in
the foreground, or `Updates.markHealthy()`). An error screen, a hang, a start failure or **no first screen in 10 s**
blocks it and runs the last good bundle **in place**. A crash blocks it at the next start. Rollback goes to the last
good bundle or to the APK's own bundle; the server can also point back (rollback) or to "built-in" (kill switch).
FlowStore, storage and files are untouched by an apply. Up to 4 older bundles stay on the phone.

So this happens, and the plugin must handle it:
1. Bundle #12 adds migration 2 (`gst_no`). The phone runs #12; `openDatabase` applies migration 2.
2. #12 shows an error screen before healthy → blocked → #10 runs in place. #10 knows only migration 1.
3. #10 opens the database: it has migration 2, #10 doesn't know it. **Step 3 in §3.1: allowed.**
4. #10's code keeps working **only if migration 2 changed nothing #10 depends on.** Adding a nullable column or a new
   table is fine: #10 never reads them, and its inserts leave `gst_no` NULL.
5. Later #13 (the fix) ships migration 2 **unchanged** plus a new migration 3. The database skips 2, runs 3.

What would break: a migration that renames or drops something #10 reads, adds `NOT NULL` without a default (#10's
inserts fail), or adds a UNIQUE index or a trigger on an old table (#10's writes fail). Also: #13 sending a different
migration 2 (phones that ran #12 keep the old one).

Two more facts from ota.md shape the rules:
- **The oldest code that can ever run is the APK's own bundle** (kill switch, or no good bundle left). A newer APK
  always wins and drops bundles older than its own [checked: §3.1, §3.6 "New APK install"]. So any bundle can meet a
  database migrated by any newer bundle.
- **The first-screen rule:** if the first screen waits for a slow migration for 10 s, the new bundle is rolled back,
  while its migration may already be committed. Hence "don't await `openDatabase` before the first screen" (§2.1) and
  "no big data work in migrations" (§3.4).

### 3.3 The rule: add only

**For app authors (guide note, when built):**
- **Do:** only add: new tables, new nullable columns (or with a `DEFAULT`), new non-unique indexes, new views. A UNIQUE
  index or a trigger only on a table made in the same migration (older code doesn't know that table).
- **Do:** treat a new column as "may be NULL" in new code: rows written by an older bundle (after a rollback) don't
  fill it.
- **Do:** name columns in every `INSERT` (`INSERT INTO t (a, b) VALUES ...`). `INSERT INTO t VALUES (...)` breaks
  when a column is added.
- **Don't:** rename or drop a table or a column, change a column's type, or add NOT NULL / UNIQUE / CHECK rules to an
  old table. (Old phones can't even rename or drop columns: §1.3.)
- **Don't:** edit or remove a migration once a build with it went to any channel, staging included. Fix forward with a
  new id.
- **Don't:** put big data work in a migration (a backfill `UPDATE` over thousands of rows). Do it after the first
  screen, in batches.
- **Need a real change?** Add a new table (`receipts_v2`), copy into it, read from it in new code. The old table stays.
  For a `kind: "cache"` database (all rows come from the server again), dropping and rebuilding is fine: that is the
  `reset` path below.
- **Why:** an OTA rollback brings back older code against the newer database. Add-only changes are invisible to older
  code. WatermelonDB has the same rule: its migrations support only `createTable` and `addColumns`, and "deleting or
  renaming tables and columns" is not implemented [checked: https://watermelondb.dev/docs/Advanced/Migrations].

**For `kind: "cache"` databases:** on `migration_changed`, a refused migration, or a damaged file, the plugin deletes
the file (and `-wal`, `-shm`) and builds it again from migration 1, then reports `sqlite.reset`. The app syncs again.
WatermelonDB also resets when no migration path exists [checked: same page]. For `kind: "data"` (the default) it
never deletes: it rejects with the code and reports a serious error.

### 3.4 How the plugin enforces it

1. **At run time, in release builds too** (cheap: a few keyword checks per statement, after removing comments): the
   checker allows `CREATE TABLE`, `CREATE INDEX` (non-unique), `CREATE VIEW`, `ALTER TABLE ... ADD COLUMN`,
   `INSERT`, `UPDATE`, `DELETE`, and `CREATE UNIQUE INDEX` / `CREATE TRIGGER` only on a table made in the same
   migration. It refuses `DROP`, `RENAME`, `DROP COLUMN`, `PRAGMA`, `BEGIN` / `COMMIT`, `ATTACH`, and the new-SQLite
   words of §1.3 → `migration_refused` (the whole open is rolled back). SQLite itself refuses
   `ADD COLUMN ... NOT NULL` with no default [reasoned].
2. **At test time:** a helper `checkMigrations(migrations, "sqlite-migrations.lock.json")` for the app's `bun test`. The
   lock file keeps id, name and SHA of every shipped migration; the test fails if one changed or disappeared. Same
   idea as `packages/template/registry.lock.json` for the registry [checked: `docs/ota.md` §3.2].
3. **At run time, SHA check** (§3.1 step 2) catches what slipped through: dev builds throw, release builds follow
   `kind` (§3.3).
4. An `unsafe: true` or `reset: true` flag on a migration skips check 1. They are Pavan's opt-in for real schema
   changes (§3.5). The test helper and the OTA release tool print a loud warning for them; they don't refuse.

### 3.5 Unsafe and reset migrations (Pavan's call, 2026-11-04)

Add-only is the default and what the guide asks for. When a team really needs a rename, a drop or a new shape, it can
opt in, **if the app can sync the data again from the server** (ZeroBill can: passbook, offers).

```ts
{ id: 7, name: "receipts_shape_2", unsafe: true, sql: [`ALTER TABLE receipts RENAME COLUMN amount TO amount_paise`] },
{ id: 9, name: "offers_rebuild", reset: true },   // drop everything, build again from migration 1, sync again
```

- **`unsafe: true`:** the SQL runs as written, in place (keeps the data). On old phones SQLite 3.9 has no
  `RENAME COLUMN` or `DROP COLUMN` (§1.3), so the plugin checks the phone's version and turns such a migration into a
  reset there.
- **`reset: true`:** the plugin deletes the database file and builds it again from all migrations. All rows are gone.
- **The schema epoch.** Each `unsafe` or `reset` migration starts a new "epoch" (the count of such migrations up to
  it). The database stores its epoch. This is what keeps an OTA rollback safe:
  - an older bundle (after a rollback) opens a database whose epoch it doesn't know, so it can't trust the shape;
  - the plugin then resets the database **to that older bundle's own migrations**, and the app syncs again;
  - when the fixed newer bundle runs later, it moves forward again (one more sync).
  - The cost of a rollback after an unsafe migration is therefore two syncs, never a broken screen.
- **The app's part:** `db.onReset((why) => sync.fullResync())`. The plugin calls it after any reset (`"migration"`,
  `"epoch"`, `"damaged"`, `"changed"`). An app that has no full sync from the server must not use `unsafe` or `reset`;
  the plugin warns when a database with either has no `onReset` listener.
- **Never for data that exists only on the phone** (an outbox of unsent writes): a reset loses it. Keep such tables
  in a separate database that stays add-only, or send them before the reset (`onBeforeReset`, a later step if needed).
- **Not for money state:** the pending payment stays in `flowStore` (§8 "Not").
- **Why this is safe enough:** the server is the source of truth for every row a reset drops, and the epoch makes old
  code throw the database away instead of reading a shape it doesn't know. [reasoned; DB.4 tests a rollback across
  an epoch]

---

## 4. Drizzle later (optional, no framework change)

**What Drizzle needs.** Drizzle's `sqlite-proxy` driver takes one async callback, plus an optional batch callback
[checked: `drizzle-orm/src/sqlite-proxy/driver.ts`, github.com/drizzle-team/drizzle-orm, main branch]:

```ts
export type AsyncRemoteCallback = (sql: string, params: any[], method: 'run' | 'all' | 'values' | 'get') => Promise<{ rows: any[] }>;
export type AsyncBatchRemoteCallback = (batch: { sql: string; params: any[]; method: 'run' | 'all' | 'values' | 'get' }[]) => Promise<{ rows: any[] }[]>;
drizzle(callback, batchCallback?, config?)
```

Its session reads `all` / `values` rows as **arrays in column order** and maps them by its own field list; `get`
reads one row array [checked: `drizzle-orm/src/sqlite-proxy/session.ts`]. That is exactly `getValues`.

**The adapter** (a small file, `@zero-native/sqlite/drizzle`, [reasoned] sketch):

```ts
import { drizzle } from "drizzle-orm/sqlite-proxy"
export function drizzleFor<S extends Record<string, unknown>>(db: Database, config?: { schema: S }) {
  const one = async (sql: string, params: any[], method: "run" | "all" | "values" | "get") => {
    if (/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(sql)) throw new Error("sqlite: use orm.batch(), not orm.transaction() (docs/sqlite-plugin-proposal.md §4)")
    if (method === "run") { await db.run(sql, params); return { rows: [] } }
    const rows = await db.getValues(sql, params)
    return { rows: method === "get" ? rows[0] : rows }       // check the empty "get" case against Drizzle's tests
  }
  const many = async (qs: { sql: string; params: any[]; method: any }[]) => /* db.batch for writes, getValues for reads */ ...
  return drizzle(one, many, config)
}
```

- **Drizzle's `transaction()` is not supported in v1.** Its proxy sends `begin`, the statements and `commit` as
  separate `run` calls through the same callback [checked: `session.ts`]. The callback can't tell the transaction's
  statements from other code's statements made at the same time: expo-sqlite's exact warning (§2.3). So the adapter
  refuses `begin` with a clear message, and atomic writes use `orm.batch([...])`, which goes through the batch
  callback as one native call. Supporting it later would need a transaction id on each call, which Drizzle's callback
  doesn't give.
- **Migrations:** drizzle-kit writes SQL migration files. We import their SQL into our `migrations` list and our plugin
  runs them (§3), not Drizzle's `migrate()` (whose proxy form just hands us `string[]` [checked: `migrator.ts`]). A
  good side effect: when drizzle-kit writes a `DROP` or a table copy for a schema edit, our add-only checker refuses it
  in dev, so the rule is visible early [reasoned].
- **What replaces `useLiveQuery`.** Drizzle's expo helper is a React hook (`useState`, `useEffect`) that listens with
  expo-sqlite's `addDatabaseChangeListener` and runs the query again when `config.name === tableName` [checked:
  `drizzle-orm/src/expo-sqlite/query.ts`]. zn has no hooks. Ours is `liveQuery(orm.select().from(receipts)...)`: it
  takes the query's `toSQL()` and its table names, and calls `db.watch` (§2.6). Same idea, signals instead of hooks.
- **Bundle cost [estimate].** The npm package is 10.5 MB unpacked in 2,690 files (v0.45.4) [checked:
  https://registry.npmjs.org/drizzle-orm/latest], but only `sqlite-core` + `sqlite-proxy` get bundled. My estimate is
  60–120 KB minified, before Hermes bytecode. Today the whole sample bundle is 346 KB raw [checked: `docs/ota.md` §1],
  so Drizzle could add a fifth to a third. Measure it (DB.10) before choosing it for ZeroBill.
- **Not checked:** whether Drizzle's code runs on Hermes V1 without changes. DB.10 tests it.

---

## 5. How it compares (so ported code feels familiar)

| | expo-sqlite | op-sqlite | WatermelonDB | **zn (this study)** |
|---|---|---|---|---|
| SQLite on Android | own build, it seems (config options for SQLCipher and build flags [checked: expo docs], so [reasoned]) | **always compiled from source on Android** [checked: https://op-engineering.github.io/op-sqlite/docs/installation] | its own adapters | **the phone's own, 0 bytes** |
| Open | `openDatabaseAsync(name, options)` | `open({ name, encryptionKey? })` | `new Database({ adapter, modelClasses })` | `openDatabase(name, { migrations, kind })` |
| Write | `runAsync(sql, params)` → `{ changes, lastInsertRowId }` | `execute(sql, params)` | `database.write(async () => ...)` | `run(sql, params)` → `{ changes, lastInsertRowId }` |
| Read | `getAllAsync`, `getFirstAsync`, `getEachAsync` | `execute` → `{ rows }`, `executeRaw` → arrays | `collection.query(Q.where(...)).fetch()` | `getAll`, `getFirst`, `getValues` |
| Transaction | `withTransactionAsync` (not exclusive), `withExclusiveTransactionAsync` (new connection) | `transaction(async tx => ...)` | inside `write` | `transaction(async tx => ...)`, exclusive |
| Batch | — | `executeBatch` | `batch` | `batch` |
| Live | `addDatabaseChangeListener` (needs `enableChangeListener`) | `reactiveExecute({ query, arguments, fireOn: [{ table, ids }] })`, **only fires for writes in transactions**, update hook | `observe()`, `observeCount()` (RxJS) | `watch({ tables, sql, params })` → signals |
| Migrations | by hand with `PRAGMA user_version` | by hand | `schemaMigrations`: `createTable`, `addColumns` only | built in, add-only, checked |

Sources: expo [checked: https://docs.expo.dev/versions/latest/sdk/sqlite/], op-sqlite [checked:
https://op-engineering.github.io/op-sqlite/docs/api and `/reactive_queries`], WatermelonDB [checked:
https://watermelondb.dev/docs/Query and `/Advanced/Migrations`].

**Names chosen:** expo-sqlite's (the most used, §2) without `Async`: `run`, `getAll`, `getFirst`, and its result
fields `changes`, `lastInsertRowId`. `transaction` and `batch` from op-sqlite and Drizzle (expo has no batch, and its
transaction name means "not exclusive", which ours is not). `getValues` from Drizzle's `values` method. `watch` is
ours (Pavan's word; no library shares one name for it). **Why not `execute` / `query`:** a ported expo screen then
changes only by dropping `Async`, and `execute` in op-sqlite is both read and write, which hides whether a call
changes data. A thin `@zero-native/sqlite/expo` file with the exact `...Async` names is cheap if a big port needs it.

---

## 6. Core or official opt-in plugin

**Official opt-in plugin: `plugins/sqlite/` (`@zero-native/sqlite`, module `Sqlite` v1).**
- **Why:** many apps need no SQL. A plugin costs nothing for them: no dex, no module, no start-up work. It follows D5
  (official plugins live in `plugins/<name>/`) and the pattern of `pdf` and `location`, which are also built on
  Android's own APIs with no new library [checked: `docs/plugins.md` §7, `plugins/pdf/README.md`].
- **What stays in core:** `storage` (settings, drafts), `flowStore` (money state), `SecureStore` (secrets). The
  database is for app data: lists and caches.
- **Host API impact: none.** The host API number covers the `__zn_*` host functions, app event numbers, the batch and
  value formats [checked: `packages/core/src/host-api.ts`]. The plugin uses only `callNative` and module events (app
  events 7, 8, 9, which exist). Its version goes in each bundle's `requires.modules`, so an app without the plugin, or
  with an older one, refuses a bundle that needs it [checked: `docs/plugins.md` §1 and §3 "OTA rule for plugins",
  `docs/guide-notes.md` §30]. Raise `Sqlite`'s version with every new native function.
- **One later core item:** the `<List>` native data source (`docs/lists.md` §6) is a renderer feature in core; this
  plugin would feed it. Not needed for v1.

---

## 7. Threads, locks and safety

### 7.1 WAL mode
- Open with `ENABLE_WRITE_AHEAD_LOGGING` (API 11) [checked: SQLiteDatabase page]. WAL ("write-ahead log": changes go
  to a side file first, and are copied into the main file later) lets readers and the writer work at the same time,
  "but there can only be one writer at a time" [checked: https://www.sqlite.org/wal.html].
- `synchronous = NORMAL`: in WAL mode it is "safe from corruption", "always consistent", and commits "are durable
  across application crashes"; only a power loss can undo the last commits [checked:
  https://www.sqlite.org/pragma.html]. On API 33+ through `OpenParams` (its `JOURNAL_MODE_*` / `SYNC_MODE_*` constants
  are API 33 [checked]); below, a `PRAGMA` on the writer connection after open [reasoned; DB.1 checks it sticks].
- Foreign keys on (`setForeignKeyConstraintsEnabled`, API 16 [checked]).
- WAL file growth: a reader that never ends stops checkpoints and the WAL grows [checked: wal.html]. Our reads are
  short, one call each; no cursor stays open across calls [reasoned].

### 7.2 One writer
- **v1: one serial thread per database does everything** (reads and writes), like op-sqlite's "single separate and
  dedicated thread" [checked: op-sqlite API page]. Simple, and order is exact.
- Cost: a long `batch` makes a `getAll` wait. If DB.7 shows reads waiting too long behind sync writes, v1.1 sends reads
  to WAL reader connections, after all earlier writes of the same JS (Android runs parallel queries on extra
  connections in WAL mode [checked: SQLiteDatabase page]).
- Big syncs go in pages of ~500 rows per `batch`, so a read never waits for more than one page [reasoned].
- `SQLiteDatabaseLockedException` should not happen with one writer; if it does (a second process), the call fails
  with `busy`. Main process only, like `storage` [checked: `docs/storage.md` §7].

### 7.3 A kill in the middle of a transaction
- SQLite commits atomically: the transaction is in the database whole, or not at all. After a kill, the next open runs
  WAL recovery [checked: wal.html, "recovery process"], and an uncommitted transaction is simply gone [reasoned from
  the commit record rule on the same page].
- So the app must be able to do the work again: sync with `INSERT OR IGNORE` + `UPDATE` keyed by the server id, and
  save the sync cursor **in the same batch** as the rows. A kill then loses at most one page, which the next sync
  fetches again [reasoned].
- Better than `storage`: a damaged MMKV store opens empty (`docs/storage.md` §4, measured), while SQLite's journal is
  made for exactly this. DB.3 repeats the storage kill test (a child process killed at random 100 times) to prove it.
- **Damaged file:** Android's default error handler deletes a corrupt database file [reasoned: `DatabaseErrorHandler`
  default]. The plugin passes its own handler: `kind: "cache"` → delete and rebuild (§3.3); `kind: "data"` → rename
  the file to `<name>.corrupt-<time>`, report it, open a new empty one.
- **Disk full:** `SQLiteFullException` → the whole call rolls back → `disk_full`. Nothing half-written [reasoned].
- **Not for money state.** A pending payment stays in `flowStore` + the server (guide-notes §16 [checked]). The
  database may hold the passbook (a copy of server data), not the "I am in the UPI app" record.

### 7.4 Big result sets: a row cap and a clear error
- A JS answer is parsed on the JS thread. Past 200 ms it is logged as "slow JS"; past 2 s (release) JS is stopped and
  the screen shows "stopped responding" [checked: `docs/guide-notes.md` §26–27].
- **Cap: 1,000 rows or 1 MB of answer, whichever comes first.** Native stops reading the cursor at row 1,001 and
  rejects: `too_many_rows: "SELECT ... returned more than 1000 rows. Add LIMIT, or page (docs §2.5)."` A call can ask
  for `maxRows` up to 10,000 (hard limit) [reasoned; DB.7 sets the final numbers].
- One row bigger than Android's cursor window (about 2 MB) fails as `row_too_big` [reasoned].
- **Why an error and not a silent cut:** a silent cut shows a wrong total or a passbook with missing rows.
- **100,000 rows in a table (Pavan's goal).** The cap limits what one answer brings into JS, not the table. 100,000
  receipts at ~300 bytes are ~30 MB on disk, which SQLite handles easily [reasoned]. What must never happen is 30 MB
  of JSON into JS in one answer. So:
  - totals, counts, sums and filters run **in SQL** (`SELECT count(*), sum(amount_paise) ... WHERE ...`), with an
    index for each list's sort order;
  - lists use `pages()` (§2.5): a live top window plus keyset pages of 50;
  - a full read (an export) uses `each(sql, params, onPage, { pageSize: 500 })`, pages one after another, never one
    big answer;
  - a big first sync writes with `batch` of 500 rows per call, with watch triggers paused during it (risk 6).
  - **Open:** scrolling a list to row 100,000 keeps all loaded pages in JS (~100,000 small objects). DB.6 measures
    the JS heap for that. If it is too high, DB.11 (the native list source, rows never pass through JS) moves into v1.
- **Full disk:** a write fails with `disk_full` and the old data stays (WAL rolls the half write back) [reasoned].
  The app shows its low-storage screen, as for FlowStore (guide §16). A read never needs space.

### 7.5 Where the file lives
- `noBackupFilesDir/zn-sqlite/<name>.db` (+ `-wal`, `-shm`). **Not** `getDatabasePath()`, which is in Android's Auto
  Backup by default [reasoned]. Same reason as `storage`: a restored copy brings back stale state, and a file copied
  while being written can be damaged [checked: `docs/storage.md` §2 "Folder"]. What must follow the user to a new
  phone belongs on the server.
- App-private: since Android 7 the private folder is `0700` [checked: android-7.0-changes page above].
- `deleteDatabase(name)` closes it and removes all three files.

### 7.6 No secrets in it
- No tokens, PINs or keys: those go in `SecureStore` [checked: `docs/storage.md`]. No encryption in the base version.
- **What SQLCipher would cost:** it replaces Android's SQLite with its own build, so the 0-byte benefit is gone: about
  1.25 MB per ARM ABI (Zetetic's forum, an older version; another user saw 1.5–2 MB in a bundle) [checked:
  https://discuss.zetetic.net/t/sqlcipher-library-is-adding-6mb-to-apk-size/1776, dated]. Its key would live in
  `SecureStore`; if the Keystore key is lost, the database is lost too (the same problem `docs/storage.md` §5 names for
  encrypted MMKV) [reasoned]. Worth it only if the database ever holds data that must be hidden from a rooted phone.

---

## 8. The build plan

Ids **DB.1–DB.11** (S.x is taken by SVG). All are **[framework]** unless marked. None blocks the pilot. Each step adds
the plugin's `README.md` part and a guide note (`docs/guide-notes.md`, new section) as it lands.

| Step | What | Tests (done when) |
|---|---|---|
| DB.1 | `plugins/sqlite/` skeleton (`package.json`, `SqlitePlugin`, module `Sqlite` v1, serial thread per db). `openDatabase`, `close`, `deleteDatabase`, name check, file location, WAL, `NORMAL`, foreign keys, `sqliteVersion`, own error handler | JS tests with core's fake host (args, names, errors). Kotlin unit tests for the name and path rules. Sample `/dev/sqlite` page on the emulator: opens, shows version, `PRAGMA journal_mode` = wal and `synchronous` = 1 on the writer connection |
| DB.2 | `run`, `getAll`, `getFirst`, `getValues`, the `sql` tag; typed binding; type mapping; one-statement and no-transaction-control checks; row cap; error codes; cancel | JS: `sql` tag output, params checks. Kotlin: statement checker (comments, strings with `;`). Device: every type round-trips (text with Hindi + emoji, 2^53 − 1, NULL, bool), `too_many_rows` at 1,001, `invalid_sql` message, an aborted queued read never runs |
| DB.3 | `batch` (list and `rows` forms), exclusive `transaction`, 5 s timeout, rollback on `onRuntimeReplaced`, `owned: false` writes | Rollback on a failing 3rd statement leaves nothing. Another call made during a body waits. Timeout fires. `applyNow` during a body rolls back. **Kill test:** a child process writes batches nonstop and is killed at random 100 times (like `testStorageKill`, `docs/storage.md` §4): every open is clean, every batch is there whole or not at all. Disk full (the emulator trick from second-opinions 106): `disk_full`, old data intact |
| DB.4 | Migrations (§3.1), the add-only checker, `kind: "cache"` reset, `unsafe` / `reset` migrations with the schema epoch and `onReset` (§3.5), `checkMigrations` + lock file | Kotlin: checker table tests (allowed / refused statements, comments, case). Device: fresh open; upgrade 1 → 3; **rollback case** (db at 3, bundle knows 2: opens, old inserts work); changed SHA (`data` rejects, `cache` resets); a failing migration rolls back everything. Bun: the lock helper fails on an edited or removed entry |
| DB.5 | `watch`: lazy temp triggers, `changed` events, coalescing, hash skip, reactive params, owner cleanup, Kotlin `ZnSqlite` writes, `notifyChanged`, the dev `EXPLAIN` check | A write through `run`, `batch`, `transaction` and Kotlin each fires once; a rollback fires nothing; a cascade delete fires the child table; 100 writes in one turn give 1–2 re-runs; a closed screen stops its watch; a JS restart drops old watchers; triggers are dropped with the last watcher |
| DB.6 | `pages()` and `each()` helpers + a sample screen: `<List>` over **100,000** receipt rows, live top window + keyset pages | Scrolls to the end on the emulator with the JS heap measured (decides whether DB.11 moves into v1); a new row at the top appears without losing the scroll position; count and sum of 100,000 rows in SQL under 100 ms on the Lava |
| DB.7 | **Benchmark, emulator** (`Medium_Phone` AVD, release build; emulator times are only for comparing the three, Pavan's phone notes say emulator numbers don't stand in for real timings). Then the same run on the Lava for real numbers | See below |
| DB.8 | Old phones: run the DB.2–DB.5 device tests on an **API 24** emulator image (SQLite 3.9), plus the §1.3 word warnings | All pass on API 24; each warned word has a test |
| DB.9 | Docs: guide note "SQL database" (do / don't / why), ARCHITECTURE §13.1 (a third row), `docs/plugins.md` §7 row, second-opinions entries for the choices made while building | Docs match the code |
| DB.10 (later, optional) | Drizzle adapter `@zero-native/sqlite/drizzle`, `liveQuery` | Drizzle's select / insert / batch on Hermes in the sample; `begin` refused with the message; **bundle size measured** with and without Drizzle |
| DB.11 (later, v1.1) | `<List>` native data source on this plugin (`docs/lists.md` §6) | Only if an app needs lists beyond a few thousand rows |

**DB.7 benchmark.** A receipt-like row: id, store id, store name, amount in paise, status, time, UPI ref, item count,
and ~150 bytes of JSON text (about 300 bytes in all). 1,000, 10,000 and 100,000 rows (B and C only up to where
they become unusable). Three ways:
- **A. SQLite** (this plugin), index on `(created_at, id)`.
- **B. `storage`, one big JSON value** (`receipts` = the whole array).
- **C. `storage`, one key per row** (`receipt.<id>`), plus nothing else.

| Measure (median and p95 of 20 runs) | A | B | C |
|---|---|---|---|
| Load all N first (sync of a fresh install) | one `batch` per 500 rows | build array, one `set` | N `set`s |
| Add 1 row | `run` | read all, parse, push, stringify, `set` | 1 `set` |
| Change 1 row's status | `run` | as above | read, parse, change, `set` |
| Newest 50 rows | `getAll ... LIMIT 50` | read all, parse, sort, slice | `keys()`, N `get`s, parse, sort, slice |
| Count by status | `SELECT count(*) ... GROUP BY` | parse all, count | N `get`s |
| Write → screen updated | `watch` latency | `onChange` + re-read | `onChange` + re-read |
| Also | JS thread busy time per action (the "slow JS" line), JS heap after each, file size on disk, cold start with the data present, trigger cost (A with and without a watcher during the 10,000-row load) | | |

What I expect [reasoned, to be proved]: B costs grow with N on the JS thread (10,000 × 300 B = ~3 MB of JSON for
every single change); C is fast for one row but slow for any list, because there is no order; A pays ~1–3 ms per
call for the thread hop and JSON, and stays flat as N grows. If A is not clearly better at 1,000 rows, ZeroBill can
wait.

**Risks**
1. **Old SQLite (3.9 on Android 7) and makers' own versions** limit the SQL; a query fine on the test phone fails in
   the field. Mitigation: the §1.3 rule, warnings, DB.8 on API 24.
2. **Temp triggers on the right connection.** If Android ever ran a write on a connection without our triggers, a
   watch would miss it. Mitigation: all writes through one plugin thread; DB.5 tests each write path. Room depends on
   the same behaviour.
3. **JSON size and JS thread time** for big answers. Mitigation: row cap, arrays on the wire, hash skip; binary
   answers later.
4. **Interactive transactions** can deadlock or leak. Mitigation: `batch` first, exclusive lock, 5 s timeout, rollback
   on JS restart.
5. **The add-only rule gets bypassed** (`unsafe`, or a team edits a shipped migration), and an OTA rollback breaks
   old code. Mitigation: checker in release, lock file test, SHA check, `cache` reset.
6. **Trigger cost on big syncs** (one extra tiny insert per row on watched tables). Measured in DB.7; if high, the
   plugin pauses triggers during a `batch` and marks the tables once at the end.
7. **One thread for reads and writes** makes a read wait behind a sync page. Measured in DB.7; reader connections in
   v1.1.
8. **Misuse:** money state in the database instead of `flowStore`. Mitigation: the guide note says it in its first
   line.
9. **Drizzle (later):** bundle size and Hermes support unknown; no `transaction()`.

**What ZeroBill would put in it first [ZeroBill]** (after the pilot; nothing here is needed for it):
1. **Passbook: receipts and transactions** as a `kind: "cache"` database per user (`user.<id>`): rows from the
   server, newest first, live top window on the home and passbook screens, sync cursor in `sync_state`.
2. **Offers** list cache with an expiry column, so "valid offers for this store" is one indexed query.
3. **Later:** an outbox table for writes made offline (reviews, ratings), sent by a sync task.
- **Not:** the pending payment record (stays `flowStore` + `/verify`), tokens (`SecureStore`), settings (`storage`).

---

## 9. Questions for Pavan (answered 2026-11-04)
1. **Names:** expo-style `run` / `getAll` / `getFirst`. (Pavan: framework author's call.)
2. **Destructive migrations:** allowed as an opt-in (`unsafe` / `reset`) for apps that can sync again; the OTA
   release tool warns, doesn't refuse. Design in §3.5.
3. **Row cap:** 1,000 rows / 1 MB per answer by default (up to 10,000 per call), and 100,000-row tables are a v1 goal
   (§7.4). DB.6 and DB.7 give the final numbers.
4. **Android 7 (minSdk 24) stays.** SQL is written for SQLite 3.9.

**Still open (for the build):** whether DB.11 (the native list source) moves into v1, after DB.6's 100,000-row heap
numbers.
</content>
</invoke>
