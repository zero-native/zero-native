// Packs every package we publish to npm into one folder, the way `npm publish` would send them
// (docs/publishing-plan.md §2.1, §7). Nothing is uploaded.
//
//   bun run tools/pack.ts [--out <dir>]        default: build/npm
//
// A package is published when it isn't "private" (the root, the sample, the server and device-test are). Each gets
// the repo's LICENSE and NOTICE for the pack, removed again after. `bun pm pack` turns `workspace:*` into the exact
// version, so the packages only work with each other at one version (§6). After packing, each tarball is checked:
// no `workspace:` left, no test files, and its `main` / `bin` files are in it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const root = resolve(import.meta.dir, "..")

export interface Publishable {
  name: string
  version: string
  dir: string
}

/** The workspace packages that aren't private, in the order they must be published (dependencies first). */
export function publishable(): Publishable[] {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces: string[] }
  const dirs: string[] = []
  for (const w of rootPkg.workspaces) {
    if (w.endsWith("/*")) {
      const parent = join(root, w.slice(0, -2))
      for (const d of readdirSync(parent).sort()) if (existsSync(join(parent, d, "package.json"))) dirs.push(join(w.slice(0, -2), d))
    } else dirs.push(w)
  }
  const out: (Publishable & { deps: string[] })[] = []
  for (const dir of dirs) {
    const p = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))
    if (p.private) continue
    const deps = Object.keys({ ...p.dependencies, ...p.peerDependencies })
    out.push({ name: p.name, version: p.version, dir, deps })
  }
  // Dependencies first, so a release that stops half way never leaves a package whose dependency isn't there yet.
  const names = new Set(out.map((p) => p.name))
  const done = new Set<string>()
  const ordered: Publishable[] = []
  while (ordered.length < out.length) {
    const next = out.filter((p) => !done.has(p.name) && p.deps.every((d) => !names.has(d) || done.has(d)))
    if (next.length === 0) throw new Error(`a dependency loop among: ${out.filter((p) => !done.has(p.name)).map((p) => p.name).join(", ")}`)
    for (const p of next) {
      done.add(p.name)
      ordered.push({ name: p.name, version: p.version, dir: p.dir })
    }
  }
  return ordered
}

/** What is wrong with one packed package.json and its file list (empty: fine). */
export function packProblems(pkg: Record<string, any>, files: string[]): string[] {
  const problems: string[] = []
  for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
      if (range.startsWith("workspace:") || range.startsWith("link:")) problems.push(`${field} ${name}: "${range}"`)
    }
  }
  for (const f of files) if (/\.test\.tsx?$/.test(f)) problems.push(`a test file: ${f}`)
  const needed = [pkg.main, ...Object.values((pkg.bin ?? {}) as Record<string, string>)].filter(Boolean) as string[]
  for (const f of needed) if (!files.includes(f.replace(/^\.\//, ""))) problems.push(`${f} is not in the package`)
  for (const f of ["LICENSE", "NOTICE", "package.json"]) if (!files.includes(f)) problems.push(`no ${f}`)
  return problems
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } })
  const out = resolve(values.out ?? join(root, "build/npm"))
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  let failed = false
  for (const p of publishable()) {
    const dir = join(root, p.dir)
    const added = ["LICENSE", "NOTICE"].filter((f) => !existsSync(join(dir, f)))
    for (const f of added) copyFileSync(join(root, f), join(dir, f))
    try {
      const r = Bun.spawnSync(["bun", "pm", "pack", "--destination", out, "--quiet"], { cwd: dir, stderr: "pipe", stdout: "pipe" })
      if (r.exitCode !== 0) throw new Error(`bun pm pack failed in ${p.dir}:\n${r.stderr.toString()}`)
    } finally {
      for (const f of added) rmSync(join(dir, f), { force: true })
    }
    const tgz = join(out, `${p.name.replace(/^@/, "").replace("/", "-")}-${p.version}.tgz`)
    const list = Bun.spawnSync(["tar", "-tzf", tgz]).stdout.toString().trim().split("\n").map((f) => f.replace(/^package\//, ""))
    const packed = JSON.parse(Bun.spawnSync(["tar", "-xzOf", tgz, "package/package.json"]).stdout.toString())
    const problems = packProblems(packed, list)
    const kb = (Bun.file(tgz).size / 1024).toFixed(0)
    console.log(`${problems.length ? "✗" : "✓"} ${p.name}@${p.version}: ${list.length} files, ${kb} KB`)
    for (const problem of problems) console.log(`    ${problem}`)
    if (problems.length) failed = true
  }
  console.log(`\nin ${out}`)
  if (failed) process.exit(1)
}
