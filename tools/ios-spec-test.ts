// Runs iOS's parsers for template values read before they are drawn (grid row style, pinned rows, scroll commands) on
// the Mac: builds ios/tests/spec/main.swift with the runtime files named in ios/tests/spec/sources.txt (Foundation
// only) and runs it.
//   bun run tools/ios-spec-test.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const work = mkdtempSync(join(tmpdir(), "zn-ios-spec-"))
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (r.exitCode !== 0) {
    rmSync(work, { recursive: true, force: true })
    process.exit(r.exitCode ?? 1)
  }
}
try {
  const sources = readFileSync(join(root, "ios/tests/spec/sources.txt"), "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")).map((f) => `ios/ZnRuntime/Swift/${f}`)
  run(["xcrun", "swiftc", "-O", "-o", join(work, "spec-tests"), ...sources, "ios/tests/spec/main.swift"])
  run([join(work, "spec-tests")])
} finally {
  rmSync(work, { recursive: true, force: true })
}
