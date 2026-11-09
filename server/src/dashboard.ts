// The dashboard's files (server/web), built once in memory with Bun.build on first use. They are served only to a
// signed-in session (src/session.ts); without one every dashboard path answers 404. (A Bun HTML import would publish
// the files to everyone, which is why the server builds them itself.)
import { basename, join } from "node:path"

export interface DashboardFile {
  body: Uint8Array<ArrayBuffer>
  type: string
}

let built: Promise<Map<string, DashboardFile>> | null = null

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  map: "application/json",
}

async function build(): Promise<Map<string, DashboardFile>> {
  const r = await Bun.build({
    entrypoints: [join(import.meta.dir, "../web/index.html")],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })
  if (!r.success) throw new Error(`the dashboard did not build:\n${r.logs.map((l) => String(l)).join("\n")}`)
  const files = new Map<string, DashboardFile>()
  for (const o of r.outputs) {
    const name = basename(o.path)
    const ext = name.slice(name.lastIndexOf(".") + 1)
    files.set(name === "index.html" ? "/" : `/${name}`, { body: new Uint8Array(await o.arrayBuffer()), type: TYPES[ext] ?? "application/octet-stream" })
  }
  if (!files.has("/")) throw new Error("the dashboard build has no index.html")
  return files
}

/** The file for this path ("/" = the page), or null. A failed build is tried again on the next request. */
export async function dashboardFile(path: string): Promise<DashboardFile | null> {
  if (!built) {
    built = build()
    built.catch((e) => {
      console.error(`✗ dashboard: ${(e as Error).message}`)
      built = null
    })
  }
  return (await built).get(path) ?? null
}
