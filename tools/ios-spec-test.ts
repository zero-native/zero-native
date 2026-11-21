// Runs iOS's parsers for template values read before they are drawn (grid row style, pinned rows, scroll commands) on
// the Mac: builds ios/tests/spec/main.swift with ZnListLogic.swift and ZnScrollCommand.swift (Foundation only) and
// runs it.
//   bun run tools/ios-spec-test.ts
import { mkdtempSync, rmSync } from "node:fs"
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
  const swift = "ios/ZnRuntime/Swift"
  run(["xcrun", "swiftc", "-O", "-o", join(work, "spec-tests"), `${swift}/ZnListLogic.swift`, `${swift}/ZnScrollCommand.swift`,
    "ios/tests/spec/main.swift"])
  run([join(work, "spec-tests")])
} finally {
  rmSync(work, { recursive: true, force: true })
}
