// The database: Postgres through Bun's own driver (Bun.sql) in production, PGlite (Postgres in WASM, in-process) for
// local runs and tests. Both speak the same SQL; this file hides the two small API differences. Plain SQL, no ORM:
// the schema is small and the migrations are files (src/migrations/NNN_name.sql, applied in order, once).
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface Db {
  /** Runs one statement with $1, $2… parameters; returns the rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  /** Runs [fn] in one transaction: all of it, or none of it. */
  tx<R>(fn: (q: Db) => Promise<R>): Promise<R>
  close(): Promise<void>
  readonly kind: "postgres" | "pglite"
}

/**
 * Opens the database named by [url]: `postgres://…` / `postgresql://…`, or `pglite:<folder>` (`pglite:memory`).
 * [schema] (Postgres only, for tests): one connection whose tables live in that schema (it must exist).
 */
export async function openDb(url: string, schema?: string): Promise<Db> {
  if (url.startsWith("pglite:")) return openPglite(url.slice("pglite:".length))
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return openPostgres(url, schema)
  throw new Error(`DATABASE_URL must be postgres://… or pglite:<folder>, got "${url.split(":")[0]}:…"`)
}

async function openPglite(where: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite")
  const pg = where === "memory" || where === "" ? new PGlite() : new PGlite(where)
  await pg.waitReady
  const wrap = (q: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    kind: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      return (await q.query(text, params)).rows as T[]
    },
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  })
  return wrap(pg)
}

async function openPostgres(url: string, schema?: string): Promise<Db> {
  const { SQL } = await import("bun")
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`bad schema name "${schema}"`)
  const sql = schema ? new SQL({ url, max: 1 }) : new SQL(url)
  if (schema) await sql.unsafe(`SET search_path TO ${schema}`)
  // Bun's client is a tagged template; `unsafe` runs a text with parameters, as PGlite's query does.
  type Client = { unsafe: (t: string, p?: unknown[]) => Promise<unknown[]> }
  const wrap = (c: Client, inTx: boolean): Db => ({
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      return [...(await c.unsafe(text, params))] as T[]
    },
    tx: inTx ? (fn) => fn(wrap(c, true)) : (fn) => sql.begin((t: unknown) => fn(wrap(t as Client, true))) as never,
    close: () => sql.close(),
  })
  return wrap(sql as unknown as Client, false)
}

/** Applies the migrations not applied yet, in name order. Each runs in its own transaction. */
export async function migrate(db: Db, dir = join(import.meta.dir, "migrations")): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name))
  const applied: string[] = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(name)) continue
    const text = readFileSync(join(dir, name), "utf8")
    await db.tx(async (q) => {
      for (const stmt of splitSql(text)) await q.query(stmt)
      await q.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name])
    })
    applied.push(name)
  }
  return applied
}

/** Splits a migration file into statements on `;` at line ends (the files have no functions or quoted semicolons). */
function splitSql(text: string): string[] {
  return text
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)
}
