// Checks that the repo is ready to release a version (docs/publishing-plan.md §6, docs/releasing.md). The release
// workflow runs it first, on the tag's version; run it by hand before tagging.
//
//   bun run tools/check-release.ts --version 0.1.0     checks; exits 1 with every problem listed
//   bun run tools/check-release.ts --set 0.1.0         writes 0.1.0 into every published package.json (then commit)
//
// Checks:
// - every package we publish (tools/pack.ts publishable()) has that version. Gradle reads the Android version from
//   packages/core/package.json, so there is no Gradle file to check.
// - Hermes is the same release everywhere: tools/fetch-hermes-apple.ts, hermes-compiler in package.json and
//   tools/package.json, hermes-android in android/runtime/build.gradle.kts, and Package.swift's release url.
// - Package.swift's Hermes checksum is a real one (not the zeros left before the first Hermes release).
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { publishable } from "./pack"

const root = resolve(import.meta.dir, "..")
const read = (f: string) => readFileSync(join(root, f), "utf8")

export interface HermesPins {
  fetchScript: string | null
  rootCompiler: string | null
  cliCompiler: string | null
  android: string | null
  packageSwift: string | null
  packageSwiftChecksum: string | null
}

/** Where Hermes's version is written, as each file has it now. */
export function hermesPins(file: (f: string) => string = read): HermesPins {
  const m = (re: RegExp, text: string) => re.exec(text)?.[1] ?? null
  const swift = file("Package.swift")
  return {
    fetchScript: m(/const VERSION = "([^"]+)"/, file("tools/fetch-hermes-apple.ts")),
    rootCompiler: JSON.parse(file("package.json")).devDependencies?.["hermes-compiler"] ?? null,
    cliCompiler: JSON.parse(file("tools/package.json")).dependencies?.["hermes-compiler"] ?? null,
    android: m(/com\.facebook\.hermes:hermes-android:([^"]+)"/, file("android/runtime/build.gradle.kts")),
    packageSwift: m(/releases\/download\/hermes-([^/]+)\/hermesvm\.xcframework\.zip/, swift),
    packageSwiftChecksum: m(/checksum: "([0-9a-f]{64})"/, swift),
  }
}

/** Every problem with releasing [version] (empty: ready). */
export function releaseProblems(version: string, packages = publishable(), pins = hermesPins()): string[] {
  const problems: string[] = []
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`the version must be like 0.1.0, got "${version}"`)
  for (const p of packages) if (p.version !== version) problems.push(`${p.name} (${p.dir}/package.json) is ${p.version}, not ${version}`)
  const named: [string, string | null][] = [
    ["tools/fetch-hermes-apple.ts VERSION", pins.fetchScript],
    ["package.json hermes-compiler", pins.rootCompiler],
    ["tools/package.json hermes-compiler", pins.cliCompiler],
    ["android/runtime/build.gradle.kts hermes-android", pins.android],
    ["Package.swift's Hermes release", pins.packageSwift],
  ]
  for (const [where, v] of named) if (!v) problems.push(`no Hermes version found in ${where}`)
  const versions = new Set(named.map(([, v]) => v).filter(Boolean))
  if (versions.size > 1) problems.push(`Hermes differs: ${named.map(([w, v]) => `${w} = ${v}`).join("; ")}`)
  if (!pins.packageSwiftChecksum || /^0+$/.test(pins.packageSwiftChecksum)) {
    problems.push("Package.swift has no real Hermes checksum: run the Hermes release first (docs/releasing.md)")
  }
  return problems
}

/** Writes [version] into every published package.json. Internal `workspace:*` ranges stay: packing turns them exact. */
export function setVersion(version: string): string[] {
  const changed: string[] = []
  for (const p of publishable()) {
    const file = join(root, p.dir, "package.json")
    const text = readFileSync(file, "utf8")
    const next = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`)
    if (next !== text) {
      writeFileSync(file, next)
      changed.push(`${p.dir}/package.json`)
    }
  }
  return changed
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, set: { type: "string" } } })
  if (values.set) {
    if (!/^\d+\.\d+\.\d+$/.test(values.set)) throw new Error(`--set must be like 0.1.0, got "${values.set}"`)
    const changed = setVersion(values.set)
    console.log(`${values.set} in ${changed.length} package.json files${changed.length ? ":\n  " + changed.join("\n  ") : ""}`)
    process.exit(0)
  }
  const version = (values.version ?? "").replace(/^v/, "")
  if (!version) {
    console.error("usage: bun run tools/check-release.ts --version <x.y.z>   (or --set <x.y.z>)")
    process.exit(1)
  }
  const problems = releaseProblems(version)
  if (problems.length) {
    console.error(`✗ not ready to release ${version}:`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  const pins = hermesPins()
  console.log(`✓ ready to release ${version}: ${publishable().length} packages at ${version}, Hermes ${pins.fetchScript} everywhere`)
}
