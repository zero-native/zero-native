// Runs iOS's Mac unit tests: every ios/tests/<suite>/ with a sources.txt is built with swiftc (its Swift files plus
// the suite's main.swift) and run. A suite may also have setup.ts (run first, given the scratch folder) and args.txt
// (the program's arguments). ios/tests/README.md says how to add one.
//   bun run tools/ios-unit-test.ts            every suite
//   bun run tools/ios-unit-test.ts ota routes  just these
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const testsDir = join(root, "ios/tests")

// One line per entry; blank lines and lines starting with # are skipped.
function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"))
}

// The suites, by folder name, in name order.
export function iosSuites(): string[] {
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(testsDir, d.name, "sources.txt")))
    .map((d) => d.name)
    .sort()
}

// The files a suite's args.txt names that aren't there (a built sample, say), with the file's # lines as the hint.
// An argument with $WORK in it is in the scratch folder, and one starting with - is a flag, so neither is checked.
export function iosSuiteMissing(suite: string): { missing: string[]; hint: string } {
  const file = join(testsDir, suite, "args.txt")
  if (!existsSync(file)) return { missing: [], hint: "" }
  const text = readFileSync(file, "utf8").split("\n").map((l) => l.trim())
  const hint = text.filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s?/, "")).join(" ")
  const missing = lines(file).filter((a) => !a.includes("$WORK") && !a.startsWith("-") && !existsSync(join(root, a)))
  return { missing, hint }
}

// True when this Mac can build the suites.
export function hasSwiftc(): boolean {
  if (process.platform !== "darwin") return false
  return Bun.spawnSync(["xcrun", "--find", "swiftc"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0
}

// Builds and runs one suite in its own scratch folder; true when it passed.
function runSuite(suite: string): boolean {
  const dir = join(testsDir, suite)
  const sources = lines(join(dir, "sources.txt"))
  for (const s of sources) {
    // Swift only: C, C++ and Objective-C++ (ZNHost.mm, core/) are tested in core/tests (tools/run-core-tests-apple.ts).
    if (!s.endsWith(".swift")) {
      console.error(`${suite}: sources.txt names ${s}; a suite builds only Swift files (C and C++ go in core/tests)`)
      return false
    }
    if (!existsSync(join(root, s))) {
      console.error(`${suite}: sources.txt names ${s}, which isn't there`)
      return false
    }
  }
  const { missing, hint } = iosSuiteMissing(suite)
  if (missing.length > 0) {
    console.error(`${suite}: no ${missing.join(", ")}${hint ? ` (${hint})` : ""}`)
    return false
  }
  const work = mkdtempSync(join(tmpdir(), `zn-ios-${suite}-`))
  const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" }).exitCode === 0
  try {
    if (existsSync(join(dir, "setup.ts"))) {
      mkdirSync(join(work, "setup"))
      if (!run([process.execPath, "run", join(dir, "setup.ts"), join(work, "setup")])) {
        console.error(`${suite}: setup.ts failed`)
        return false
      }
    }
    const exe = join(work, `${suite}-tests`)
    if (!run(["xcrun", "swiftc", "-O", "-o", exe, ...sources, `ios/tests/${suite}/main.swift`])) {
      console.error(`${suite}: didn't build`)
      return false
    }
    const argsFile = join(dir, "args.txt")
    const args = existsSync(argsFile)
      ? lines(argsFile).map((a) => (a.startsWith("-") ? a : a.includes("$WORK") ? a.replaceAll("$WORK", work) : join(root, a)))
      : []
    return run([exe, ...args])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const all = iosSuites()
  const asked = process.argv.slice(2)
  const unknown = asked.filter((s) => !all.includes(s))
  if (unknown.length > 0) {
    console.error(`no suite ${unknown.join(", ")} in ios/tests (there are: ${all.join(", ")})`)
    process.exit(2)
  }
  if (!hasSwiftc()) {
    console.error("these tests need a Mac with Xcode (xcrun swiftc)")
    process.exit(2)
  }
  const failed: string[] = []
  for (const suite of asked.length > 0 ? asked : all) {
    console.log(`== ios/tests/${suite}`)
    if (!runSuite(suite)) failed.push(suite)
  }
  const ran = asked.length > 0 ? asked.length : all.length
  if (failed.length === 0) console.log(`ios unit tests: ${ran} suite(s) passed`)
  else console.log(`ios unit tests: ${failed.length} of ${ran} suite(s) failed: ${failed.join(", ")}`)
  process.exit(failed.length === 0 ? 0 : 1)
}
